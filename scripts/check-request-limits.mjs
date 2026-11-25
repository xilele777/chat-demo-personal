import assert from 'node:assert/strict'
import { bodyLimits, MiB, putAttachment, readBody } from '../worker/bodyLimits.ts'
import { readJsonObject } from '../worker/types.ts'
import { storage } from '../worker/storage.ts'
import { upstream } from '../worker/upstream.ts'

const chunk = new Uint8Array(MiB)
const streamRequest = (count, headers = {}, fail = false) => {
  let read = 0,
    cancelled = false
  const request = new Request('http://localhost/api/files/probe', {
    method: 'PUT',
    duplex: 'half',
    headers,
    body: new ReadableStream({
      pull(controller) {
        if (fail && read === count) controller.error(new Error('network interrupted'))
        else if (read++ < count) controller.enqueue(chunk)
        else controller.close()
      },
      cancel() {
        cancelled = true
      },
    }),
  })
  return { request, cancelled: () => cancelled }
}
const bucket = () => {
  const state = { saved: 'old-object', aborted: 0, completed: 0, created: 0, bytes: 0 }
  return {
    state,
    async put(_key, bytes) {
      state.saved = bytes.byteLength
    },
    async createMultipartUpload() {
      state.created++
      const parts = []
      return {
        async uploadPart(partNumber, body) {
          assert.ok(body.byteLength <= 5 * MiB)
          parts.push(body.byteLength)
          state.bytes += body.byteLength
          return { partNumber, etag: `etag-${partNumber}` }
        },
        async complete(receipts) {
          assert.equal(receipts.length, parts.length)
          assert.ok(parts.slice(0, -1).every((size) => size === 5 * MiB))
          state.completed++
          state.saved = parts.reduce((sum, size) => sum + size, 0)
        },
        async abort() {
          state.aborted++
        },
      }
    },
  }
}
for (const headers of [{}, { 'Content-Length': '1' }]) {
  const target = bucket(),
    probe = streamRequest(66, headers)
  await assert.rejects(
    storage(
      probe.request,
      {
        FILES: target,
        DB: {
          prepare() {
            return {
              bind() {
                return this
              },
              async all() {
                return { results: [{ id: 'pin' }] }
              },
              async run() {
                return {}
              },
            }
          },
        },
      },
      '/api/files/probe'
    ),
    (e) => e.status === 413
  )
  assert.equal(target.state.saved, 'old-object')
  assert.equal(target.state.completed, 0)
  assert.equal(target.state.aborted, 1)
  assert.equal(probe.cancelled(), true)
}
const declared = bucket(),
  probe = streamRequest(65, { 'Content-Length': String(65 * MiB) })
await assert.rejects(
  putAttachment(probe.request, declared, 'attachments/probe'),
  (e) => e.status === 413
)
assert.equal(declared.state.created, 0)
assert.equal(probe.cancelled(), true)
const exact = bucket()
await putAttachment(streamRequest(64).request, exact, 'attachments/probe')
assert.equal(exact.state.saved, bodyLimits.attachment)
assert.equal(exact.state.aborted, 0)
const interrupted = bucket()
await assert.rejects(
  putAttachment(streamRequest(6, {}, true).request, interrupted, 'attachments/probe'),
  /interrupted/
)
assert.equal(interrupted.state.saved, 'old-object')
assert.equal(interrupted.state.aborted, 1)
const empty = bucket()
await putAttachment(new Request('http://localhost', { method: 'PUT' }), empty, 'empty')
assert.equal(empty.state.saved, 0)

await assert.rejects(readBody(streamRequest(2).request, MiB), (e) => e.status === 413)
await assert.rejects(
  readJsonObject(new Request('http://localhost', { method: 'POST', body: '{broken' })),
  (e) => e.status === 400
)
await assert.rejects(
  readJsonObject(
    new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ text: 'x'.repeat(100) }),
    }),
    32
  ),
  (e) => e.status === 413
)
assert.deepEqual(
  await readJsonObject(
    new Request('http://localhost', { method: 'POST', body: '{"text":"中文"}' })
  ),
  { text: '中文' }
)
const abort = new AbortController()
const stalled = new Request('http://localhost', {
  method: 'POST',
  duplex: 'half',
  signal: abort.signal,
  body: new ReadableStream(),
})
const reading = readBody(stalled, 32)
setTimeout(() => abort.abort(), 10)
await assert.rejects(reading, (e) => e.name === 'AbortError')

const env = {
  UPSTREAM_PROTOCOL: 'openai',
  UPSTREAM_MODEL: 'model',
  FILES: {
    put() {
      throw new Error('unexpected write')
    },
  },
}
const form = new FormData()
form.set('file', new File([new Uint8Array(8 * MiB + 1)], 'big.png', { type: 'image/png' }))
await assert.rejects(
  upstream(
    new Request('http://localhost/api/anthropic/v1/files', { method: 'POST', body: form }),
    env,
    '/api/anthropic/v1/files'
  ),
  (e) => e.status === 413
)
const duplicate = new FormData()
duplicate.append('file', new File(['a'], 'a.txt'))
duplicate.append('file', new File(['b'], 'b.txt'))
await assert.rejects(
  upstream(
    new Request('http://localhost', { method: 'POST', body: duplicate }),
    env,
    '/api/anthropic/v1/files'
  ),
  (e) => e.status === 400
)
console.log(
  'PASS: actual upload bytes, missing/false lengths, 64 MiB boundary, multipart abort preserves old objects, bounded JSON/multipart and cancellation'
)
