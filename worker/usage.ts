import type { MessageUsage } from '../src/services/api/types.js'
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
export const openAIUsage = (usage: Record<string, unknown>): MessageUsage => {
  const details = usage.prompt_tokens_details as { cached_tokens?: unknown } | undefined
  const completion = usage.completion_tokens_details as { reasoning_tokens?: unknown } | undefined
  const input = count(usage.prompt_tokens ?? usage.input_tokens)
  const cached = Math.min(
    input,
    count(details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens)
  )
  const created = Math.min(input - cached, count(usage.cache_creation_input_tokens))
  return {
    input_tokens: input - cached - created,
    cache_creation_input_tokens: created,
    cache_read_input_tokens: cached,
    output_tokens: count(usage.completion_tokens ?? usage.output_tokens),
    ...(completion?.reasoning_tokens !== undefined || usage.reasoning_tokens !== undefined
      ? { reasoning_tokens: count(completion?.reasoning_tokens ?? usage.reasoning_tokens) }
      : {}),
    cache_reported:
      details?.cached_tokens !== undefined ||
      usage.prompt_cache_hit_tokens !== undefined ||
      usage.cache_read_input_tokens !== undefined,
  }
}
