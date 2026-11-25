import type { StoredServer, ConnectedMcpTool } from './mcp.js'
import { HttpError, type Env } from './types.js'

/** Remote annotations are hints; only the owner's saved choice grants automatic reads. */
export const trustedRead = (entry: ConnectedMcpTool) =>
  entry.server.trustedReadTools?.includes(entry.tool.name) === true &&
  entry.tool.annotations?.readOnlyHint === true

export async function verifyMcpDispatch(entry: ConnectedMcpTool, env: Env) {
  const row = await env.DB.prepare('SELECT data FROM mcp_servers WHERE id = ?')
    .bind(entry.server.id)
    .first<{ data: string }>()
  const current: StoredServer | undefined = row ? JSON.parse(row.data) : undefined
  if (
    !current?.enabled ||
    current.disabledTools.includes(entry.tool.name) ||
    !current.tools.some(
      (tool) => tool.name === entry.tool.name && JSON.stringify(tool) === JSON.stringify(entry.tool)
    ) ||
    JSON.stringify(current) !== JSON.stringify(entry.server)
  ) {
    throw new HttpError(
      409,
      'MCP configuration changed or permission was revoked. Start a new request with the current settings.'
    )
  }
  if (current.authType === 'oauth') {
    const auth = await env.DB.prepare('SELECT tokens FROM mcp_oauth WHERE server_id = ?')
      .bind(current.id)
      .first<{ tokens: string | null }>()
    if (!auth?.tokens) {
      throw new HttpError(409, 'MCP authorization was revoked. Sign in again before a new request.')
    }
  }
}
