import { contextCost } from './context.js'
import { tokenBudgets, toolResultLimits } from './policy.js'
import type { Env } from './types.js'

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** This tool bridge supports textual evidence, not base64 image/audio tokens. */
export const mcpResultText = (result: Record<string, unknown>): string =>
  JSON.stringify({
    content: Array.isArray(result.content)
      ? result.content.map((block) => {
          if (!record(block)) {
            return block
          }
          if (block.type === 'image' || block.type === 'audio') {
            const metadata = { ...block }
            delete metadata.data
            return {
              ...metadata,
              binary_omitted: true,
              message: 'Binary content is not available as textual evidence.',
            }
          }
          if (block.type === 'resource' && record(block.resource) && 'blob' in block.resource) {
            const resource = { ...block.resource }
            delete resource.blob
            return { ...block, resource, binary_omitted: true }
          }
          return block
        })
      : [],
    ...(result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent }
      : {}),
  })

/** Request-local full results: large payloads are inspected in slices without repeating remote actions. */
export class ToolResults {
  readonly name = 'read_tool_result'
  private readonly results = new Map<string, string>()
  private readonly budget: number
  private readonly limits
  private bytes = 0
  constructor(env: Env) {
    this.budget = Math.min(3000, Math.floor(tokenBudgets(env).input / 8))
    this.limits = toolResultLimits(env)
  }
  get size() {
    return { bytes: this.bytes, entries: this.results.size }
  }
  remember(text: string, preview = text): string {
    const bytes = text.length * 2
    const reason =
      bytes > this.limits.resultBytes
        ? 'result_limit'
        : this.bytes + bytes > this.limits.cacheBytes
          ? 'cache_limit'
          : this.results.size >= this.limits.entries
            ? 'entry_limit'
            : undefined
    const id = reason ? undefined : crypto.randomUUID()
    if (id) {
      this.results.set(id, text)
      this.bytes += bytes
    }
    const metadata = id
      ? { result_id: id }
      : {
          cache_status: 'not_cached',
          cache_reason: reason,
          truncated: true,
          message: 'Cache limit reached; omitted data unavailable. Do not replay actions.',
        }
    if (preview !== text || contextCost(text) <= this.budget) {
      try {
        const value = JSON.parse(preview)
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          delete value.result_id
          const encoded = JSON.stringify({ ...value, ...metadata })
          if (contextCost(encoded) <= this.budget) {
            return encoded
          }
        }
      } catch {
        // Plain error messages stay readable; large results always carry a cache reference.
      }
    }
    const fragment = preview !== text ? preview : text
    const serialize = (end: number) =>
      JSON.stringify({
        type: 'tool_result_excerpt',
        ...metadata,
        total_characters: text.length,
        text: fragment.slice(0, end),
        ...(id && preview === text ? { next_offset: end } : {}),
        truncated: true,
        ...(id
          ? {
              message:
                'Full result cached; use read_tool_result for omitted evidence. Do not repeat actions.',
            }
          : {}),
      })
    let end = Math.min(fragment.length, this.budget * 3)
    while (contextCost(serialize(end)) > this.budget && end > 0) {
      end = Math.floor(end * 0.75)
    }
    return serialize(end)
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
