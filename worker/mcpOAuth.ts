import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { checkResourceAllowed } from '@modelcontextprotocol/sdk/shared/auth-utils.js'
import { oauthFetch, validateMcpUrl } from './mcpNet.js'
import { HttpError, type Env } from './types.js'
import type { StoredServer } from './mcp.js'
import { sessionBinding } from './auth.js'

type OAuthConfig = {
  url: string
  issuer: string
  metadata: AuthorizationServerMetadata
  client: OAuthClientInformationMixed
  redirectUri: string
  resource?: string
}
type SavedTokens = OAuthTokens & { expiresAt?: number }
type OAuthRow = {
  config: string
  tokens: string | null
  lock_id: string | null
  lock_until: number
}
type Flow = { server: StoredServer; config: OAuthConfig; verifier: string; previous: string | null }
export const oauthRequired = () =>
  new HttpError(428, 'MCP OAuth sign-in required. Open Settings → MCP and sign in again.')
const read = (env: Env, id: string) =>
  env.DB.prepare('SELECT * FROM mcp_oauth WHERE server_id = ?').bind(id).first<OAuthRow>()
const saveTokens = (tokens: OAuthTokens): SavedTokens => {
  if (tokens.token_type.toLowerCase() !== 'bearer' || /[\r\n]/.test(tokens.access_token)) {
    throw new HttpError(502, 'Unsupported OAuth token type')
  }
  return {
    ...tokens,
    ...(tokens.expires_in !== undefined
      ? { expiresAt: Date.now() + tokens.expires_in * 1000 }
      : {}),
  }
}

export async function beginAuthorization(
  server: StoredServer,
  request: Request,
  env: Env,
  previous: string | null
) {
  const fetchFn = oauthFetch(env)
  const probe = await fetchFn(server.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'personal-chat', version: '0.1.3' },
      },
    }),
    signal: request.signal,
  })
  const challenge = extractWWWAuthenticateParams(probe)
  await probe.body?.cancel()
  const info = await discoverOAuthServerInfo(server.url, {
    resourceMetadataUrl: challenge.resourceMetadataUrl,
    fetchFn,
  })
  const metadata = info.authorizationServerMetadata
  const issuer = validateMcpUrl(info.authorizationServerUrl, env).href
  if (
    !metadata ||
    validateMcpUrl(metadata.issuer, env).href !== issuer ||
    !metadata.code_challenge_methods_supported?.includes('S256')
  ) {
    throw new HttpError(422, 'This MCP server must support OAuth discovery and PKCE S256')
  }
  validateMcpUrl(metadata.authorization_endpoint, env)
  if (!metadata.token_endpoint) {
    throw new HttpError(422, 'OAuth token endpoint is missing')
  }
  validateMcpUrl(metadata.token_endpoint, env)
  const resource = info.resourceMetadata?.resource
  if (
    resource &&
    !checkResourceAllowed({ requestedResource: server.url, configuredResource: resource })
  ) {
    throw new HttpError(422, 'OAuth resource does not match this MCP server')
  }
  const redirectUri = new URL('/mcp/oauth/callback', request.url).href
  validateMcpUrl(redirectUri, env)
  const row = await read(env, server.id)
  const saved = row ? (JSON.parse(row.config) as OAuthConfig) : undefined
  const scope = challenge.scope ?? info.resourceMetadata?.scopes_supported?.join(' ')
  let client =
    saved?.url === server.url && saved.issuer === issuer && saved.redirectUri === redirectUri
      ? saved.client
      : undefined
  if (!client) {
    if (!metadata.registration_endpoint) {
      throw new HttpError(422, 'This server does not support dynamic OAuth client registration')
    }
    validateMcpUrl(metadata.registration_endpoint, env)
    client = await registerClient(issuer, {
      metadata,
      fetchFn,
      scope,
      clientMetadata: {
        client_name: 'Personal Chat',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
    })
  }
  const state = crypto.randomUUID()
  const { authorizationUrl, codeVerifier } = await startAuthorization(issuer, {
    metadata,
    clientInformation: client,
    redirectUrl: redirectUri,
    scope,
    state,
    resource,
  })
  const config: OAuthConfig = { url: server.url, issuer, metadata, client, redirectUri, resource }
  const flow: Flow = { server, config, verifier: codeVerifier, previous }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mcp_oauth_flows WHERE expires_at <= ?').bind(Date.now()),
    env.DB.prepare('DELETE FROM mcp_oauth_flows WHERE session = ? AND server_id = ?').bind(
      await sessionBinding(request),
      server.id
    ),
    env.DB.prepare(
      'INSERT INTO mcp_oauth_flows (state, session, server_id, data, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(
      state,
      await sessionBinding(request),
      server.id,
      JSON.stringify(flow),
      Date.now() + 10 * 60_000
    ),
  ])
  return authorizationUrl.href
}

export async function finishAuthorization(request: Request, env: Env) {
  const url = new URL(request.url)
  const state = url.searchParams.get('state')
  if (!state || state.length > 160) {
    throw oauthRequired()
  }
  const row = await env.DB.prepare(
    'DELETE FROM mcp_oauth_flows WHERE state = ? AND session = ? AND expires_at > ? RETURNING data'
  )
    .bind(state, await sessionBinding(request), Date.now())
    .first<{ data: string }>()
  if (!row) {
    throw oauthRequired()
  }
  const flow = JSON.parse(row.data) as Flow
  const { config } = flow
  const issuer = url.searchParams.get('iss')
  if (
    new URL(config.redirectUri).origin !== url.origin ||
    ((config.metadata as Record<string, unknown>).authorization_response_iss_parameter_supported ===
      true &&
      !issuer) ||
    (issuer && validateMcpUrl(issuer, env).href !== config.issuer)
  ) {
    throw oauthRequired()
  }
  const code = url.searchParams.get('code')
  if (url.searchParams.has('error') || !code || code.length > 4096) {
    throw oauthRequired()
  }
  const current = await env.DB.prepare('SELECT data FROM mcp_servers WHERE id = ?')
    .bind(flow.server.id)
    .first<{ data: string }>()
  if ((current?.data ?? null) !== flow.previous) {
    throw new HttpError(409, 'MCP connection changed; start authorization again')
  }
  const tokens = saveTokens(
    await exchangeAuthorization(config.issuer, {
      metadata: config.metadata,
      clientInformation: config.client,
      authorizationCode: code,
      codeVerifier: flow.verifier,
      redirectUri: config.redirectUri,
      resource: config.resource,
      fetchFn: oauthFetch(env),
    })
  )
  return { ...flow, tokens }
}

export async function oauthStatus(env: Env, server: StoredServer) {
  if (server.authType !== 'oauth') {
    return undefined
  }
  const row = await read(env, server.id)
  if (!row?.tokens || (JSON.parse(row.config) as OAuthConfig).url !== server.url) {
    return 'required' as const
  }
  const tokens = JSON.parse(row.tokens) as SavedTokens
  return tokens.expiresAt && tokens.expiresAt <= Date.now() && !tokens.refresh_token
    ? ('required' as const)
    : ('authorized' as const)
}

export async function oauthAccessToken(
  env: Env,
  server: StoredServer,
  rejected?: string
): Promise<string> {
  for (let attempt = 0; attempt < 65; attempt++) {
    const row = await read(env, server.id)
    if (!row?.tokens) {
      throw oauthRequired()
    }
    const config = JSON.parse(row.config) as OAuthConfig
    if (config.url !== server.url) {
      throw oauthRequired()
    }
    const tokens = JSON.parse(row.tokens) as SavedTokens
    const mustRefresh =
      rejected === tokens.access_token ||
      (tokens.expiresAt !== undefined && tokens.expiresAt <= Date.now() + 60_000)
    if (!mustRefresh) {
      return tokens.access_token
    }
    if (!tokens.refresh_token) {
      await env.DB.prepare('UPDATE mcp_oauth SET tokens = NULL WHERE server_id = ? AND tokens = ?')
        .bind(server.id, row.tokens)
        .run()
      throw oauthRequired()
    }
    const refreshToken = tokens.refresh_token
    const lock = crypto.randomUUID()
    const claimed = await env.DB.prepare(
      'UPDATE mcp_oauth SET lock_id = ?, lock_until = ? WHERE server_id = ? AND tokens = ? AND lock_until <= ? RETURNING server_id'
    )
      .bind(lock, Date.now() + 30_000, server.id, row.tokens, Date.now())
      .first()
    if (!claimed) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      continue
    }
    // The refresh survives cancellation of the chat request, so a rotating refresh token can be saved.
    const renewal = (async () => {
      try {
        let terminal = false
        const guardedFetch = async (input: string | URL, init?: RequestInit) => {
          const response = await oauthFetch(env)(input, init)
          if (!response.ok) {
            const error = (await response
              .clone()
              .json()
              .catch(() => null)) as { error?: string } | null
            terminal = ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(
              error?.error ?? ''
            )
          }
          return response
        }
        let next: SavedTokens
        try {
          next = saveTokens(
            await refreshAuthorization(config.issuer, {
              metadata: config.metadata,
              clientInformation: config.client,
              refreshToken,
              resource: config.resource,
              fetchFn: guardedFetch,
            })
          )
        } catch {
          if (terminal) {
            await env.DB.prepare(
              'UPDATE mcp_oauth SET tokens = NULL WHERE server_id = ? AND lock_id = ?'
            )
              .bind(server.id, lock)
              .run()
            throw oauthRequired()
          }
          throw new HttpError(502, 'OAuth token refresh is temporarily unavailable. Try again.')
        }
        await env.DB.prepare(
          'UPDATE mcp_oauth SET tokens = ?, lock_id = NULL, lock_until = 0 WHERE server_id = ? AND lock_id = ?'
        )
          .bind(JSON.stringify(next), server.id, lock)
          .run()
        return next.access_token
      } finally {
        await env.DB.prepare(
          'UPDATE mcp_oauth SET lock_id = NULL, lock_until = 0 WHERE server_id = ? AND lock_id = ?'
        )
          .bind(server.id, lock)
          .run()
      }
    })()
    env.waitUntil?.(renewal.catch(() => {}))
    return renewal
  }
  throw new HttpError(503, 'OAuth token refresh is busy. Try again.')
}
