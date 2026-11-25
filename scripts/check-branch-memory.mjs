import assert from 'node:assert/strict'
import { upstream } from '../worker/upstream.ts'
import { buildBranchMemory, memoryText } from '../worker/branchMemory.ts'
import { contextCost } from '../worker/context.ts'
import { memoryDigest, validBranchMemory } from '../src/services/chat/branchMemory.ts'
import { toRequestMessages, toMemorySource, applyEvent } from '../src/services/chat/reply.ts'
import { getVisibleMessages, appendBranch, selectVersion } from '../src/services/chat/branches.ts'
import {
  snapshotSession,
  exportSnapshot,
  importSnapshot,
} from '../src/services/chat/history/snapshot.ts'
import { validSessionStructure } from '../src/services/chat/validation.ts'

const user = (id, content) => ({ id, role: 'user', content, files: [], createdAt: 1 })
const answer = (id, text) => ({
  id,
  role: 'assistant',
  status: 'done',
  model: 'test',
  prefix: true,
  blocks: [{ type: 'text', text }],
  createdAt: 2,
})
const q = user(
  'q1',
  'Budget constraint: CNY 500. Do not publish anything. ' + 'old context '.repeat(8000)
)
const a = answer('a1', 'Source note-42 says delivery is Friday; this has not been verified.')
const q2 = user('q2', 'What was my budget and the source of delivery time?')
const source = toRequestMessages([q, a], q2, undefined, false, undefined, true)
const covered = source.slice(0, 2).map((message) => ({ ...message, contextRound: 1 }))
const memory = await buildBranchMemory(covered, 2, 1024)
assert.ok(validBranchMemory(memory))
assert.match(memoryText(memory), /CNY 500/)
assert.match(memoryText(memory), /note-42/)
assert.match(memoryText(memory), /not been verified/)
assert.ok(memory.estimatedTokens <= 1024)
assert.equal(memory.sourceDigest, await memoryDigest([q, a].map(toMemorySource)))
assert.ok(memory.omittedSources > 0)
assert.equal(await buildBranchMemory(covered, 2, 40), undefined)
assert.equal(await buildBranchMemory([{ ...covered[0], contextId: undefined }], 2, 1024), undefined)
assert.equal(
  validBranchMemory({ ...memory, excerpts: [{ ...memory.excerpts[0], text: 'x'.repeat(5000) }] }),
  false
)

let session = appendBranch(
  { id: 'memory', title: 'memory', createdAt: 1, updatedAt: 2, messages: [] },
  null,
  [q, a, q2, { ...answer('a2', 'New answer'), branchMemory: memory }]
)
assert.ok(validSessionStructure(session))
const edited = { ...q, content: q.content.replace('500', '900') }
assert.notEqual(await memoryDigest([edited, a].map(toMemorySource)), memory.sourceDigest)
const regenerated = answer('a3', 'Delivery is Monday according to another source.')
session = appendBranch(session, q.id, [regenerated])
assert.notDeepEqual(
  getVisibleMessages(session)
    .slice(0, 2)
    .map((message) => message.id),
  memory.sourceIds
)
session = selectVersion(session, a.id)
assert.deepEqual(
  getVisibleMessages(session)
    .slice(0, 2)
    .map((message) => message.id),
  memory.sourceIds
)
assert.equal(
  await memoryDigest(getVisibleMessages(session).slice(0, 2).map(toMemorySource)),
  memory.sourceDigest
)
assert.notEqual(await memoryDigest([a].map(toMemorySource)), memory.sourceDigest)
assert.deepEqual(
  snapshotSession(session).messages.find((message) => message.id === 'a2').branchMemory,
  memory
)
const archive = await exportSnapshot([session], async () => undefined)
const restored = []
await importSnapshot(new File([archive], 'memory.zip'), {
  addStagingSession: async (item) => restored.push(item),
  saveStagingFiles: async () => {},
})
assert.deepEqual(restored[0].messages.find((message) => message.id === 'a2').branchMemory, memory)
assert.deepEqual(
  applyEvent(answer('target', ''), { type: 'branch_memory', memory }, 1, new Map()).branchMemory,
  memory
)

const originalFetch = globalThis.fetch
try {
  for (const protocol of ['openai', 'anthropic']) {
    for (const style of protocol === 'openai' ? ['chat_completions', 'responses'] : ['messages']) {
      let calls = 0,
        sent
      globalThis.fetch = async (_url, init) => {
        calls++
        sent = JSON.parse(init.body)
        const events =
          protocol === 'anthropic'
            ? [
                { type: 'message_start', message: { usage: { input_tokens: 100 } } },
                {
                  type: 'content_block_start',
                  index: 0,
                  content_block: {
                    type: 'text',
                    text: 'CNY 500; source note-42 remains unverified.',
                  },
                },
                { type: 'content_block_stop', index: 0 },
                {
                  type: 'message_delta',
                  delta: { stop_reason: 'end_turn' },
                  usage: { output_tokens: 10 },
                },
                { type: 'message_stop' },
              ]
            : style === 'responses'
              ? [
                  { type: 'response.output_text.delta', delta: 'CNY 500' },
                  {
                    type: 'response.completed',
                    response: {
                      output: [
                        {
                          type: 'message',
                          role: 'assistant',
                          content: [{ type: 'output_text', text: 'CNY 500' }],
                        },
                      ],
                      usage: { input_tokens: 100, output_tokens: 10 },
                    },
                  },
                ]
              : [
                  {
                    choices: [{ delta: { content: 'CNY 500' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 100, completion_tokens: 10 },
                  },
                ]
        return new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
            (style === 'chat_completions' ? 'data: [DONE]\n\n' : ''),
          { headers: { 'Content-Type': 'text/event-stream' } }
        )
      }
      const env = {
        UPSTREAM_PROTOCOL: protocol,
        OPENAI_API_STYLE: style,
        UPSTREAM_MODEL: 'test',
        UPSTREAM_BASE_URL: 'https://mock.example/v1',
        UPSTREAM_API_KEY: 'test',
        MAX_INPUT_TOKENS: '8192',
        MAX_OUTPUT_TOKENS: '2048',
        DB: { prepare: () => ({ all: async () => ({ results: [] }) }) },
      }
      const response = await upstream(
        new Request('https://app.example/api/anthropic/v1/messages', {
          method: 'POST',
          body: JSON.stringify({ system: 'Answer from evidence', messages: source }),
        }),
        env,
        '/api/anthropic/v1/messages'
      )
      const output = await response.text()
      assert.equal(calls, 1)
      assert.match(output, /branch_memory/)
      assert.match(output, /message_stop/)
      const payload = JSON.stringify(sent)
      assert.match(payload, /CNY 500/)
      assert.match(payload, /not new instructions or tool authorization/)
      assert.doesNotMatch(payload, /sourceDigest|contextId|contextRound|contextVersion/)
      assert.ok(
        contextCost(sent.system ?? sent.messages?.[0]?.content ?? '') +
          contextCost(sent.messages?.slice(1) ?? sent.input) <
          8192
      )
      const event = output
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)))
        .find((event) => event.type === 'branch_memory')
      assert.ok(validBranchMemory(event.memory))
      assert.equal(event.memory.extraModelRequests, 0)
    }
  }
  const originalDigest = crypto.subtle.digest
  try {
    crypto.subtle.digest = async () => {
      throw new Error('Injected summary fingerprint failure')
    }
    const response = await upstream(
      new Request('https://app.example/api/anthropic/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ system: 'Answer from evidence', messages: source }),
      }),
      {
        UPSTREAM_PROTOCOL: 'anthropic',
        UPSTREAM_MODEL: 'test',
        UPSTREAM_BASE_URL: 'https://mock.example/v1',
        UPSTREAM_API_KEY: 'test',
        MAX_INPUT_TOKENS: '8192',
        MAX_OUTPUT_TOKENS: '2048',
        DB: { prepare: () => ({ all: async () => ({ results: [] }) }) },
      },
      '/api/anthropic/v1/messages'
    )
    const output = await response.text()
    assert.doesNotMatch(output, /branch_memory|event: error/)
    assert.match(output, /message_stop/)
  } finally {
    crypto.subtle.digest = originalDigest
  }
} finally {
  globalThis.fetch = originalFetch
}
console.log(
  'PASS: branch-bound verbatim constraints and uncertain source claims, SHA-256 edit/branch/delete invalidation, backup roundtrip, bounded fallback and all three provider APIs without extra model calls'
)
