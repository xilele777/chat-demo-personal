import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { anthropicReply } from '../worker/upstream.ts'

let toolCalls = 0
let modelRequests = []
let readonly = true
let decision = 'approved'
const tools = [
  {
    name: 'read_note',
    description: 'Read a note',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    annotations: { readOnlyHint: true },
  },
]
const mock = createServer(async (request, response) => {
  if (request.method === 'GET') {
    response.writeHead(405).end()
    return
  }
  let raw = ''
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw)
  if (request.url === '/mcp') {
    assert.equal(request.headers.authorization, 'Bearer mcp-key')
    if (body.id === undefined) {
      response.writeHead(202).end()
      return
    }
    const result =
      body.method === 'initialize'
        ? {
            protocolVersion: body.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'mock', version: '1' },
          }
        : body.method === 'tools/list'
          ? { tools: tools.map((tool) => ({ ...tool, annotations: { readOnlyHint: readonly } })) }
          : (() => {
              toolCalls++
              return { content: [{ type: 'text', text: 'native MCP result' }] }
            })()
    response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
    return
  }
  assert.equal(request.url, '/v1/messages')
  assert.equal(request.headers['x-api-key'], 'model-key')
  modelRequests.push(body)
  const result = body.messages.at(-1).content
  const afterTool = Array.isArray(result) && result.some((block) => block.type === 'tool_result')
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const event = (value) =>
    response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
  event({
    type: 'message_start',
    message: {
      id: 'native',
      model: body.model,
      usage: afterTool
        ? { input_tokens: 20, output_tokens: 0 }
        : {
            input_tokens: 12,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 2,
            output_tokens: 0,
          },
    },
  })
  if (!afterTool) {
    event({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    })
    event({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Exposed thinking.' },
    })
    event({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'signed-thinking' },
    })
    event({ type: 'content_block_stop', index: 0 })
    event({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'native-call', name: body.tools[0].name, input: {} },
    })
    event({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"query":' },
    })
    event({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '"note"}' },
    })
    event({ type: 'content_block_stop', index: 1 })
    event({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 5 },
    })
  } else {
    event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    event({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Final native answer.' },
    })
    event({ type: 'content_block_stop', index: 0 })
    event({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 9 },
    })
  }
  event({ type: 'message_stop' })
  response.end()
})
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${mock.address().port}`
const server = {
  id: 'test',
  name: 'Native MCP',
  url: `${base}/mcp`,
  token: 'mcp-key',
  enabled: true,
  disabledTools: [],
  tools,
}
const approvals = new Map()
const env = {
  DEV_AUTH: 'true',
  UPSTREAM_PROTOCOL: 'anthropic',
  UPSTREAM_BASE_URL: `${base}/v1`,
  UPSTREAM_MODEL: 'native-model',
  UPSTREAM_API_KEY: 'model-key',
  DB: {
    prepare(sql) {
      let args = []
      const statement = {
        bind(...values) {
          args = values
          return statement
        },
        async all() {
          return {
            results: sql.startsWith('SELECT data') ? [{ data: JSON.stringify(server) }] : [],
          }
        },
        async first() {
          return { status: approvals.get(args[0]) }
        },
        async run() {
          if (sql.startsWith('INSERT INTO mcp_approvals')) approvals.set(args[0], 'pending')
          if (sql.startsWith('DELETE FROM mcp_approvals WHERE id')) approvals.delete(args[0])
          return {}
        },
      }
      return statement
    },
  },
}
const run = async () => {
  modelRequests = []
  const events = []
  for await (const event of anthropicReply(
    { system: 'test', messages: [{ role: 'user', content: 'use a note' }] },
    env,
    new AbortController().signal
  )) {
    events.push(event)
    if (event.type === 'mcp_tool_status' && event.block.status === 'approval')
      approvals.set(event.block.approvalId, decision)
  }
  assert.equal(events.filter((event) => event.type === 'message_start').length, 1)
  assert.equal(events.filter((event) => event.type === 'message_stop').length, 1)
  assert.ok(
    events.some(
      (event) => event.type === 'content_block_delta' && event.delta.type === 'thinking_delta'
    )
  )
  assert.deepEqual(events.find((event) => event.type === 'message_delta').usage, {
    input_tokens: 32,
    cache_read_input_tokens: 4,
    cache_creation_input_tokens: 2,
    output_tokens: 14,
  })
  assert.equal(modelRequests[1].messages.at(-2).content[0].signature, 'signed-thinking')
  assert.equal(modelRequests[1].messages.at(-1).content[0].type, 'tool_result')
  assert.equal(approvals.size, 0)
  return events
}
try {
  await run()
  assert.equal(toolCalls, 1)
  readonly = false
  await run()
  assert.equal(toolCalls, 2)
  decision = 'denied'
  const denied = await run()
  assert.equal(toolCalls, 2)
  assert.ok(
    denied.some((event) => event.type === 'mcp_tool_status' && event.block.status === 'denied')
  )
  console.log(
    'PASS: native Anthropic thinking/signatures, fragmented tool arguments, MCP calls, approval/denial, and multi-request token totals'
  )
} finally {
  await new Promise((resolve) => mock.close(resolve))
}
