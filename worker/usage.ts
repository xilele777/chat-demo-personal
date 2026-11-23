import type { MessageUsage } from '../src/services/api/types.js'
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
export const openAIUsage = (usage: Record<string, unknown>): MessageUsage => {
  const details = usage.prompt_tokens_details as { cached_tokens?: unknown } | undefined
  const completion = usage.completion_tokens_details as { reasoning_tokens?: unknown } | undefined
  const cached = Math.min(count(usage.prompt_tokens), count(details?.cached_tokens))
  return {
    input_tokens: count(usage.prompt_tokens) - cached,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
    output_tokens: count(usage.completion_tokens),
    reasoning_tokens: count(completion?.reasoning_tokens),
  }
}
