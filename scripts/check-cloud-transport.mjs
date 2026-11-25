import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'

globalThis.__CLOUD_MODE__ = true
const { cloudFetch, CloudError } = await import('../src/services/cloud.ts')
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json')
  if (request.url.endsWith('/normal')) return response.end('{"ok":true}')
  if (request.url.endsWith('/large-error')) {
    response.statusCode = 503
    return response.end('x'.repeat(2 * 1024 * 1024))
  }
  response.write('{"ok":') // Headers arrive, then the body never completes.
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
const priorFetch = globalThis.fetch,
  priorTimeout = AbortSignal.timeout
globalThis.fetch = (path, init) => priorFetch(new URL(path, origin), init)
try {
  assert.deepEqual(await (await cloudFetch('/normal')).json(), { ok: true })
  const controller = new AbortController()
  const response = await cloudFetch('/hang', { signal: controller.signal })
  controller.abort()
  await assert.rejects(response.json(), (e) => e.name === 'AbortError')
  AbortSignal.timeout = (ms) => priorTimeout(ms === 60_000 ? 80 : ms)
  await assert.rejects(
    (await cloudFetch('/hang')).json(),
    (e) => e.name === 'AbortError' || e.name === 'TimeoutError'
  )
  await assert.rejects(
    cloudFetch('/large-error'),
    (e) => e instanceof CloudError && e.status === 503
  )
  console.log(
    'PASS: real HTTP response-body cancellation, body deadline, normal JSON and bounded non-JSON errors'
  )
} finally {
  globalThis.fetch = priorFetch
  AbortSignal.timeout = priorTimeout
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
