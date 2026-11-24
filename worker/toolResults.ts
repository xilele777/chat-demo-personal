import { contextCost } from './context.js'
import { tokenBudgets } from './policy.js'
import type { Env } from './types.js'

/** Request-local full results: large payloads are inspected in slices without repeating remote actions. */
export class ToolResults {
  readonly name = 'read_tool_result'
  private readonly results = new Map<string, string>()
  private readonly budget: number
  constructor(env: Env) {
    this.budget = Math.min(3000, Math.floor(tokenBudgets(env).input / 8))
  }
  remember(text: string, preview = text): string {
    const id = crypto.randomUUID()
    this.results.set(id, text)
    if (preview !== text || contextCost(text) <= this.budget) {
      try {
        const value = JSON.parse(preview)
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return JSON.stringify({ ...value, result_id: id })
        }
      } catch {
        // Plain error messages stay readable; large results always carry a cache reference.
      }
      return preview
    }
    let end = Math.min(text.length, this.budget * 3)
    while (contextCost(text.slice(0, end)) > this.budget) {
      end = Math.floor(end * 0.75)
    }
    return JSON.stringify({
      type: 'tool_result_excerpt',
      result_id: id,
      total_characters: text.length,
      text: text.slice(0, end),
      next_offset: end,
      truncated: true,
      message:
        'The full result is cached for this request. Use read_tool_result for omitted sections; do not repeat the remote action.',
    })
  }
  definition(protocol: 'openai' | 'anthropic'): Record<string, unknown> {
    const name = this.name
    const description =
      'Read an omitted section of a cached tool result by result_id. Use offset or find to locate evidence. No remote service is called.'
    const parameters = {
      type: 'object',
      properties: {
        result_id: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 16000 },
        find: { type: 'string', maxLength: 200 },
      },
      required: ['result_id'],
      additionalProperties: false,
    }
    return protocol === 'openai'
      ? { type: 'function', function: { name, description, parameters } }
      : { name, description, input_schema: parameters }
  }
  read(input: Record<string, unknown>): string {
    const value =
      typeof input.result_id === 'string' ? this.results.get(input.result_id) : undefined
    if (value === undefined) {
      return JSON.stringify({
        error: 'Unknown result_id. Results are available only within the current request.',
      })
    }
    let offset =
      Number.isSafeInteger(input.offset) && Number(input.offset) >= 0 ? Number(input.offset) : 0
    if (typeof input.find === 'string' && input.find) {
      const position = value.toLowerCase().indexOf(input.find.slice(0, 200).toLowerCase(), offset)
      if (position < 0) {
        return JSON.stringify({
          result_id: input.result_id,
          error: 'Text not found in the remaining result.',
        })
      }
      offset = Math.max(offset, position - 500)
    }
    const limit = Number.isSafeInteger(input.limit)
      ? Math.max(1, Math.min(16000, Number(input.limit)))
      : 8000
    const found =
      typeof input.find === 'string' && input.find
        ? value.toLowerCase().indexOf(input.find.slice(0, 200).toLowerCase(), offset)
        : -1
    const serialize = (end: number) =>
      JSON.stringify({
        type: 'tool_result_excerpt',
        result_id: input.result_id,
        offset,
        text: value.slice(offset, end),
        total_characters: value.length,
        ...(end < value.length ? { next_offset: end, truncated: true } : {}),
      })
    // A character limit alone can still overflow for CJK text or escaped JSON.
    // Include the envelope, and keep a requested match instead of only its preamble.
    let end = Math.min(value.length, offset + limit)
    while (contextCost(serialize(end)) > this.budget && end > offset) {
      if (found >= 0 && (found >= end || found - offset > (end - offset) / 2)) {
        offset = found
        end = Math.min(value.length, offset + limit)
      } else {
        end = offset + Math.floor((end - offset) * 0.75)
      }
    }
    return serialize(end)
  }
}
