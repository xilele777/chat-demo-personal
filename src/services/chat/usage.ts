import type { MessageUsage } from '../api/types.js'
const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
export const inputTokens = (usage: MessageUsage) =>
  number(usage.input_tokens) +
  number(usage.cache_creation_input_tokens) +
  number(usage.cache_read_input_tokens)
export const totalTokens = (usage: MessageUsage) => inputTokens(usage) + number(usage.output_tokens)
/** Merge cumulative provider frames; absent values preserve earlier counts, explicit zero replaces them. */
export const mergeUsageSnapshot = (
  left: MessageUsage | undefined,
  right: Partial<MessageUsage> | undefined
): MessageUsage | undefined => {
  if (!right) {
    return left
  }
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...left,
    ...right,
  }
}
export const addUsage = (
  left: MessageUsage | undefined,
  right: MessageUsage | undefined
): MessageUsage | undefined => {
  if (!left && !right) {
    return undefined
  }
  return {
    input_tokens: number(left?.input_tokens) + number(right?.input_tokens),
    output_tokens: number(left?.output_tokens) + number(right?.output_tokens),
    cache_creation_input_tokens:
      number(left?.cache_creation_input_tokens) + number(right?.cache_creation_input_tokens),
    cache_read_input_tokens:
      number(left?.cache_read_input_tokens) + number(right?.cache_read_input_tokens),
    ...(left?.reasoning_tokens !== undefined || right?.reasoning_tokens !== undefined
      ? { reasoning_tokens: number(left?.reasoning_tokens) + number(right?.reasoning_tokens) }
      : {}),
    cache_reported: [left, right].every(
      (usage) =>
        !usage ||
        (usage.cache_reported ??
          Boolean(usage.cache_read_input_tokens || usage.cache_creation_input_tokens))
    ),
  }
}
