import { json, readJsonObject, validId, type Env } from './types.js'
import { HttpError } from './httpError.js'

export const recordOperation = async (
  env: Env,
  operation: { id: string; serverId: string; server: string; name: string },
  state: 'approval' | 'dispatched' | 'done' | 'unknown' | 'denied',
  result?: string
) => {
  const digest =
    result === undefined
      ? null
      : Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(result)))
        )
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('')
  const now = Date.now()
  await env.DB.prepare(`INSERT INTO tool_operations
    (id, request_id, server_id, server_name, tool_name, state, created_at, updated_at, result_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at,
    result_sha256 = excluded.result_sha256`)
    .bind(
      operation.id,
      env.operationRequestId ?? null,
      operation.serverId,
      operation.server.slice(0, 160),
      operation.name.slice(0, 200),
      state,
      now,
      now,
      digest
    )
    .run()
}

export const toolOperationRoutes = async (request: Request, env: Env, path: string) => {
  if (path !== '/api/mcp/operations/query' || request.method !== 'POST') {
    return null
  }
  const body = await readJsonObject(request)
  if (
    !Array.isArray(body.requestIds) ||
    body.requestIds.length > 100 ||
    !body.requestIds.every((id) => typeof id === 'string' && validId(id))
  ) {
    throw new HttpError(400, 'Invalid operation request IDs')
  }
  if (!body.requestIds.length) {
    return json({ operations: [] })
  }
  const rows = await env.DB.prepare(`SELECT id, request_id AS requestId,
    server_name AS server, tool_name AS name, state, updated_at AS updatedAt,
    result_sha256 AS resultSha256 FROM tool_operations
    WHERE request_id IN (${body.requestIds.map(() => '?').join(',')})
    ORDER BY created_at DESC LIMIT 3200`)
    .bind(...body.requestIds)
    .all()
  return json({ operations: rows.results })
}
