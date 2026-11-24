import assert from 'node:assert/strict'
import {
  exportSnapshot,
  importSnapshot,
  snapshotSession,
  checkSnapshotManifest,
} from '../src/services/chat/history/snapshot.ts'
import { readArchive, readEntry } from '../src/services/chat/history/zipReader.ts'
import { writeArchive } from '../src/services/chat/history/zipWriter.ts'
import { getVisibleMessages } from '../src/services/chat/branches.ts'
import { totalTokens } from '../src/services/chat/usage.ts'

const text = new Blob(['shared original 文本'], { type: 'text/plain' })
const image = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2])], { type: 'image/png' })
const attachment = (id, blob, isImage) => ({
  id,
  name: `${id}.file`,
  serverId: 'old-provider-handle',
  imageSizeChecked: true,
  size: blob.size,
  mimeType: blob.type,
  isImage,
})
const question = (id, parentId, selectedChildId) => ({
  id,
  role: 'user',
  content: `Question ${id}`,
  files: [attachment('text', text, false)],
  createdAt: 1,
  parentId,
  selectedChildId,
})
const answer = (id, parentId, selectedChildId) => ({
  id,
  role: 'assistant',
  parentId,
  ...(selectedChildId ? { selectedChildId } : {}),
  createdAt: 2,
  status: 'done',
  prefix: true,
  model: 'selected-model',
  reasoningEffort: 'high',
  thinking: true,
  search: true,
  latestReminder: 'historical reminder',
  processingSeconds: 17.5,
  blocks: [
    {
      type: 'thinking',
      thinking: 'Thought',
      signature: 'opaque-signature',
      startedAt: 1,
      endedAt: 2,
    },
    {
      type: 'text',
      text: 'Answer [citation:1]',
      citations: [
        {
          type: 'web_search_result_location',
          url: 'https://example.com',
          title: 'Evidence',
          cited_text: 'Answer',
          encrypted_index: '',
        },
      ],
    },
  ],
  usage: {
    input_tokens: 100,
    output_tokens: 25,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 5,
    reasoning_tokens: 10,
    cache_reported: true,
  },
  mcpTools: [
    {
      type: 'mcp_tool',
      id: `tool-${id}`,
      server: 'Notes',
      name: 'create_note',
      input: { title: 'Note' },
      status: 'done',
      output: '{"note_id":"123"}',
      approvalId: 'stale-approval',
    },
  ],
})
const original = {
  id: 'conversation',
  title: 'Snapshot',
  pinned: true,
  titleSource: 'manual',
  createdAt: 1,
  updatedAt: 3,
  cloud: { revision: 'remote-revision', generation: 'remote-generation' },
  rootMessageId: 'q1',
  messages: [
    question('q1', null, 'a1'),
    answer('a1', 'q1', 'q2'),
    answer('a1-alt', 'q1', 'q2-alt'),
    question('q2', 'a1', 'a2'),
    question('q2-alt', 'a1-alt', 'a2-alt'),
    answer('a2', 'q2'),
    answer('a2-alt', 'q2-alt'),
  ],
}
original.messages[0].files.push(
  attachment('image', image, true),
  attachment('missing', text, false)
)
const originals = new Map([
  ['text', text],
  ['image', image],
])
const loads = []
const archive = await exportSnapshot([original], async (id) => {
  loads.push(id)
  return originals.get(id)
})
assert.deepEqual(loads, ['text', 'image', 'missing'])
assert.equal(original.cloud.revision, 'remote-revision')
assert.equal(original.messages[0].files[0].serverId, 'old-provider-handle')
assert.equal(original.messages[1].mcpTools[0].approvalId, 'stale-approval')

const staged = [],
  files = []
const storage = {
  addStagingSession: async (s) => {
    staged.push(s)
  },
  saveStagingFiles: async (f) => {
    files.push(...f)
  },
}
const file = (blob) => new File([blob], 'history.zip')
await importSnapshot(file(archive), storage)
assert.deepEqual(staged, [snapshotSession(original)])
assert.deepEqual(
  getVisibleMessages(staged[0]).map((m) => m.id),
  ['q1', 'a1', 'q2', 'a2']
)
assert.equal(staged[0].messages[2].selectedChildId, 'q2-alt')
assert.equal(totalTokens(staged[0].messages[1].usage), 180)
assert.equal(files.length, 2)
for (const restored of files) {
  assert.equal(restored.blob.type, originals.get(restored.id).type)
  assert.deepEqual(
    new Uint8Array(await restored.blob.arrayBuffer()),
    new Uint8Array(await originals.get(restored.id).arrayBuffer())
  )
}
const second = await exportSnapshot(staged, async (id) => files.find((f) => f.id === id)?.blob)
const restoredAgain = []
await importSnapshot(file(second), {
  ...storage,
  addStagingSession: async (s) => {
    restoredAgain.push(s)
  },
})
assert.deepEqual(restoredAgain, staged)
const nonAscii = structuredClone(original)
nonAscii.id = '旧记录 空间-é'
nonAscii.messages[0].files[0].id = '旧附件'
const nonAsciiZip = await exportSnapshot([nonAscii], async () => undefined)
const nonAsciiRestored = []
await importSnapshot(file(nonAsciiZip), {
  ...storage,
  addStagingSession: async (s) => {
    nonAsciiRestored.push(s)
  },
})
assert.equal(nonAsciiRestored[0].id, nonAscii.id)
assert.equal(nonAsciiRestored[0].messages[0].files[0].id, '旧附件')

const entries = []
for await (const entry of readArchive(file(archive))) {
  entries.push({ name: entry.path, blob: await readEntry(entry) })
}
const invalidArchives = [
  async (e) => e.filter((entry) => entry.name !== 'snapshot/files/0'),
  async (e) => e.filter((entry) => entry.name !== 'snapshot/index.json'),
  async (e) =>
    e.map((entry) =>
      entry.name === 'snapshot/files/0' ? { ...entry, blob: text.slice(0, 2) } : entry
    ),
  async (e) => {
    const entry = e.find((entry) => entry.name === 'snapshot/index.json')
    const index = JSON.parse(await entry.blob.text())
    index.files = index.files.slice(1) // Declared original cannot silently disappear.
    entry.blob = new Blob([JSON.stringify(index)])
    return e
  },
  async (e) => {
    const entry = e.find((entry) => entry.name.endsWith('/conversation.json'))
    const session = JSON.parse(await entry.blob.text())
    session.messages[1].parentId = 'missing-parent'
    entry.blob = new Blob([JSON.stringify(session)])
    return e
  },
  async (e) => e.concat({ name: 'snapshot/files/unreferenced', blob: text }),
]
for (const mutate of invalidArchives) {
  const invalid = await writeArchive(await mutate(entries.map((entry) => ({ ...entry }))))
  await assert.rejects(importSnapshot(file(invalid), storage))
}
assert.throws(
  () => checkSnapshotManifest({ format: 'chat-demo-personal', version: 2 }),
  (error) => error.key === 'backupNewerVersion'
)
const live = structuredClone(original)
live.messages[1].status = 'streaming'
live.messages[1].processingStartedAt = 10
live.messages[1].mcpTools[0].status = 'running'
const settled = snapshotSession(live, 1010).messages[1]
assert.equal(settled.status, 'stopped')
assert.equal(settled.processingStartedAt, undefined)
assert.equal(settled.processingSeconds, 18.5)
assert.equal(settled.mcpTools[0].status, 'error')
assert.ok(settled.mcpTools[0].output.includes('unknown'))

// The old migration format remains readable, including its existing lossy semantics.
globalThis.__CLOUD_MODE__ = false
globalThis.__API_ORIGIN__ = 'http://127.0.0.1'
const { toSessionFile } = await import('../src/services/chat/history/toArchive.ts')
const { toLocalSession } = await import('../src/services/chat/history/toLocal.ts')
const { readSessionFile, checkManifest } = await import('../src/services/chat/history/schema.ts')
checkManifest({ export_format_version: 3 })
checkManifest({ format: 'chat-demo-personal', version: 1 })
const legacy = toLocalSession(readSessionFile(toSessionFile(original, () => null)))
assert.equal(legacy.session.messages.length, original.messages.length)
assert.equal(legacy.session.title, original.title)
assert.equal(legacy.session.pinned, true)
console.log(
  'PASS: lossless snapshot round trips, branches/citations/MCP/usage, all available originals, shared files, stale handle removal, interrupted recovery, strict entry validation and legacy compatibility'
)
