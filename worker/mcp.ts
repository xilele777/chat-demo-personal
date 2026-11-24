import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { HttpError, json, validId, type Env } from './types.js'
import type { McpServer, McpToolBlock } from '../src/services/mcpTypes.js'
import { validateMcpUrl } from './mcpNet.js'
import {
  beginAuthorization,
  finishAuthorization,
  oauthAccessToken,
  oauthRequired,
  oauthStatus,
} from './mcpOAuth.js'
import { authorize } from './auth.js'

export type StoredServer = Omit<McpServer, 'hasToken' | 'tools' | 'oauthStatus'> & {
  token: string
  tools: Tool[]
}
const publicServer = (server: StoredServer): McpServer => ({
  id: server.id,
  name: server.name,
  url: server.url,
  enabled: server.enabled,
  hasToken: Boolean(server.token),
  authType: server.authType ?? 'bearer',
  disabledTools: server.disabledTools,
  tools: server.tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    readOnly: tool.annotations?.readOnlyHint === true,
  })),
})

const errorMessage = (error: unknown, server: StoredServer) => {
  if (server.authType === 'oauth') {
    return error instanceof HttpError
      ? error.message
      : 'MCP OAuth request failed. Check the connection or sign in again.'
  }
  const message = error instanceof Error ? error.message : 'MCP request failed'
  return (server.token ? message.replaceAll(server.token, '[redacted]') : message).slice(0, 500)
}

async function connect(
  server: StoredServer,
  env: Env,
  signal: AbortSignal,
  tokenOverride?: string
) {
  const url = validateMcpUrl(server.url, env)
  const client = new Client({ name: 'personal-chat', version: '0.1.3' }, { capabilities: {} })
  const transport = new StreamableHTTPClientTransport(url, {
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: async (input, init) => {
      let token =
        tokenOverride ??
        (server.authType === 'oauth' ? await oauthAccessToken(env, server) : server.token)
      const send = () => {
        const headers = new Headers(init?.headers)
        if (token) {
          headers.set('Authorization', `Bearer ${token}`)
        }
        return fetch(input, {
          ...init,
          headers,
          redirect: 'manual',
          signal: AbortSignal.any([
            signal,
            ...(init?.signal ? [init.signal] : []),
            AbortSignal.timeout(30_000),
          ]),
        })
      }
      let response = await send()
      if (response.status === 401 && server.authType === 'oauth' && tokenOverride === undefined) {
        await response.body?.cancel()
        token = await oauthAccessToken(env, server, token)
        response = await send()
        if (response.status === 401) {
          await response.body?.cancel()
          await env.DB.prepare(
            "UPDATE mcp_oauth SET tokens = NULL WHERE server_id = ? AND json_extract(tokens, '$.access_token') = ?"
          )
            .bind(server.id, token)
            .run()
          throw oauthRequired()
        }
      }
      if (response.status >= 300 && response.status < 400) {
        throw new HttpError(502, 'MCP redirects are not allowed. Use the final endpoint URL.')
      }
      return response
    },
  })
  try {
    await client.connect(transport, { signal, timeout: 15_000 })
    return client
  } catch (error) {
    await client.close().catch(() => {})
    if (server.authType === 'oauth') {
      throw error instanceof HttpError
        ? error
        : new HttpError(502, 'MCP OAuth connection failed. Try signing in again.')
    }
    throw new HttpError(502, errorMessage(error, server))
  }
}

const readServers = async (env: Env): Promise<StoredServer[]> =>
  (
    await env.DB.prepare('SELECT data FROM mcp_servers ORDER BY id').all<{ data: string }>()
  ).results.map((row) => JSON.parse(row.data))

const listTools = async (client: Client, signal: AbortSignal): Promise<Tool[]> => {
  const tools: Tool[] = []
  let cursor: string | undefined
  const seen = new Set<string>()
  do {
    const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 15_000 })
    tools.push(...result.tools)
    cursor = result.nextCursor
    if (tools.length > 100 || (cursor && seen.has(cursor))) {
      throw new HttpError(422, 'This MCP server exposes too many tools (maximum 100)')
    }
    if (cursor) {
      seen.add(cursor)
    }
  } while (cursor)
  return tools
}

export async function mcpRoutes(
  request: Request,
  env: Env,
  path: string
): Promise<Response | null> {
  if (path === '/api/mcp/servers' && request.method === 'GET') {
    return json({
      servers: await Promise.all(
        (await readServers(env)).map(async (server) => ({
          ...publicServer(server),
          oauthStatus: await oauthStatus(env, server),
        }))
      ),
    })
  }
  const approval = path.match(/^\/api\/mcp\/approvals\/([a-zA-Z0-9_-]+)$/)
  if (approval && request.method === 'POST') {
    const body = (await request.json()) as { approved?: unknown }
    if (typeof body.approved !== 'boolean') {
      throw new HttpError(400, 'Approval decision is required')
    }
    const result = await env.DB.prepare(
      "UPDATE mcp_approvals SET status = ? WHERE id = ? AND status = 'pending' AND expires_at > ? RETURNING id"
    )
      .bind(body.approved ? 'approved' : 'denied', approval[1], Date.now())
      .all()
    if (!result.results.length) {
      throw new HttpError(409, 'This tool request has expired or was already handled')
    }
    return json({ ok: true })
  }
  const route = path.match(/^\/api\/mcp\/servers\/([a-zA-Z0-9_-]+)(\/(?:test|authorize))?$/)
  if (!route) {
    return null
  }
  const id = route[1]
  if (!validId(id)) {
    throw new HttpError(400, 'Invalid MCP server ID')
  }
  const old = (await readServers(env)).find((server) => server.id === id)
  if (request.method === 'DELETE' && !route[2]) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM mcp_oauth_flows WHERE server_id = ?').bind(id),
      env.DB.prepare('DELETE FROM mcp_servers WHERE id = ?').bind(id),
    ])
    return json({ ok: true })
  }
  if (!(request.method === 'PUT' && !route[2]) && !(request.method === 'POST' && route[2])) {
    return null
  }
  if (!request.headers.get('Content-Type')?.includes('application/json')) {
    throw new HttpError(415, 'JSON is required')
  }
  const body = (await request.json()) as Partial<McpServer> & { token?: string }
  if (
    typeof body.name !== 'string' ||
    !body.name.trim() ||
    body.name.length > 80 ||
    typeof body.url !== 'string' ||
    body.url.length > 2048 ||
    typeof body.enabled !== 'boolean' ||
    (body.authType !== undefined && !['bearer', 'oauth'].includes(body.authType)) ||
    (body.token !== undefined &&
      (typeof body.token !== 'string' || body.token.length > 4096 || /[\r\n]/.test(body.token))) ||
    !Array.isArray(body.disabledTools) ||
    !body.disabledTools.every((name) => typeof name === 'string') ||
    body.disabledTools.length > 100
  ) {
    throw new HttpError(400, 'Invalid MCP configuration')
  }
  const servers = await readServers(env)
  if (!old && servers.length >= 5) {
    throw new HttpError(422, 'You can connect up to five MCP servers')
  }
  const server: StoredServer = {
    id,
    name: body.name.trim(),
    url: validateMcpUrl(body.url, env).href,
    enabled: body.enabled,
    authType: body.authType ?? old?.authType ?? 'bearer',
    token:
      body.token === undefined
        ? old?.url === validateMcpUrl(body.url, env).href
          ? old.token
          : ''
        : body.token.trim(),
    disabledTools: body.disabledTools,
    tools: old?.tools ?? [],
  }
  if (server.authType === 'oauth') {
    server.token = ''
  }
  if (old?.url !== server.url || (old?.authType ?? 'bearer') !== server.authType) {
    server.tools = []
  }
  if (route[2] === '/authorize') {
    if (server.authType !== 'oauth') {
      throw new HttpError(400, 'Select OAuth to sign in')
    }
    try {
      return json({
        authorizationUrl: await beginAuthorization(
          server,
          request,
          env,
          old ? JSON.stringify(old) : null
        ),
      })
    } catch (error) {
      throw error instanceof HttpError
        ? error
        : new HttpError(502, 'Could not start MCP OAuth sign-in. Check the server and try again.')
    }
  }
  // Always discover capabilities before saving an enabled connection. Failed edits preserve the old settings.
  if (route[2] || server.enabled) {
    const client = await connect(server, env, request.signal)
    try {
      server.tools = await listTools(client, request.signal)
    } catch (error) {
      throw new HttpError(502, errorMessage(error, server))
    } finally {
      await client.close().catch(() => {})
    }
  } else if (old?.url !== server.url || body.token !== undefined) {
    server.tools = []
  }
  if (!route[2]) {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO mcp_servers (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'
      ).bind(id, JSON.stringify(server)),
      ...(old && (old.url !== server.url || server.authType !== 'oauth')
        ? [
            env.DB.prepare('DELETE FROM mcp_oauth WHERE server_id = ?').bind(id),
            env.DB.prepare('DELETE FROM mcp_oauth_flows WHERE server_id = ?').bind(id),
          ]
        : []),
    ])
  }
  return json({ server: publicServer(server) })
}

// Top-level browser navigation may arrive cross-site; the owner session and one-time state
// authorize this callback. Keep the ordinary API origin checks intact.
export async function mcpOAuthCallback(request: Request, env: Env): Promise<Response> {
  let result = 'failed'
  try {
    await authorize(request, env)
    const flow = await finishAuthorization(request, env)
    const client = await connect(flow.server, env, request.signal, flow.tokens.access_token)
    try {
      flow.server.tools = await listTools(client, request.signal)
    } finally {
      await client.close().catch(() => {})
    }
    const data = JSON.stringify(flow.server)
    const saved = await env.DB.batch([
      env.DB.prepare(`INSERT INTO mcp_servers (id, data) SELECT ?, ?
        WHERE (? IS NULL AND NOT EXISTS (SELECT 1 FROM mcp_servers WHERE id = ?) AND (SELECT COUNT(*) FROM mcp_servers) < 5)
          OR EXISTS (SELECT 1 FROM mcp_servers WHERE id = ? AND data = ?)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data`).bind(
        flow.server.id,
        data,
        flow.previous,
        flow.server.id,
        flow.server.id,
        flow.previous
      ),
      env.DB.prepare(`INSERT INTO mcp_oauth (server_id, config, tokens)
        SELECT ?, ?, ? WHERE changes() > 0 AND EXISTS (SELECT 1 FROM mcp_servers WHERE id = ? AND data = ?)
        ON CONFLICT(server_id) DO UPDATE SET config = excluded.config, tokens = excluded.tokens, lock_id = NULL, lock_until = 0`).bind(
        flow.server.id,
        JSON.stringify(flow.config),
        JSON.stringify(flow.tokens),
        flow.server.id,
        data
      ),
    ])
    if (saved[0].meta.changes && saved[1].meta.changes) {
      result = 'connected'
    }
  } catch {
    // Callback parameters and token endpoint errors must never be reflected into HTML or URLs.
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: `/?mcp_oauth=${result}`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

export type ConnectedMcpTool = { alias: string; server: StoredServer; tool: Tool; client: Client }
export async function connectMcpTools(env: Env, signal: AbortSignal) {
  const connections: Client[] = []
  const tools: ConnectedMcpTool[] = []
  const failures: string[] = []
  const servers = (await readServers(env)).filter((server) => server.enabled)
  const settled = await Promise.allSettled(
    servers.map(async (server) => {
      let client: Client | undefined
      try {
        client = await connect(server, env, signal)
        const available = await listTools(client, signal)
        return { client, available }
      } catch (error) {
        await client?.close().catch(() => {})
        throw error
      }
    })
  )
  for (const [index, result] of settled.entries()) {
    const server = servers[index]
    if (result.status === 'fulfilled') {
      const { client, available } = result.value
      connections.push(client)
      // Keep aliases deterministic even when connection discovery finishes out of order.
      for (const tool of available.filter(
        (tool) =>
          server.tools.some((known) => known.name === tool.name) &&
          !server.disabledTools.includes(tool.name)
      )) {
        tools.push({ alias: `mcp_${tools.length}`, server, tool, client })
      }
    } else {
      failures.push(`${server.name}: ${errorMessage(result.reason, server)}`)
    }
  }
  if (signal.aborted) {
    await Promise.all(connections.map((connection) => connection.close().catch(() => {})))
    signal.throwIfAborted()
  }
  return {
    tools,
    failures,
    close: () => Promise.all(connections.map((client) => client.close().catch(() => {}))),
  }
}

const delay = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, 1000)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
    }
  })

export async function* runMcpTool(
  entry: ConnectedMcpTool,
  input: Record<string, unknown>,
  env: Env,
  signal: AbortSignal
): AsyncGenerator<Record<string, unknown>, { text: string; isError: boolean }> {
  const block: McpToolBlock = {
    type: 'mcp_tool',
    id: crypto.randomUUID(),
    server: entry.server.name,
    name: entry.tool.name,
    input,
    status: 'running',
  }
  let approvalId: string | undefined
  try {
    if (entry.tool.annotations?.readOnlyHint !== true) {
      approvalId = crypto.randomUUID()
      await env.DB.prepare('DELETE FROM mcp_approvals WHERE expires_at <= ?').bind(Date.now()).run()
      const expires = Date.now() + 120_000
      await env.DB.prepare("INSERT INTO mcp_approvals VALUES (?, 'pending', ?)")
        .bind(approvalId, expires)
        .run()
      yield { type: 'mcp_tool_status', block: { ...block, status: 'approval', approvalId } }
      let approved = false
      while (Date.now() < expires) {
        signal.throwIfAborted()
        const decision = await env.DB.prepare('SELECT status FROM mcp_approvals WHERE id = ?')
          .bind(approvalId)
          .first<{ status: string }>()
        if (decision?.status === 'approved') {
          approved = true
          break
        }
        if (!decision || decision.status === 'denied') {
          break
        }
        yield { type: 'ping' }
        await delay(signal)
      }
      if (!approved) {
        const text =
          'The user declined this tool call, or its approval expired. Do not repeat it without a new user request.'
        yield { type: 'mcp_tool_status', block: { ...block, status: 'denied', output: text } }
        return { text, isError: true }
      }
    }
    yield { type: 'mcp_tool_status', block }
    const result = await entry.client.callTool(
      { name: entry.tool.name, arguments: input },
      undefined,
      { signal, timeout: 30_000 }
    )
    const text = JSON.stringify({
      content: result.content,
      ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
    })
    const isError = result.isError === true
    yield {
      type: 'mcp_tool_status',
      block: {
        ...block,
        status: isError ? 'error' : 'done',
        output:
          text.length > 48000
            ? JSON.stringify({
                text: text.slice(0, 48000),
                truncated: true,
                message: 'The model can inspect the full cached result during this request.',
              })
            : text,
      },
    }
    return { text, isError }
  } catch (error) {
    if (signal.aborted) {
      throw error
    }
    const text = errorMessage(error, entry.server)
    yield { type: 'mcp_tool_status', block: { ...block, status: 'error', output: text } }
    return { text, isError: true }
  } finally {
    if (approvalId) {
      await env.DB.prepare('DELETE FROM mcp_approvals WHERE id = ?').bind(approvalId).run()
    }
  }
}
