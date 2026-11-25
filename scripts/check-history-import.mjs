import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { historyImport } from '../worker/historyImport.ts'
import { mcpRoutes } from '../worker/mcp.ts'

const require = createRequire(import.meta.url)
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'))
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare')
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-11-01',
    d1Databases: { DB: 'final-import-review' },
  })
)
try {
  const { DB } = await mf.getBindings()
  for (const file of [
    '0001_cloud.sql',
    '0003_mcp.sql',
    '0004_mcp_oauth.sql',
    '0006_history_import.sql',
    '0007_object_lifecycle.sql',
  ]) {
    await DB.exec(
      (await readFile(`migrations/${file}`, 'utf8'))
        .replaceAll(/--[^\n]*/g, '')
        .replaceAll('\n', ' ')
    )
  }
  const env = { DB }
  const request = (path, method, body) =>
    new Request(`https://app.example${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const call = (path, method, body) => historyImport(request(path, method, body), env, path)
  const state = () => DB.prepare('SELECT * FROM cloud_state').first()
  const start = async () =>
    (
      await (
        await call('/api/history/imports', 'POST', { revision: (await state()).revision })
      ).json()
    ).id
  const session = (id, file) => ({
    id,
    title: id,
    createdAt: 1,
    updatedAt: 2,
    rootMessageId: 'q',
    messages: [
      {
        id: 'q',
        role: 'user',
        content: 'import',
        files: [
          { id: file, name: file, mimeType: 'text/plain', size: 1, isImage: false, serverId: null },
        ],
        parentId: null,
      },
    ],
  })
  const id = await start(),
    path = `/api/history/imports/${id}`
  const original = await state()
  const s = session('imported', 'original')
  await call(path, 'PUT', { session: s })
  await call(path, 'PUT', { session: s })
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM history_import_sessions').first()).n, 1)
  await assert.rejects(
    call(path, 'PUT', { session: session('imported', 'other') }),
    (e) => e.status === 413
  )
  const pins = (await DB.prepare('SELECT keys FROM object_pins').all()).results.flatMap((p) =>
    JSON.parse(p.keys)
  )
  assert.ok(pins.includes('attachments/original'))
  assert.ok(pins.includes('attachments/other'))
  await assert.rejects(call(`${path}/commit`, 'POST', { count: 2 }), (e) => e.status === 409)
  assert.deepEqual(await state(), original)
  await DB.prepare('INSERT INTO object_gc_claims VALUES (?)').bind('attachments/original').run()
  await assert.rejects(call(`${path}/commit`, 'POST', { count: 1 }), /cleanup in progress/)
  assert.deepEqual(await state(), original)
  await DB.prepare('DELETE FROM object_gc_claims').run()
  assert.equal((await (await call(`${path}/commit`, 'POST', { count: 1 })).json()).generation, id)
  assert.ok((await DB.prepare('SELECT COUNT(*) AS n FROM object_pins').first()).n > 0)
  await call(`${path}/pins`, 'DELETE')
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM object_pins').first()).n, 0)
  const committed = await state()
  await assert.rejects(call(`${path}/commit`, 'POST', { count: 1 }), (e) => e.status === 409)
  assert.deepEqual(await state(), committed)
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM sessions').first()).n, 1)
  const stale = await start()
  await call(`/api/history/imports/${stale}`, 'PUT', { session: session('stale', 'recover') })
  await DB.prepare('UPDATE cloud_state SET revision = ?').bind('concurrent-edit').run()
  await assert.rejects(
    call(`/api/history/imports/${stale}/commit`, 'POST', { count: 1 }),
    (e) => e.status === 409
  )
  await call(`/api/history/imports/${stale}`, 'DELETE')
  assert.ok(
    (await DB.prepare('SELECT keys FROM object_pins').all()).results.some((p) =>
      p.keys.includes('recover')
    )
  )

  // Production save SQL must not resurrect a deleted connection after slow discovery.
  const server = {
    id: 'notes',
    name: 'Notes',
    url: 'https://mock.example/mcp',
    enabled: true,
    authType: 'bearer',
    token: '',
    disabledTools: [],
    trustedReadTools: [],
    tools: [{ name: 'read', inputSchema: { type: 'object' } }],
    configurationRevision: 'old',
  }
  await DB.prepare('INSERT INTO mcp_servers VALUES (?, ?)')
    .bind(server.id, JSON.stringify(server))
    .run()
  await assert.rejects(
    mcpRoutes(
      request('/api/mcp/servers/notes', 'PUT', { ...server, configurationRevision: 'stale' }),
      env,
      '/api/mcp/servers/notes'
    ),
    (e) => e.status === 409
  )
  const prior = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const rpc = JSON.parse(init.body)
    if (rpc.id === undefined) return new Response(null, { status: 202 })
    if (rpc.method === 'tools/list') {
      await DB.prepare('DELETE FROM mcp_servers WHERE id = ?').bind(server.id).run()
    }
    return Response.json({
      jsonrpc: '2.0',
      id: rpc.id,
      result:
        rpc.method === 'initialize'
          ? {
              protocolVersion: rpc.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'test', version: '1' },
            }
          : { tools: server.tools },
    })
  }
  try {
    const route = '/api/mcp/servers/notes'
    await assert.rejects(
      mcpRoutes(request(route, 'PUT', { ...server, refreshTools: true }), env, route),
      (e) => e.status === 409
    )
    assert.equal(await DB.prepare('SELECT * FROM mcp_servers').first(), null)
  } finally {
    globalThis.fetch = prior
  }
  console.log(
    'PASS: real D1 staged retries, immutable references, rollback fencing, commit receipt/replay, failed-import pins and concurrent MCP deletion'
  )
} finally {
  await mf.dispose()
}
