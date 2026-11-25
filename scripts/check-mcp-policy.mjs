import assert from 'node:assert/strict'
import { runMcpTool, mcpRoutes } from '../worker/mcp.ts'
import { trustedRead, verifyMcpDispatch } from '../worker/mcpPolicy.ts'
import { ToolRuntime } from '../worker/toolRuntime.ts'

const tool = {
  name: 'read_note',
  inputSchema: { type: 'object' },
  annotations: { readOnlyHint: true },
}
const server = {
  id: 'notes',
  name: 'Notes',
  url: 'https://mock.example/mcp',
  token: '',
  authType: 'bearer',
  enabled: true,
  disabledTools: [],
  tools: [tool],
  trustedReadTools: [],
  configurationRevision: 'initial',
}
let current = structuredClone(server),
  approvals = 0,
  calls = 0,
  active = 0,
  peak = 0,
  auth = { tokens: '{}' },
  fail = false
const env = {
  DB: {
    prepare(sql) {
      let args
      return {
        bind(...values) {
          args = values
          return this
        },
        async first() {
          if (fail) throw new Error('DB unavailable')
          if (sql.startsWith('SELECT data'))
            return current ? { data: JSON.stringify(current) } : null
          if (sql.startsWith('SELECT tokens')) return auth
          return { status: 'approved' }
        },
        async all() {
          return { results: current ? [{ data: JSON.stringify(current) }] : [] }
        },
        async run() {
          if (sql.startsWith('INSERT INTO mcp_approvals')) approvals++
          if (sql.startsWith('INSERT INTO mcp_servers')) {
            const previous = current ? JSON.stringify(current) : null
            if (previous !== args[2]) return { results: [] }
            current = JSON.parse(args[1])
            return { results: [{ id: current.id }] }
          }
          return { results: [] }
        },
      }
    },
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()))
    },
  },
}
const entry = {
  alias: 'mcp_0',
  server: structuredClone(current),
  tool,
  client: {
    async callTool() {
      calls++
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 15))
      active--
      return { content: [{ type: 'text', text: 'source note-42' }] }
    },
  },
}
const collect = async (iterator, onEvent = () => {}) => {
  const events = []
  for (;;) {
    const next = await iterator.next()
    if (next.done) return { events, result: next.value }
    events.push(next.value)
    await onEvent(next.value)
  }
}
const run = (onEvent) => collect(runMcpTool(entry, {}, env, new AbortController().signal), onEvent)
assert.equal(trustedRead(entry), false)
await run()
assert.equal(approvals, 1)
assert.equal(calls, 1)
current.trustedReadTools = ['read_note']
entry.server = structuredClone(current)
assert.equal(trustedRead(entry), true)
await run()
assert.equal(approvals, 1)
assert.equal(calls, 2)
const parallel = async (trusted) => {
  current.trustedReadTools = trusted ? ['read_note'] : []
  entry.server = structuredClone(current)
  peak = 0
  const runtime = new ToolRuntime([entry], env, false, { index: -1 }, new Map())
  runtime.catalog.load({ names: ['mcp_0'] })
  await collect(
    runtime.batch(
      [
        { name: 'mcp_0', input: { id: 1 } },
        { name: 'mcp_0', input: { id: 2 } },
      ],
      new AbortController().signal
    )
  )
  assert.equal(peak, trusted ? 2 : 1)
}
await parallel(false)
await parallel(true)
for (const mutate of [
  () => {
    current.enabled = false
  },
  () => {
    current.disabledTools = ['read_note']
  },
  () => {
    current = null
  },
  () => {
    current.token = 'new-token'
  },
  () => {
    current.url = 'https://another.example/mcp'
  },
  () => {
    current.trustedReadTools = ['another_read']
  },
  () => {
    current.configurationRevision = 'next'
  },
  () => {
    current.tools[0].inputSchema = { type: 'object', required: ['new'] }
  },
]) {
  current = structuredClone(server)
  entry.server = structuredClone(current)
  const before = calls
  const stopped = await run((event) => {
    if (event.block?.status === 'approval') mutate()
  })
  assert.equal(calls, before)
  assert.equal(stopped.events.at(-1).block.status, 'error')
  assert.match(stopped.result.text, /configuration changed|permission was revoked/)
}
current = { ...structuredClone(server), trustedReadTools: ['read_note'] }
entry.server = structuredClone(current)
const beforeAutoRevoke = calls
await run((event) => {
  if (event.block?.status === 'running') current.trustedReadTools = []
})
assert.equal(calls, beforeAutoRevoke)
current = { ...structuredClone(server), authType: 'oauth' }
entry.server = structuredClone(current)
auth = { tokens: null }
await assert.rejects(verifyMcpDispatch(entry, env), /authorization was revoked/)
fail = true
assert.equal((await run()).result.isError, true)
fail = false
current = structuredClone(server)
entry.server = structuredClone(current)
const request = new Request('https://app.example/api/mcp/servers/notes', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    ...server,
    token: undefined,
    disabledTools: ['read_note'],
    trustedReadTools: [],
  }),
})
const previousFetch = globalThis.fetch
globalThis.fetch = () => {
  throw new Error('Revocation must not discover remote tools')
}
try {
  assert.equal((await mcpRoutes(request, env, '/api/mcp/servers/notes')).status, 200)
  assert.deepEqual(current.disabledTools, ['read_note'])
  assert.notEqual(current.configurationRevision, server.configurationRevision)
} finally {
  globalThis.fetch = previousFetch
}
console.log(
  'PASS: owner-only automatic reads, matching concurrency, live approval/config/auth/schema revocation, fail-closed storage and permission edits without remote discovery'
)
