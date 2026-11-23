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
assert.ok(limited.length < converted.length)
assert.ok(
  contextCost('system') +
    limited.reduce(
      (sum, message) =>
        sum +
        16 +
        contextCost(message.content) +
        contextCost(JSON.stringify(message.tool_calls ?? '')),
      0
    ) <=
    4096
)
for (let index = 0; index < limited.length - 1; index += 2) {
  assert.equal(limited[index].role, 'user')
  assert.equal(limited[index + 1].role, 'assistant')
}
assert.equal(contextCost('中文'), 4)
assert.equal(contextCost('hello world!'), 4)
assert.equal(contextCost([{ type: 'image_url' }]), 4096)
assert.throws(
  () =>
    limitContext('system', [{ role: 'user', content: 'X'.repeat(15000) }], {
      MAX_INPUT_TOKENS: '4096',
    }),
  /本轮问题和附件超过输入预算/
)
assert.throws(
  () =>
    limitContext(
      'system',
      [
        { role: 'user', content: 'X'.repeat(15000) },
        { role: 'assistant', content: 'partial' },
        { role: 'user', content: CONTINUE_PROMPT },
      ],
      { MAX_INPUT_TOKENS: '4096' }
    ),
  /本轮问题和附件超过输入预算/
)
// MCP definitions are fixed overhead in every conversation; a new chat does not remove them.
const tools = JSON.stringify({
  tools: Array.from({ length: 60 }, (_, i) => ({
    name: `tool_${i}`,
    description: 'Description '.repeat(100),
  })),
})
assert.equal(limitContext(tools, [{ role: 'user', content: '你好' }], {}).length, 1)
assert.throws(
  () =>
    limitContext('schema'.repeat(3000), [{ role: 'user', content: '你好' }], {
      MAX_INPUT_TOKENS: '4096',
    }),
  /MCP 工具定义超过输入预算/
)
assert.throws(
  () =>
    limitContext(
      '',
      [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '', tool_calls: [] },
        { role: 'tool', content: 'data'.repeat(4000) },
      ],
      { MAX_INPUT_TOKENS: '4096' }
    ),
  /本轮工具结果超过输入预算/
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
  'PASS: bounded complete context rounds, current question and continuation preservation, token/image estimates, MCP overhead diagnostics, retained historical sources, citation isolation and failed-round filtering'
)
