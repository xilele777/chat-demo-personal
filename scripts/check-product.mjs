import assert from 'node:assert/strict'
import { readDraftTexts, writeDraftTexts } from '../src/services/chat/draftStorage.ts'
import { searchSession } from '../src/services/chat/search.ts'
import { revealMessage, getVisibleMessages } from '../src/services/chat/branches.ts'
import { readMessageEvent } from '../src/services/api/parseEvent.ts'
import { inputTokens, totalTokens, addUsage } from '../src/services/chat/usage.ts'
import { openAIUsage } from '../worker/usage.ts'
import { reasoningText } from '../worker/reasoning.ts'

assert.equal(
  reasoningText({
    reasoning_details: [
      { type: 'reasoning.text', text: '可展示的思考' },
      { type: 'reasoning.encrypted', data: 'secret' },
    ],
  }),
  '可展示的思考'
)
assert.equal(reasoningText({ reasoning: { summary: [{ text: '推理摘要' }] } }), '推理摘要')
assert.equal(
  reasoningText({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'secret' }] }),
  ''
)
assert.equal(reasoningText({ reasoning_content: '标准格式' }), '标准格式')

const data = new Map()
const storage = {
  getItem: (key) => data.get(key) ?? null,
  setItem: (key, value) => data.set(key, value),
  removeItem: (key) => data.delete(key),
}
assert.equal(
  writeDraftTexts(
    storage,
    true,
    new Map([
      [null, { text: '未发送的中文草稿' }],
      ['conversation', { text: '第二个草稿' }],
    ])
  ),
  true
)
assert.equal(readDraftTexts(storage, true).get(null), '未发送的中文草稿')
assert.equal(readDraftTexts(storage, false).size, 0)
assert.equal(
  writeDraftTexts(storage, true, new Map([['conversation', { text: '第二个草稿' }]])),
  true
)
assert.equal(readDraftTexts(storage, true).has(null), false)
writeDraftTexts(storage, true, [])
assert.equal(readDraftTexts(storage, true).size, 0)
assert.equal(
  writeDraftTexts(
    {
      setItem() {
        throw new Error('quota')
      },
      removeItem() {},
    },
    false,
    [[null, { text: 'keep' }]]
  ),
  false
)
assert.equal(readDraftTexts({ getItem: () => 'corrupt' }, true).size, 0)
console.log(
  'PASS: text drafts restore, stay separate by mode, clear after sending, and report storage failures'
)

const session = {
  id: 's',
  title: '研究记录',
  updatedAt: 2,
  rootMessageId: 'q',
  messages: [
    { id: 'q', role: 'user', parentId: null, selectedChildId: 'a', content: '原始问题', files: [] },
    { id: 'a', role: 'assistant', parentId: 'q', blocks: [{ type: 'text', text: '当前版本' }] },
    {
      id: 'b',
      role: 'assistant',
      parentId: 'q',
      selectedChildId: 'q2',
      blocks: [
        { type: 'thinking', thinking: '不应被搜索的秘密' },
        { type: 'text', text: '隐藏分支 Token 100%_value' },
      ],
    },
    {
      id: 'q2',
      role: 'user',
      parentId: 'b',
      selectedChildId: 'b2',
      content: '继续这个分支',
      files: [],
    },
    { id: 'b2', role: 'assistant', parentId: 'q2', blocks: [{ type: 'text', text: '最终结果' }] },
  ],
}
assert.equal(searchSession(session, 'token')[0].messageId, 'b')
assert.equal(searchSession(session, '100%_value')[0].messageId, 'b')
assert.equal(searchSession(session, '秘密').length, 0)
assert.equal(searchSession(session, '研究')[0].messageId, null)
const revealed = revealMessage(session, 'b2')
assert.deepEqual(
  getVisibleMessages(revealed).map((message) => message.id),
  ['q', 'b', 'q2', 'b2']
)
assert.equal(getVisibleMessages(session)[1].id, 'a')
assert.equal(revealMessage(session, 'missing'), session)
console.log(
  'PASS: literal history search excludes thinking and reveals hidden branch ancestors without changing content'
)

const usage = openAIUsage({
  prompt_tokens: 100,
  completion_tokens: 40,
  prompt_tokens_details: { cached_tokens: 30 },
  completion_tokens_details: { reasoning_tokens: 20 },
})
assert.equal(inputTokens(usage), 100)
assert.equal(totalTokens(usage), 140)
assert.equal(totalTokens(addUsage(usage, usage)), 280)
assert.equal(addUsage(undefined, undefined), undefined)
const initial = readMessageEvent({
  type: 'message_start',
  message: { id: 'a', model: 'claude', usage: { input_tokens: 12, output_tokens: 0 } },
})
assert.equal(initial.message.usage.cache_read_input_tokens, 0)
const delta = readMessageEvent({
  type: 'message_delta',
  delta: { stop_reason: 'end_turn' },
  usage: { output_tokens: 15 },
})
assert.equal(delta.usage.output_tokens, 15)
assert.equal(
  readMessageEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }).usage,
  undefined
)
console.log(
  'PASS: cached and reasoning tokens are not double-counted, continuations accumulate, and partial provider usage is accepted'
)
