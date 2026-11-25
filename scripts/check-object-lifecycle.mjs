import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { pinObjects, unpinObjects, objectLifecycle } from '../worker/objectLifecycle.ts'
import { observe } from '../worker/observability.ts'
const require = createRequire(import.meta.url)
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'))
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare')
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-11-01',
    d1Databases: { DB: 'lifecycle-test' },
  })
)
try {
  const { DB } = await mf.getBindings()
  // Real D1 executes the production schema and cleanup fencing triggers.
  await DB.exec(
    (await readFile('migrations/0001_cloud.sql', 'utf8'))
      .replaceAll(/--[^\n]*/g, '')
      .replaceAll('\n', ' ')
  )
  await DB.exec(
    (await readFile('migrations/0007_object_lifecycle.sql', 'utf8'))
      .replaceAll(/--[^\n]*/g, '')
      .replaceAll('\n', ' ')
  )
  const old = new Date(Date.now() - 40 * 24 * 60 * 60_000)
  const objects = new Map(
    ['shared', 'orphan', 'recovering', 'racing', 'recent'].map((id) => [
      `attachments/${id}`,
      { key: `attachments/${id}`, etag: id, size: 1, uploaded: id === 'recent' ? new Date() : old },
    ])
  )
  let onDelete = async () => {},
    onHead = async () => {}
  const FILES = {
    async head(key) {
      await onHead(key)
      return objects.get(key)
    },
    async delete(key) {
      await onDelete(key)
      objects.delete(key)
    },
    async list() {
      return { objects: [...objects.values()], truncated: false }
    },
  }
  const env = { DB, FILES, OBJECT_GC_TRACKING_SINCE: '2020-01-01' }
  const request = (key) =>
    new Request('https://app.example/api/storage/objects', {
      method: 'DELETE',
      body: JSON.stringify({ key, etag: key.split('/')[1] }),
    })
  const insert = async (id, file) =>
    DB.prepare(
      'INSERT INTO sessions (id, revision, title, created_at, updated_at, data) VALUES (?, ?, ?, 1, 2, ?)'
    )
      .bind(
        id,
        'r',
        'title',
        JSON.stringify({ messages: [{ role: 'user', files: [{ id: file }] }] })
      )
      .run()
  await insert('a', 'shared')
  await insert('b', 'shared')
  await pinObjects(env, 'outbox', 'old', ['attachments/recovering'])
  await pinObjects(env, 'outbox', 'new', ['attachments/recovering'])
  await unpinObjects(env, 'outbox', 'old')
  assert.ok(await DB.prepare('SELECT id FROM object_pins WHERE id = ?').bind('outbox').first())
  const preview = await (
    await objectLifecycle(
      new Request('https://app.example/api/storage/objects'),
      env,
      '/api/storage/objects'
    )
  ).json()
  assert.equal(preview.dryRun, true)
  assert.equal(
    preview.objects.find((o) => o.key.endsWith('/shared')).disposition,
    'referenced_or_pinned'
  )
  for (const id of ['shared', 'recovering', 'recent'])
    await assert.rejects(
      objectLifecycle(request(`attachments/${id}`), env, '/api/storage/objects'),
      (e) => e.status === 409
    )
  await assert.rejects(
    objectLifecycle(
      request('attachments/orphan'),
      { ...env, OBJECT_GC_TRACKING_SINCE: undefined },
      '/api/storage/objects'
    ),
    (e) => e.status === 409
  )
  let heads = 0
  onHead = async (key) => {
    if (key.endsWith('/racing') && ++heads === 2) objects.get(key).etag = 'changed'
  }
  await assert.rejects(
    objectLifecycle(request('attachments/racing'), env, '/api/storage/objects'),
    (e) => e.status === 409
  )
  onHead = async () => {}
  let fenced = false
  onDelete = async (key) => {
    await assert.rejects(pinObjects(env, 'late-outbox', 'v', [key]), (e) => e.status === 409)
    await assert.rejects(insert('late-session', 'orphan'), /cleanup in progress/)
    fenced = true
  }
  assert.equal(
    (await objectLifecycle(request('attachments/orphan'), env, '/api/storage/objects')).status,
    200
  )
  assert.equal(fenced, true)
  assert.equal(objects.has('attachments/orphan'), false)
  assert.equal(
    (await DB.prepare('SELECT COUNT(*) AS count FROM object_gc_claims').first()).count,
    0
  )
  objects.set('attachments/uncertain', {
    key: 'attachments/uncertain',
    etag: 'uncertain',
    size: 1,
    uploaded: old,
  })
  onDelete = async () => {
    throw new Error('R2 delete response lost')
  }
  await assert.rejects(
    objectLifecycle(request('attachments/uncertain'), env, '/api/storage/objects'),
    /response lost/
  )
  await assert.rejects(
    pinObjects(env, 'retry-upload', 'v', ['attachments/uncertain']),
    (e) => e.status === 409
  )
  assert.ok(
    await DB.prepare('SELECT key FROM object_gc_claims WHERE key = ?')
      .bind('attachments/uncertain')
      .first()
  )
  // Data-minimized logs are allowlisted independently of request/body/error text.
  const prior = console.log,
    logs = []
  console.log = (value) => logs.push(value)
  try {
    observe(
      { OBSERVABILITY: 'true', requestId: 'id', UPSTREAM_API_KEY: 'never-log-secret' },
      'model_headers',
      { elapsedMs: 12, status: 504, outcome: 'timeout' }
    )
    observe({ OBSERVABILITY: 'false' }, 'request', { status: 200 })
  } finally {
    console.log = prior
  }
  assert.equal(logs.length, 1)
  assert.equal(logs[0].includes('never-log-secret'), false)
  assert.deepEqual(Object.keys(JSON.parse(logs[0])), [
    'requestId',
    'stage',
    'elapsedMs',
    'status',
    'outcome',
  ])
  console.log(
    'PASS: real D1 shared-reference/recovery pins, retention/legacy protection, changed etag, atomic delete fencing, pin version race and content-free metrics'
  )
} finally {
  await mf.dispose()
}
