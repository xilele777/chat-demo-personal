import assert from 'node:assert/strict'
import { ServerSentEventDecoder, readServerSentEvents } from '../src/services/api/sse.ts'
import { boundedResponseText } from '../src/services/api/streamLimits.ts'
import { fetchProvider } from '../worker/providerTransport.ts'
import { upstream } from '../worker/upstream.ts'
import { runMcpTool } from '../worker/mcp.ts'
import { toolOperationRoutes } from '../worker/toolOperations.ts'
import { applyEvent } from '../src/services/chat/reply.ts'
import { validContextReport } from '../src/services/chat/contextReport.ts'
import { validSessionStructure } from '../src/services/chat/validation.ts'
import { snapshotSession } from '../src/services/chat/history/snapshot.ts'
import { historicalMcpContext } from '../src/services/chat/toolHistory.ts'

const originalFetch = globalThis.fetch
// AbortSignal.timeout does not keep a Node process alive; keep this bounded suite alive explicitly.
const keepAlive = setTimeout(() => {
  throw new Error('Generation bounds suite timed out')
}, 60_000)
const bytes = (text) => new TextEncoder().encode(text)
const sse = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
const headers = { 'Content-Type': 'text/event-stream' }
const collect = async (generator) => {
  const events = []
  for (;;) {
    const next = await generator.next()
    if (next.done) return { events, result: next.value }
    events.push(next.value)
  }
}
const env = {
  UPSTREAM_PROTOCOL: 'openai',
  UPSTREAM_MODEL: 'test-model',
  UPSTREAM_BASE_URL: 'https://mock.example/v1',
  UPSTREAM_API_KEY: 'test-key',
  DB: { prepare: () => ({ all: async () => ({ results: [] }) }) },
  MODEL_RESPONSE_TIMEOUT_MS: '30',
  MODEL_FIRST_EVENT_TIMEOUT_MS: '40',
  MODEL_IDLE_TIMEOUT_MS: '40',
  MODEL_TOTAL_TIMEOUT_MS: '500',
}
const request = (body) =>
  new Request('https://app.example/api/anthropic/v1/messages', {
    method: 'POST',
    body: JSON.stringify(body),
  })
const chat = { system: '', messages: [{ role: 'user', content: 'Question', contextId: 'q' }] }
try {
  const decoder = new ServerSentEventDecoder(32, 60)
  assert.deepEqual(decoder.push('data: 一\r').concat(decoder.push('\n\r\n'))[0].data, '一')
  assert.throws(
    () => new ServerSentEventDecoder(32, 100).push('data: ' + '界'.repeat(12)),
    /line exceeds/
  )
  assert.throws(() => decoder.push(('data: ' + 'x'.repeat(20) + '\n').repeat(4)), /event exceeds/)
  for (const prefix of ['', 'data: {"half":', ': heartbeat\n\n', sse([{ type: 'ping' }])]) {
    let cancelled = false
    const stream = new ReadableStream({
      start(c) {
        if (prefix) c.enqueue(bytes(prefix))
      },
      cancel() {
        cancelled = true
      },
    })
    await assert.rejects(
      collect(readServerSentEvents(stream, undefined, { firstEventMs: 30, totalMs: 200 })),
      (error) => error.name === 'TimeoutError'
    )
    assert.equal(cancelled, true)
  }
  const thinking = new ReadableStream({
    start(c) {
      c.enqueue(bytes(sse([{ type: 'thinking', value: 'first' }])))
      setTimeout(() => c.enqueue(bytes(sse([{ type: 'thinking', value: 'second' }]))), 35)
      setTimeout(() => c.close(), 60)
    },
  })
  assert.equal(
    (
      await collect(
        readServerSentEvents(thinking, undefined, { firstEventMs: 20, idleMs: 50, totalMs: 200 })
      )
    ).events.length,
    2
  )
  let interval
  const endless = new ReadableStream({
    start(c) {
      interval = setInterval(() => c.enqueue(bytes('data: progress\n\n')), 5)
    },
    cancel() {
      clearInterval(interval)
    },
  })
  await assert.rejects(
    collect(readServerSentEvents(endless, undefined, { idleMs: 30, totalMs: 50 })),
    (error) => error.name === 'TimeoutError'
  )
  let errorBytes = 0,
    errorCancelled = false
  const errorBody = new ReadableStream({
    pull(c) {
      errorBytes += 1024
      c.enqueue(bytes('x'.repeat(1024)))
    },
    cancel() {
      errorCancelled = true
    },
  })
  assert.equal((await boundedResponseText(new Response(errorBody), 4096)).length, 4096)
  assert.ok(errorBytes <= 6144)
  assert.equal(errorCancelled, true)
  const idle = new ReadableStream({
    start(c) {
      c.enqueue(bytes('data: first\n\n'))
    },
  })
  await assert.rejects(
    collect(readServerSentEvents(idle, undefined, { firstEventMs: 200, idleMs: 25, totalMs: 400 })),
    (error) => error.name === 'TimeoutError'
  )
  let oversizedCancelled = false
  const oversized = new ReadableStream({
    start(c) {
      c.enqueue(bytes('data: ' + 'x'.repeat(2 * 1024 * 1024)))
    },
    cancel() {
      oversizedCancelled = true
    },
  })
  await assert.rejects(collect(readServerSentEvents(oversized)), /line exceeds/)
  assert.equal(oversizedCancelled, true)
  console.log(
    'PASS: UTF-8 line/event bounds, first event/partial event/heartbeat stalls, sliding thinking deadline, total deadline and bounded error reads'
  )

  globalThis.fetch = () => new Promise(() => {})
  await assert.rejects(
    fetchProvider('https://mock.example', { signal: new AbortController().signal }, env),
    (error) => error.status === 504
  )
  for (const protocol of ['openai', 'anthropic', 'deepseek']) {
    for (const prefix of ['', 'data: {"half":']) {
      let cancelled = false
      globalThis.fetch = async () =>
        new Response(
          new ReadableStream({
            start(c) {
              if (prefix) c.enqueue(bytes(prefix))
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers }
        )
      const response = await upstream(
        request(chat),
        { ...env, UPSTREAM_PROTOCOL: protocol },
        '/api/anthropic/v1/messages'
      )
      assert.match(await response.text(), /event: error[\s\S]*超时/)
      assert.equal(cancelled, true)
    }
  }
  // A response deadline stops after headers: it must not cut off a healthy longer stream.
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(bytes('data: first\n\n'))
          setTimeout(() => {
            c.enqueue(bytes('data: second\n\n'))
            c.close()
          }, 55)
        },
      }),
      { headers }
    )
  const healthy = await fetchProvider(
    'https://mock.example',
    {},
    { ...env, MODEL_IDLE_TIMEOUT_MS: '100' }
  )
  assert.match(await healthy.text(), /second/)
  console.log(
    'PASS: bounded provider header wait, all three protocols stop silent/partial streams, header timer does not kill long responses'
  )

  let sent
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body)
    return new Response(
      sse([{ choices: [{ delta: { content: 'Answer' }, finish_reason: 'stop' }] }]) +
        'data: [DONE]\n\n',
      { headers }
    )
  }
  const long = {
    ...chat,
    messages: [
      { role: 'user', content: 'Old constraint '.repeat(2000), contextId: 'old-q' },
      { role: 'assistant', content: 'Old answer' },
      ...chat.messages,
    ],
  }
  const output = await (
    await upstream(
      request(long),
      { ...env, MAX_INPUT_TOKENS: '4096' },
      '/api/anthropic/v1/messages'
    )
  ).text()
  const report = output
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
    .find((event) => event.type === 'context_report').report
  assert.ok(validContextReport(report))
  assert.equal(report.omittedRounds, 1)
  assert.deepEqual(report.retainedQuestionIds, ['q'])
  assert.ok(report.estimatedInputTokens <= report.inputBudget)
  assert.doesNotMatch(
    JSON.stringify(sent),
    /contextId|contextRound|operationRequestId|Old constraint/
  )
  let reply = {
    id: 'a',
    role: 'assistant',
    model: 'test-model',
    createdAt: 2,
    status: 'pending',
    prefix: true,
    blocks: [],
    operationRequestId: 'request-evidence',
  }
  reply = applyEvent(reply, { type: 'context_report', report }, 3, new Map())
  const session = {
    id: 's',
    title: 'T',
    createdAt: 1,
    updatedAt: 2,
    messages: [{ id: 'q', role: 'user', content: 'Q', files: [], createdAt: 1 }, reply],
  }
  assert.ok(validSessionStructure(session))
  assert.equal(
    validSessionStructure({
      ...session,
      messages: [
        session.messages[0],
        { ...reply, contextReports: [{ ...report, omittedRounds: -1 }] },
      ],
    }),
    false
  )
  assert.deepEqual(snapshotSession(session).messages[1].contextReports, [report])
  assert.equal(snapshotSession(session).messages[1].operationRequestId, undefined)
  console.log(
    'PASS: actual sent context ranges and budgets, stripped internal IDs, per-answer reports, backup preservation and stale journal handle removal'
  )

  const records = new Map()
  const journalEnv = {
    ...env,
    operationRequestId: 'request-evidence',
    DB: {
      prepare(sql) {
        let args
        return {
          bind(...values) {
            args = values
            return this
          },
          async run() {
            if (sql.startsWith('INSERT INTO tool_operations'))
              records.set(args[0], {
                id: args[0],
                requestId: args[1],
                server: args[3],
                name: args[4],
                state: args[5],
                resultSha256: args[8],
              })
          },
          async first() {
            return sql.startsWith('SELECT data')
              ? { data: JSON.stringify(entry.server) }
              : { status: 'approved' }
          },
          async all() {
            return { results: [...records.values()] }
          },
        }
      },
    },
  }
  const entry = {
    server: { id: 'notes', name: 'Notes' },
    tool: { name: 'create_note', annotations: { readOnlyHint: false } },
    client: {
      async callTool() {
        assert.ok([...records.values()].some((record) => record.state === 'dispatched'))
        return { content: [{ type: 'text', text: 'Created private-content' }] }
      },
    },
  }
  Object.assign(entry.server, { enabled: true, disabledTools: [], tools: [entry.tool] })
  const success = await collect(
    runMcpTool(entry, { token: 'secret-argument' }, journalEnv, new AbortController().signal)
  )
  assert.equal(success.events.at(-1).block.status, 'done')
  assert.equal([...records.values()].at(-1).state, 'done')
  assert.match([...records.values()].at(-1).resultSha256, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify([...records.values()]), /private-content|secret-argument/)
  globalThis.fetch = () => new Promise(() => {})
  await assert.rejects(
    fetchProvider('https://mock.example', {}, env),
    (error) => error.status === 504
  )
  assert.equal([...records.values()].at(-1).state, 'done')
  const delayedApproval = runMcpTool(entry, {}, journalEnv, new AbortController().signal)
  assert.equal((await delayedApproval.next()).value.block.status, 'approval')
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal((await collect(delayedApproval)).result.isError, false)
  const aborted = new AbortController()
  const pendingEntry = {
    ...entry,
    client: {
      callTool(_params, _schema, options) {
        aborted.abort()
        return Promise.reject(options.signal.reason)
      },
    },
  }
  await assert.rejects(collect(runMcpTool(pendingEntry, {}, journalEnv, aborted.signal)))
  assert.equal([...records.values()].at(-1).state, 'unknown')
  const recordResponse = await toolOperationRoutes(
    new Request('https://app.example/api/mcp/operations/query', {
      method: 'POST',
      body: JSON.stringify({ requestIds: ['request-evidence'] }),
    }),
    journalEnv,
    '/api/mcp/operations/query'
  )
  assert.equal((await recordResponse.json()).operations.length, 3)
  assert.match(
    historicalMcpContext([{ ...success.events.at(-1).block, status: 'unknown' }]),
    /outcome_unknown/
  )
  let dispatched = 0
  const storageFailure = {
    ...journalEnv,
    DB: {
      prepare: () => ({
        bind() {
          return this
        },
        run: async () => {
          throw new Error('Disk failed')
        },
      }),
    },
  }
  const failed = await collect(
    runMcpTool(
      {
        ...entry,
        client: {
          callTool() {
            dispatched++
          },
        },
      },
      {},
      storageFailure,
      new AbortController().signal
    )
  )
  assert.equal(failed.result.isError, true)
  assert.equal(dispatched, 0)
  console.log(
    'PASS: durable dispatch barrier, completion digest without content/parameters, aborted writes remain unknown, recovery query and storage-failure prevents dispatch'
  )
} finally {
  clearTimeout(keepAlive)
  globalThis.fetch = originalFetch
}
