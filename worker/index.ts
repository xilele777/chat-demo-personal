import { authentication, authorize } from './auth.js'
import { storage } from './storage.js'
import { upstream } from './upstream.js'
import { publicConfig } from './config.js'
import { HttpError, json, type Env } from './types.js'
import { mcpRoutes, mcpOAuthCallback } from './mcp.js'
import { toolOperationRoutes } from './toolOperations.js'
import { observe } from './observability.js'

// Wrangler's module entry point requires a default export.
// eslint-disable-next-line import/no-default-export
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const started = performance.now()
    env = { ...env, requestId: crypto.randomUUID(), waitUntil: ctx.waitUntil.bind(ctx) }
    const finish = (
      response: Response,
      outcome: 'ok' | 'failed' | 'cancelled' = response.ok ? 'ok' : 'failed'
    ) => {
      const result = new Response(response.body, {
        status: response.status,
        headers: response.headers,
      })
      result.headers.set('X-Request-ID', env.requestId ?? '')
      observe(env, 'request', {
        elapsedMs: Math.round(performance.now() - started),
        status: result.status,
        outcome,
      })
      return result
    }
    try {
      const url = new URL(request.url)
      const path = url.pathname
      if (path === '/mcp/oauth/callback' && request.method === 'GET') {
        return finish(await mcpOAuthCallback(request, env))
      }
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
          return finish(authResponse)
        }
        await authorize(request, env)
        if (path === '/api/config' && request.method === 'GET') {
          if (!['deepseek', 'anthropic', 'openai'].includes(env.UPSTREAM_PROTOCOL)) {
            throw new HttpError(503, 'Invalid UPSTREAM_PROTOCOL')
          }
          return finish(json(publicConfig(env)))
        }
        const response =
          (await toolOperationRoutes(request, env, path)) ??
          (await mcpRoutes(request, env, path)) ??
          (await storage(request, env, path)) ??
          (await upstream(request, env, path))
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
        return finish(safe)
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
      return finish(response)
    } catch (error) {
      const local =
        env.DEV_AUTH === 'true' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname)
      return finish(
        json(
          {
            error: {
              message:
                error instanceof HttpError || (local && error instanceof Error)
                  ? error.message
                  : 'The request failed. Check the Worker configuration and storage bindings.',
            },
          },
          error instanceof HttpError ? error.status : 500
        ),
        request.signal.aborted ? 'cancelled' : 'failed'
      )
    }
  },
} satisfies ExportedHandler<Env>
