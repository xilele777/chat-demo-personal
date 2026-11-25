import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { HttpError, json, readJsonObject, validId, type Env } from './types.js'
import type { McpServer, McpToolBlock } from '../src/services/mcpTypes.js'
import { recordOperation } from './toolOperations.js'
import { trustedRead, verifyMcpDispatch } from './mcpPolicy.js'
import { validateMcpUrl, limitMcpResponse } from './mcpNet.js'
import { toolResultLimits } from './policy.js'
import { mcpResultText } from './toolResults.js'
import {
  beginAuthorization,
  finishAuthorization,
  oauthAccessToken,
  oauthRequired,
  oauthStatus,
} from './mcpOAuth.js'
import { authorize } from './auth.js'
import { observe } from './observability.js'

export type StoredServer = Omit<McpServer, 'hasToken' | 'tools' | 'oauthStatus'> & {
  token: string
  tools: Tool[]
  toolsDiscoveredAt?: number
}
const publicServer = (server: StoredServer): McpServer => ({
  id: server.id,
  name: server.name,
  url: server.url,
  enabled: server.enabled,
  hasToken: Boolean(server.token),
  authType: server.authType ?? 'bearer',
  disabledTools: server.disabledTools,
  trustedReadTools: server.trustedReadTools ?? [],
  configurationRevision: server.configurationRevision,
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
  tokenOverride?: string,
  connectionSignal = signal,
  catalogValid = () => true,
  onCatalogChanged?: () => Promise<void>
) {
  const url = validateMcpUrl(server.url, env)
  const client = new Client({ name: 'personal-chat', version: '0.1.3' }, { capabilities: {} })
  if (onCatalogChanged) {
    client.setNotificationHandler(ToolListChangedNotificationSchema, onCatalogChanged)
  }
  const limits = toolResultLimits(env)
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
      const send = async () => {
        if (typeof init?.body === 'string') {
          const rpc = JSON.parse(init.body) as { method?: string; params?: { name?: string } }
          if (rpc.method === 'tools/call') {
            if (!catalogValid()) {
              throw new HttpError(409, 'MCP catalog changed. Start a new request.')
            }
            const tool = server.tools.find((tool) => tool.name === rpc.params?.name)
            if (!tool) {
              throw new HttpError(409, 'MCP tool is no longer available')
            }
            await verifyMcpDispatch({ alias: '', server, tool, client }, env)
          }
        }
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
      return limitMcpResponse(response, limits.responseBytes)
    },
  })
  try {
    const started = performance.now()
    await client.connect(transport, { signal: connectionSignal, timeout: 15_000 })
    observe(env, 'mcp_connect', {
      elapsedMs: Math.round(performance.now() - started),
      outcome: 'ok',
    })
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
  let pages = 0
  do {
    const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 15_000 })
    tools.push(...result.tools)
    cursor = result.nextCursor
    if (
      (++pages >= 10 && Boolean(cursor)) ||
      tools.length > 100 ||
      (cursor && seen.has(cursor)) ||
      new TextEncoder().encode(JSON.stringify(tools)).length > 2 * 1024 * 1024
    ) {
      throw new HttpError(422, 'This MCP server exposes too many tools (maximum 100)')
    }
    if (cursor) {
      seen.add(cursor)
    }
  } while (cursor)
  return tools
}

/** One deadline covers initialization and every discovery page. */
async function discover(server: StoredServer, env: Env, signal: AbortSignal, token?: string) {
  const started = performance.now()
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
  let changed = false
  const client = await connect(
    server,
    env,
    deadline,
    token,
    deadline,
    () => !changed,
    async () => {
      changed = true
    }
  )
  try {
    const tools = await listTools(client, deadline)
    if (changed) {
      throw new HttpError(
        409,
        'MCP catalog changed during discovery. Retry with the current catalog.'
      )
    }
    observe(env, 'mcp_discovery', {
      elapsedMs: Math.round(performance.now() - started),
      count: tools.length,
      outcome: 'ok',
    })
    return tools
  } finally {
    await client.close().catch(() => {})
  }
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
    const body = await readJsonObject(request)
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
  const body = (await readJsonObject(request)) as Partial<McpServer> & {
    token?: string
    refreshTools?: boolean
  }
  if (
    typeof body.name !== 'string' ||
    !body.name.trim() ||
    body.name.length > 80 ||
    typeof body.url !== 'string' ||
    body.url.length > 2048 ||
    typeof body.enabled !== 'boolean' ||
    (body.refreshTools !== undefined && typeof body.refreshTools !== 'boolean') ||
    (body.authType !== undefined && !['bearer', 'oauth'].includes(body.authType)) ||
    (body.token !== undefined &&
      (typeof body.token !== 'string' || body.token.length > 4096 || /[\r\n]/.test(body.token))) ||
    !Array.isArray(body.disabledTools) ||
    !body.disabledTools.every((name) => typeof name === 'string') ||
    body.disabledTools.length > 100 ||
    (body.trustedReadTools !== undefined &&
      (!Array.isArray(body.trustedReadTools) ||
        body.trustedReadTools.length > 100 ||
        !body.trustedReadTools.every((name) => typeof name === 'string' && name.length <= 200)))
  ) {
    throw new HttpError(400, 'Invalid MCP configuration')
  }
  const servers = await readServers(env)
  if (
    body.configurationRevision !== undefined &&
    body.configurationRevision !== old?.configurationRevision
  ) {
    throw new HttpError(409, 'MCP settings are stale. Reload settings before saving.')
  }
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
    trustedReadTools: body.trustedReadTools ?? old?.trustedReadTools ?? [],
    configurationRevision: crypto.randomUUID(),
    tools: old?.tools ?? [],
    toolsDiscoveredAt: old?.toolsDiscoveredAt,
  }
  if (server.authType === 'oauth') {
    server.token = ''
  }
  if (
    old?.url !== server.url ||
    (old?.authType ?? 'bearer') !== server.authType ||
    old?.token !== server.token
  ) {
    server.tools = []
    if (old) {
      server.trustedReadTools = []
    }
  }
  if (route[2] === '/authorize') {
    server.trustedReadTools = []
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
  if (
    route[2] ||
    body.refreshTools ||
    (server.enabled &&
      (!old?.enabled ||
        !server.tools.length ||
        old?.url !== server.url ||
        old?.token !== server.token ||
        old?.authType !== server.authType))
  ) {
    try {
      server.tools = await discover(server, env, request.signal)
      server.toolsDiscoveredAt = Date.now()
    } catch (error) {
      throw error instanceof HttpError ? error : new HttpError(502, errorMessage(error, server))
    }
  } else if (old?.url !== server.url || body.token !== undefined) {
    if (!server.enabled && old?.token !== server.token) {
      server.tools = []
    }
  }
  server.trustedReadTools = server.trustedReadTools?.filter((name) =>
    server.tools.some(
      (tool) =>
        tool.name === name &&
        tool.annotations?.readOnlyHint === true &&
        (!old?.tools.some((previous) => previous.name === name) ||
          JSON.stringify(tool) ===
            JSON.stringify(old.tools.find((previous) => previous.name === name)))
    )
  )
  if (!route[2]) {
    const saved = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO mcp_servers (id, data) SELECT ?, ?
        WHERE (? IS NULL AND NOT EXISTS (SELECT 1 FROM mcp_servers WHERE id = ?) AND (SELECT COUNT(*) FROM mcp_servers) < 5)
          OR EXISTS (SELECT 1 FROM mcp_servers WHERE id = ? AND data = ?)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data RETURNING id`
      ).bind(
        id,
        JSON.stringify(server),
        old ? JSON.stringify(old) : null,
        id,
        id,
        old ? JSON.stringify(old) : null
      ),
      ...(old && (old.url !== server.url || server.authType !== 'oauth')
        ? [
            env.DB.prepare(
              'DELETE FROM mcp_oauth WHERE server_id = ? AND EXISTS (SELECT 1 FROM mcp_servers WHERE id = ? AND data = ?)'
            ).bind(id, id, JSON.stringify(server)),
            env.DB.prepare(
              'DELETE FROM mcp_oauth_flows WHERE server_id = ? AND EXISTS (SELECT 1 FROM mcp_servers WHERE id = ? AND data = ?)'
            ).bind(id, id, JSON.stringify(server)),
          ]
        : []),
    ])
    if (!saved[0].results.length) {
      throw new HttpError(409, 'MCP configuration changed while saving. Reload settings and retry.')
    }
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
    flow.server.tools = await discover(flow.server, env, request.signal, flow.tokens.access_token)
    flow.server.toolsDiscoveredAt = Date.now()
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

export type ConnectedMcpTool = {
  alias: string
  server: StoredServer
  tool: Tool
  client?: Client
  prepare?: () => Promise<Client>
}
export async function connectMcpTools(env: Env, signal: AbortSignal) {
  const connections: Client[] = []
  const tools: ConnectedMcpTool[] = []
  const failures: string[] = []
  const servers = (await readServers(env)).filter((server) => server.enabled)
  let closed = false
  for (const server of servers) {
    let pending: Promise<Client> | undefined
    let invalidated = false
    const prepare = () =>
      (pending ??= (async () => {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
        const client = await connect(
          server,
          env,
          signal,
          undefined,
          deadline,
          () => !invalidated,
          async () => {
            invalidated = true
            const next = {
              ...server,
              toolsDiscoveredAt: 0,
              configurationRevision: crypto.randomUUID(),
              trustedReadTools: [],
            }
            await env.DB.prepare('UPDATE mcp_servers SET data = ? WHERE id = ? AND data = ?')
              .bind(JSON.stringify(next), server.id, JSON.stringify(server))
              .run()
          }
        )
        try {
          if (closed || invalidated) {
            throw new HttpError(409, 'MCP request has ended')
          }
          const now = Date.now()
          if (
            !server.toolsDiscoveredAt ||
            now - server.toolsDiscoveredAt >= 5 * 60_000 ||
            server.toolsDiscoveredAt > now
          ) {
            const available = await listTools(client, deadline)
            if (closed || invalidated) {
              throw new HttpError(409, 'MCP catalog changed or request ended during discovery.')
            }
            const previous = JSON.stringify(server)
            const changed = JSON.stringify(available) !== JSON.stringify(server.tools)
            const refreshed = {
              ...server,
              tools: available,
              toolsDiscoveredAt: now,
              ...(changed
                ? { trustedReadTools: [], configurationRevision: crypto.randomUUID() }
                : {}),
            }
            const saved = await env.DB.prepare(
              'UPDATE mcp_servers SET data = ? WHERE id = ? AND data = ? RETURNING id'
            )
              .bind(JSON.stringify(refreshed), server.id, previous)
              .all()
            if (!saved.results.length || changed) {
              throw new HttpError(
                409,
                'MCP schema or configuration changed. Start a new request with the current catalog.'
              )
            }
            Object.assign(server, refreshed)
          }
          if (closed || invalidated) {
            throw new HttpError(409, 'MCP catalog changed or request ended during discovery.')
          }
          connections.push(client)
          return client
        } catch (error) {
          await client.close().catch(() => {})
          throw error
        }
      })())
    for (const tool of server.tools.filter((tool) => !server.disabledTools.includes(tool.name))) {
      const entry: ConnectedMcpTool = {
        alias: `mcp_${tools.length}`,
        server,
        tool,
        prepare: async () => {
          await verifyMcpDispatch(entry, env)
          const client = await prepare()
          if (invalidated) {
            throw new HttpError(409, 'MCP tool catalog changed. Start a new request.')
          }
          await verifyMcpDispatch(entry, env)
          entry.client = client
          return client
        },
      }
      tools.push(entry)
    }
  }
  if (signal.aborted) {
    await Promise.all(connections.map((connection) => connection.close().catch(() => {})))
    signal.throwIfAborted()
  }
  return {
    tools,
    failures,
    close: () => {
      closed = true
      return Promise.all(connections.map((client) => client.close().catch(() => {})))
    },
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
): AsyncGenerator<
  Record<string, unknown>,
  { text: string; isError: boolean; denied?: boolean; uncertain?: boolean }
> {
  const block: McpToolBlock = {
    type: 'mcp_tool',
    id: crypto.randomUUID(),
    server: entry.server.name,
    name: entry.tool.name,
    input,
    status: 'running',
  }
  let approvalId: string | undefined
  let dispatched = false
  const operation = { ...block, serverId: entry.server.id }
  let recorded = false
  try {
    const client = entry.prepare ? await entry.prepare() : entry.client
    if (!client) {
      throw new HttpError(502, 'MCP connection is unavailable')
    }
    await verifyMcpDispatch(entry, env)
    if (!trustedRead(entry)) {
      await recordOperation(env, operation, 'approval')
      recorded = true
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
        await verifyMcpDispatch(entry, env)
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
        await recordOperation(env, operation, 'denied')
        yield { type: 'mcp_tool_status', block: { ...block, status: 'denied', output: text } }
        return { text, isError: true, denied: true }
      }
    }
    yield { type: 'mcp_tool_status', block }
    signal.throwIfAborted()
    // A durable dispatch barrier: if storage fails, no external action is sent.
    await recordOperation(env, operation, 'dispatched')
    recorded = true
    signal.throwIfAborted()
    await verifyMcpDispatch(entry, env)
    dispatched = true
    const result = await client.callTool({ name: entry.tool.name, arguments: input }, undefined, {
      signal,
      timeout: 30_000,
    })
    if (!Array.isArray(result.content)) {
      throw new HttpError(
        502,
        'MCP did not return a completed tool result. The operation may have executed; verify its outcome before retrying.'
      )
    }
    const text = mcpResultText(result)
    const isError = result.isError === true
    await recordOperation(env, operation, isError ? 'unknown' : 'done', text)
    yield {
      type: 'mcp_tool_status',
      block: {
        ...block,
        status: isError ? (trustedRead(entry) ? 'error' : 'unknown') : 'done',
        output:
          text.length > 48000
            ? JSON.stringify({
                text: text.slice(0, 48000),
                truncated: true,
                message: 'Only bounded excerpts may be available to the model during this request.',
              })
            : text,
      },
    }
    return { text, isError, uncertain: isError && !trustedRead(entry) }
  } catch (error) {
    if (recorded) {
      const save = recordOperation(env, operation, dispatched ? 'unknown' : 'denied').catch(
        () => {}
      )
      env.waitUntil?.(save)
      await save
    }
    if (signal.aborted) {
      throw error
    }
    const text = errorMessage(error, entry.server)
    yield {
      type: 'mcp_tool_status',
      block: { ...block, status: dispatched ? 'unknown' : 'error', output: text },
    }
    return {
      text,
      isError: true,
      uncertain: dispatched && !trustedRead(entry),
    }
  } finally {
    if (approvalId) {
      await env.DB.prepare('DELETE FROM mcp_approvals WHERE id = ?').bind(approvalId).run()
    }
  }
}
