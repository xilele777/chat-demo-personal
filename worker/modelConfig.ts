import { HttpError, type Env } from './types.js'
import {
  capabilitiesForModel,
  type ModelCapabilities,
  type ModelCatalog,
} from '../src/services/modelCapabilities.js'

export const validModelId = (id: string) => /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$/.test(id)
const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])
const integer = (value: unknown, name: string, min = 1) => {
  const number = Number(value)
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    !Number.isSafeInteger(number) ||
    number < min ||
    number > 1_000_000
  ) {
    throw new HttpError(503, `Invalid ${name}`)
  }
  return number
}
const reasoning = (value: unknown): ModelCapabilities['reasoningEfforts'] => {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !efforts.has(v))) {
    throw new HttpError(503, 'Invalid model reasoningEfforts')
  }
  return [...new Set(value)] as ModelCapabilities['reasoningEfforts']
}
const budgets = (input: number, output: number, context: number | null) => {
  if (context !== null) {
    input = Math.min(input, context - output - 1024)
  }
  if (input < 1024) {
    throw new HttpError(503, 'MODEL_CONTEXT_TOKENS must leave room for input and output')
  }
  return input
}

export const modelCatalog = (env: Env): ModelCatalog => {
  const openai = env.UPSTREAM_PROTOCOL === 'openai'
  const contextTokens =
    env.MODEL_CONTEXT_TOKENS === undefined
      ? null
      : integer(env.MODEL_CONTEXT_TOKENS, 'MODEL_CONTEXT_TOKENS', 2048)
  const outputTokens = integer(
    env.MAX_OUTPUT_TOKENS ?? (openai ? 32768 : 8192),
    'MAX_OUTPUT_TOKENS'
  )
  const inputTokens = budgets(
    integer(env.MAX_INPUT_TOKENS ?? (openai ? 196608 : 64000), 'MAX_INPUT_TOKENS', 1024),
    outputTokens,
    contextTokens
  )
  const defaults: ModelCapabilities = {
    contextTokens,
    inputTokens,
    outputTokens,
    images: true,
    tools: true,
    reasoningEfforts: openai
      ? reasoning(
          (env.OPENAI_REASONING_EFFORTS ?? '')
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
        )
      : [],
    apiStyle: env.OPENAI_API_STYLE ?? 'chat_completions',
    source: 'default',
  }
  const profiles: Record<string, ModelCapabilities> = {}
  let fallback: ModelCapabilities = {
    contextTokens: null,
    inputTokens: 8192,
    outputTokens: 2048,
    images: false,
    tools: false,
    reasoningEfforts: [],
    apiStyle: defaults.apiStyle,
    source: 'fallback',
  }
  if (env.MODEL_PROFILES !== undefined) {
    let value: unknown
    try {
      value = JSON.parse(env.MODEL_PROFILES)
    } catch {
      throw new HttpError(503, 'Invalid MODEL_PROFILES JSON')
    }
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length > 500
    ) {
      throw new HttpError(503, 'Invalid MODEL_PROFILES')
    }
    for (const [id, raw] of Object.entries(value)) {
      if (
        (id !== '*' && !validModelId(id)) ||
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw)
      ) {
        throw new HttpError(503, 'Invalid model profile')
      }
      const profile = raw as Record<string, unknown>
      const allowed = [
        'contextTokens',
        'maxInputTokens',
        'maxOutputTokens',
        'images',
        'tools',
        'reasoningEfforts',
        'apiStyle',
      ]
      if (
        Object.keys(profile).some((key) => !allowed.includes(key)) ||
        typeof profile.images !== 'boolean' ||
        typeof profile.tools !== 'boolean'
      ) {
        throw new HttpError(503, `Invalid model profile: ${id}`)
      }
      const context =
        profile.contextTokens === null
          ? null
          : integer(profile.contextTokens, `${id}.contextTokens`, 2048)
      const output = integer(profile.maxOutputTokens, `${id}.maxOutputTokens`)
      const input = budgets(
        integer(
          profile.maxInputTokens ?? (context === null ? 8192 : context),
          `${id}.maxInputTokens`,
          1024
        ),
        output,
        context
      )
      const apiStyle = profile.apiStyle ?? defaults.apiStyle
      if (apiStyle !== 'responses' && apiStyle !== 'chat_completions') {
        throw new HttpError(503, `Invalid ${id}.apiStyle`)
      }
      const resolved: ModelCapabilities = {
        contextTokens: context,
        inputTokens: input,
        outputTokens: output,
        images: profile.images,
        tools: profile.tools,
        reasoningEfforts: openai ? reasoning(profile.reasoningEfforts ?? []) : [],
        apiStyle,
        source: id === '*' ? 'wildcard' : 'model',
      }
      if (id === '*') {
        fallback = resolved
      } else {
        profiles[id] = resolved
      }
    }
  }
  return { defaultModel: env.UPSTREAM_MODEL, defaultCapabilities: defaults, profiles, fallback }
}

export const resolveModelCapabilities = (env: Env) =>
  env.modelCapabilities ?? capabilitiesForModel(modelCatalog(env), env.UPSTREAM_MODEL)
export const selectModel = (env: Env, model: unknown): Env => {
  const id = model ?? env.UPSTREAM_MODEL
  if (typeof id !== 'string' || !validModelId(id)) {
    throw new HttpError(400, 'Invalid model ID')
  }
  const capabilities = capabilitiesForModel(modelCatalog(env), id)
  return {
    ...env,
    UPSTREAM_MODEL: id,
    OPENAI_API_STYLE: capabilities.apiStyle,
    modelCapabilities: capabilities,
  }
}
