import { create } from 'zustand'
import { cloudFetch, useCloud } from './cloud.js'
import { useSettings } from './settings.js'
import { capabilitiesForModel } from './modelCapabilities.js'

export const useModels = create<{ models: string[]; loading: boolean; error: string | null }>(
  () => ({ models: [], loading: false, error: null })
)
let loading: Promise<void> | undefined
export const availableModels = (
  defaultModel: string | undefined,
  custom: string[],
  remote: string[],
  selected: string
) => [
  ...new Set(
    [defaultModel, ...custom, ...remote, selected].filter((id): id is string => Boolean(id))
  ),
]
export const loadModels = (): Promise<void> => {
  if (loading) {
    return loading
  }
  useModels.setState({ loading: true, error: null })
  loading = (async () => {
    try {
      const data = (await (await cloudFetch('/models')).json()) as {
        data: { id: string }[]
        warning?: string
      }
      useModels.setState({
        models: data.data.map((model) => model.id),
        error: data.warning ?? null,
      })
    } catch (error) {
      useModels.setState({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      loading = undefined
      useModels.setState({ loading: false })
    }
  })()
  return loading
}

export const selectedModel = () =>
  useSettings.getState().model || useCloud.getState().config?.model || 'deepseek-flash'

export const modelCapabilities = (model: string) => {
  const catalog = useCloud.getState().config?.modelCatalog
  return catalog ? capabilitiesForModel(catalog, model) : undefined
}
export const modelReasoningEfforts = (model: string) =>
  modelCapabilities(model)?.reasoningEfforts ?? []
