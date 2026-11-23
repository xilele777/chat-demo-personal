import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { HttpError, json, validId, type Env } from './types.js'
import type { McpServer, McpToolBlock } from '../src/services/mcpTypes.js'

type StoredServer = Omit<McpServer, 'hasToken' | 'tools'> & { token: string; tools: Tool[] }
const publicServer = (server: StoredServer): McpServer => ({
  id: server.id,
  name: server.name,
  url: server.url,
  enabled: server.enabled,
  hasToken: Boolean(server.token),
  disabledTools: server.disabledTools,
  tools: server.tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    readOnly: tool.annotations?.readOnlyHint === true,
  })),
})

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
    (!localTest && (url.protocol !== 'https:' || privateHost))
  ) {
    throw new HttpError(
      400,
      'Use a public HTTPS MCP endpoint without credentials or a fragment in its URL'
    )
  }
  return url
}

const errorMessage = (error: unknown, server: StoredServer) => {
  const message = error instanceof Error ? error.message : 'MCP request failed'
  return (server.token ? message.replaceAll(server.token, '[redacted]') : message).slice(0, 500)
}

async function connect(server: StoredServer, env: Env, signal: AbortSignal) {
  const url = validateMcpUrl(server.url, env)
  const client = new Client({ name: 'personal-chat', version: '0.1.3' }, { capabilities: {} })
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: server.token ? { Authorization: `Bearer ${server.token}` } : {} },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: async (input, init) => {
      const response = await fetch(input, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.any([
          signal,
          ...(init?.signal ? [init.signal] : []),
          AbortSignal.timeout(30_000),
        ]),
      })
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
    return json({ servers: (await readServers(env)).map(publicServer) })
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
  const route = path.match(/^\/api\/mcp\/servers\/([a-zA-Z0-9_-]+)(\/test)?$/)
  if (!route) {
    return null
  }
  const id = route[1]
  if (!validId(id)) {
    throw new HttpError(400, 'Invalid MCP server ID')
  }
  const old = (await readServers(env)).find((server) => server.id === id)
  if (request.method === 'DELETE' && !route[2]) {
    await env.DB.prepare('DELETE FROM mcp_servers WHERE id = ?').bind(id).run()
    return json({ ok: true })
  }
  if (request.method !== 'PUT' && !(request.method === 'POST' && route[2])) {
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
    token:
      body.token === undefined
        ? old?.url === validateMcpUrl(body.url, env).href
          ? old.token
          : ''
        : body.token.trim(),
    disabledTools: body.disabledTools,
    tools: old?.tools ?? [],
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
    await env.DB.prepare(
      'INSERT INTO mcp_servers (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'
    )
      .bind(id, JSON.stringify(server))
      .run()
  }
  return json({ server: publicServer(server) })
}

export type ConnectedMcpTool = { alias: string; server: StoredServer; tool: Tool; client: Client }
export async function connectMcpTools(env: Env, signal: AbortSignal) {
  const connections: Client[] = []
  const tools: ConnectedMcpTool[] = []
  const failures: string[] = []
  for (const server of (await readServers(env)).filter((server) => server.enabled)) {
    let client: Client | undefined
    try {
      client = await connect(server, env, signal)
      const available = await listTools(client, signal)
      connections.push(client)
      // Only tools already seen and enabled by the owner enter the model's tool list.
      for (const tool of available.filter(
        (tool) =>
          server.tools.some((known) => known.name === tool.name) &&
          !server.disabledTools.includes(tool.name)
      )) {
        tools.push({ alias: `mcp_${tools.length}`, server, tool, client })
      }
    } catch (error) {
      await client?.close().catch(() => {})
      if (signal.aborted) {
        await Promise.all(connections.map((connection) => connection.close().catch(() => {})))
        throw error
      }
      failures.push(`${server.name}: ${errorMessage(error, server)}`)
    }
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
    }).slice(0, 16000)
    const isError = result.isError === true
    yield {
      type: 'mcp_tool_status',
      block: { ...block, status: isError ? 'error' : 'done', output: text },
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
