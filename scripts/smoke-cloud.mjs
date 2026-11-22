// A small integration check against real local D1/R2 and a deterministic model endpoint.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js')
const prefix = path.join(tmpdir(), 'personal-chat-smoke-')
const persist = await mkdtemp(prefix)
const port = Number(process.env.SMOKE_WORKER_PORT ?? 8788)
const mockPort = Number(process.env.SMOKE_MODEL_PORT ?? 9899)
const origin = `http://127.0.0.1:${port}`
const password = 'local-smoke-password-only'
let cookie = ''
let sentToProvider
let worker
let logs = ''
const mock = createServer(async (req, res) => {
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404).end()
    return
  }
  let body = ''
  for await (const chunk of req) body += chunk
  sentToProvider = JSON.parse(body)
  assert.equal(req.headers.authorization, 'Bearer smoke-test')
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const delta of [
    { reasoning_content: '先检查内容。' },
    { content: '你好，' },
    { content: '云端同步正常。' },
  ]) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`)
  }
  res.end(
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
  )
})
const call = (route, method = 'GET', body) =>
  fetch(`${origin}/api${route}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
  })
const session = (id, content = '第一版') => ({
  id,
  title: '同步检查',
  createdAt: 1,
  updatedAt: 2,
  rootMessageId: 'question',
  messages: [
    {
      id: 'question',
      role: 'user',
      content: '你好',
      files: [],
      createdAt: 1,
      parentId: null,
      selectedChildId: 'reply',
    },
    {
      id: 'reply',
      role: 'assistant',
      createdAt: 2,
      parentId: 'question',
      status: 'done',
      model: 'test-model',
      prefix: true,
      blocks: [{ type: 'text', text: content }],
    },
  ],
})
try {
  await new Promise((resolve, reject) => {
    mock.once('error', reject)
    mock.listen(mockPort, '127.0.0.1', resolve)
  })
  const migration = spawnSync(
    process.execPath,
    [wrangler, 'd1', 'migrations', 'apply', 'personal-chat', '--local', '--persist-to', persist],
    { cwd: root, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } }
  )
  assert.equal(migration.status, 0, migration.stdout + migration.stderr)
  worker = spawn(
    process.execPath,
    [
      wrangler,
      'dev',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--persist-to',
      persist,
      '--var',
      'DEV_AUTH:true',
      '--var',
      `APP_PASSWORD:${password}`,
      '--var',
      'UPSTREAM_API_KEY:smoke-test',
      '--var',
      'UPSTREAM_MODEL:test-model',
      '--var',
      `UPSTREAM_BASE_URL:http://127.0.0.1:${mockPort}/v1`,
    ],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    }
  )
  worker.stdout.on('data', (value) => {
    logs += value.toString()
  })
  worker.stderr.on('data', (value) => {
    logs += value.toString()
  })
  let ready = false
  for (let i = 0; i < 100; i++) {
    if (worker.exitCode !== null) throw new Error(logs)
    try {
      if ((await call('/auth')).ok) {
        ready = true
        break
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  assert.ok(ready, logs)

  const { authorize } = await import('../worker/auth.ts')
  await assert.rejects(
    authorize(new Request('https://personal.example/api/config'), { DEV_AUTH: 'true' }),
    /APP_PASSWORD/
  )
  assert.equal((await call('/sessions')).status, 401)
  assert.equal((await call('/auth/login', 'POST', { password: 'wrong' })).status, 401)
  const login = await call('/auth/login', 'POST', { password })
  assert.equal(login.status, 200)
  assert.match(login.headers.get('Set-Cookie'), /HttpOnly/)
  cookie = login.headers.get('Set-Cookie').split(';')[0]
  assert.equal((await (await call('/auth')).json()).authenticated, true)
  await authorize(new Request(`${origin}/api/config`, { headers: { Cookie: cookie } }), {
    APP_PASSWORD: password,
  })
  await assert.rejects(
    authorize(new Request(`${origin}/api/config`, { headers: { Cookie: cookie } }), {
      APP_PASSWORD: 'changed-smoke-password',
    }),
    /session expired/
  )
  console.log('PASS: password login, private API, cookie session and password rotation')

  // Two devices share the same version; only the first update may commit.
  const initial = await (await call('/sessions')).json()
  assert.equal(
    (
      await call('/sessions/shared', 'PUT', {
        session: session('shared'),
        revision: null,
        generation: initial.generation,
      })
    ).status,
    200
  )
  const deviceA = await (await call('/sessions/shared')).json()
  const deviceB = await (await call('/sessions/shared')).json()
  assert.equal(
    (
      await call('/sessions/shared', 'PUT', {
        session: session('shared', '设备 A'),
        revision: deviceA.revision,
        generation: initial.generation,
      })
    ).status,
    200
  )
  assert.equal(
    (
      await call('/sessions/shared', 'PUT', {
        session: session('shared', '设备 B'),
        revision: deviceB.revision,
        generation: initial.generation,
      })
    ).status,
    409
  )
  assert.equal(
    (await (await call('/sessions/shared')).json()).session.messages[1].blocks[0].text,
    '设备 A'
  )

  // Replacements are atomic and invalidate stale devices, including deleted IDs.
  const stale = await (await call('/sessions')).json()
  assert.equal(
    (
      await call('/sessions/extra', 'PUT', {
        session: session('extra'),
        revision: null,
        generation: initial.generation,
      })
    ).status,
    200
  )
  assert.equal(
    (await call('/history', 'PUT', { revision: stale.revision, sessions: [] })).status,
    409
  )
  assert.equal((await (await call('/sessions')).json()).sessions.length, 2)
  const latest = await (await call('/sessions')).json()
  assert.equal(
    (
      await call('/history', 'PUT', {
        revision: latest.revision,
        sessions: [session('replacement')],
      })
    ).status,
    200
  )
  assert.equal(
    (
      await call('/sessions/shared', 'PUT', {
        session: session('shared'),
        revision: deviceA.revision,
        generation: initial.generation,
      })
    ).status,
    409
  )
  const replacement = await (await call('/sessions/replacement')).json()
  assert.equal(
    (
      await call('/sessions/replacement', 'DELETE', {
        revision: replacement.revision,
        generation: replacement.generation,
      })
    ).status,
    200
  )
  assert.equal(
    (
      await call('/sessions/replacement', 'PUT', {
        session: session('replacement'),
        revision: null,
        generation: replacement.generation,
      })
    ).status,
    409
  )
  console.log('PASS: multi-device conflicts, atomic replacement and deletion')

  // Originals remain byte-identical across devices; text uploads enter the provider context.
  const original = new Uint8Array([0, 1, 2, 128, 255])
  assert.equal(
    (
      await fetch(`${origin}/api/files/original`, {
        method: 'PUT',
        body: original,
        headers: { 'Content-Type': 'application/octet-stream', Cookie: cookie },
      })
    ).status,
    200
  )
  assert.deepEqual(new Uint8Array(await (await call('/files/original')).arrayBuffer()), original)
  const form = new FormData()
  form.append('file', new File(['附件内容'], 'note.txt', { type: 'text/plain' }))
  const attachment = await (
    await fetch(`${origin}/api/anthropic/v1/files`, {
      method: 'POST',
      body: form,
      headers: { Cookie: cookie },
    })
  ).json()
  const answer = await call('/anthropic/v1/messages', 'POST', {
    system: '测试',
    messages: [
      { role: 'latest_reminder', content: '今天' },
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'file', file_id: attachment.id } },
          { type: 'text', text: '你好' },
        ],
      },
    ],
    tools: [{ type: 'deepseek_read_url' }],
    safety_check: { level: 'high' },
  })
  assert.equal(answer.status, 200, answer.ok ? '' : await answer.text())
  const stream = await answer.text()
  assert.match(stream, /thinking_delta/)
  assert.match(stream, /云端同步正常/)
  assert.match(stream, /message_stop/)
  assert.equal(sentToProvider.model, 'test-model')
  assert.equal(sentToProvider.tools, undefined)
  assert.match(JSON.stringify(sentToProvider.messages), /附件内容/)
  assert.match(sentToProvider.messages[0].content, /今天/)
  console.log('PASS: R2 originals, text attachments and OpenAI streaming adaptation')

  assert.equal(
    (await fetch(`${origin}/api/sessions`, { headers: { Origin: 'https://another-site.example' } }))
      .status,
    403
  )
  const logout = await call('/auth/logout', 'POST')
  assert.match(logout.headers.get('Set-Cookie'), /Max-Age=0/)
  cookie = ''
  assert.equal((await call('/sessions')).status, 401)
  console.log('PASS: same-origin API and logout')
  if (process.argv.includes('--serve')) {
    console.log(`Browser preview ready at ${origin} (temporary local data only).`)
    await new Promise((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
  }
} catch (error) {
  console.error(logs.slice(-6000))
  throw error
} finally {
  worker?.kill()
  await new Promise((resolve) => mock.close(resolve))
  // The path is a directory allocated above under the explicit smoke-test prefix.
  if (path.resolve(persist).startsWith(prefix))
    await rm(persist, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}
