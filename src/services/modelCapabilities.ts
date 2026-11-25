import type { ReasoningEffort } from './api/types.js'

export type ModelCapabilities = {
  contextTokens: number | null
  inputTokens: number
  outputTokens: number
  images: boolean
  tools: boolean
  reasoningEfforts: Exclude<ReasoningEffort, 'auto'>[]
  apiStyle: 'chat_completions' | 'responses'
  source: 'model' | 'default' | 'fallback' | 'wildcard'
}
export type ModelCatalog = {
  defaultModel: string
  defaultCapabilities: ModelCapabilities
  profiles: Record<string, ModelCapabilities>
  fallback: ModelCapabilities
}

export const capabilitiesForModel = (catalog: ModelCatalog, model: string): ModelCapabilities =>
  Object.hasOwn(catalog.profiles, model)
    ? catalog.profiles[model]
    : model === catalog.defaultModel
      ? catalog.defaultCapabilities
      : catalog.fallback
