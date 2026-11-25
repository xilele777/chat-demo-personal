import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtemp, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

const freePort = async () => {
  const s = createServer()
  s.listen(0, '127.0.0.1')
  await once(s, 'listening')
  const p = s.address().port
  await new Promise((r) => s.close(r))
  return p
}
const workerPort = await freePort(),
  modelPort = await freePort(),
  inspectorPort = await freePort()
const origin = `http://127.0.0.1:${workerPort}`
const source = spawn(process.execPath, ['--import', 'tsx', 'scripts/smoke-cloud.mjs', '--serve'], {
  env: {
    ...process.env,
    SMOKE_WORKER_PORT: String(workerPort),
    SMOKE_MODEL_PORT: String(modelPort),
    SMOKE_INSPECTOR_PORT: String(inspectorPort),
    SMOKE_KEEP_PERSIST: 'true',
    WRANGLER_SEND_METRICS: 'false',
  },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
})
let logs = '',
  persist,
  restored
source.stdout.on('data', (v) => {
  logs = (logs + v).slice(-8000)
})
source.stderr.on('data', (v) => {
  logs = (logs + v).slice(-8000)
})
const exited = once(source, 'exit')
const backupRoot = await mkdtemp(path.join(tmpdir(), 'chat-disaster-recovery-'))
const backup = path.join(backupRoot, 'offline-copy')
const login = async (base) => {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'local-smoke-password-only' }),
  })
  assert.equal(r.status, 200)
  return r.headers.get('set-cookie').split(';')[0]
}
const read = async (base, cookie, route) => {
  const r = await fetch(`${base}/api${route}`, { headers: { Cookie: cookie } })
  assert.ok(r.ok)
  return r.json()
}
const digest = async (base, cookie, id) => {
  const r = await fetch(`${base}/api/files/${id}`, { headers: { Cookie: cookie } })
  assert.ok(r.ok)
  return createHash('sha256')
    .update(new Uint8Array(await r.arrayBuffer()))
    .digest('hex')
}
try {
  persist = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Local backup source startup timed out: ${logs}`)),
      120_000
    )
    source.on('message', (m) => {
      if (m.type === 'ready') {
        clearTimeout(timer)
        resolve(m.persist)
      }
    })
    source.once('exit', () => {
      clearTimeout(timer)
      reject(new Error(logs))
    })
  })
  assert.ok(path.resolve(persist).startsWith(path.join(tmpdir(), 'personal-chat-smoke-')))
  const cookie = await login(origin)
  const index = await read(origin, cookie, '/sessions')
  const pinsPut = await fetch(`${origin}/api/storage/pins/dr-proof`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 'v1', keys: ['attachments/original'] }),
  })
  assert.ok(pinsPut.ok)
  const pins = await read(origin, cookie, '/storage/pins')
  const hashes = await Promise.all(
    ['original', 'multipart-original'].map((id) => digest(origin, cookie, id))
  )
  source.send({ type: 'shutdown' })
  assert.equal((await exited)[0], 0)
  // Stop the writer before copying the entire D1/R2 persistence directory, including WAL/state.
  await cp(persist, backup, { recursive: true })
  const restoredPort = await freePort(),
    restoredInspector = await freePort(),
    restoredOrigin = `http://127.0.0.1:${restoredPort}`
  restored = spawn(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'dev',
      '--ip',
      '127.0.0.1',
      '--port',
      String(restoredPort),
      '--inspector-port',
      String(restoredInspector),
      '--persist-to',
      backup,
      '--var',
      'DEV_AUTH:true',
      '--var',
      'APP_PASSWORD:local-smoke-password-only',
    ],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    }
  )
  restored.stdout.on('data', (v) => {
    logs = (logs + v).slice(-8000)
  })
  restored.stderr.on('data', (v) => {
    logs = (logs + v).slice(-8000)
  })
  let restoredCookie
  for (let i = 0; i < 100; i++) {
    try {
      restoredCookie = await login(restoredOrigin)
      break
    } catch {
      if (restored.exitCode !== null) throw new Error(logs)
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  assert.ok(restoredCookie, logs)
  assert.deepEqual(await read(restoredOrigin, restoredCookie, '/sessions'), index)
  assert.deepEqual(await read(restoredOrigin, restoredCookie, '/storage/pins'), pins)
  assert.deepEqual(
    await Promise.all(
      ['original', 'multipart-original'].map((id) => digest(restoredOrigin, restoredCookie, id))
    ),
    hashes
  )
  for (const session of index.sessions)
    assert.ok((await read(restoredOrigin, restoredCookie, `/sessions/${session.id}`)).session)
  console.log(
    'PASS: stopped-writer full local D1/R2 backup restored in a fresh Worker; generations/revisions, session bodies, recovery pins and original SHA-256 match; no model call during restore'
  )
} finally {
  if (source.connected) {
    source.send({ type: 'shutdown' })
    await exited
  }
  if (restored) {
    restored.kill()
    if (restored.exitCode === null) await once(restored, 'exit')
  }
  if (persist && path.resolve(persist).startsWith(path.join(tmpdir(), 'personal-chat-smoke-')))
    await rm(persist, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  if (path.resolve(backupRoot).startsWith(path.join(tmpdir(), 'chat-disaster-recovery-')))
    await rm(backupRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}
