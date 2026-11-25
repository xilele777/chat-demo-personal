import { validSessionStructure } from '../src/services/chat/validation.js'
import { bodyLimits, readBody } from './bodyLimits.js'
import type { ModelCapabilities } from '../src/services/modelCapabilities.js'
import { HttpError } from './httpError.js'
export { HttpError } from './httpError.js'

export type Protocol = 'deepseek' | 'anthropic' | 'openai'

export interface Env {
  requestId?: string
  OBSERVABILITY?: string
  OBJECT_GC_TRACKING_SINCE?: string
  /** Request runtime hook, attached by the Worker entry point rather than a binding. */
  waitUntil?: (promise: Promise<unknown>) => void
  ASSETS: Fetcher
  DB: D1Database
  FILES: R2Bucket
  UPSTREAM_API_KEY?: string
  UPSTREAM_BASE_URL: string
  UPSTREAM_MODEL: string
  UPSTREAM_PROTOCOL: Protocol
  OPENAI_API_STYLE?: 'chat_completions' | 'responses'
  MAX_OUTPUT_TOKENS?: string
  OPENAI_REASONING_EFFORTS?: string
  MAX_INPUT_TOKENS?: string
  MODEL_CONTEXT_TOKENS?: string
  MODEL_PROFILES?: string
  MODEL_RESPONSE_TIMEOUT_MS?: string
  MODEL_FIRST_EVENT_TIMEOUT_MS?: string
  MODEL_IDLE_TIMEOUT_MS?: string
  MODEL_TOTAL_TIMEOUT_MS?: string
  contextTrace?: {
    totalRounds: number
    round: number
    report?: import('../src/services/chat/contextReport.js').ContextReport
    sources?: import('./context.js').ContextMessage[]
    memory?: import('../src/services/chat/branchMemory.js').BranchMemory
  }
  operationRequestId?: string
  /** Resolved once for the selected model; never supplied by the browser. */
  modelCapabilities?: ModelCapabilities
  MAX_AGENT_ROUNDS?: string
  MAX_TOOL_CALLS?: string
  MAX_SEARCH_CALLS?: string
  MAX_PAGE_READS?: string
  MAX_RESEARCH_ROUNDS?: string
  MAX_RESEARCH_TOKENS?: string
  TOOL_CONCURRENCY?: string
  MAX_TOOL_RESULT_BYTES?: string
  MAX_TOOL_CACHE_BYTES?: string
  MAX_TOOL_CACHE_ENTRIES?: string
  MAX_MCP_RESPONSE_BYTES?: string
  SEARCH_MAX_RESULTS?: string
  SEARCH_DEPTH?: 'basic' | 'advanced'
  PAGE_MAX_CHARACTERS?: string
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

export const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })

export const validId = (value: string) => /^[a-zA-Z0-9_-]{1,160}$/.test(value)

export async function readJsonObject(
  request: Request,
  maxBytes = bodyLimits.json
): Promise<Record<string, unknown>> {
  const body = await readBody(request, maxBytes)
  let value: unknown
  try {
    value = JSON.parse(await body.text())
  } catch {
    throw new HttpError(400, 'Invalid JSON body')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'A JSON object is required')
  }
  return value as Record<string, unknown>
}

export const readSession = (value: unknown): CloudSession => {
  const s = value as CloudSession | null
  if (
    !s ||
    typeof s !== 'object' ||
    Array.isArray(s) ||
    typeof s.id !== 'string' ||
    !validId(s.id) ||
    typeof s.title !== 'string' ||
    !Number.isFinite(s.createdAt) ||
    !Number.isFinite(s.updatedAt) ||
    (s.pinned !== undefined && typeof s.pinned !== 'boolean') ||
    !validSessionStructure(s as unknown as Record<string, unknown>)
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
