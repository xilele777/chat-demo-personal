import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { upstream, openAIStream } from '../worker/upstream.ts'
import { responsesInput } from '../worker/openaiResponses.ts'
import { readMessageEvent } from '../src/services/api/parseEvent.ts'
import { applyEvent, toRequestMessages } from '../src/services/chat/reply.ts'
import { buildReplyView } from '../src/services/chat/view.ts'
import { addUsage, totalTokens } from '../src/services/chat/usage.ts'
import { publicPageUrl, limitWebContext } from '../worker/webPage.ts'

const wire = (values) =>
  values.map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join('')
const convert = async (values) =>
  (
    await openAIStream(
      new Response(wire(values), { headers: { 'Content-Type': 'text/event-stream' } }),
      new AbortController().signal,
      'test'
    ).text()
  )
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
const summary = {
  type: 'reasoning',
  id: 'reason',
  summary: [{ text: '公开摘要' }],
  encrypted_content: 'opaque-private-signature',
}
let events = await convert([
  { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: '公开' },
  { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: '摘要' },
  { type: 'response.output_item.done', output_index: 0, item: summary },
  { type: 'response.output_text.delta', output_index: 1, delta: '回答' },
  {
    type: 'response.completed',
    response: {
      output: [summary],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
        output_tokens_details: { reasoning_tokens: 30 },
      },
    },
  },
])
assert.equal(
  events
    .filter((event) => event.delta?.type === 'thinking_delta')
    .map((event) => event.delta.thinking)
    .join(''),
  '公开摘要'
)
assert.equal(JSON.stringify(events).includes('opaque-private-signature'), false)
assert.deepEqual(events.findLast((event) => event.type === 'message_delta').usage, {
  input_tokens: 70,
  cache_read_input_tokens: 20,
  cache_creation_input_tokens: 10,
  output_tokens: 50,
  reasoning_tokens: 30,
  cache_reported: true,
})
events = await convert([
  { type: 'response.output_item.done', output_index: 0, item: summary },
  { type: 'response.completed', response: { output: [summary] } },
])
assert.ok(events.some((event) => event.delta?.thinking === '公开摘要'))
events = await convert([
  {
    type: 'response.incomplete',
    response: { output: [], incomplete_details: { reason: 'max_output_tokens' } },
  },
])
assert.equal(
  events.findLast((event) => event.type === 'message_delta').delta.stop_reason,
  'max_tokens'
)
assert.deepEqual(
  responsesInput([
    { role: 'assistant', content: '', provider_output: [summary] },
    { role: 'tool', tool_call_id: 'call', content: 'value' },
  ]),
  [summary, { type: 'function_call_output', call_id: 'call', output: 'value' }]
)
assert.equal(
  responsesInput([
    {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
    },
  ])[0].content[0].type,
  'input_image'
)
for (const url of [
  'http://127.0.0.1',
  'https://10.0.0.1',
  'file:///etc/passwd',
  'https://user:pass@example.com',
])
  assert.throws(() => publicPageUrl(url, {}))
const full = [
  { role: 'user', content: '当前问题' },
  { role: 'assistant', content: '', tool_calls: [] },
  {
    role: 'tool',
    content: JSON.stringify({
      type: 'web_page',
      title: '标题',
      url: 'https://example.com',
      citation: '[citation:1]',
      text: '文'.repeat(8000),
    }),
  },
]
const bounded = limitWebContext('system', full, { MAX_INPUT_TOKENS: '4096' })
assert.equal(JSON.parse(bounded.at(-1).content).url, 'https://example.com')
assert.ok(JSON.parse(bounded.at(-1).content).text.length < 8000)
assert.equal(JSON.parse(full.at(-1).content).text.length, 8000)
console.log(
  'PASS: Responses public summaries, opaque signatures, cache-write usage, images, limits and safe page URLs'
)

let requests = []
let extracts = 0
let failRead = false
let laterFailure = false
let mockError
const mock = createServer(async (request, response) => {
  try {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    if (request.url === '/search') {
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(
          JSON.stringify({
            results: [
              { title: '搜索摘要', url: 'https://example.com/source', content: '只有摘要' },
            ],
          })
        )
      return
    }
    if (request.url === '/extract') {
      extracts++
      assert.deepEqual(body.urls, ['https://example.com/source'])
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(
          JSON.stringify(
            failRead
              ? {
                  results: [],
                  failed_results: [{ url: body.urls[0], error: 'must not leak credentials' }],
                }
              : {
                  results: [{ url: body.urls[0], raw_content: '# 抓取标题\n正文中的独特证据：42' }],
                }
          )
        )
      return
    }
    assert.equal(request.url, '/v1/responses')
    requests.push(body)
    assert.equal(body.store, false)
    assert.equal(body.reasoning.summary, 'detailed')
    assert.equal(body.stream_options, undefined)
    assert.equal(body.max_completion_tokens, undefined)
    if (!body.stream) {
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(
          JSON.stringify({
            output: [{ type: 'message', content: [{ type: 'output_text', text: '测试标题' }] }],
          })
        )
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const outputs = body.input.filter((item) => item.type === 'function_call_output')
    const phase = outputs.length
    if (phase > 0)
      assert.ok(body.input.some((item) => item.encrypted_content === 'opaque-private-signature'))
    if (laterFailure && phase === 1) {
      response.end(
        wire([
          { type: 'response.failed', response: { error: { message: 'later request failed' } } },
        ])
      )
      return
    }
    const callName = phase === 0 ? 'web_search' : phase === 1 ? 'read_web_page' : null
    const item = callName
      ? {
          type: 'function_call',
          id: `item-${phase}`,
          call_id: `call-${phase}`,
          name: callName,
          arguments: JSON.stringify(
            phase === 0 ? { query: '测试页面' } : { url: 'https://example.com/source' }
          ),
        }
      : {
          type: 'message',
          id: 'answer',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: failRead ? '网页读取失败。' : '根据正文，答案是 42。[citation:1]',
            },
          ],
        }
    if (phase === 2 && !failRead) assert.match(outputs.at(-1).output, /独特证据/)
    response.end(
      wire([
        {
          type: 'response.reasoning_summary_text.delta',
          output_index: 0,
          delta: `公开步骤${phase}`,
        },
        { type: 'response.output_item.done', output_index: 0, item: summary },
        { type: 'response.output_item.done', output_index: 1, item },
        {
          type: 'response.completed',
          response: {
            output: [summary, item],
            usage: {
              input_tokens: 100 + phase * 100,
              output_tokens: 20,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 5 },
            },
          },
        },
      ])
    )
  } catch (error) {
    mockError = error
    response.writeHead(500).end('mock failed')
  }
})
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${mock.address().port}`
const env = {
  DEV_AUTH: 'true',
  UPSTREAM_PROTOCOL: 'openai',
  OPENAI_API_STYLE: 'responses',
  UPSTREAM_MODEL: 'test-model',
  OPENAI_REASONING_EFFORTS: 'high',
  UPSTREAM_BASE_URL: `${origin}/v1`,
  UPSTREAM_API_KEY: 'test-key',
  TAVILY_API_KEY: 'test-search',
  DEV_SEARCH_URL: `${origin}/search`,
  DB: {
    prepare() {
      return { all: async () => ({ results: [] }) }
    },
  },
}
const run = async () => {
  requests = []
  const response = await upstream(
    new Request(`${origin}/api/anthropic/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({
        system: 'Test',
        messages: [{ role: 'user', content: '搜索并读取网页' }],
        reasoning_effort: 'high',
        tools: [{ type: 'deepseek_web_search' }],
      }),
    }),
    env,
    '/api/anthropic/v1/messages'
  )
  const events = (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
  if (mockError) throw mockError
  return events
}
try {
  const events = await run()
  assert.equal(requests.length, 3)
  assert.equal(extracts, 1)
  assert.equal(totalTokens(events.findLast((event) => event.delta?.stop_reason).usage), 660)
  const usageSnapshots = events
    .filter((event) => event.type === 'message_delta')
    .map((event) => totalTokens(event.usage))
  assert.deepEqual(usageSnapshots, [120, 340, 660, 660])
  let reply = { id: 'answer', role: 'assistant', status: 'pending', thinking: true, blocks: [] }
  const indexes = new Map()
  for (const event of events) {
    const parsed = readMessageEvent(event)
    if (parsed) reply = applyEvent(reply, parsed, 1, indexes)
  }
  const view = buildReplyView(reply, false)
  assert.ok(view.steps.some((step) => step.type === 'open' && step.pages[0].status === 'done'))
  assert.match(view.answer.text, /42/)
  const history = toRequestMessages(
    [
      { id: 'q', role: 'user', content: '问题', files: [] },
      { ...reply, status: 'done' },
    ],
    { id: 'next', role: 'user', content: '追问', files: [] },
    undefined,
    false,
    undefined,
    true
  )
  assert.match(JSON.stringify(history), /独特证据/)
  const prior = {
    input_tokens: 40,
    output_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }
  assert.deepEqual(
    [undefined, ...events.filter((event) => event.usage).map((event) => event.usage)].map((usage) =>
      totalTokens(addUsage(prior, usage))
    ),
    [50, 170, 390, 710, 710]
  )
  failRead = true
  const failed = await run()
  assert.ok(
    failed.some((event) => event.content_block?.content?.type === 'web_fetch_tool_result_error')
  )
  assert.equal(JSON.stringify(failed).includes('must not leak credentials'), false)
  failRead = false
  laterFailure = true
  const interrupted = await run()
  assert.ok(interrupted.some((event) => event.error))
  assert.equal(totalTokens(interrupted.find((event) => event.usage).usage), 120)
  const title = await upstream(
    new Request(`${origin}/api/title`, {
      method: 'POST',
      body: JSON.stringify({ question: '问题', answer: '回答' }),
    }),
    env,
    '/api/title'
  )
  assert.equal((await title.json()).title, '测试标题')
  console.log(
    'PASS: search → page extraction → answer, chronological UI steps, preserved evidence, cumulative usage, failure recovery and Responses titles'
  )
} finally {
  await new Promise((resolve) => mock.close(resolve))
}
