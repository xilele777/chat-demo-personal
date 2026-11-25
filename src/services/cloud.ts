import { create } from 'zustand'
import type { ReasoningEffort } from './api/types.js'
import type { ModelCatalog } from './modelCapabilities.js'
import { boundedResponseText } from './api/streamLimits.js'

export const cloudMode = __CLOUD_MODE__

export type CloudConfig = {
  generationTimeouts?: import('./api/streamLimits.js').GenerationTimeouts
  protocol: 'deepseek' | 'anthropic' | 'openai'
  model: string
  configured: boolean
  search: boolean
  speech: boolean
  thinking: boolean
  reasoningEfforts: Exclude<ReasoningEffort, 'auto'>[]
  reasoningEffortsAutomatic?: boolean
  mcp?: boolean
  tokenBudgets?: { input: number; output: number }
  modelCatalog?: ModelCatalog
}

export const useCloud = create<{
  authRequired: boolean
  config: CloudConfig | null
  syncing: boolean
  error: string | null
  lastSyncedAt: number | null
}>(() => ({ authRequired: false, config: null, syncing: false, error: null, lastSyncedAt: null }))

export class CloudError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export async function cloudFetch(path: string, init: RequestInit = {}): Promise<Response> {
  // Fetch keeps this signal attached while callers consume the response body.
  const signal = AbortSignal.any([
    AbortSignal.timeout(60_000),
    ...(init.signal ? [init.signal] : []),
  ])
  const response = await fetch(`/api${path}`, {
    ...init,
    signal,
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
  })
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth')) {
      useCloud.setState({ authRequired: true })
    }
    const text = await boundedResponseText(response, 64 * 1024, signal)
    let body: { error?: { message?: string } } | null = null
    try {
      body = JSON.parse(text)
    } catch {
      // Non-JSON errors still carry their HTTP status without unbounded buffering.
    }
    throw new CloudError(response.status, body?.error?.message ?? `HTTP ${response.status}`)
  }
  return response
}

export async function loadCloudConfig(): Promise<void> {
  const config = (await (await cloudFetch('/config')).json()) as CloudConfig
  useCloud.setState({ config, authRequired: false })
}

export const cloudJson = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
