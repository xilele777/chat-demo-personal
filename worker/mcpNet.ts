import { HttpError, type Env } from './types.js'

export const validateMcpUrl = (value: string, env: Env): URL => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new HttpError(400, 'Invalid MCP URL')
  }
  // A trailing DNS dot denotes the same host; normalize before checking the boundary.
  const host = url.hostname.toLowerCase().replace(/\.+$/, '')
  url.hostname = host
  const localTest = env.DEV_AUTH === 'true' && ['127.0.0.1', 'localhost'].includes(host)
  const ip = host.split('.').map(Number)
  const privateHost =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    !host.includes('.') ||
    host.includes(':') ||
    (ip.length === 4 &&
      ip.every(Number.isInteger) &&
      (ip[0] === 0 ||
        ip[0] === 10 ||
        ip[0] === 127 ||
        ip[0] >= 224 ||
        (ip[0] === 169 && ip[1] === 254) ||
        (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) ||
        (ip[0] === 192 && ip[1] === 168) ||
        (ip[0] === 198 && (ip[1] === 18 || ip[1] === 19)) ||
        (ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127)))
  if (
    url.username ||
    url.password ||
    url.hash ||
    !['https:', ...(localTest ? ['http:'] : [])].includes(url.protocol) ||
    (!localTest && privateHost)
  ) {
    throw new HttpError(
      400,
      'Use a public HTTPS MCP endpoint without credentials or a fragment in its URL'
    )
  }
  return url
}

// Apply the same boundary to metadata, registration and token endpoints; never follow redirects.
export const oauthFetch = (env: Env) => async (input: string | URL, init?: RequestInit) => {
  validateMcpUrl(String(input), env)
  const response = await fetch(input, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(10_000)]),
  })
  if (response.status >= 300 && response.status < 400) {
    throw new HttpError(502, 'OAuth endpoint redirects are not allowed')
  }
  // SDK errors may contain a raw response body, including tokens. Expose only a fixed message.
  return response
}

/** Enforce decoded body bytes before the SDK accumulates JSON/SSE payloads in memory. */
export const limitMcpResponse = async (response: Response, maxBytes: number): Promise<Response> => {
  if (!response.body) {
    return response
  }
  const exceeded = () =>
    new HttpError(
      502,
      'MCP response exceeds MAX_MCP_RESPONSE_BYTES. The operation may have executed; verify its outcome before retrying.'
    )
  const length = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body.cancel().catch(() => {})
    throw exceeded()
  }
  const reader = response.body.getReader()
  let bytes = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          reader.releaseLock()
          controller.close()
          return
        }
        bytes += value.byteLength
        if (bytes > maxBytes) {
          const error = exceeded()
          await reader.cancel(error).catch(() => {})
          reader.releaseLock()
          controller.error(error)
        } else {
          controller.enqueue(value)
        }
      } catch (error) {
        await reader.cancel(error).catch(() => {})
        reader.releaseLock()
        controller.error(error)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {})
      reader.releaseLock()
    },
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
