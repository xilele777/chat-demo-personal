import type { Env } from './types.js'

export type MetricStage =
  | 'request'
  | 'mcp_connect'
  | 'mcp_discovery'
  | 'model_headers'
  | 'model_stream'
  | 'context'
  | 'storage'
/** Only an explicit numeric/enumerated allowlist reaches logs. Never pass caught errors here. */
export function observe(
  env: Env,
  stage: MetricStage,
  values: {
    elapsedMs?: number
    status?: number
    inputTokens?: number
    inputBudget?: number
    outputBudget?: number
    count?: number
    outcome?: 'ok' | 'failed' | 'cancelled' | 'timeout'
  }
) {
  if (env.OBSERVABILITY !== 'true') {
    return
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ requestId: env.requestId, stage, ...values }))
}
