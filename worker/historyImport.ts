import { HttpError, json, readJsonObject, readSession, type Env } from './types.js'
import { bodyLimits } from './bodyLimits.js'
import { pinObjects } from './objectLifecycle.js'

export const historyCapacity = { sessions: 10_000, bytes: 512 * 1024 * 1024, ttl: 24 * 60 * 60_000 }

/** Bounded upload requests, followed by one D1 transaction. Old history survives any stage failure. */
export async function historyImport(
  request: Request,
  env: Env,
  path: string
): Promise<Response | null> {
  if (path === '/api/history/imports' && request.method === 'POST') {
    const body = await readJsonObject(request)
    if (typeof body.revision !== 'string') {
      throw new HttpError(400, 'History revision is required')
    }
    const id = crypto.randomUUID()
    await env.DB.prepare('DELETE FROM history_imports WHERE expires_at <= ?').bind(Date.now()).run()
    const saved = await env.DB.prepare(`INSERT INTO history_imports SELECT ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM cloud_state WHERE revision = ?)
      AND (SELECT COUNT(*) FROM history_imports) < 4 RETURNING id`)
      .bind(id, body.revision, Date.now() + historyCapacity.ttl, body.revision)
      .all()
    if (!saved.results.length) {
      throw new HttpError(409, 'History changed or too many unfinished imports. Sync and retry.')
    }
    return json({ id })
  }
  const route = path.match(/^\/api\/history\/imports\/([a-zA-Z0-9_-]+)(\/(?:commit|pins))?$/)
  if (!route) {
    return null
  }
  const id = route[1]
  if (route[2] === '/pins' && request.method === 'DELETE') {
    await env.DB.prepare(`DELETE FROM object_pins WHERE version = ? AND substr(id, 1, ?) = ?
      AND EXISTS (SELECT 1 FROM cloud_state WHERE generation = ?)`)
      .bind(id, `import_${id}_`.length, `import_${id}_`, id)
      .run()
    return json({ ok: true })
  }
  if (!route[2] && request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM history_imports WHERE id = ?').bind(id).run()
    return json({ ok: true })
  }
  if (!route[2] && request.method === 'PUT') {
    const body = await readJsonObject(request, bodyLimits.session)
    const s = readSession(body.session)
    const data = JSON.stringify(s)
    const encoded = new TextEncoder().encode(data)
    const bytes = encoded.length
    // Also protect metadata-only references whose original was absent from the ZIP.
    const keys = [
      ...new Set(
        s.messages.flatMap((message) =>
          message.role === 'user'
            ? (message.files as { id: string; serverId?: string | null }[]).flatMap((file) => [
                `attachments/${file.id}`,
                ...(file.serverId && /^[a-zA-Z0-9_-]{1,160}$/.test(file.serverId)
                  ? [`provider/${file.serverId}`]
                  : []),
              ])
            : []
        )
      ),
    ]
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    await pinObjects(env, `import_${id}_${s.id}_${hash}`, id, keys)
    const saved = await env.DB.prepare(`INSERT INTO history_import_sessions
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM history_imports WHERE id = ? AND expires_at > ?)
      AND (SELECT COUNT(*) FROM history_import_sessions WHERE import_id = ? AND id != ?) < ?
      AND COALESCE((SELECT SUM(bytes) FROM history_import_sessions WHERE import_id = ? AND id != ?), 0) + ? <= ?
      ON CONFLICT(import_id, id) DO UPDATE SET id = excluded.id
      WHERE history_import_sessions.data = excluded.data
      RETURNING id`)
      .bind(
        id,
        s.id,
        s.title,
        s.createdAt,
        s.updatedAt,
        data,
        bytes,
        id,
        Date.now(),
        id,
        s.id,
        historyCapacity.sessions,
        id,
        s.id,
        bytes,
        historyCapacity.bytes
      )
      .all()
    if (!saved.results.length) {
      throw new HttpError(
        413,
        'Import expired or exceeds 10,000 conversations / 512 MiB. Old history is preserved; export smaller batches and retry.'
      )
    }
    return json({ ok: true })
  }
  if (route[2] === '/commit' && request.method === 'POST') {
    const body = await readJsonObject(request)
    if (!Number.isSafeInteger(body.count) || Number(body.count) < 0) {
      throw new HttpError(400, 'Imported count is required')
    }
    // The import ID is also its commit receipt, allowing response-loss recovery.
    const generation = id
    const saved = await env.DB.batch([
      env.DB.prepare(`UPDATE cloud_state SET generation = ?, revision = ? WHERE id = 1
        AND revision = (SELECT revision FROM history_imports WHERE id = ? AND expires_at > ?)
        AND (SELECT COUNT(*) FROM history_import_sessions WHERE import_id = ?) = ? RETURNING generation`).bind(
        generation,
        generation,
        id,
        Date.now(),
        id,
        body.count
      ),
      env.DB.prepare(
        `DELETE FROM sessions WHERE EXISTS (SELECT 1 FROM cloud_state WHERE generation = ?)
        AND EXISTS (SELECT 1 FROM history_imports WHERE id = ?)`
      ).bind(generation, id),
      env.DB.prepare(`INSERT INTO sessions (id, revision, title, created_at, updated_at, data)
        SELECT id, lower(hex(randomblob(16))), title, created_at, updated_at, data FROM history_import_sessions
        WHERE import_id = ? AND EXISTS (SELECT 1 FROM cloud_state WHERE generation = ?)
        AND EXISTS (SELECT 1 FROM history_imports WHERE id = ?)`).bind(id, generation, id),
      env.DB.prepare(
        'DELETE FROM history_imports WHERE id = ? AND EXISTS (SELECT 1 FROM cloud_state WHERE generation = ?)'
      ).bind(id, generation),
    ])
    if (!saved[0].results.length) {
      throw new HttpError(
        409,
        'History changed, import expired or incomplete. Old history is preserved; sync and retry.'
      )
    }
    return json({ generation })
  }
  return null
}
