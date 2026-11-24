import { HttpError, json, readJsonObject, readSession, validId, type Env } from './types.js'
import { searchSession, type SearchableSession } from '../src/services/chat/search.js'

const conflict = () =>
  new HttpError(
    409,
    'This conversation changed on another device. Keep a copy and sync before retrying.'
  )

export async function storage(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path === '/api/history/search' && request.method === 'GET') {
    const query = new URL(request.url).searchParams.get('q')?.trim() ?? ''
    if (!query || query.length > 200) {
      throw new HttpError(400, 'Search must contain 1–200 characters')
    }
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`
    // Narrow candidates in D1; only the matching excerpts travel to the browser.
    const rows = await env.DB.prepare(`SELECT data FROM sessions s WHERE deleted = 0 AND (
      title LIKE ? ESCAPE '\\' OR EXISTS (
        SELECT 1 FROM json_each(s.data, '$.messages') m WHERE
        json_extract(m.value, '$.content') LIKE ? ESCAPE '\\' OR EXISTS (
          SELECT 1 FROM json_each(m.value, '$.blocks') b WHERE
          json_extract(b.value, '$.type') = 'text' AND json_extract(b.value, '$.text') LIKE ? ESCAPE '\\'
        )
      )
    ) ORDER BY updated_at DESC LIMIT 100`)
      .bind(pattern, pattern, pattern)
      .all<{ data: string }>()
    const results = []
    for (const row of rows.results) {
      results.push(
        ...searchSession(JSON.parse(row.data) as SearchableSession, query, 50 - results.length)
      )
      if (results.length >= 50) {
        break
      }
    }
    return json({ results, limited: results.length >= 50 || rows.results.length >= 100 })
  }
  if (path === '/api/sessions' && request.method === 'GET') {
    const [state, sessions] = await env.DB.batch([
      env.DB.prepare('SELECT generation, revision FROM cloud_state WHERE id = 1'),
      env.DB.prepare(
        "SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, revision, COALESCE(json_extract(data, '$.pinned'), 0) AS pinned FROM sessions WHERE deleted = 0 ORDER BY updated_at DESC"
      ),
    ])
    return json({
      ...(state.results[0] as object),
      sessions: (sessions.results as Record<string, unknown>[]).map((session) => ({
        ...session,
        pinned: Boolean(session.pinned),
      })),
    })
  }
  if (path === '/api/history' && request.method === 'PUT') {
    const body = await readJsonObject(request)
    if (!Array.isArray(body.sessions) || typeof body.revision !== 'string') {
      throw new HttpError(400, 'Invalid history')
    }
    const sessions = body.sessions.map(readSession)
    if (new Set(sessions.map((s) => s.id)).size !== sessions.length) {
      throw new HttpError(400, 'Duplicate session IDs')
    }
    // D1 batches are transactional. Every statement is conditional on our unique generation,
    // so a failed compare-and-swap cannot clear or partially replace the existing history.
    const generation = crypto.randomUUID()
    const statements = [
      env.DB.prepare(
        'UPDATE cloud_state SET generation = ?, revision = ? WHERE id = 1 AND revision = ? RETURNING generation'
      ).bind(generation, generation, body.revision),
      env.DB.prepare(
        'DELETE FROM sessions WHERE EXISTS (SELECT 1 FROM cloud_state WHERE generation = ?)'
      ).bind(generation),
      ...sessions.map((s) =>
        env.DB.prepare(
          'INSERT INTO sessions (id, revision, title, created_at, updated_at, data) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM cloud_state WHERE generation = ?)'
        ).bind(
          s.id,
          crypto.randomUUID(),
          s.title,
          s.createdAt,
          s.updatedAt,
          JSON.stringify(s),
          generation
        )
      ),
    ]
    const result = await env.DB.batch(statements)
    if (!result[0].results.length) {
      throw conflict()
    }
    return json({ generation })
  }
  const match = path.match(/^\/api\/sessions\/([a-zA-Z0-9_-]{1,160})$/)
  if (match) {
    const id = match[1]
    if (request.method === 'GET') {
      const [state, rows] = await env.DB.batch([
        env.DB.prepare('SELECT generation FROM cloud_state WHERE id = 1'),
        env.DB.prepare('SELECT data, revision FROM sessions WHERE id = ? AND deleted = 0').bind(id),
      ])
      const row = rows.results[0] as { data: string; revision: string } | undefined
      if (!row) {
        throw new HttpError(404, 'Conversation not found')
      }
      return json({
        ...(state.results[0] as object),
        revision: row.revision,
        session: JSON.parse(row.data),
      })
    }
    if (request.method === 'PUT') {
      const body = (await readJsonObject(request)) as {
        session: unknown
        revision: string | null
        generation: string
      }
      const session = readSession(body.session)
      if (
        session.id !== id ||
        typeof body.generation !== 'string' ||
        !(body.revision === null || typeof body.revision === 'string')
      ) {
        throw new HttpError(400, 'Invalid session ID or generation')
      }
      const revision = crypto.randomUUID()
      const result =
        await env.DB.prepare(`INSERT INTO sessions (id, revision, title, created_at, updated_at, data)
        SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM cloud_state WHERE generation = ?)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM sessions WHERE id = ?))
        ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, title = excluded.title,
        created_at = excluded.created_at, updated_at = excluded.updated_at, data = excluded.data
        WHERE sessions.deleted = 0 AND sessions.revision = ? RETURNING revision`)
          .bind(
            id,
            revision,
            session.title,
            session.createdAt,
            session.updatedAt,
            JSON.stringify(session),
            body.generation,
            body.revision,
            id,
            body.revision
          )
          .all()
      if (!result.results.length) {
        throw conflict()
      }
      return json({ revision })
    }
    if (request.method === 'DELETE') {
      const body = await readJsonObject(request)
      if (typeof body.revision !== 'string' || typeof body.generation !== 'string') {
        throw new HttpError(400, 'Revision and generation are required')
      }
      const result =
        await env.DB.prepare(`UPDATE sessions SET deleted = 1, revision = ?, data = '{}'
        WHERE id = ? AND revision = ? AND deleted = 0
        AND EXISTS (SELECT 1 FROM cloud_state WHERE generation = ?) RETURNING id`)
          .bind(crypto.randomUUID(), id, body.revision, body.generation)
          .all()
      if (!result.results.length) {
        throw conflict()
      }
      return json({ ok: true })
    }
  }
  const file = path.match(/^\/api\/files\/([^/]+)$/)
  if (file) {
    const id = decodeURIComponent(file[1])
    if (!validId(id)) {
      throw new HttpError(400, 'Invalid file ID')
    }
    const key = `attachments/${id}`
    if (request.method === 'PUT') {
      const size = Number(request.headers.get('Content-Length'))
      if (!Number.isFinite(size) || size > 64 * 1024 * 1024) {
        throw new HttpError(413, 'Attachment exceeds 64 MiB')
      }
      await env.FILES.put(key, request.body, {
        httpMetadata: {
          contentType: request.headers.get('Content-Type') ?? 'application/octet-stream',
        },
      })
      return json({ ok: true })
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      const object =
        request.method === 'HEAD' ? await env.FILES.head(key) : await env.FILES.get(key)
      if (!object) {
        throw new HttpError(404, 'Attachment not found')
      }
      return new Response('body' in object ? (object.body as ReadableStream) : null, {
        headers: {
          'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
          'Content-Length': String(object.size),
          'Content-Disposition': 'attachment',
          'Cache-Control': 'private, no-store',
        },
      })
    }
  }
  return null
}
