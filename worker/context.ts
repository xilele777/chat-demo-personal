import { HttpError, type Env } from './types.js'
import { tokenBudgets } from './policy.js'

export type ContextMessage = { role: string; content: unknown; [key: string]: unknown }
export const CONTINUE_PROMPT =
  'Continue the previous answer from exactly where it stopped. Do not repeat the existing answer.'

// Approximate tokens, not UTF-8 bytes: ASCII averages 3 characters/token,
// non-ASCII reserves 2 tokens/code point. Images reserve 4096 tokens each.
// Trim complete old rounds, never part of the latest user question or a tool exchange.
export const contextCost = (content: unknown): number => {
  if (typeof content === 'string') {
    let ascii = 0
    let other = 0
    for (const character of content) {
      if (character.charCodeAt(0) < 128) {
        ascii++
      } else {
        other++
      }
    }
    return Math.ceil(ascii / 3) + other * 2
  }
  if (Array.isArray(content)) {
    return content.reduce(
      (sum, block) =>
        sum +
        (block.type === 'image' || block.type === 'image_url'
          ? 4096
          : contextCost(block.text) +
            contextCost(block.content) +
            contextCost(block.input ? JSON.stringify(block.input) : '')),
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
  const limit = tokenBudgets(env).input
  const result = [...messages]
  if (contextCost(system) + 16 >= limit) {
    throw new HttpError(
      422,
      '系统提示和 MCP 工具定义超过输入预算。请在设置中减少启用的工具，或提高 MAX_INPUT_TOKENS。'
    )
  }
  const messageCost = (message: T) =>
    16 +
    contextCost(message.content) +
    contextCost(JSON.stringify(message.tool_calls ?? '')) +
    contextCost(JSON.stringify(message.provider_output ?? ''))
  const costs = result.map(messageCost)
  let cost = contextCost(system) + costs.reduce((sum, value) => sum + value, 0)
  while (cost > limit) {
    const next = result.findIndex(
      (message, index) =>
        index > 0 &&
        message.role === 'user' &&
        message.content !== CONTINUE_PROMPT &&
        !(
          Array.isArray(message.content) &&
          message.content.some((block) => block.type === 'tool_result')
        )
    )
    if (next < 0) {
      throw new HttpError(
        422,
        result.some(
          (message) =>
            message.role === 'tool' ||
            (Array.isArray(message.content) &&
              message.content.some((block) => block.type === 'tool_result'))
        )
          ? '本轮工具结果超过输入预算。请减少工具返回内容，或提高 MAX_INPUT_TOKENS。'
          : '本轮问题和附件超过输入预算。请缩短问题、减少附件，或提高 MAX_INPUT_TOKENS。'
      )
    }
    result.splice(0, next)
    cost -= costs.splice(0, next).reduce((sum, value) => sum + value, 0)
  }
  return result
}
