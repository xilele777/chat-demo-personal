import { readServerSentEvents, type ServerSentEvent } from '../src/services/api/sse.js'

type Item = {
  type: string
  id?: string
  call_id?: string
  name?: string
  arguments?: string
  summary?: { text?: string }[]
  content?: { type: string; text?: string; refusal?: string }[]
  [key: string]: unknown
}
type ResponseEvent = {
  type?: string
  delta?: string
  output_index?: number
  item?: Item
  response?: {
    model?: string
    output?: Item[]
    usage?: Record<string, unknown>
    error?: { message?: string }
    incomplete_details?: { reason?: string }
  }
}
const event = (value: Record<string, unknown>): ServerSentEvent => ({
  event: 'message',
  data: JSON.stringify(value),
  lastEventId: '',
})
const delta = (value: Record<string, unknown>) => event({ choices: [{ delta: value }] })

/** Normalize public Responses text/summary and calls; encrypted reasoning stays opaque. */
export async function* readOpenAIEvents(stream: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const items = new Map<number, Item>()
  const textStreamed = new Set<number>()
  const reasoningStreamed = new Set<number>()
  for await (const raw of readServerSentEvents(stream, signal)) {
    if (raw.data === '[DONE]') {
      yield raw
      continue
    }
    const value = JSON.parse(raw.data) as ResponseEvent
    if (!value.type?.startsWith('response.')) {
      yield raw
      continue
    }
    const index = value.output_index ?? 0
    if (value.response?.model?.trim()) {
      yield event({ model: value.response.model })
    }
    switch (value.type) {
      case 'response.output_text.delta':
        textStreamed.add(index)
        yield delta({ content: value.delta ?? '' })
        break
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        reasoningStreamed.add(index)
        yield delta({ reasoning_content: value.delta ?? '' })
        break
      case 'response.refusal.delta':
        textStreamed.add(index)
        yield delta({ refusal: value.delta ?? '', content: value.delta ?? '' })
        break
      case 'response.output_item.done': {
        const item = value.item
        if (!item) {
          break
        }
        items.set(index, item)
        if (item.type === 'function_call') {
          yield delta({
            tool_calls: [
              {
                index,
                id: item.call_id,
                type: 'function',
                function: { name: item.name, arguments: item.arguments ?? '{}' },
              },
            ],
          })
        } else if (item.type === 'reasoning' && !reasoningStreamed.has(index)) {
          const summary = item.summary?.map((part) => part.text ?? '').join('')
          if (summary) {
            yield delta({ reasoning_content: summary })
          }
        } else if (item.type === 'message' && !textStreamed.has(index)) {
          for (const part of item.content ?? []) {
            if (part.type === 'output_text' && part.text) {
              yield delta({ content: part.text })
            }
            if (part.type === 'refusal' && part.refusal) {
              yield delta({ refusal: part.refusal, content: part.refusal })
            }
          }
        }
        break
      }
      case 'response.failed':
        yield event({
          error: { message: value.response?.error?.message ?? 'Responses request failed' },
        })
        break
      case 'response.completed':
      case 'response.incomplete': {
        const output = value.response?.output ?? [...items.values()]
        const finish =
          value.type === 'response.incomplete'
            ? value.response?.incomplete_details?.reason === 'content_filter'
              ? 'content_filter'
              : 'length'
            : output.some((item) => item.type === 'function_call')
              ? 'tool_calls'
              : 'stop'
        yield event({
          choices: [{ delta: {}, finish_reason: finish }],
          usage: value.response?.usage,
          provider_output: output,
        })
        yield { event: 'message', data: '[DONE]', lastEventId: '' }
        return
      }
    }
  }
}

/** Reuse complete output items within a tool loop, including opaque reasoning signatures. */
export const responsesInput = (
  messages: { role: string; content: unknown; [key: string]: unknown }[]
) =>
  messages.flatMap((message): Record<string, unknown>[] => {
    if (message.role === 'tool') {
      return [
        {
          type: 'function_call_output',
          call_id: message.tool_call_id,
          output: String(message.content),
        },
      ]
    }
    if (Array.isArray(message.provider_output)) {
      return message.provider_output as Record<string, unknown>[]
    }
    const content = Array.isArray(message.content)
      ? message.content.map((block) => {
          if (block.type === 'image_url') {
            return { type: 'input_image', image_url: block.image_url.url }
          }
          return { type: 'input_text', text: block.text ?? '' }
        })
      : message.content
    const result: Record<string, unknown>[] =
      typeof content === 'string' && !content.trim() ? [] : [{ role: message.role, content }]
    for (const call of (message.tool_calls ?? []) as {
      id: string
      function: { name: string; arguments: string }
    }[]) {
      result.push({
        type: 'function_call',
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })
    }
    return result
  })
