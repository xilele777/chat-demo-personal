export type Protocol = 'deepseek' | 'anthropic' | 'openai'

export interface Env {
  ASSETS: Fetcher
  DB: D1Database
  FILES: R2Bucket
  UPSTREAM_API_KEY?: string
  UPSTREAM_BASE_URL: string
  UPSTREAM_MODEL: string
  UPSTREAM_PROTOCOL: Protocol
  MAX_OUTPUT_TOKENS?: string
  OPENAI_REASONING_EFFORTS?: string
  MAX_INPUT_TOKENS?: string
  TAVILY_API_KEY?: string
  /** Optional loopback endpoint for local integration tests only. */
  DEV_SEARCH_URL?: string
  APP_PASSWORD?: string
  DEV_AUTH?: string
}

export interface CloudSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pinned?: boolean
  messages: Record<string, unknown>[]
  rootMessageId?: string | null
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })

export const validId = (value: string) => /^[a-zA-Z0-9_-]{1,160}$/.test(value)

export const readSession = (value: unknown): CloudSession => {
  const s = value as CloudSession | null
  if (
    !s ||
    !validId(s.id ?? '') ||
    typeof s.title !== 'string' ||
    !Number.isFinite(s.createdAt) ||
    !Number.isFinite(s.updatedAt) ||
    (s.pinned !== undefined && typeof s.pinned !== 'boolean') ||
    !Array.isArray(s.messages) ||
    s.messages.some(
      (m) => !m || typeof m.id !== 'string' || !['user', 'assistant'].includes(String(m.role))
    )
  ) {
    throw new HttpError(400, 'Invalid session')
  }
  if (new TextEncoder().encode(JSON.stringify(s)).length > 1_500_000) {
    throw new HttpError(
      413,
      'This conversation is too large. Export it and start a new conversation.'
    )
  }
  return s
}
