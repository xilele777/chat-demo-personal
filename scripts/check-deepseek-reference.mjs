import assert from 'node:assert/strict'
import { readServerSentEvents } from '../src/services/api/sse.ts'
import { readMessageEvent } from '../src/services/api/parseEvent.ts'
import { applyEvent, settleReply } from '../src/services/chat/reply.ts'
import { addUsage, totalTokens } from '../src/services/chat/usage.ts'
import { snapshotSession } from '../src/services/chat/history/snapshot.ts'
import { validSessionStructure } from '../src/services/chat/validation.ts'
import { upstream } from '../worker/upstream.ts'
import { contextCost } from '../worker/context.ts'

globalThis.__API_ORIGIN__ = 'https://api.example'
const { streamMessage, ApiError } = await import('../src/services/api/client.ts')
const originalFetch = globalThis.fetch
const encoder = new TextEncoder()
const frames = (events) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
const start = { type: 'message_start', message: { id: 'a', model: 'provider-version' } }
const content = {
  type: 'content_block_start',
  index: 0,
  content_block: { type: 'text', text: '已收到的中文🙂' },
}
const stop = { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
const done = { type: 'message_stop' }
const headers = { 'Content-Type': 'text/event-stream' }
const makeStream = (bytes, chunkSize = bytes.length) =>
  new ReadableStream({
    start(c) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize)
        c.enqueue(bytes.slice(offset, offset + chunkSize))
      c.close()
    },
  })
const collect = async (generator) => {
  const result = []
  for await (const event of generator) result.push(event)
  return result
}
const initial = {
  id: 'a',
  role: 'assistant',
  model: 'request-alias',
  createdAt: 2,
  status: 'pending',
  prefix: true,
  blocks: [],
}
try {
  // The same Chinese/emoji stream must survive every byte boundary, CRLF and a BOM.
  for (const chunkSize of [1, 2, 7, 8192]) {
    const bytes = encoder.encode(
      '\uFEFF' + frames([start, content, stop, done]).replaceAll('\n', '\r\n')
    )
    globalThis.fetch = async () => new Response(makeStream(bytes, chunkSize), { headers })
    const events = await collect(streamMessage('', { messages: [] }, new AbortController().signal))
    assert.equal(events.at(-1).type, 'message_stop')
    assert.equal(
      events.find((e) => e.type === 'content_block_start').content_block.text,
      content.content_block.text
    )
  }
  for (const [wire, kind] of [
    [frames([start, content]), 'interrupted'],
    [frames([start, content, stop]), 'interrupted'],
    [frames([start, content, done]), 'protocol'],
    [frames([start, content]) + 'data: {broken}\n\n' + frames([stop, done]), 'protocol'],
    [
      frames([
        start,
        content,
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 42 } },
        stop,
        done,
      ]),
      'protocol',
    ],
  ]) {
    globalThis.fetch = async () => new Response(wire, { headers })
    let reply = structuredClone(initial)
    const indexes = new Map()
    await assert.rejects(
      async () => {
        for await (const e of streamMessage('', { messages: [] }, new AbortController().signal))
          reply = applyEvent(reply, e, 3, indexes)
      },
      (e) => e instanceof ApiError && e.kind === kind
    )
    reply = settleReply(reply, 'error', 4)
    assert.equal(reply.status, 'error')
    assert.equal(reply.blocks[0].text, content.content_block.text)
  }
  const invalid = new Uint8Array([...encoder.encode('data: "'), 0xff, ...encoder.encode('"\n\n')])
  await assert.rejects(collect(readServerSentEvents(makeStream(invalid, 1))), TypeError)
  console.log(
    'PASS: byte-split UTF-8/CRLF/BOM, malformed events, missing terminal event and preserved partial answers'
  )

  // Billing totals retain all branches; missing reasoning never becomes a reported zero.
  const reported = {
    input_tokens: 100,
    output_tokens: 40,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 2,
    reasoning_tokens: 20,
    cache_reported: true,
  }
  const unknown = {
    input_tokens: 80,
    output_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_reported: false,
  }
  const mixed = addUsage(reported, unknown)
  assert.equal(totalTokens(mixed), totalTokens(reported) + totalTokens(unknown))
  assert.equal(mixed.cache_read_input_tokens, 30)
  assert.equal(mixed.reasoning_tokens, 20)
  assert.equal(mixed.reasoning_reported, false)
  assert.equal(addUsage(mixed, reported).reasoning_reported, false)
  assert.equal(addUsage(reported, reported).reasoning_reported, true)
  assert.equal(mixed.cache_reported, false)
  assert.equal(readMessageEvent({ type: 'provider_model', model: '' }), null)
  let reply = applyEvent(initial, start, 3, new Map())
  assert.equal(reply.model, 'request-alias')
  assert.equal(reply.providerModel, 'provider-version')
  reply = applyEvent(reply, { type: 'provider_model', model: 'latest-version' }, 4, new Map())
  reply = settleReply({ ...reply, usage: mixed }, 'done', 5)
  const session = { id: 's', title: 'T', createdAt: 1, updatedAt: 5, messages: [reply] }
  assert.equal(snapshotSession(session).messages[0].providerModel, 'latest-version')
  assert.equal(snapshotSession(session).messages[0].usage.reasoning_reported, false)
  assert.equal(
    validSessionStructure({ ...session, messages: [{ ...reply, providerModel: 42 }] }),
    false
  )
  console.log(
    'PASS: requested/provider identity separation, snapshot preservation and partial reasoning/cache accounting'
  )

  const env = {
    UPSTREAM_PROTOCOL: 'openai',
    UPSTREAM_MODEL: 'request-alias',
    UPSTREAM_API_KEY: 'mock-key',
    UPSTREAM_BASE_URL: 'https://mock.example/v1',
    MAX_INPUT_TOKENS: '4096',
    MAX_OUTPUT_TOKENS: '1024',
    DB: { prepare: () => ({ all: async () => ({ results: [] }) }) },
  }
  const call = async (body, extra = {}) => {
    const response = await upstream(
      new Request('https://app.example/api/anthropic/v1/messages', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      { ...env, ...extra },
      '/api/anthropic/v1/messages'
    )
    return collect(readServerSentEvents(response.body))
  }
  let sent
  for (const protocol of ['openai', 'responses', 'anthropic']) {
    globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(init.body)
      const wire =
        protocol === 'anthropic'
          ? frames([start, content, stop, done])
          : protocol === 'responses'
            ? frames([
                { type: 'response.output_text.delta', delta: 'Answer' },
                { type: 'response.completed', response: { model: 'provider-version', output: [] } },
              ])
            : 'data: ' +
              JSON.stringify({
                model: 'provider-version',
                choices: [{ delta: { content: 'Answer' }, finish_reason: 'stop' }],
              }) +
              '\n\ndata: [DONE]\n\n'
      return new Response(wire, { headers })
    }
    const events = (
      await call(
        { model: 'request-alias', messages: [{ role: 'user', content: 'Question' }] },
        {
          UPSTREAM_PROTOCOL: protocol === 'anthropic' ? 'anthropic' : 'openai',
          OPENAI_API_STYLE: protocol === 'responses' ? 'responses' : 'chat_completions',
        }
      )
    ).map((e) => JSON.parse(e.data))
    assert.equal(sent.model, 'request-alias')
    assert.equal(events.find((e) => e.type === 'message_start').message.model, undefined)
    assert.equal(events.find((e) => e.type === 'provider_model').model, 'provider-version')
  }
  console.log(
    'PASS: OpenAI Chat Completions, Responses and Anthropic relay real model labels without changing request aliases'
  )

  // A 6000-byte ASCII file fits 4096 tokens, but the old bytes*2 estimate rejected it.
  const files = new Map()
  let reads = 0
  const storage = {
    async put(key, body, options) {
      const blob = await new Response(body).blob()
      files.set(key, { size: blob.size, ...options, text: () => blob.text() })
    },
    async head(key) {
      return files.get(key) ?? null
    },
    async get(key) {
      reads++
      return files.get(key) ?? null
    },
  }
  const text = 'a'.repeat(6000)
  const form = new FormData()
  form.set('file', new File([text], 'reference.txt', { type: 'text/plain' }))
  const upload = await upstream(
    new Request('https://app.example/api/anthropic/v1/files', {
      method: 'POST',
      body: form,
    }),
    { ...env, FILES: storage },
    '/api/anthropic/v1/files'
  )
  const file = await upload.json()
  assert.equal(
    Number(files.get('provider/' + file.id).customMetadata.context_tokens_v1),
    contextCost('[reference.txt]\n' + text)
  )
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body)
    return new Response(
      'data: ' +
        JSON.stringify({ choices: [{ delta: { content: 'Answer' }, finish_reason: 'stop' }] }) +
        '\n\ndata: [DONE]\n\n',
      { headers }
    )
  }
  const body = {
    messages: [{ role: 'user', content: [{ type: 'document', source: { file_id: file.id } }] }],
  }
  assert.ok((await call(body, { FILES: storage })).some((e) => e.event === 'message_stop'))
  assert.match(JSON.stringify(sent), /reference.txt/)
  assert.equal(reads, 1)
  const metadata = files.get('provider/' + file.id)
  metadata.customMetadata.context_tokens_v1 = '12000'
  const over = await call(body, { FILES: storage })
  assert.ok(over.some((e) => e.event === 'error' && /输入预算/.test(e.data)))
  assert.equal(reads, 1)
  delete metadata.customMetadata.context_tokens_v1
  assert.ok((await call(body, { FILES: storage })).some((e) => e.event === 'error'))
  assert.equal(reads, 1)
  console.log(
    'PASS: parsed text attachment estimates, actual expansion, budget rejection before reads and legacy metadata fallback'
  )
} finally {
  globalThis.fetch = originalFetch
}
