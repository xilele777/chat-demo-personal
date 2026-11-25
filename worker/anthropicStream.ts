import { readServerSentEvents } from '../src/services/api/sse.js'
import { HttpError } from './types.js'

export type Block = {
  type: string
  text?: string
  source?: { file_id?: string; [key: string]: unknown }
  [key: string]: unknown
}

/** Consume one protocol stream; the caller owns the agent/tool loop. */
export async function* consumeAnthropic(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  state: { index: number }
): AsyncGenerator<
  Record<string, unknown>,
  {
    blocks: Map<number, Block>
    inputs: Map<number, string>
    usage: Record<string, number>
    stop: string
  }
> {
  const blocks = new Map<number, Block>()
  const inputs = new Map<number, string>()
  const visible = new Map<number, number>()
  const usage: Record<string, number> = {}
  let stop = ''
  let ended = false
  for await (const raw of readServerSentEvents(body, signal)) {
    const event = JSON.parse(raw.data)
    if (event.type === 'error') {
      throw new HttpError(502, event.error?.message ?? 'Provider stream error')
    }
    if (event.type === 'message_start') {
      Object.assign(usage, event.message?.usage ?? {})
      continue
    }
    if (event.type === 'content_block_start') {
      blocks.set(event.index, { ...event.content_block })
      if (['text', 'thinking'].includes(event.content_block.type)) {
        visible.set(event.index, ++state.index)
        yield { ...event, index: state.index }
      }
    } else if (event.type === 'content_block_delta') {
      const block = blocks.get(event.index)
      if (block) {
        if (event.delta.type === 'input_json_delta') {
          if (typeof event.delta.partial_json !== 'string') {
            throw new HttpError(502, 'Invalid tool argument delta')
          }
          const input = (inputs.get(event.index) ?? '') + event.delta.partial_json
          if (input.length > 16000) {
            throw new HttpError(502, 'Tool arguments exceed the allowed size')
          }
          inputs.set(event.index, input)
        } else if (event.delta.type === 'text_delta') {
          block.text = (block.text ?? '') + event.delta.text
        } else if (event.delta.type === 'thinking_delta') {
          block.thinking = String(block.thinking ?? '') + event.delta.thinking
        } else if (event.delta.type === 'signature_delta') {
          block.signature = String(block.signature ?? '') + event.delta.signature
        }
      }
      if (visible.has(event.index)) {
        yield { ...event, index: visible.get(event.index) }
      }
    } else if (event.type === 'content_block_stop') {
      if (visible.has(event.index)) {
        yield { ...event, index: visible.get(event.index) }
      }
    } else if (event.type === 'message_delta') {
      stop = event.delta.stop_reason ?? stop
      Object.assign(usage, event.usage ?? {})
    } else if (event.type === 'message_stop') {
      ended = true
      break
    }
  }
  if (!ended || !stop) {
    throw new HttpError(502, 'Upstream stream ended before completion')
  }
  return { blocks, inputs, usage, stop }
}
