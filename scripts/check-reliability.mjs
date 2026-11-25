import assert from 'node:assert/strict'
import { validateMcpUrl } from '../worker/mcpNet.ts'
import { readSession, readJsonObject } from '../worker/types.ts'
import { readOpenAIEvents } from '../worker/openaiResponses.ts'
import { ToolResults } from '../worker/toolResults.ts'
import { ToolRuntime } from '../worker/toolRuntime.ts'
import { contextCost } from '../worker/context.ts'
import { anthropicReply } from '../worker/upstream.ts'

for (const url of [
  'https://localhost./mcp',
  'https://service.local./mcp',
  'https://198.18.0.1/mcp',
  'https://100.64.1.1/mcp',
  'https://[::1]/mcp',
])
  assert.throws(() => validateMcpUrl(url, {}), /public HTTPS/)
assert.equal(validateMcpUrl('https://mcp.example.com./mcp', {}).hostname, 'mcp.example.com')
assert.throws(() => validateMcpUrl('http://localhost/mcp', {}), /public HTTPS/)
assert.equal(validateMcpUrl('http://localhost/mcp', { DEV_AUTH: 'true' }).protocol, 'http:')

const session = {
  id: 'check',
  title: 'Check',
  createdAt: 1,
  updatedAt: 2,
  rootMessageId: 'q',
  messages: [
    { id: 'q', role: 'user', content: 'Question', files: [], parentId: null, selectedChildId: 'a' },
    {
      id: 'a',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Answer' }],
      status: 'done',
      parentId: 'q',
    },
  ],
}
assert.deepEqual(readSession(session), session)
for (const mutate of [
  (s) => {
    s.messages[0].files = null
  },
  (s) => {
    s.messages[0].content = {}
  },
  (s) => {
    s.messages[1].blocks = [{ type: 'text', text: 42 }]
  },
  (s) => {
    s.messages[1].blocks = [{ type: 'thinking', thinking: 'thought', signature: 42 }]
  },
  (s) => {
    s.messages[1].blocks = [{ type: 'text', text: 'answer', isTemplate: 'false' }]
  },
  (s) => {
    s.messages[1].usage = { input_tokens: 1, cache_reported: 'false' }
  },
  (s) => {
    s.messages[1].reasoningEffort = ['high']
  },
  (s) => {
    s.messages[1].stopReason = ['refusal']
  },
  (s) => {
    s.messages[1].error = {
      kind: 'upload',
      message: 'error',
      localMessage: { key: 'message', params: [] },
    }
  },
  (s) => {
    s.messages[1].status = 'unknown'
  },
  (s) => {
    s.messages[1].id = 'q'
  },
  (s) => {
    s.messages[1].selectedChildId = 'q'
    s.messages[0].parentId = 'a'
  },
  (s) => {
    s.rootMessageId = 'missing'
  },
  (s) => {
    s.messages[1].blocks = [
      {
        type: 'web_fetch_tool_result',
        tool_use_id: 't',
        kind: 'deep_search',
        content: {
          type: 'web_fetch_result',
          url: 'https://example.com',
          content: { title: 'Page' },
        },
      },
    ]
  },
]) {
  const invalid = structuredClone(session)
  mutate(invalid)
  assert.throws(
    () => readSession(invalid),
    (error) => error.status === 400
  )
}
for (const body of ['null', '[]', '{invalid']) {
  await assert.rejects(
    readJsonObject(new Request('https://example.com', { method: 'POST', body })),
    (error) => error.status === 400
  )
}

for (const [reason, finish] of [
  ['max_output_tokens', 'length'],
  ['content_filter', 'content_filter'],
]) {
  const events = []
  const value = {
    type: 'response.incomplete',
    response: { output: [], incomplete_details: { reason } },
  }
  for await (const event of readOpenAIEvents(
    new Response(`data: ${JSON.stringify(value)}\n\n`).body,
    new AbortController().signal
  ))
    events.push(event)
  assert.equal(JSON.parse(events[0].data).choices[0].finish_reason, finish)
}

for (const inputBudget of [1024, 8192, 196608]) {
  const cache = new ToolResults({ MAX_INPUT_TOKENS: String(inputBudget) })
  const preview = JSON.parse(
    cache.remember(
      JSON.stringify({ content: [{ type: 'text', text: '文'.repeat(40000) + 'needle-42' }] })
    )
  )
  const read = cache.read({ result_id: preview.result_id, find: 'needle-42', limit: 16000 })
  assert.ok(
    contextCost(read) <= Math.min(3000, Math.floor(inputBudget / 8)),
    `Cache read overflow at ${inputBudget}`
  )
  assert.match(JSON.parse(read).text, /needle-42/)
}

let approvals = 0,
  executions = 0
const tools = [
  {
    alias: 'mcp_0',
    server: { name: 'Notes', token: '' },
    tool: {
      name: 'write_note',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: false },
    },
    client: {
      async callTool() {
        executions++
        return { content: [] }
      },
    },
  },
]
const env = {
  DB: {
    prepare(sql) {
      const statement = {
        bind() {
          return statement
        },
        async run() {
          if (sql.startsWith('INSERT INTO mcp_approvals')) approvals++
        },
        async first() {
          return sql.startsWith('SELECT data')
            ? { data: JSON.stringify(tools[0].server) }
            : { status: 'denied' }
        },
      }
      return statement
    },
  },
}
Object.assign(tools[0].server, {
  id: 'notes',
  enabled: true,
  disabledTools: [],
  tools: [tools[0].tool],
})
const runtime = new ToolRuntime(tools, env, false, { index: -1 }, new Map())
runtime.catalog.load({ names: ['mcp_0'] })
const run = async (input) => {
  const iterator = runtime.batch([{ name: 'mcp_0', input }], new AbortController().signal)
  for (;;) {
    const next = await iterator.next()
    if (next.done) return next.value[0]
  }
}
assert.equal((await run({ title: 'Note', data: { a: 1, b: 2 } })).isError, true)
assert.equal((await run({ data: { b: 2, a: 1 }, title: 'Note' })).isError, true)
assert.equal(
  approvals,
  1,
  'A declined action must not solicit the same approval again in this request'
)
assert.equal(executions, 0)
assert.equal((await run({ title: 'Different note' })).isError, true)
assert.equal(approvals, 2, 'Distinct actions retain their own approval')
const originalFetch = globalThis.fetch
try {
  const events = [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'oversized', name: 'tool', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: 'x'.repeat(16001) },
    },
  ]
  globalThis.fetch = async () =>
    new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  await assert.rejects(async () => {
    for await (const _event of anthropicReply(
      { system: '', messages: [{ role: 'user', content: 'test' }] },
      {
        UPSTREAM_PROTOCOL: 'anthropic',
        UPSTREAM_MODEL: 'test',
        UPSTREAM_API_KEY: 'mock',
        UPSTREAM_BASE_URL: 'https://example.com',
        DB: {
          prepare() {
            return {
              async all() {
                return { results: [] }
              },
            }
          },
        },
      },
      new AbortController().signal
    )) {
      /* Consume until oversized arguments are rejected. */
    }
  }, /Tool arguments exceed/)
} finally {
  globalThis.fetch = originalFetch
}
console.log(
  'PASS: private URL boundaries, session and JSON validation, incomplete response reasons, bounded cached evidence and enforced MCP denial'
)
