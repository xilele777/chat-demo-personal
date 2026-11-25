import type { Env } from './types.js'
import { searchAvailable } from './search.js'
import { tokenBudgets, agentPolicy } from './policy.js'
import { modelCatalog, resolveModelCapabilities } from './modelConfig.js'
import { generationTimeouts } from './providerTransport.js'

export const reasoningEfforts = (env: Env) => resolveModelCapabilities(env).reasoningEfforts

export const publicConfig = (env: Env) => ({
  cloud: true,
  protocol: env.UPSTREAM_PROTOCOL,
  model: env.UPSTREAM_MODEL,
  configured: Boolean(env.UPSTREAM_API_KEY),
  search: searchAvailable(env),
  speech: env.UPSTREAM_PROTOCOL === 'deepseek',
  thinking: env.UPSTREAM_PROTOCOL === 'deepseek',
  reasoningEfforts: reasoningEfforts(env),
  reasoningEffortsAutomatic: false,
  modelCatalog: modelCatalog(env),
  mcp: env.UPSTREAM_PROTOCOL === 'openai' || env.UPSTREAM_PROTOCOL === 'anthropic',
  tokenBudgets: tokenBudgets(env),
  agentPolicy: agentPolicy(env),
  generationTimeouts: generationTimeouts(env),
})
