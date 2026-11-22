import { create } from 'zustand'

export const cloudMode = __CLOUD_MODE__

export type CloudConfig = {
  protocol: 'deepseek' | 'anthropic' | 'openai'
  model: string
  configured: boolean
  search: boolean
  speech: boolean
  thinking: boolean
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
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    const response = await fetch(`/api${path}`, {
      ...init,
      signal: controller.signal,
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
    })
    if (!response.ok) {
      if (response.status === 401 && !path.startsWith('/auth')) {
        useCloud.setState({ authRequired: true })
      }
      const body = await response.json().catch(() => null)
      throw new CloudError(response.status, body?.error?.message ?? `HTTP ${response.status}`)
    }
    return response
  } finally {
    clearTimeout(timer)
  }
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
