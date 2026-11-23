import assert from 'node:assert/strict'
import { openAIStream } from '../worker/upstream.ts'
import { responsesInput } from '../worker/openaiResponses.ts'

const wire = (values) =>
  values.map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join('')
const convert = async (values) =>
  (
    await openAIStream(
      new Response(wire(values), { headers: { 'Content-Type': 'text/event-stream' } }),
      new AbortController().signal,
      'test'
    ).text()
  )
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
const summary = {
  type: 'reasoning',
  id: 'reason',
  summary: [{ text: '公开摘要' }],
  encrypted_content: 'opaque-private-signature',
}
let events = await convert([
  { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: '公开' },
  { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: '摘要' },
  { type: 'response.output_item.done', output_index: 0, item: summary },
  { type: 'response.output_text.delta', output_index: 1, delta: '回答' },
  {
    type: 'response.completed',
    response: {
      output: [summary],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
        output_tokens_details: { reasoning_tokens: 30 },
      },
    },
  },
])
assert.equal(
  events
    .filter((event) => event.delta?.type === 'thinking_delta')
    .map((event) => event.delta.thinking)
    .join(''),
  '公开摘要'
)
assert.equal(JSON.stringify(events).includes('opaque-private-signature'), false)
assert.deepEqual(events.findLast((event) => event.type === 'message_delta').usage, {
  input_tokens: 70,
  cache_read_input_tokens: 20,
  cache_creation_input_tokens: 10,
  output_tokens: 50,
  reasoning_tokens: 30,
  cache_reported: true,
})
events = await convert([
  { type: 'response.output_item.done', output_index: 0, item: summary },
  { type: 'response.completed', response: { output: [summary] } },
])
assert.ok(events.some((event) => event.delta?.thinking === '公开摘要'))
events = await convert([
  {
    type: 'response.incomplete',
    response: { output: [], incomplete_details: { reason: 'max_output_tokens' } },
  },
])
assert.equal(
  events.findLast((event) => event.type === 'message_delta').delta.stop_reason,
  'max_tokens'
)
assert.deepEqual(
  responsesInput([
    { role: 'assistant', content: '', provider_output: [summary] },
    { role: 'tool', tool_call_id: 'call', content: 'value' },
  ]),
  [summary, { type: 'function_call_output', call_id: 'call', output: 'value' }]
)
assert.equal(
  responsesInput([
    {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
    },
  ])[0].content[0].type,
  'input_image'
)
console.log('PASS: Responses public summaries, opaque signatures, cache-write usage, images and output limits')
