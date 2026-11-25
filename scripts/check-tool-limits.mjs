import assert from 'node:assert/strict'
import { ToolResults, mcpResultText } from '../worker/toolResults.ts'
import { toolResultLimits } from '../worker/policy.ts'
import { limitMcpResponse } from '../worker/mcpNet.ts'
import { contextCost } from '../worker/context.ts'
import { ToolRuntime } from '../worker/toolRuntime.ts'
import { HttpError } from '../worker/types.ts'

for (const field of [
  'MAX_TOOL_RESULT_BYTES',
  'MAX_TOOL_CACHE_BYTES',
  'MAX_TOOL_CACHE_ENTRIES',
  'MAX_MCP_RESPONSE_BYTES',
]) {
  for (const value of ['0', '-1', '2.5', 'bad', '999999999'])
    assert.throws(() => toolResultLimits({ [field]: value }), /Invalid/)
}
const cache = new ToolResults({
  MAX_TOOL_RESULT_BYTES: '2048',
  MAX_TOOL_CACHE_BYTES: '2048',
  MAX_INPUT_TOKENS: '4096',
})
const first = JSON.parse(cache.remember('A'.repeat(800)))
assert.equal(cache.size.bytes, 1600)
const rejected = JSON.parse(cache.remember('B'.repeat(600)))
assert.equal(rejected.cache_status, 'not_cached')
assert.equal(rejected.cache_reason, 'cache_limit')
assert.equal(rejected.result_id, undefined)
assert.equal(cache.size.bytes, 1600)
assert.match(JSON.parse(cache.read({ result_id: first.result_id })).text, /^A+$/)
cache.remember('中文'.repeat(50))
assert.deepEqual(cache.size, { bytes: 1800, entries: 2 })
const count = new ToolResults({ MAX_TOOL_CACHE_ENTRIES: '1' })
const one = JSON.parse(count.remember('{"fact":"first result"}'))
assert.equal(JSON.parse(count.remember('{"fact":"second result"}')).cache_reason, 'entry_limit')
assert.match(count.read({ result_id: one.result_id }), /first result/)
for (const budget of [1024, 4096, 196608]) {
  const bounded = new ToolResults({
    MAX_INPUT_TOKENS: String(budget),
    MAX_TOOL_RESULT_BYTES: '1024',
  })
  const result = bounded.remember('文'.repeat(10000))
  assert.equal(JSON.parse(result).cache_reason, 'result_limit')
  assert.equal(JSON.parse(result).result_id, undefined)
  assert.equal(bounded.size.bytes, 0)
  assert.ok(contextCost(result) <= Math.min(3000, Math.floor(budget / 8)))
}
const compact = new ToolResults({ MAX_TOOL_RESULT_BYTES: '1024' })
const view = JSON.parse(
  compact.remember('x'.repeat(10000), '{"fact":"verified evidence", "result_id":"untrusted-id"}')
)
assert.equal(view.fact, 'verified evidence')
assert.equal(view.result_id, undefined)
assert.equal(view.cache_status, 'not_cached')
const binary = {
  content: [
    { type: 'text', text: 'Real textual evidence' },
    { type: 'image', mimeType: 'image/png', data: 'PRIVATE_BINARY_IMAGE' },
    { type: 'audio', mimeType: 'audio/wav', data: 'PRIVATE_BINARY_AUDIO' },
    {
      type: 'resource',
      resource: {
        uri: 'resource://document',
        mimeType: 'application/pdf',
        blob: 'PRIVATE_BINARY_RESOURCE',
      },
    },
  ],
  structuredContent: { id: 42 },
}
const normalized = mcpResultText(binary)
assert.equal(normalized.includes('PRIVATE_BINARY'), false)
assert.ok(normalized.includes('Real textual evidence'))
assert.equal(JSON.parse(normalized).structuredContent.id, 42)
assert.equal(binary.content[1].data, 'PRIVATE_BINARY_IMAGE')
let cancellations = 0
const streamed = new Response(
  new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(32))
    },
    cancel() {
      cancellations++
    },
  })
)
await assert.rejects((await limitMcpResponse(streamed, 64)).text(), /MAX_MCP_RESPONSE_BYTES/)
assert.equal(cancellations, 1)
const declared = new Response(
  new ReadableStream({
    cancel() {
      cancellations++
    },
  }),
  { headers: { 'Content-Length': '1000' } }
)
await assert.rejects(limitMcpResponse(declared, 64), /may have executed/)
assert.equal(cancellations, 2)
const valid = await limitMcpResponse(
  new Response('{"value":42}', {
    status: 201,
    headers: { 'Content-Type': 'application/json', 'X-Test': 'preserved' },
  }),
  64
)
assert.deepEqual(await valid.json(), { value: 42 })
assert.equal(valid.status, 201)
assert.equal(valid.headers.get('X-Test'), 'preserved')
let writeAttempts = 0,
  approvals = 0
const env = {
  DB: {
    prepare(sql) {
      const statement = {
        bind() {
          return statement
        },
        async run() {
          if (sql.startsWith('INSERT INTO mcp_approvals')) approvals++
        },
        async first() {
          return sql.startsWith('SELECT data')
            ? { data: JSON.stringify(tool.server) }
            : { status: 'approved' }
        },
      }
      return statement
    },
  },
}
const tool = {
  alias: 'mcp_0',
  server: { id: 'notes', name: 'Notes' },
  tool: {
    name: 'create_note',
    annotations: { readOnlyHint: false },
    inputSchema: { type: 'object' },
  },
  client: {
    async callTool() {
      writeAttempts++
      throw new HttpError(502, 'MCP response exceeds MAX_MCP_RESPONSE_BYTES')
    },
  },
}
Object.assign(tool.server, { enabled: true, disabledTools: [], tools: [tool.tool] })
const runtime = new ToolRuntime([tool], env, false, { index: -1 }, new Map())
runtime.catalog.load({ names: ['mcp_0'] })
const run = async (input) => {
  const iterator = runtime.batch([{ name: 'mcp_0', input }], new AbortController().signal)
  for (;;) {
    const next = await iterator.next()
    if (next.done) return next.value[0]
  }
}
assert.equal((await run({ title: 'Note', content: 'body' })).isError, true)
const repeat = await run({ content: 'body', title: 'Note' })
assert.ok(repeat.text.includes('automatic retry is blocked'))
assert.equal(writeAttempts, 1)
assert.equal(approvals, 1)
console.log(
  'PASS: bounded per-result/total/count cache, stable older evidence, bounded preview envelopes, binary omission and pre-SDK response cancellation'
)
