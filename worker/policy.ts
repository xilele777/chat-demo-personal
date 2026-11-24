import { HttpError, type Env } from './types.js'

const integer = (
  value: string | undefined,
  fallback: number,
  name: string,
  min = 1,
  max = 1_000_000
) => {
  const result = Number(value ?? fallback)
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new HttpError(503, `Invalid ${name}`)
  }
  return result
}

export const tokenBudgets = (env: Env) => {
  const output = integer(
    env.MAX_OUTPUT_TOKENS,
    env.UPSTREAM_PROTOCOL === 'openai' ? 32768 : 8192,
    'MAX_OUTPUT_TOKENS'
  )
  let input = integer(
    env.MAX_INPUT_TOKENS,
    env.UPSTREAM_PROTOCOL === 'openai' ? 196608 : 64000,
    'MAX_INPUT_TOKENS',
    1024
  )
  if (env.MODEL_CONTEXT_TOKENS !== undefined) {
    const window = integer(env.MODEL_CONTEXT_TOKENS, 0, 'MODEL_CONTEXT_TOKENS', 2048)
    input = Math.min(input, window - output - 1024)
    if (input < 1024) {
      throw new HttpError(503, 'MODEL_CONTEXT_TOKENS must leave room for input and output')
    }
  }
  return { input, output }
}

export const agentPolicy = (env: Env) => ({
  maxRounds: integer(env.MAX_AGENT_ROUNDS, 24, 'MAX_AGENT_ROUNDS', 1, 100),
  maxCalls: integer(env.MAX_TOOL_CALLS, 32, 'MAX_TOOL_CALLS', 1, 100),
  maxSearches: integer(env.MAX_SEARCH_CALLS, 8, 'MAX_SEARCH_CALLS', 1, 40),
  maxPages: integer(env.MAX_PAGE_READS, 12, 'MAX_PAGE_READS', 1, 60),
  concurrency: integer(env.TOOL_CONCURRENCY, 4, 'TOOL_CONCURRENCY', 1, 8),
})
