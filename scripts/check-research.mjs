import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { ToolRuntime } from '../worker/toolRuntime.ts'
import { evidenceExcerpt, sourceUrl } from '../worker/evidence.ts'
import { contextCost } from '../worker/context.ts'
import { researchPolicy } from '../worker/policy.ts'
import { upstream, anthropicReply } from '../worker/upstream.ts'

assert.equal(
  sourceUrl('https://example.com/page?id=42&utm_source=test#section'),
  'https://example.com/page?id=42'
)
const primary =
  '无关正文。'.repeat(1500) +
  '\n王丹红《太阳颂》于2014年11月30日首演，创作年份未注明。\n' +
  '其他内容。'.repeat(1500)
assert.match(
  evidenceExcerpt(primary, '王丹红 太阳颂 首演年份', 700),
  /2014年11月30日首演，创作年份未注明/
)
assert.ok(evidenceExcerpt(primary, '王丹红 太阳颂', 700).length <= 700)
assert.equal(researchPolicy({}).maxSearches, 4)
assert.equal(researchPolicy({}, 'research').maxSearches, 8)
assert.throws(() => researchPolicy({ MAX_RESEARCH_TOKENS: 'garbage' }), /Invalid/)

let searchCalls = 0
let pageCalls = 0
let providerCalls = []
let fixture = 'normal'
let modelRound = 0
let mockError
const model = createServer(async (req, res) => {
  try {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    if (req.url === '/search') {
      searchCalls++
      assert.equal(body.search_depth, fixture === 'deep' ? 'advanced' : 'basic')
      assert.equal(body.max_results, fixture === 'deep' ? 8 : 5)
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          results:
            fixture === 'empty'
              ? []
              : Array.from({ length: body.max_results }, (_, i) => ({
                  title: `Primary source ${i}`,
                  url: `https://example.com/${fixture === 'duplicates' ? 'same' : body.query}/${i}?utm_source=test`,
                  content: `Source ${i}: ` + primary,
                })),
        })
      )
      return
    }
    if (req.url === '/extract') {
      pageCalls++
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          results: [
            {
              url: body.urls[0],
              raw_content: '# Primary program\n' + primary + '\n独特尾部证据：2021',
            },
          ],
        })
      )
      return
    }
    providerCalls.push(body)
    const phase = modelRound++
    const final = body.tool_choice === 'none' || body.tool_choice?.type === 'none'
    const calls = final
      ? []
      : [0, 1].map((i) => ({
          id: `call-${phase}-${i}`,
          name: 'web_search',
          input: { query: `王丹红 太阳颂 ${phase}-${i}` },
        }))
    const answer = '已核实首演记录；确切创作年份尚不能确定。[citation:1]'
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const event = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`)
    if (req.url === '/v1/responses') {
      const output = calls.length
        ? calls.map((call) => ({
            type: 'function_call',
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
        response: { output, usage: { input_tokens: 100, output_tokens: 10 } },
      })
    } else if (req.url === '/v1/messages') {
      event({ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0 } } })
      const blocks = calls.length
        ? calls.map((call) => ({ type: 'tool_use', ...call }))
        : [{ type: 'text', text: answer }]
      blocks.forEach((content_block, index) => {
        event({ type: 'content_block_start', index, content_block })
        event({ type: 'content_block_stop', index })
      })
      event({
        type: 'message_delta',
        delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn' },
        usage: { output_tokens: 10 },
      })
      event({ type: 'message_stop' })
    } else {
      event({
        choices: [
          {
            delta: calls.length
              ? {
                  tool_calls: calls.map((call, index) => ({
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
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      })
      res.write('data: [DONE]\n\n')
    }
    res.end()
  } catch (error) {
    mockError = error
    res.writeHead(500).end('mock failure')
  }
})
await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${model.address().port}`
const env = {
  UPSTREAM_PROTOCOL: 'openai',
  UPSTREAM_MODEL: 'test-model',
  UPSTREAM_BASE_URL: `${origin}/v1`,
  UPSTREAM_API_KEY: 'mock',
  TAVILY_API_KEY: 'mock',
  DEV_AUTH: 'true',
  DEV_SEARCH_URL: `${origin}/search`,
  DB: { prepare: () => ({ all: async () => ({ results: [] }) }) },
}
const signal = new AbortController().signal
const call = (query, extra = {}) => ({ name: 'web_search', input: { query, ...extra } })
const drain = async (iterator) => {
  for (;;) {
    const next = await iterator.next()
    if (next.done) return next.value
  }
}
try {
  const runtime = new ToolRuntime([], env, true, { index: -1 }, new Map())
  const definitions = JSON.stringify(runtime.definitions('openai'))
  const first = await drain(
    runtime.batch([call('  王丹红  太阳颂 '), call('王丹红 太阳颂')], signal)
  )
  assert.equal(searchCalls, 1, 'Concurrent identical queries must make one external request')
  assert.equal(JSON.parse(first[1].text).previously_requested, true)
  const parsed = JSON.parse(first[0].text)
  assert.ok(parsed.sources.every((item) => item.citation && item.url && item.title))
  assert.ok(contextCost(first[0].text) < 1900)
  const cached = await drain(
    runtime.batch(
      [
        {
          name: 'read_tool_result',
          input: {
            result_id: parsed.result_id,
            find: '2014年11月30日',
            limit: 16000,
          },
        },
      ],
      signal
    )
  )
  assert.match(cached[0].text, /2014年11月30日/)
  assert.equal(searchCalls, 1, 'Reading cached evidence must not repeat the search')
  assert.ok(
    contextCost(cached[0].text) < 1900,
    'A large cache read cannot bypass the evidence budget'
  )
  assert.equal(JSON.stringify(runtime.definitions('openai')), definitions)
  const now = Date.now
  try {
    Date.now = () => now() + 31000
    assert.match(runtime.web.stopReason, /time budget/)
    const expiredRead = await drain(
      runtime.batch(
        [
          {
            name: 'read_tool_result',
            input: {
              result_id: parsed.result_id,
              find: 'Source',
            },
          },
        ],
        signal
      )
    )
    assert.equal(expiredRead[0].isError, true, 'Cache reads also obey the research deadline')
    await drain(runtime.batch([call('late query')], signal))
    assert.equal(searchCalls, 1, 'Expired research must not start another remote lookup')
  } finally {
    Date.now = now
  }

  const pages = new ToolRuntime([], env, true, { index: -1 }, new Map())
  const result = await drain(
    pages.batch(
      [
        {
          name: 'read_web_page',
          input: { url: 'https://example.com/program#one', focus: '王丹红 太阳颂 首演' },
        },
        {
          name: 'read_web_page',
          input: { url: 'https://example.com/program?utm_source=test', focus: '王丹红' },
        },
      ],
      signal
    )
  )
  assert.equal(pageCalls, 1)
  assert.match(result[0].text, /2014年11月30日/)
  const whole = await drain(
    pages.batch(
      [
        {
          name: 'read_tool_result',
          input: {
            result_id: JSON.parse(result[0].text).result_id,
            find: '独特尾部证据',
          },
        },
      ],
      signal
    )
  )
  assert.match(whole[0].text, /独特尾部证据/)

  fixture = 'duplicates'
  const duplicate = new ToolRuntime([], env, true, { index: -1 }, new Map())
  await drain(duplicate.batch([call('first')], signal))
  const repeat = await drain(duplicate.batch([call('second', { mode: 'research' })], signal))
  assert.equal(
    JSON.parse(repeat[0].text).research_budget.mode,
    'quick',
    'A single fact cannot escalate halfway through research'
  )
  assert.ok(
    JSON.parse(repeat[0].text).sources.every((item) => item.previously_seen && !item.excerpt)
  )
  await drain(duplicate.batch([call('third')], signal))
  assert.equal(duplicate.exhausted, true)

  fixture = 'deep'
  const deep = new ToolRuntime([], env, true, { index: -1 }, new Map())
  const deepResult = await drain(deep.batch([call('report', { mode: 'research' })], signal))
  assert.equal(JSON.parse(deepResult[0].text).research_budget.mode, 'research')
  assert.equal(JSON.parse(deepResult[0].text).sources.length, 8)

  for (const [protocol, style] of [
    ['openai', 'responses'],
    ['openai', 'chat_completions'],
    ['anthropic'],
  ]) {
    for (const scenario of ['normal', 'empty']) {
      fixture = scenario
      searchCalls = 0
      modelRound = 0
      providerCalls = []
      const body = {
        system: 'Stable instructions',
        messages: [{ role: 'user', content: '王丹红太阳颂是哪一年创作的？' }],
        tools: [{ type: 'deepseek_web_search' }],
      }
      let events
      if (protocol === 'anthropic') {
        events = []
        for await (const event of anthropicReply(
          body,
          { ...env, UPSTREAM_PROTOCOL: protocol },
          signal
        ))
          events.push(event)
      } else {
        const response = await upstream(
          new Request(`${origin}/api/anthropic/v1/messages`, {
            method: 'POST',
            body: JSON.stringify(body),
          }),
          { ...env, UPSTREAM_PROTOCOL: protocol, OPENAI_API_STYLE: style },
          '/api/anthropic/v1/messages'
        )
        events = (await response.text())
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => JSON.parse(line.slice(6)))
      }
      if (mockError) throw mockError
      assert.ok(events.some((event) => event.type === 'message_stop'))
      assert.equal(searchCalls, 4)
      assert.equal(providerCalls.length, scenario === 'empty' ? 3 : 4)
      assert.ok(
        providerCalls.at(-1).tool_choice === 'none' ||
          providerCalls.at(-1).tool_choice.type === 'none'
      )
      assert.ok(
        providerCalls.every(
          (body) => JSON.stringify(body.tools) === JSON.stringify(providerCalls[0].tools)
        )
      )
      if (style === 'responses') {
        assert.ok(
          providerCalls.every(
            (body) =>
              body.input[0].role === 'developer' &&
              body.input[0].content === providerCalls[0].input[0].content
          )
        )
        assert.equal(providerCalls[0].instructions, undefined)
        assert.match(
          providerCalls.at(-1).instructions,
          scenario === 'empty' ? /no new evidence/ : /turn limit/
        )
        const evidence = providerCalls
          .at(-1)
          .input.filter((item) => item.type === 'function_call_output')
        assert.ok(evidence.reduce((sum, item) => sum + contextCost(item.output), 0) <= 8000)
      }
    }
    console.log(
      `PASS: ${protocol}/${style ?? 'messages'} stops over-searching and empty-result loops, stable schemas, unchanged Responses prefix`
    )
  }
  console.log(
    'PASS: compact relevant evidence, preserved full text, deduplicated queries/pages/sources, locked research mode and bounded cache reads'
  )
} finally {
  await new Promise((resolve) => model.close(resolve))
}
