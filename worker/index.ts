import { authentication, authorize } from './auth.js'
import { storage } from './storage.js'
import { upstream } from './upstream.js'
import { searchAvailable } from './search.js'
import { HttpError, json, type Env } from './types.js'

// Wrangler's module entry point requires a default export.
// eslint-disable-next-line import/no-default-export
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url)
      const path = url.pathname
      if (path.startsWith('/api/')) {
        const origin = request.headers.get('Origin')
        if (
          (origin && origin !== url.origin) ||
          request.headers.get('Sec-Fetch-Site') === 'cross-site'
        ) {
          throw new HttpError(403, 'Cross-origin API requests are not allowed')
        }
        const authResponse = await authentication(request, env, path)
        if (authResponse) {
          return authResponse
        }
        await authorize(request, env)
        if (path === '/api/config' && request.method === 'GET') {
          if (!['deepseek', 'anthropic', 'openai'].includes(env.UPSTREAM_PROTOCOL)) {
            throw new HttpError(503, 'Invalid UPSTREAM_PROTOCOL')
          }
          return json({
            cloud: true,
            protocol: env.UPSTREAM_PROTOCOL,
            model: env.UPSTREAM_MODEL,
            configured: Boolean(env.UPSTREAM_API_KEY),
            search: searchAvailable(env),
            speech: env.UPSTREAM_PROTOCOL === 'deepseek',
            thinking: env.UPSTREAM_PROTOCOL === 'deepseek',
          })
        }
        const response = (await storage(request, env, path)) ?? (await upstream(request, env, path))
        if (!response) {
          throw new HttpError(404, 'API route not found')
        }
        const safe = new Response(response.body, {
          status: response.status,
          headers: response.headers,
        })
        // Do not forward upstream cookies, redirects or permissive CORS headers to the browser.
        for (const header of [
          'Set-Cookie',
          'Location',
          'Access-Control-Allow-Origin',
          'Access-Control-Allow-Credentials',
        ]) {
          safe.headers.delete(header)
        }
        safe.headers.set('Cache-Control', 'no-store')
        safe.headers.set('X-Content-Type-Options', 'nosniff')
        return safe
      }
      const asset = await env.ASSETS.fetch(request)
      const response = new Response(asset.body, { status: asset.status, headers: asset.headers })
      response.headers.set('X-Content-Type-Options', 'nosniff')
      response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
      response.headers.set(
        'Content-Security-Policy',
        "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
      )
      response.headers.set('X-Frame-Options', 'DENY')
      response.headers.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)')
      return response
    } catch (error) {
      const local =
        env.DEV_AUTH === 'true' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname)
      return json(
        {
          error: {
            message:
              error instanceof HttpError || (local && error instanceof Error)
                ? error.message
                : 'The request failed. Check the Worker configuration and storage bindings.',
          },
        },
        error instanceof HttpError ? error.status : 500
      )
    }
  },
} satisfies ExportedHandler<Env>
