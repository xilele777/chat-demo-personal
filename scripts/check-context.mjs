import assert from 'node:assert/strict'
import { contextCost, limitContext, CONTINUE_PROMPT } from '../worker/context.ts'
import { toRequestMessages } from '../src/services/chat/reply.ts'

const user = (id, content) => ({ id, role: 'user', content, files: [], createdAt: 1 })
const reply = (id, text) => ({
  id,
  role: 'assistant',
  createdAt: 2,
  status: 'done',
  blocks: [{ type: 'text', text }],
})
const history = Array.from({ length: 100 }, (_, index) => [
  user(`q${index}`, 'Q'.repeat(1000)),
  reply(`a${index}`, 'A'.repeat(1000)),
]).flat()
const messages = toRequestMessages(history, user('latest', '本轮问题'))
const converted = messages.map((message) => ({
  ...message,
  content: Array.isArray(message.content)
    ? message.content.map((block) => block.text ?? '').join('')
    : message.content,
}))
const limited = limitContext('system', converted, { MAX_INPUT_TOKENS: '4096' })
assert.equal(limited.at(-1).content, '本轮问题')
assert.equal(limited[0].role, 'user')
assert.ok(limited.length < 10)
for (let index = 0; index < limited.length - 1; index += 2) {
  assert.equal(limited[index].role, 'user')
  assert.equal(limited[index + 1].role, 'assistant')
}
assert.equal(contextCost('中文'), 6)
assert.equal(contextCost([{ type: 'image_url' }]), 4096)
assert.throws(
  () =>
    limitContext('system', [{ role: 'user', content: 'X'.repeat(5000) }], {
      MAX_INPUT_TOKENS: '4096',
    }),
  /exceed the input budget/
)
assert.throws(
  () =>
    limitContext(
      'system',
      [
        { role: 'user', content: 'X'.repeat(5000) },
        { role: 'assistant', content: 'partial' },
        { role: 'user', content: CONTINUE_PROMPT },
      ],
      { MAX_INPUT_TOKENS: '4096' }
    ),
  /exceed the input budget/
)
const searched = {
  ...reply('searched', '答案 [citation:1]'),
  blocks: [
    {
      type: 'server_tool_use',
      id: 's',
      name: 'deepseek_web_search',
      kind: 'search',
      input: { action: 'search', query: '主题' },
    },
    {
      type: 'web_search_tool_result',
      tool_use_id: 's',
      kind: 'search',
      content: [
        {
          type: 'web_search_result',
          url: 'https://example.com/source',
          title: '来源',
          snippet: '独特的来源证据',
        },
      ],
    },
    { type: 'text', text: '答案 [citation:1]' },
  ],
}
const native = JSON.stringify(
  toRequestMessages([user('q', '问题'), searched], user('next', '追问'))
)
assert.equal(native.includes('独特的来源证据'), false)
assert.equal(native.includes('[citation:1]'), true)
const generic = JSON.stringify(
  toRequestMessages(
    [user('q', '问题'), searched],
    user('next', '追问'),
    undefined,
    false,
    undefined,
    true
  )
)
assert.equal(generic.includes('独特的来源证据'), true)
assert.equal(generic.includes('https://example.com/source'), true)
assert.equal(generic.includes('[historical-source:1]'), true)
assert.equal(generic.includes('[citation:1]'), false)
const broken = { ...reply('error', '不应进入上下文'), status: 'error' }
assert.equal(
  toRequestMessages([user('broken', '失败问题'), broken], user('latest', '有效问题')).length,
  1
)
console.log(
  'PASS: bounded complete context rounds, current question and continuation preservation, UTF-8/image budgets, retained historical sources, citation isolation and failed-round filtering'
)
