import assert from 'node:assert/strict'
import { connectMcpTools } from '../worker/mcp.ts'
import { ToolRuntime } from '../worker/toolRuntime.ts'

const tool = {
  name: 'read_note',
  inputSchema: { type: 'object' },
  annotations: { readOnlyHint: true },
}
const base = {
  name: 'Notes',
  enabled: true,
  token: '',
  disabledTools: [],
  trustedReadTools: ['read_note'],
  tools: [tool],
  toolsDiscoveredAt: Date.now(),
}
const rows = [
  { ...base, id: 'fast', url: 'https://fast.example/mcp' },
  { ...base, id: 'slow', url: 'https://slow.example/mcp' },
]
const env = {
  DB: {
    prepare(sql) {
      let args
      return {
        bind(...values) {
          args = values
          return this
        },
        async all() {
          if (sql.startsWith('SELECT'))
            return { results: rows.map((s) => ({ data: JSON.stringify(s) })) }
          const i = rows.findIndex((s) => s.id === args[1] && JSON.stringify(s) === args[2])
          if (i >= 0) rows[i] = JSON.parse(args[0])
          return { results: i >= 0 ? [{ id: rows[i].id }] : [] }
        },
        async first() {
          const s = rows.find((s) => s.id === args[0])
          return s ? { data: JSON.stringify(s) } : null
        },
        async run() {
          return this.all()
        },
      }
    },
  },
}
const prior = globalThis.fetch
const rpc = []
let change = false,
  endless = false,
  notifyOn = ''
globalThis.fetch = async (input, init) => {
  const url = String(input),
    body = JSON.parse(init.body)
  rpc.push({ url, method: body.method })
  assert.ok(!url.includes('slow'), 'Unrelated slow service must never connect')
  if (body.id === undefined) return new Response(null, { status: 202 })
  const result =
    body.method === 'initialize'
      ? {
          protocolVersion: body.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'test', version: '1' },
        }
      : {
          tools: endless
            ? []
            : [change ? { ...tool, inputSchema: { type: 'object', required: ['new'] } } : tool],
          ...(endless ? { nextCursor: crypto.randomUUID() } : {}),
        }
  const reply = { jsonrpc: '2.0', id: body.id, result }
  if (body.method === notifyOn) {
    return new Response(
      `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\ndata: ${JSON.stringify(reply)}\n\n`,
      {
        headers: { 'Content-Type': 'text/event-stream' },
      }
    )
  }
  return Response.json(reply)
}
try {
  let catalog = await connectMcpTools(env, new AbortController().signal)
  assert.equal(rpc.length, 0)
  const runtime = new ToolRuntime(catalog.tools, env, false, { index: 0 }, new Map())
  assert.ok(runtime.catalog.instructions.includes('Notes'))
  runtime.catalog.load({ query: 'read' })
  assert.equal(rpc.length, 0)
  await catalog.tools[0].prepare()
  assert.equal(rpc.filter((r) => r.method === 'tools/list').length, 0)
  await catalog.close()
  for (const phase of ['initialize', 'tools/list']) {
    notifyOn = phase
    rows[0].toolsDiscoveredAt = phase === 'tools/list' ? 0 : Date.now()
    rows[0].trustedReadTools = ['read_note']
    catalog = await connectMcpTools(env, new AbortController().signal)
    await assert.rejects(catalog.tools[0].prepare(), /ended|catalog changed|configuration changed/)
    assert.deepEqual(rows[0].trustedReadTools, [])
    await catalog.close()
  }
  notifyOn = ''
  rpc.length = 0
  rows[0].toolsDiscoveredAt = 0
  catalog = await connectMcpTools(env, new AbortController().signal)
  await catalog.tools[0].prepare()
  assert.equal(rpc.filter((r) => r.method === 'tools/list').length, 1)
  assert.ok(rows[0].toolsDiscoveredAt > 0)
  await catalog.close()
  rows[0].disabledTools = ['read_note']
  catalog = await connectMcpTools(env, new AbortController().signal)
  assert.equal(
    catalog.tools.some((e) => e.server.id === 'fast'),
    false
  )
  await catalog.close()
  rows[0].disabledTools = []
  rows[0].toolsDiscoveredAt = 0
  change = true
  catalog = await connectMcpTools(env, new AbortController().signal)
  await assert.rejects(catalog.tools[0].prepare(), /schema or configuration changed/)
  assert.deepEqual(rows[0].trustedReadTools, [])
  await catalog.close()
  change = false
  endless = true
  rows[0].toolsDiscoveredAt = 0
  catalog = await connectMcpTools(env, new AbortController().signal)
  const before = rpc.length
  await assert.rejects(catalog.tools[0].prepare(), /too many tools/)
  assert.ok(rpc.length - before <= 13)
  await catalog.close()
} finally {
  globalThis.fetch = prior
}
console.log(
  'PASS: greeting/catalog zero network, selected connection only, TTL refresh, disabled tools, changed schema/trust revoked and bounded empty pagination'
)
