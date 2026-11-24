import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { upstream, anthropicReply } from '../worker/upstream.ts'
import { ToolResults } from '../worker/toolResults.ts'
import { tokenBudgets } from '../worker/policy.ts'
import { McpTools } from '../worker/mcpTools.ts'
import { applyEvent, settleReply } from '../src/services/chat/reply.ts'
import { buildReplyView, getAreaTitle, getTotalThinkingSeconds } from '../src/services/chat/view.ts'

assert.deepEqual(tokenBudgets({ UPSTREAM_PROTOCOL: 'openai' }), { input: 196608, output: 32768 })
assert.deepEqual(
  tokenBudgets({
    MAX_INPUT_TOKENS: '196608',
    MAX_OUTPUT_TOKENS: '32768',
    MODEL_CONTEXT_TOKENS: '131072',
  }),
  { input: 97280, output: 32768 }
)
assert.throws(() => tokenBudgets({ MAX_INPUT_TOKENS: '2.5' }), /Invalid/)
assert.throws(
  () => tokenBudgets({ MODEL_CONTEXT_TOKENS: '8192', MAX_OUTPUT_TOKENS: '8192' }),
  /leave room/
)
const small = new McpTools(
  [
    {
      alias: 'mcp_0',
      server: { name: 'Notes' },
      tool: { name: 'read_note', inputSchema: { type: 'object' } },
    },
  ],
  {}
)
assert.equal(small.deferred, true)
assert.equal(small.definitions('openai', true)[0].function.name, 'mcp_load_tools')
assert.equal(small.isActive('mcp_0'), false)
small.load({ names: ['mcp_0'] })
assert.equal(small.isActive('mcp_0'), true)
const cache = new ToolResults({ MAX_INPUT_TOKENS: '8192' })
const full = JSON.stringify({
  content: [{ type: 'text', text: '文'.repeat(40000) + ' omitted-evidence-42' }],
})
const preview = JSON.parse(cache.remember(full))
assert.equal(preview.truncated, true)
assert.ok(preview.text.length < full.length)
assert.match(
  JSON.parse(cache.read({ result_id: preview.result_id, find: 'omitted-evidence-42' })).text,
  /omitted-evidence-42/
)
assert.equal(JSON.parse(cache.read({ result_id: 'unknown' })).error.includes('Unknown'), true)
const timed = settleReply(
  { role: 'assistant', blocks: [], processingStartedAt: 1000, processingSeconds: 12 },
  'stopped',
  34000
)
assert.equal(timed.processingSeconds, 45)
assert.equal(timed.processingStartedAt, undefined)
const emptyView = { steps: [], answer: null, sources: [], searchResults: [] }
assert.equal(getTotalThinkingSeconds([], 1), null)
assert.match(getAreaTitle(emptyView, false, 999999, true, timed), /45/)
console.log(
  'PASS: larger and window-aware budgets, universal lazy schemas, intact cached MCP evidence and persisted processing duration'
)

let requests = []
let active = 0
let maximum = 0
let searches = 0
let pages = 0
let mockError
const source = (query, i = 0) => `https://example.com/${query}/${i}`
const mock = createServer(async (req, res) => {
  try {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    if (req.url === '/search' || req.url === '/extract') {
      active++
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, body.query === 'q0' ? 40 : 5))
      active--
      if (req.url === '/search') {
        searches++
        assert.equal(body.search_depth, 'advanced')
        assert.equal(body.max_results, 8)
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            results: Array.from({ length: 8 }, (_, i) => ({
              url: source(body.query, i),
              title: `${body.query}-${i}`,
              content: 'Relevant evidence '.repeat(140),
            })),
          })
        )
      } else {
        pages++
        assert.equal(body.extract_depth, 'advanced')
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            results: [
              {
                url: body.urls[0],
                raw_content: '# Primary evidence\n' + '正文'.repeat(8000) + '\npage-evidence-42',
              },
            ],
          })
        )
      }
      return
    }
    requests.push(body)
    const responses = req.url === '/v1/responses'
    const anthropic = req.url === '/v1/messages'
    const outputs = responses
      ? body.input.filter((item) => item.type === 'function_call_output').map((item) => item.output)
      : anthropic
        ? body.messages.flatMap((message) =>
            Array.isArray(message.content)
              ? message.content
                  .filter((block) => block.type === 'tool_result')
                  .map((block) => block.content)
              : []
          )
        : body.messages
            .filter((message) => message.role === 'tool')
            .map((message) => message.content)
    const final = body.tool_choice === 'none' || body.tool_choice?.type === 'none'
    let calls = []
    if (!final && outputs.length === 0)
      calls = ['q0', 'q1', 'q2'].map((query) => ({
        name: 'web_search',
        input: { query, mode: 'research' },
      }))
    else if (!final && outputs.length === 3)
      calls = [source('q0'), source('q1'), source('q2'), 'https://example.com/external'].map(
        (url) => ({ name: 'read_web_page', input: { url } })
      )
    else if (!final && outputs.length === 7)
      calls = [
        {
          name: 'read_tool_result',
          input: { result_id: JSON.parse(outputs[6]).result_id, find: 'page-evidence-42' },
        },
        { name: 'web_search', input: { query: 'q3' } },
      ]
    if (outputs.length === 9)
      assert.ok(
        outputs[7].includes('page-evidence-42'),
        'Omitted page evidence must be retrievable from the local result cache'
      )
    if (!anthropic) assert.equal(body.parallel_tool_calls, true)
    const values = calls.map((call, i) => ({ ...call, id: `call-${outputs.length}-${i}` }))
    const answer = 'Verified result. [citation:1]'
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const event = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`)
    if (responses) {
      const output = values.length
        ? values.map((call) => ({
            type: 'function_call',
            id: `item-${call.id}`,
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.input),
          }))
        : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] }]
      output.forEach((item, output_index) =>
        event({ type: 'response.output_item.done', output_index, item })
      )
      event({
        type: 'response.completed',
        response: { output, usage: { input_tokens: 100, output_tokens: 5 } },
      })
    } else if (anthropic) {
      event({ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0 } } })
      const blocks = values.length
        ? values.map((call) => ({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: call.input,
          }))
        : [{ type: 'text', text: answer }]
      blocks.forEach((content_block, index) => {
        event({ type: 'content_block_start', index, content_block })
        event({ type: 'content_block_stop', index })
      })
      event({
        type: 'message_delta',
        delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn' },
        usage: { output_tokens: 5 },
      })
      event({ type: 'message_stop' })
    } else {
      event({
        choices: [
          {
            delta: values.length
              ? {
                  tool_calls: values.map((call, index) => ({
                    index,
                    id: call.id,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  })),
                }
              : { content: answer },
            finish_reason: calls.length ? 'tool_calls' : 'stop',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 5 },
      })
      res.write('data: [DONE]\n\n')
    }
    res.end()
  } catch (error) {
    mockError = error
    res.writeHead(500).end('mock failure')
  }
})
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${mock.address().port}`
const env = {
  DEV_AUTH: 'true',
  UPSTREAM_BASE_URL: `${origin}/v1`,
  UPSTREAM_API_KEY: 'mock',
  UPSTREAM_MODEL: 'test-model',
  TAVILY_API_KEY: 'mock',
  DEV_SEARCH_URL: `${origin}/search`,
  TOOL_CONCURRENCY: '2',
  MAX_INPUT_TOKENS: '196608',
  DB: { prepare: () => ({ all: async () => ({ results: [] }) }) },
}
const body = {
  system: 'Test',
  messages: [{ role: 'user', content: 'Research several sources' }],
  tools: [{ type: 'deepseek_web_search' }],
}
async function run(protocol, style, limits = {}) {
  requests = []
  maximum = 0
  searches = 0
  pages = 0
  mockError = undefined
  const config = { ...env, UPSTREAM_PROTOCOL: protocol, OPENAI_API_STYLE: style, ...limits }
  let events
  if (protocol === 'anthropic') {
    events = []
    for await (const event of anthropicReply(body, config, new AbortController().signal))
      events.push(event)
  } else {
    const response = await upstream(
      new Request(`${origin}/api/anthropic/v1/messages`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      config,
      '/api/anthropic/v1/messages'
    )
    events = (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)))
  }
  if (mockError) throw mockError
  assert.ok(
    events.some((event) => event.type === 'message_stop'),
    JSON.stringify(events)
  )
  return events
}
try {
  for (const [protocol, style] of [
    ['openai', 'chat_completions'],
    ['openai', 'responses'],
    ['anthropic', undefined],
  ]) {
    const events = await run(protocol, style)
    assert.equal(searches, 4)
    assert.equal(pages, 4)
    assert.equal(maximum, 2)
    assert.equal(requests.length, 4)
    assert.equal(events.findLast((event) => event.delta?.stop_reason).usage.output_tokens, 20)
    const starts = events
      .filter((event) => event.type === 'content_block_start')
      .map((event) => event.index)
    assert.equal(new Set(starts).size, starts.length)
    let reply = { role: 'assistant', status: 'pending', blocks: [] }
    const indexes = new Map()
    for (const event of events) reply = applyEvent(reply, event, 1, indexes)
    assert.equal(indexes.size, 0)
    const view = buildReplyView(reply, false)
    assert.equal(view.sources[0].url, source('q1'))
    assert.equal(view.searchResults.length, 32)
    const payloads =
      requests[1].input
        ?.filter((item) => item.type === 'function_call_output')
        .map((item) => item.output) ??
      (protocol === 'anthropic'
        ? requests[1].messages.at(-1).content.map((item) => item.content)
        : requests[1].messages.filter((item) => item.role === 'tool').map((item) => item.content))
    for (const payload of payloads)
      for (const item of JSON.parse(payload).sources) {
        assert.equal(view.sources[Number(item.citation.match(/\d+/)[0]) - 1].url, item.url)
      }
    await run(protocol, style, { MAX_AGENT_ROUNDS: '1' })
    assert.equal(requests.length, 2)
    assert.equal(pages, 0)
    assert.ok(requests[1].tool_choice === 'none' || requests[1].tool_choice.type === 'none')
    await run(protocol, style, { MAX_TOOL_CALLS: '2' })
    assert.equal(searches, 2)
    assert.equal(requests.length, 2)
    console.log(
      `PASS: ${protocol}/${style ?? 'messages'} concurrent research, compact evidence, stable citations, complete exchanges and graceful budget completion`
    )
  }
} finally {
  await new Promise((resolve) => mock.close(resolve))
}
