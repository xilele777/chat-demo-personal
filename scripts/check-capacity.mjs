import assert from 'node:assert/strict'
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { exportSnapshot, importSnapshot } from '../src/services/chat/history/snapshot.ts'
import { readArchive } from '../src/services/chat/history/zipReader.ts'
import { chromium, expect } from '@playwright/test'
import { createRequire } from 'node:module'

const origin = process.env.UI_ORIGIN
if (!origin || !['127.0.0.1', 'localhost'].includes(new URL(origin).hostname))
  throw new Error('Use the isolated cloud runner')
const login = await fetch(`${origin}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'local-smoke-password-only' }),
})
assert.equal(login.status, 200)
const cookie = login.headers.get('set-cookie').split(';')[0]
const call = async (path, method = 'GET', body) => {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const value = await response.json()
  return { response, value }
}
const ok = async (...args) => {
  const r = await call(...args)
  assert.ok(r.response.ok, JSON.stringify(r.value))
  return r.value
}
const targets = await (await fetch(`http://127.0.0.1:${process.env.UI_INSPECTOR_PORT}/json`)).json()
const inspectorUrl = new URL(targets[0].webSocketDebuggerUrl)
inspectorUrl.hostname = '127.0.0.1'
inspectorUrl.port = process.env.UI_INSPECTOR_PORT
const require = createRequire(import.meta.url)
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'))
const WebSocket = wranglerRequire('ws')
const ws = new WebSocket(inspectorUrl.href, {
  origin: `http://127.0.0.1:${process.env.UI_INSPECTOR_PORT}`,
})
await new Promise((resolve, reject) => {
  ws.once('open', resolve)
  ws.once('error', reject)
})
let nextId = 0
const pending = new Map()
const failPending = (error) => {
  for (const entry of pending.values()) entry.reject(error)
  pending.clear()
}
ws.once('close', () => failPending(new Error('Worker inspector closed during capacity sampling')))
ws.once('error', failPending)
ws.addEventListener('message', ({ data }) => {
  const r = JSON.parse(data)
  if (pending.has(r.id)) {
    const p = pending.get(r.id)
    pending.delete(r.id)
    r.error ? p.reject(new Error(r.error.message)) : p.resolve(r.result)
  }
})
const cdp = (method) =>
  new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Worker inspector timed out: ${method}`))
    }, 10_000)
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    ws.send(JSON.stringify({ id, method }))
  })
await cdp('Runtime.enable')
const baseline = await cdp('Runtime.getHeapUsage')
const measurements = []
let running = true,
  phase = 'baseline',
  samplingError
const sampler = (async () => {
  while (running) {
    measurements.push({ phase, ...(await cdp('Runtime.getHeapUsage')) })
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
})().catch((error) => {
  samplingError = error
  running = false
})
const original = await ok('/sessions')
const oldSessions = []
for (const entry of original.sessions) oldSessions.push((await ok(`/sessions/${entry.id}`)).session)
const make = (id, bytes = 100) => ({
  id,
  title: 'capacity-needle',
  createdAt: 1,
  updatedAt: 2,
  rootMessageId: 'q',
  messages: [
    {
      id: 'q',
      role: 'user',
      content: 'capacity-needle',
      files: [],
      createdAt: 1,
      parentId: null,
      selectedChildId: 'a',
    },
    {
      id: 'a',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'x'.repeat(bytes) }],
      status: 'done',
      createdAt: 2,
      parentId: 'q',
    },
  ],
})
const timings = {}
let browserMemory
let totalBytes = 0
try {
  phase = 'failure-recovery'
  const invalid = await ok('/history/imports', 'POST', { revision: original.revision })
  assert.equal(
    (await call(`/history/imports/${invalid.id}`, 'PUT', { session: make('oversize', 1_500_001) }))
      .response.status,
    413
  )
  assert.equal((await ok('/sessions')).generation, original.generation)
  await ok(`/history/imports/${invalid.id}`, 'PUT', { session: make('partial') })
  assert.equal(
    (await call(`/history/imports/${invalid.id}/commit`, 'POST', { count: 2 })).response.status,
    409
  )
  assert.equal((await ok('/sessions')).generation, original.generation)
  await ok(`/history/imports/${invalid.id}`, 'DELETE')
  phase = 'staged-import'
  const started = performance.now()
  const stage = await ok('/history/imports', 'POST', { revision: original.revision })
  for (let i = 0; i < 268; i++) {
    const session = make(`capacity-${String(i).padStart(4, '0')}`, i < 48 ? 1_350_000 : 100)
    totalBytes += new TextEncoder().encode(JSON.stringify(session)).length
    await ok(`/history/imports/${stage.id}`, 'PUT', { session })
  }
  const branched = make('capacity-branches')
  branched.messages.push(
    ...Array.from({ length: 4000 }, (_, i) => ({
      id: `branch-${i}`,
      role: 'assistant',
      blocks: [{ type: 'text', text: 'branch evidence' }],
      status: 'done',
      parentId: 'q',
    }))
  )
  await ok(`/history/imports/${stage.id}`, 'PUT', { session: branched })
  phase = 'atomic-commit'
  await ok(`/history/imports/${stage.id}/commit`, 'POST', { count: 269 })
  timings.importMs = Math.round(performance.now() - started)
  phase = 'paged-index'
  const page1 = await ok('/sessions?limit=200&offset=0'),
    page2 = await ok('/sessions?limit=200&offset=200')
  assert.equal(page1.sessions.length, 200)
  assert.equal(page2.sessions.length, 69)
  assert.equal(new Set([...page1.sessions, ...page2.sessions].map((s) => s.id)).size, 269)
  assert.equal(page1.revision, page2.revision)
  phase = 'four-concurrent-searches'
  const searchStart = performance.now()
  for (const result of await Promise.all(
    Array.from({ length: 4 }, () => ok('/history/search?q=capacity-needle'))
  )) {
    assert.ok(result.scannedBytes <= 8 * 1024 * 1024)
    assert.ok(result.results.length > 0)
    assert.equal(result.limited, true)
  }
  timings.searchMs = Math.round(performance.now() - searchStart)
  phase = '64-MiB-upload'
  const attachmentId = `capacity-file-${Date.now()}`
  const response = await fetch(`${origin}/api/files/${attachmentId}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
    body: new Blob([new Uint8Array(64 * 1024 * 1024)]),
  })
  assert.equal(response.status, 200)
  assert.equal(
    (
      await fetch(`${origin}/api/files/${attachmentId}`, {
        method: 'HEAD',
        headers: { Cookie: cookie },
      })
    ).headers.get('content-length'),
    String(64 * 1024 * 1024)
  )
  phase = 'four-concurrent-tool-results'
  await ok('/mcp/servers/capacity-tools', 'PUT', {
    name: 'Capacity',
    url: `http://127.0.0.1:${process.env.UI_MODEL_PORT}/mcp`,
    token: 'smoke-mcp',
    enabled: true,
    disabledTools: [],
    trustedReadTools: ['read_note'],
  })
  const stream = await fetch(`${origin}/api/anthropic/v1/messages`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system: 'test',
      model: 'test-model',
      messages: [{ role: 'user', content: 'capacity-mcp' }],
    }),
  })
  const events = await stream.text()
  assert.match(events, /message_stop/)
  assert.equal((events.match(/"status":"done"/g) ?? []).length, 4)
  await ok('/mcp/servers/capacity-tools', 'DELETE')
  phase = 'backup'
  const sessions = Array.from({ length: 48 }, (_, i) => make(`backup-capacity-${i}`, 1_350_000))
  sessions[0].messages[0].files = [
    {
      id: attachmentId,
      name: 'capacity.bin',
      mimeType: 'application/octet-stream',
      isImage: false,
      size: 64 * 1024 * 1024,
      serverId: null,
    },
  ]
  const archive = await exportSnapshot(
    sessions,
    async () => new Blob([new Uint8Array(64 * 1024 * 1024)])
  )
  let imported = 0,
    files = 0
  await importSnapshot(new File([archive], 'capacity.zip'), {
    async addStagingSession() {
      imported++
    },
    async saveStagingFiles(list) {
      files += list.length
    },
  })
  assert.equal(imported, 48)
  assert.equal(files, 1)
  timings.backupBytes = archive.size
  phase = 'browser-backup-import'
  const archiveDirectory = await mkdtemp(path.join(tmpdir(), 'chat-capacity-archive-'))
  const archivePath = path.join(archiveDirectory, 'large-capacity.zip')
  await writeFile(archivePath, new Uint8Array(await archive.arrayBuffer()))
  const browser = await chromium.launch({
    channel:
      process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined),
    headless: true,
  })
  try {
    const context = await browser.newContext({ locale: 'zh-CN' })
    const page = await context.newPage()
    await page.goto(origin)
    await page.getByLabel('访问密码', { exact: true }).fill('local-smoke-password-only')
    await page.getByRole('button', { name: '进入个人空间', exact: true }).click()
    await expect(page.getByPlaceholder('请输入消息')).toBeVisible()
    const session = await context.newCDPSession(page)
    const browserBaseline = await session.send('Runtime.getHeapUsage')
    let sampling = true
    const samples = []
    const memory = (async () => {
      while (sampling) {
        samples.push(await session.send('Runtime.getHeapUsage'))
        await new Promise((r) => setTimeout(r, 100))
      }
    })()
    try {
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await page.getByRole('button', { name: '数据管理', exact: true }).click()
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await settings.locator('input[accept*=".zip"]').setInputFiles(archivePath)
      await page
        .getByRole('dialog', { name: '确认导入历史对话？', exact: true })
        .getByRole('button', { name: '确认导入', exact: true })
        .click()
      await expect(settings).toContainText(/已导入 48 个?对话/, { timeout: 120_000 })
      assert.equal((await ok('/sessions')).sessions.length, 48)
    } finally {
      sampling = false
      await memory
      browserMemory = {
        baseline: browserBaseline,
        sampledPeakUsedHeapBytes: Math.max(...samples.map((m) => m.usedSize)),
        sampledPeakExternalBytes: Math.max(...samples.map((m) => m.backingStorageSize ?? 0)),
        samples: samples.length,
      }
    }
  } finally {
    await browser.close()
    if (path.resolve(archiveDirectory).startsWith(path.join(tmpdir(), 'chat-capacity-archive-'))) {
      await rm(archiveDirectory, { recursive: true, force: true })
    }
  }
  // Truncation is rejected without a caller committing its staged data.
  await assert.rejects(async () => {
    for await (const entry of readArchive(
      new File([archive.slice(0, archive.size - 30)], 'broken.zip')
    )) {
      for await (const _ of entry.stream) {
      }
    }
  })
} finally {
  phase = 'restore-old-history'
  const current = await ok('/sessions')
  await ok('/history', 'PUT', { revision: current.revision, sessions: oldSessions })
  running = false
  await sampler
  ws.close()
}
if (samplingError) throw samplingError
const peaks = Object.fromEntries(
  [...new Set(measurements.map((m) => m.phase))].map((name) => {
    const list = measurements.filter((m) => m.phase === name)
    return [
      name,
      {
        sampledPeakUsedHeapBytes: Math.max(...list.map((m) => m.usedSize)),
        sampledPeakTotalHeapBytes: Math.max(...list.map((m) => m.totalSize)),
        sampledPeakExternalBytes: Math.max(...list.map((m) => m.backingStorageSize ?? 0)),
        samples: list.length,
      },
    ]
  })
)
const report = {
  date: '2026-11-25',
  runtime:
    'local workerd V8 via Runtime.getHeapUsage, 50 ms sampling; not production or total process RSS',
  baseline,
  sessions: 269,
  largeSessions: 48,
  historyBytes: totalBytes,
  answerBranches: 4001,
  attachmentBytes: 64 * 1024 * 1024,
  concurrentSearches: 4,
  concurrentToolResults: 4,
  resultBytesEach: 1800 * 1024,
  timings,
  browserMemory,
  peaks,
  recovery:
    'oversized/incomplete staging preserved old history; cancelled staging retried; backup roundtrip and corrupt ZIP rejected; original cloud history restored',
}
await mkdir('reports', { recursive: true })
await writeFile('reports/capacity-baseline.json', JSON.stringify(report, null, 2) + '\n')
console.log(
  `PASS: real local Worker heap profiling, ${totalBytes} history bytes, paged index, bounded search, 64 MiB R2 upload, 4 tool results and ${timings.backupBytes} byte backup; report reports/capacity-baseline.json`
)
