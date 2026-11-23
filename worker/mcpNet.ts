import { HttpError, type Env } from './types.js'

export const validateMcpUrl = (value: string, env: Env): URL => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new HttpError(400, 'Invalid MCP URL')
  }
  const host = url.hostname.toLowerCase()
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
