import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { McpTools } from '../worker/mcpTools.ts'
import { contextCost, limitContext } from '../worker/context.ts'
import { upstream, anthropicReply } from '../worker/upstream.ts'

// Optional read-only export of the actual MCP definitions; no tokens or user content are needed.
const fixture = process.env.MCP_TOOLS_FIXTURE
const tools = fixture
  ? JSON.parse(JSON.parse(readFileSync(fixture, 'utf8'))[0].results[0].tools)
  : Array.from({ length: 77 }, (_, i) => ({
      name: i === 72 ? 'get_identity' : `large_tool_${i}`,
      description:
        i === 72
          ? 'Get the connected workspace identity'
          : 'Large tool documentation. '.repeat(100),
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Parameter documentation. '.repeat(180),
            enum: ['notes', 'tasks'],
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    }))
const target = tools.find((tool) => /get[-_]self|get[-_]identity/.test(tool.name))
assert.ok(target)
const alias = `mcp_${tools.indexOf(target)}`
const entries = tools.map((tool, i) => ({ alias: `mcp_${i}`, server: { name: 'Notion' }, tool }))
const env = { MAX_INPUT_TOKENS: '64000' }
const oldDefinitions = entries.map((entry) => ({
  type: 'function',
  function: {
    name: entry.alias,
    description: entry.tool.description.slice(0, 1500),
    parameters: entry.tool.inputSchema,
  },
}))
assert.throws(
  () => limitContext(JSON.stringify(oldDefinitions), [{ role: 'user', content: '你好' }], env),
  /MCP 工具定义超过输入预算/
)
const catalog = new McpTools(entries, env)
assert.equal(catalog.deferred, true)
assert.equal(catalog.definitions('openai', true).length, 1)
assert.equal(catalog.definitions('openai', true)[0].function.name, 'mcp_load_tools')
assert.equal(
  limitContext(
    catalog.instructions + JSON.stringify(catalog.definitions('openai', true)),
    [{ role: 'user', content: '你好' }],
    env
  ).length,
  1
)
assert.equal(catalog.load({ names: ['unknown'] }).loaded, undefined)
assert.equal(catalog.load({ names: [alias, alias, alias, alias] }).loaded, undefined)
assert.equal(catalog.load({}).tools.length, 12)
assert.equal(catalog.load({ offset: 12 }).tools[0].name, 'mcp_12')
assert.ok(catalog.load({ query: target.name }).tools.some((tool) => tool.name === alias))
assert.ok(catalog.load({ names: [alias] }).loaded)
assert.deepEqual(
  catalog.definitions('openai', true).find((tool) => tool.function.name === alias).function
    .parameters,
  target.inputSchema
)
assert.deepEqual(
  catalog.definitions('anthropic', true).find((tool) => tool.name === alias).input_schema,
  target.inputSchema
)
assert.equal(catalog.definitions('openai', false).length, 1)
assert.equal(
  new McpTools([{ ...entries[0], tool: { name: 'small', inputSchema: { type: 'object' } } }], env)
    .deferred,
  true
)
const largest = entries.toSorted(
  (a, b) =>
    contextCost(JSON.stringify(b.tool.inputSchema)) -
    contextCost(JSON.stringify(a.tool.inputSchema))
)[0]
assert.ok(
  catalog.load({ names: [largest.alias] }).loaded,
  'The largest actual schema must fit without removing constraints'
)
console.log(
  `PASS: ${tools.length} tools reproduce the old overflow; bounded catalog and individually loaded full schemas fit`
)

let requests = []
let remoteCalls = 0
let readonly = true
let decision = 'approved'
let greeting = false
const approvals = new Map()
let error
const mock = createServer(async (request, response) => {
  try {
    if (request.method === 'GET') {
      response.writeHead(405).end()
      return
    }
    if (request.method === 'DELETE') {
      response.writeHead(200).end()
      return
    }
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    if (request.url === '/mcp') {
      if (body.id === undefined) {
        response.writeHead(202).end()
        return
      }
      let result
      if (body.method === 'initialize')
        result = {
          protocolVersion: body.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'mock', version: '1' },
        }
      else if (body.method === 'tools/list')
        result = {
          tools: tools.map((tool) => ({
            ...tool,
            annotations: { ...tool.annotations, readOnlyHint: readonly },
          })),
        }
      else if (body.method === 'tools/call') {
        assert.equal(body.params.name, target.name)
        remoteCalls++
        result = { content: [{ type: 'text', text: 'Connected to test workspace' }] }
      } else result = {}
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
      return
    }
    requests.push(body)
    const openai = request.url === '/v1/chat/completions'
    const definitions = openai ? body.tools.map((tool) => tool.function) : body.tools
    const remote = definitions.find((tool) => tool.name === alias)
    const messages = body.messages
    const completed = openai
      ? messages.some((message) => message.role === 'tool' && message.tool_call_id === 'remote')
      : messages.some(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some(
              (block) => block.type === 'tool_result' && block.tool_use_id === 'remote'
            )
        )
    const callName = greeting || completed ? null : remote ? alias : 'mcp_load_tools'
    if (requests.length === 1) {
      assert.equal(definitions.length, 2)
      assert.equal(definitions[0].name, 'mcp_load_tools')
      assert.ok(
        contextCost(body.system ?? body.messages[0].content) +
          contextCost(JSON.stringify(body.tools)) <
          8000
      )
      assert.equal(JSON.stringify(body).includes('Parameter documentation.'), false)
    }
    if (remote)
      assert.deepEqual(openai ? remote.parameters : remote.input_schema, target.inputSchema)
    const args = remote
      ? target.inputSchema.required?.includes('query')
        ? { query: 'notes' }
        : {}
      : { names: [alias] }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (openai) {
      const choice = callName
        ? {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: remote ? 'remote' : 'load',
                  type: 'function',
                  function: { name: callName, arguments: JSON.stringify(args) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          }
        : { delta: { content: 'Final answer' }, finish_reason: 'stop' }
      response.end(
        `data: ${JSON.stringify({ choices: [choice], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`
      )
    } else {
      const event = (value) =>
        response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
      event({ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0 } } })
      event({
        type: 'content_block_start',
        index: 0,
        content_block: callName
          ? { type: 'tool_use', id: remote ? 'remote' : 'load', name: callName, input: args }
          : { type: 'text', text: 'Final answer' },
      })
      event({ type: 'content_block_stop', index: 0 })
      event({
        type: 'message_delta',
        delta: { stop_reason: callName ? 'tool_use' : 'end_turn' },
        usage: { output_tokens: 10 },
      })
      event({ type: 'message_stop' })
      response.end()
    }
  } catch (caught) {
    error = caught
    response.writeHead(500).end('Mock assertion failed')
  }
})
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${mock.address().port}`
const server = {
  id: 'test',
  name: 'Notion',
  url: `${origin}/mcp`,
  token: 'test-key',
  enabled: true,
  disabledTools: [],
  tools,
}
const testEnv = {
  ...env,
  DEV_AUTH: 'true',
  UPSTREAM_BASE_URL: `${origin}/v1`,
  UPSTREAM_MODEL: 'test-model',
  UPSTREAM_API_KEY: 'test-key',
  DB: {
    prepare(sql) {
      let args = []
      const statement = {
        bind(...values) {
          args = values
          return statement
        },
        async all() {
          return {
            results: sql.startsWith('SELECT data') ? [{ data: JSON.stringify(server) }] : [],
          }
        },
        async first() {
          return { status: approvals.get(args[0]) }
        },
        async run() {
          if (sql.startsWith('INSERT INTO mcp_approvals')) approvals.set(args[0], 'pending')
          if (sql.startsWith('DELETE FROM mcp_approvals WHERE id')) approvals.delete(args[0])
          return {}
        },
      }
      return statement
    },
  },
}
try {
  for (const protocol of ['openai', 'anthropic']) {
    for (const mode of ['greeting', 'read', 'approved', 'denied']) {
      requests = []
      greeting = mode === 'greeting'
      readonly = mode !== 'approved' && mode !== 'denied'
      decision = mode === 'denied' ? 'denied' : 'approved'
      const before = remoteCalls
      const body = {
        system: 'Test',
        messages: [{ role: 'user', content: greeting ? '你好' : '查询 Notion 身份' }],
      }
      const events = []
      if (protocol === 'openai') {
        const response = await upstream(
          new Request(`${origin}/api/anthropic/v1/messages`, {
            method: 'POST',
            body: JSON.stringify(body),
          }),
          { ...testEnv, UPSTREAM_PROTOCOL: protocol },
          '/api/anthropic/v1/messages'
        )
        const { readServerSentEvents } = await import('../src/services/api/sse.ts')
        for await (const raw of readServerSentEvents(response.body, new AbortController().signal)) {
          const event = JSON.parse(raw.data)
          events.push(event)
          if (event.type === 'mcp_tool_status' && event.block.status === 'approval')
            approvals.set(event.block.approvalId, decision)
        }
      } else {
        for await (const event of anthropicReply(
          body,
          { ...testEnv, UPSTREAM_PROTOCOL: protocol },
          new AbortController().signal
        )) {
          events.push(event)
          if (event.type === 'mcp_tool_status' && event.block.status === 'approval')
            approvals.set(event.block.approvalId, decision)
        }
      }
      if (error) throw error
      assert.ok(
        events.some((event) => event.type === 'message_stop'),
        JSON.stringify(events)
      )
      assert.equal(remoteCalls - before, mode === 'greeting' || mode === 'denied' ? 0 : 1)
      assert.equal(requests.length, greeting ? 1 : 3)
      assert.equal(
        events.findLast((event) => event.type === 'message_delta' && event.delta.stop_reason).usage
          .output_tokens,
        greeting ? 10 : 30
      )
      assert.equal(
        events.filter(
          (event) => event.type === 'mcp_tool_status' && event.block.status === 'approval'
        ).length,
        readonly ? 0 : 1
      )
      assert.equal(approvals.size, 0)
      console.log(
        `PASS: ${protocol} ${mode} with a large MCP catalog, on-demand definitions and accumulated usage`
      )
    }
  }
} finally {
  await new Promise((resolve) => mock.close(resolve))
}
