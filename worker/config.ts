import type { ReasoningEffort } from '../src/services/api/types.js'
import type { Env } from './types.js'
import { searchAvailable } from './search.js'

export const reasoningEfforts = (env: Env): Exclude<ReasoningEffort, 'auto'>[] => {
  if (env.UPSTREAM_PROTOCOL !== 'openai') {
    return []
  }
  const defaults = /^(gpt-[5-9]|o[1-9])/.test(env.UPSTREAM_MODEL) ? 'low,medium,high' : ''
  const allowed = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])
  return [
    ...new Set((env.OPENAI_REASONING_EFFORTS ?? defaults).split(',').map((v) => v.trim())),
  ].filter((value) => allowed.has(value)) as Exclude<ReasoningEffort, 'auto'>[]
}

export const publicConfig = (env: Env) => ({
  cloud: true,
  protocol: env.UPSTREAM_PROTOCOL,
  model: env.UPSTREAM_MODEL,
  configured: Boolean(env.UPSTREAM_API_KEY),
  search: searchAvailable(env),
  speech: env.UPSTREAM_PROTOCOL === 'deepseek',
  thinking: env.UPSTREAM_PROTOCOL === 'deepseek',
  reasoningEfforts: reasoningEfforts(env),
})
