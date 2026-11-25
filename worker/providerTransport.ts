import { readServerSentEvents } from '../src/services/api/sse.js'
import { boundedResponseText, withSignal } from '../src/services/api/streamLimits.js'
import { HttpError, type Env } from './types.js'
import { observe } from './observability.js'

const milliseconds = (value: string | undefined, fallback: number) => {
  const result = Number(value ?? fallback)
  if (!Number.isInteger(result) || result < 10 || result > 3_600_000) {
    throw new HttpError(503, 'Invalid provider timeout configuration')
  }
  return result
}
export const generationTimeouts = (env: Env) => ({
  responseMs: milliseconds(env.MODEL_RESPONSE_TIMEOUT_MS, 120_000),
  firstEventMs: milliseconds(env.MODEL_FIRST_EVENT_TIMEOUT_MS, 180_000),
  idleMs: milliseconds(env.MODEL_IDLE_TIMEOUT_MS, 180_000),
  totalMs: milliseconds(env.MODEL_TOTAL_TIMEOUT_MS, 900_000),
})

/** Each model invocation has its own clock; tool execution/approval never consumes it. */
export const fetchProvider = async (
  url: string,
  init: RequestInit,
  env: Env
): Promise<Response> => {
  const timeouts = generationTimeouts(env)
  const started = performance.now()
  const totalMs = timeouts.totalMs
  const total = AbortSignal.timeout(totalMs)
  const caller = init.signal ?? new AbortController().signal
  const bodySignal = AbortSignal.any([caller, total])
  const headerDeadline = new AbortController()
  const headersSignal = AbortSignal.any([bodySignal, headerDeadline.signal])
  const timer = setTimeout(
    () => headerDeadline.abort(new DOMException('Response timed out', 'TimeoutError')),
    timeouts.responseMs
  )
  let response: Response
  try {
    response = await withSignal(fetch(url, { ...init, signal: headersSignal }), headersSignal)
    observe(env, 'model_headers', {
      elapsedMs: Math.round(performance.now() - started),
      status: response.status,
      outcome: response.ok ? 'ok' : 'failed',
    })
  } catch (error) {
    observe(env, 'model_headers', {
      elapsedMs: Math.round(performance.now() - started),
      outcome: caller.aborted ? 'cancelled' : headersSignal.aborted ? 'timeout' : 'failed',
    })
    if (!caller.aborted && headersSignal.aborted) {
      throw new HttpError(504, '等待模型响应超时，请重试。')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
  if (
    !response.body ||
    !response.ok ||
    !response.headers.get('Content-Type')?.includes('text/event-stream')
  ) {
    return response
  }
  const source = response.body
  const cancelled = new AbortController()
  const iterator = readServerSentEvents(source, AbortSignal.any([bodySignal, cancelled.signal]), {
    firstEventMs: timeouts.firstEventMs,
    idleMs: timeouts.idleMs,
    totalMs,
  })
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next()
        if (next.done) {
          observe(env, 'model_stream', {
            elapsedMs: Math.round(performance.now() - started),
            outcome: 'ok',
          })
          controller.close()
        } else {
          controller.enqueue(
            encoder.encode(
              `event: ${next.value.event}\n${next.value.data
                .split('\n')
                .map((line) => `data: ${line}`)
                .join('\n')}\n\n`
            )
          )
        }
      } catch (error) {
        observe(env, 'model_stream', {
          elapsedMs: Math.round(performance.now() - started),
          outcome: caller.aborted
            ? 'cancelled'
            : error instanceof Error && error.name === 'TimeoutError'
              ? 'timeout'
              : 'failed',
        })
        controller.error(
          !caller.aborted && error instanceof Error && error.name === 'TimeoutError'
            ? new HttpError(504, '模型生成超时或流中长时间无进展，请重试。')
            : error
        )
      }
    },
    async cancel() {
      cancelled.abort()
      void source.cancel().catch(() => {})
      await iterator.return(undefined)
    },
  })
  return new Response(body, { status: response.status, headers: response.headers })
}

export const providerText = boundedResponseText
