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
let searchCount = 0
let searchedQuery = ''
let mcpReads = 0
let mcpWrites = 0
const mock = createServer(async (req, res) => {
  if (req.url === '/mcp') {
    if (req.method === 'GET') {
      res.writeHead(405).end()
      return
    }
    if (req.method === 'DELETE') {
      res.writeHead(200).end()
      return
    }
    assert.equal(req.headers.authorization, 'Bearer smoke-mcp')
    let text = ''
    for await (const chunk of req) text += chunk
    const message = JSON.parse(text)
    if (message.id === undefined) {
      res.writeHead(202).end()
      return
    }
    let result
    if (message.method === 'initialize')
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'smoke-mcp', version: '1' },
      }
    else if (message.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'read_note',
            description: 'Read a note',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
            annotations: { readOnlyHint: true },
          },
          {
            name: 'write_note',
            description: 'Write a note',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
            annotations: { readOnlyHint: false },
          },
        ],
      }
    else if (message.method === 'tools/call') {
      if (message.params.name === 'read_note') mcpReads++
      else if (message.params.name === 'write_note') mcpWrites++
      else {
        res.writeHead(400).end()
        return
      }
      result = { content: [{ type: 'text', text: `MCP ${message.params.name} result` }] }
    } else result = {}
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    return
  }
  if (req.url === '/v1/models') {
    assert.equal(req.headers.authorization, 'Bearer smoke-test')
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ data: [{ id: 'test-model' }, { id: 'second-model' }] }))
    return
  }
  if (req.url === '/search') {
    let text = ''
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    assert.equal(req.headers.authorization, 'Bearer smoke-search')
    searchCount++
    searchedQuery = body.query
    if (body.query === 'search-failure') {
      res
        .writeHead(429, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'smoke-search must never leak' }))
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          results:
            body.query === 'no-results'
              ? []
              : [
                  {
                    title: '测试来源',
                    url: 'https://example.com/news',
                    content: '今天发布的测试消息',
                  },
                  { title: '重复来源', url: 'https://example.com/news', content: '重复摘要' },
                  { title: '无效来源', url: 'javascript:alert(1)', content: '不可点击' },
                ],
        })
      )
    }
    return
  }
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404).end()
    return
  }
  let body = ''
  for await (const chunk of req) body += chunk
  sentToProvider = JSON.parse(body)
  assert.equal(req.headers.authorization, 'Bearer smoke-test')
  if (
    sentToProvider.messages.some((message) => message.content === 'legacy token field') &&
    sentToProvider.max_completion_tokens !== undefined
  ) {
    res
      .writeHead(400, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: { message: 'Unsupported parameter: max_completion_tokens' } }))
    return
  }
  if (
    sentToProvider.messages.some((message) => message.content === 'legacy stream options') &&
    sentToProvider.stream_options !== undefined
  ) {
    res
      .writeHead(400, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: { message: 'Unknown parameter: stream_options' } }))
    return
  }
  if (sentToProvider.stream === false) {
    assert.equal(sentToProvider.tools, undefined)
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ choices: [{ message: { content: '云端同步检查' } }] }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const last = sentToProvider.messages.at(-1)
  const lastText =
    typeof last.content === 'string' ? last.content : last.content.map((b) => b.text ?? '').join('')
  if (
    last.role === 'user' &&
    ['mcp-read', 'mcp-write'].includes(lastText) &&
    sentToProvider.tool_choice !== 'none'
  ) {
    const target = sentToProvider.tools?.find((tool) =>
      tool.function.description.includes(lastText === 'mcp-read' ? 'Read a note' : 'Write a note')
    )
    if (target) {
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_mcp', type: 'function', function: { name: target.function.name, arguments: '{"query":"note"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`
      )
      return
    }
  }
  if (
    sentToProvider.tools?.some((tool) => tool.function.name === 'web_search') &&
    last.role === 'user' &&
    lastText !== '你好' &&
    sentToProvider.tool_choice !== 'none'
  ) {
    const query = lastText === '它为什么这样？' ? '原始主题 原因' : lastText
    const args = JSON.stringify({ query })
    for (const delta of [
      {
        tool_calls: [
          {
            index: 0,
            id: 'call_search',
            type: 'function',
            function: { name: 'web_search', arguments: args.slice(0, 5) },
          },
        ],
      },
      { tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] },
    ])
      res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`)
    res.end(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`
    )
    return
  }
  let sources = []
  if (last.role === 'tool') {
    try {
      sources = JSON.parse(last.content).sources ?? []
    } catch {
      /* A denied MCP call returns plain text. */
    }
  }
  for (const delta of [
    { reasoning_content: '先检查内容。' },
    { content: '你好，' },
    {
      content: '云端同步正常。' + (sources?.length ? '[citation:1]' : ''),
    },
  ]) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`)
  }
  res.end(
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: lastText === 'no-usage' ? undefined : { prompt_tokens: 100, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 20 } } })}\n\ndata: [DONE]\n\n`
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
      'OPENAI_REASONING_EFFORTS:low,medium,high',
      '--var',
      'TAVILY_API_KEY:smoke-search',
      '--var',
      `DEV_SEARCH_URL:http://127.0.0.1:${mockPort}/search`,
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

  // Pinning is part of the same revision-protected snapshot seen by other devices.
  const pinIndex = await (await call('/sessions')).json()
  await call('/sessions/pin-check', 'PUT', {
    session: session('pin-check'),
    revision: null,
    generation: pinIndex.generation,
  })
  const beforePin = await (await call('/sessions/pin-check')).json()
  assert.equal(
    (
      await call('/sessions/pin-check', 'PUT', {
        session: { ...beforePin.session, pinned: true },
        revision: beforePin.revision,
        generation: beforePin.generation,
      })
    ).status,
    200
  )
  assert.equal(
    (await (await call('/sessions')).json()).sessions.find((s) => s.id === 'pin-check').pinned,
    true
  )
  const afterPin = await (await call('/sessions/pin-check')).json()
  assert.equal(afterPin.session.pinned, true)
  assert.equal(afterPin.session.updatedAt, beforePin.session.updatedAt)
  assert.deepEqual(afterPin.session.messages, beforePin.session.messages)
  assert.equal(
    (
      await call('/sessions/pin-check', 'PUT', {
        session: beforePin.session,
        revision: beforePin.revision,
        generation: beforePin.generation,
      })
    ).status,
    409
  )
  assert.equal(
    (
      await call('/sessions/pin-check', 'PUT', {
        session: { ...afterPin.session, pinned: false },
        revision: afterPin.revision,
        generation: afterPin.generation,
      })
    ).status,
    200
  )
  assert.equal(
    (await (await call('/sessions')).json()).sessions.find((s) => s.id === 'pin-check').pinned,
    false
  )
  assert.equal(
    (
      await call('/sessions/invalid-pin', 'PUT', {
        session: { ...session('invalid-pin'), pinned: 'yes' },
        revision: null,
        generation: afterPin.generation,
      })
    ).status,
    400
  )
  console.log('PASS: shared pin state, unpinning, unchanged messages and stale-device protection')

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

  const { readMessageEvent } = await import('../src/services/api/parseEvent.ts')
  const { applyEvent } = await import('../src/services/chat/reply.ts')
  const { buildReplyView } = await import('../src/services/chat/view.ts')
  const requestSearch = (query) =>
    call('/anthropic/v1/messages', 'POST', {
      system: '测试',
      messages: [{ role: 'user', content: [{ type: 'text', text: query }] }],
      tools: [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }],
    })
  assert.equal((await (await call('/config')).json()).search, true)
  const searchResponse = await requestSearch('今天的测试消息')
  assert.equal(searchResponse.status, 200)
  const searchStream = await searchResponse.text()
  assert.equal(searchedQuery, '今天的测试消息', searchStream)
  assert.equal(searchCount, 1)
  assert.equal(sentToProvider.tools[0].function.name, 'web_search')
  assert.equal(sentToProvider.messages.at(-1).role, 'tool')
  assert.match(JSON.stringify(sentToProvider.messages), /今天发布的测试消息/)
  const events = searchStream
    .split('\n\n')
    .filter(Boolean)
    .map((part) => JSON.parse(part.split('\ndata: ')[1]))
  assert.equal(events.filter((e) => e.type === 'message_start').length, 1)
  assert.deepEqual(
    events.filter((e) => e.type === 'content_block_start').map((e) => e.index),
    [0, 1, 2, 3]
  )
  let reply = {
    id: 'search-reply',
    role: 'assistant',
    createdAt: 1,
    status: 'pending',
    prefix: true,
    thinking: false,
    search: true,
    blocks: [],
  }
  const indexes = new Map()
  for (const event of events) {
    const parsed = readMessageEvent(event)
    if (parsed) reply = applyEvent(reply, parsed, Date.now(), indexes)
  }
  const view = buildReplyView(reply, false)
  assert.deepEqual(
    view.steps.map((s) => s.type),
    ['search', 'thinking']
  )
  assert.equal(view.steps[0].status, 'done')
  assert.deepEqual(view.steps[0].queries, ['今天的测试消息'])
  assert.equal(view.sources.length, 1)
  assert.equal(view.sources[0].snippet, '今天发布的测试消息')
  assert.match(view.answer.markdown, /\[citation:1\]/)
  const failedSearch = await (await requestSearch('search-failure')).text()
  assert.match(failedSearch, /web_search_tool_result_error/)
  assert.match(failedSearch, /message_stop/)
  assert.doesNotMatch(failedSearch, /\[citation:/)
  assert.doesNotMatch(failedSearch, /smoke-search/)
  const emptySearch = await (await requestSearch('no-results')).text()
  assert.match(emptySearch, /"content":\[\]/)
  assert.match(emptySearch, /message_stop/)
  console.log(
    'PASS: real search event flow, reasoning, citations, invalid/duplicate URLs, errors and empty results'
  )

  const capabilities = await (await call('/config')).json()
  assert.deepEqual(capabilities.reasoningEfforts, ['low', 'medium', 'high'])
  const highReasoning = await call('/anthropic/v1/messages', 'POST', {
    system: '测试',
    messages: [{ role: 'user', content: 'reasoning test' }],
    reasoning_effort: 'high',
  })
  await highReasoning.text()
  assert.equal(sentToProvider.reasoning_effort, 'high')
  assert.equal(sentToProvider.max_completion_tokens, 8192)
  assert.equal(sentToProvider.max_tokens, undefined)
  await (
    await call('/anthropic/v1/messages', 'POST', {
      system: '测试',
      messages: [{ role: 'user', content: 'auto reasoning' }],
    })
  ).text()
  assert.equal(sentToProvider.reasoning_effort, undefined)
  await (
    await call('/anthropic/v1/messages', 'POST', {
      system: '测试',
      messages: [{ role: 'user', content: 'legacy token field' }],
      reasoning_effort: 'high',
    })
  ).text()
  assert.equal(sentToProvider.max_tokens, 8192)
  assert.equal(sentToProvider.max_completion_tokens, undefined)
  assert.equal(sentToProvider.reasoning_effort, 'high')
  await (
    await call('/anthropic/v1/messages', 'POST', {
      system: '测试',
      messages: [{ role: 'user', content: 'legacy stream options' }],
    })
  ).text()
  assert.equal(sentToProvider.stream_options, undefined)
  const title = await call('/title', 'POST', { question: '同步测试', answer: '同步正常' })
  assert.deepEqual(await title.json(), { title: '云端同步检查' })
  const beforeGreeting = searchCount
  await (await requestSearch('你好')).text()
  assert.equal(searchCount, beforeGreeting)
  await (
    await call('/anthropic/v1/messages', 'POST', {
      system: '测试',
      messages: [
        { role: 'user', content: '原始主题' },
        { role: 'assistant', content: '背景回答' },
        { role: 'user', content: '它为什么这样？' },
      ],
      tools: [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }],
    })
  ).text()
  assert.equal(searchedQuery, '原始主题 原因')
  console.log(
    'PASS: reasoning effort, modern OpenAI token field, generated titles and context-aware optional search'
  )

  const { openAIStream } = await import('../worker/upstream.ts')
  let upstreamCancelled = false
  const raw = new ReadableStream({
    cancel() {
      upstreamCancelled = true
    },
  })
  const cancellationStream = openAIStream(
    new Response(raw, { headers: { 'Content-Type': 'text/event-stream' } }),
    new AbortController().signal,
    'test-model'
  )
  const cancellationReader = cancellationStream.body.getReader()
  await cancellationReader.read()
  await cancellationReader.cancel()
  assert.equal(upstreamCancelled, true)
  console.log('PASS: cancelling generation releases the upstream response stream')

  const models = await (await call('/models')).json()
  assert.deepEqual(
    models.data.map((model) => model.id),
    ['test-model', 'second-model']
  )
  await (
    await call('/anthropic/v1/messages', 'POST', {
      system: 'test',
      model: 'second-model',
      messages: [{ role: 'user', content: '你好' }],
    })
  ).text()
  assert.equal(sentToProvider.model, 'second-model')
  assert.equal(
    (await call('/anthropic/v1/messages', 'POST', { model: 'invalid model', messages: [] })).status,
    400
  )
  const tokenEvents = stream
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
  const tokenUsage = tokenEvents.find((event) => event.type === 'message_delta').usage
  assert.deepEqual(tokenUsage, {
    input_tokens: 70,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 30,
    output_tokens: 40,
    reasoning_tokens: 20,
  })
  const missingUsage = await (
    await call('/anthropic/v1/messages', 'POST', {
      system: 'test',
      messages: [{ role: 'user', content: 'no-usage' }],
    })
  ).text()
  assert.doesNotMatch(missingUsage, /"usage"/)
  console.log(
    'PASS: model discovery, per-message model selection and accurate or unavailable token usage'
  )

  const searchIndex = await (await call('/sessions')).json()
  await call('/sessions/search-check', 'PUT', {
    session: session('search-check', 'Hidden TOKEN 100%_value'),
    revision: null,
    generation: searchIndex.generation,
  })
  const found = await (await call('/history/search?q=TOKEN')).json()
  assert.equal(found.results[0].messageId, 'reply')
  const literal = await (await call('/history/search?q=100%25_value')).json()
  assert.equal(literal.results[0].sessionId, 'search-check')
  assert.equal((await call('/history/search?q=')).status, 400)
  console.log(
    'PASS: D1 history searches return message locations and treat wildcard characters literally'
  )

  const mcpConfig = {
    name: 'Test MCP',
    url: `http://127.0.0.1:${mockPort}/mcp`,
    enabled: true,
    token: 'smoke-mcp',
    disabledTools: [],
  }
  const tested = await call('/mcp/servers/test-mcp/test', 'POST', mcpConfig)
  assert.equal(tested.status, 200, await tested.clone().text())
  assert.equal((await tested.json()).server.tools.length, 2)
  const savedMcp = await call('/mcp/servers/test-mcp', 'PUT', mcpConfig)
  assert.equal(savedMcp.status, 200, await savedMcp.clone().text())
  assert.doesNotMatch(await (await call('/mcp/servers')).text(), /smoke-mcp/)
  const readMcp = await (
    await call('/anthropic/v1/messages', 'POST', {
      system: 'test',
      messages: [{ role: 'user', content: 'mcp-read' }],
    })
  ).text()
  assert.match(readMcp, /mcp_tool_status/)
  assert.match(readMcp, /"status":"done"/)
  assert.equal(mcpReads, 1)
  assert.equal(mcpWrites, 0)
  const approveCall = async (approved) => {
    const response = await call('/anthropic/v1/messages', 'POST', {
      system: 'test',
      messages: [{ role: 'user', content: 'mcp-write' }],
    })
    const reader = response.body.getReader()
    let output = ''
    let decision = false
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      output += new TextDecoder().decode(chunk.value)
      const match = output.match(/"approvalId":"([a-zA-Z0-9_-]+)"/)
      if (match && !decision) {
        assert.equal(mcpWrites, approved ? 0 : 1)
        assert.equal((await call(`/mcp/approvals/${match[1]}`, 'POST', { approved })).status, 200)
        decision = true
      }
    }
    assert.equal(decision, true)
    assert.match(output, approved ? /"status":"done"/ : /"status":"denied"/)
  }
  await approveCall(true)
  assert.equal(mcpWrites, 1)
  await approveCall(false)
  assert.equal(mcpWrites, 1)
  await call('/mcp/servers/test-mcp', 'DELETE')
  assert.equal((await (await call('/mcp/servers')).json()).servers.length, 0)
  console.log(
    'PASS: MCP discovery, hidden credentials, read calls, explicit write approval and denied calls'
  )

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
