import type { MessageUsage } from '../src/services/api/types.js'
const count = (value: unknown) =>
  (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
  Number.isFinite(Number(value)) &&
  Number(value) >= 0
    ? Number(value)
    : 0

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

export const hasOpenAIUsage = (usage: Record<string, unknown>) =>
  ['prompt_tokens', 'input_tokens', 'completion_tokens', 'output_tokens'].some((key) => {
    const value = usage[key]
    return (
      (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
      Number.isFinite(Number(value)) &&
      Number(value) >= 0
    )
  })

/** Usage frames are cumulative snapshots, not increments. Keep fields omitted by later frames. */
export const mergeOpenAIUsage = (
  previous: Record<string, unknown> | undefined,
  value: unknown
): Record<string, unknown> | undefined => {
  const next = record(value)
  if (!Object.keys(next).length) {
    return previous
  }
  const result = { ...previous }
  for (const [key, value] of Object.entries(next)) {
    if (value == null) {
      continue
    }
    result[key] = key.endsWith('_details') ? { ...record(result[key]), ...record(value) } : value
  }
  return result
}

export const openAIUsage = (usage: Record<string, unknown>): MessageUsage => {
  const details = record(usage.prompt_tokens_details ?? usage.input_tokens_details)
  const completion = record(usage.completion_tokens_details ?? usage.output_tokens_details)
  const input = count(usage.prompt_tokens ?? usage.input_tokens)
  const cache =
    details.cached_tokens ??
    usage.prompt_cache_hit_tokens ??
    usage.cache_read_input_tokens ??
    usage.cached_tokens
  const reasoning =
    completion.reasoning_tokens ??
    completion.thinking_tokens ??
    usage.reasoning_tokens ??
    usage.thinking_tokens
  const cached = Math.min(input, count(cache))
  const cacheWrite = details.cache_write_tokens ?? usage.cache_creation_input_tokens
  const created = Math.min(input - cached, count(cacheWrite))
  return {
    input_tokens: input - cached - created,
    cache_creation_input_tokens: created,
    cache_read_input_tokens: cached,
    output_tokens: count(usage.completion_tokens ?? usage.output_tokens),
    ...(reasoning !== undefined ? { reasoning_tokens: count(reasoning) } : {}),
    cache_reported: cache !== undefined || cacheWrite !== undefined,
  }
}
