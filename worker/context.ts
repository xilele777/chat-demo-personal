import { HttpError, type Env } from './types.js'

export type ContextMessage = { role: string; content: unknown; [key: string]: unknown }
export const CONTINUE_PROMPT =
  'Continue the previous answer from exactly where it stopped. Do not repeat the existing answer.'

// UTF-8 bytes are a conservative text-token upper bound. Images reserve 4096 tokens each.
// Trim complete old rounds, never part of the latest user question or a tool exchange.
export const contextCost = (content: unknown): number => {
  if (typeof content === 'string') {
    return new TextEncoder().encode(content).length
  }
  if (Array.isArray(content)) {
    return content.reduce(
      (sum, block) =>
        sum +
        (block.type === 'image' || block.type === 'image_url' ? 4096 : contextCost(block.text)),
      0
    )
  }
  return 0
}

export const limitContext = <T extends ContextMessage>(
  system: string,
  messages: T[],
  env: Env
): T[] => {
  const limit = Number(env.MAX_INPUT_TOKENS ?? 24000)
  if (!Number.isFinite(limit) || limit < 1024) {
    throw new HttpError(503, 'Invalid MAX_INPUT_TOKENS')
  }
  const result = [...messages]
  const cost = () =>
    contextCost(system) +
    result.reduce(
      (sum, message) =>
        sum +
        16 +
        contextCost(message.content) +
        contextCost(JSON.stringify(message.tool_calls ?? '')),
      0
    )
  while (cost() > limit) {
    const next = result.findIndex(
      (message, index) =>
        index > 0 && message.role === 'user' && message.content !== CONTINUE_PROMPT
    )
    if (next < 0) {
      throw new HttpError(
        422,
        'The current question and attachments exceed the input budget. Shorten the question or remove attachments.'
      )
    }
    result.splice(0, next)
  }
  return result
}
