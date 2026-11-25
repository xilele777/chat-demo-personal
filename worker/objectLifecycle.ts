import { HttpError, json, readJsonObject, type Env } from './types.js'
import { bodyLimits } from './bodyLimits.js'

const keyValid = (key: unknown): key is string =>
  typeof key === 'string' && /^(attachments|provider)\/[a-zA-Z0-9_-]{1,160}$/.test(key)
const referenced = `EXISTS (SELECT 1 FROM sessions s, json_each(s.data, '$.messages') m, json_each(m.value, '$.files') f
  WHERE s.deleted = 0 AND (? = 'attachments/' || json_extract(f.value, '$.id') OR ? = 'provider/' || json_extract(f.value, '$.serverId')))
  OR EXISTS (SELECT 1 FROM object_pins p, json_each(p.keys) k WHERE k.value = ?)`

/** Pins have no automatic expiry: an offline recovery copy must remain protected. */
export async function pinObjects(env: Env, id: string, version: string, keys: string[]) {
  const saved = await env.DB.prepare(`INSERT INTO object_pins (id, version, keys) SELECT ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM object_gc_claims c, json_each(?) k WHERE c.key = k.value)
    ON CONFLICT(id) DO UPDATE SET version = excluded.version, keys = excluded.keys RETURNING id`)
    .bind(id, version, JSON.stringify(keys), JSON.stringify(keys))
    .all()
  if (!saved.results.length) {
    throw new HttpError(
      409,
      'Attachment cleanup in progress. Retry sync; the local copy is preserved.'
    )
  }
}
export async function unpinObjects(env: Env, id: string, version: string) {
  await env.DB.prepare('DELETE FROM object_pins WHERE id = ? AND version = ?')
    .bind(id, version)
    .run()
}

async function disposition(env: Env, key: string, uploaded: Date) {
  const tracking = Date.parse(env.OBJECT_GC_TRACKING_SINCE ?? '')
  // Existing installations can contain outboxes predating pins; protect those forever by default.
  if (!Number.isFinite(tracking) || uploaded.getTime() < tracking) {
    return 'legacy_protected'
  }
  if (Date.now() - uploaded.getTime() < 30 * 24 * 60 * 60_000) {
    return 'retained'
  }
  const row = await env.DB.prepare(`SELECT (${referenced}) AS used`)
    .bind(key, key, key)
    .first<{ used: number }>()
  return row?.used ? 'referenced_or_pinned' : 'candidate'
}

/** Owner-only manual maintenance. GET is a paginated dry run; DELETE fences and rechecks one candidate. */
export async function objectLifecycle(
  request: Request,
  env: Env,
  path: string
): Promise<Response | null> {
  if (path === '/api/storage/pins' && request.method === 'GET') {
    const after = new URL(request.url).searchParams.get('after') ?? ''
    const rows = await env.DB.prepare(
      'SELECT id, version, keys FROM object_pins WHERE id > ? ORDER BY id LIMIT 100'
    )
      .bind(after)
      .all<{ id: string; version: string; keys: string }>()
    return json({
      pins: rows.results.map((row) => ({ ...row, keys: JSON.parse(row.keys) })),
      ...(rows.results.length === 100 ? { after: rows.results.at(-1)?.id } : {}),
    })
  }
  const pin = path.match(/^\/api\/storage\/pins\/([a-zA-Z0-9_-]{1,360})$/)
  if (pin && (request.method === 'PUT' || request.method === 'DELETE')) {
    const body = await readJsonObject(request, bodyLimits.session)
    if (typeof body.version !== 'string' || body.version.length > 80) {
      throw new HttpError(400, 'Pin version required')
    }
    if (request.method === 'DELETE') {
      await unpinObjects(env, pin[1], body.version)
      return json({ ok: true })
    }
    if (!Array.isArray(body.keys) || body.keys.length > 5000 || !body.keys.every(keyValid)) {
      throw new HttpError(400, 'Invalid recovery references')
    }
    await pinObjects(env, pin[1], body.version, [...new Set(body.keys)])
    return json({ ok: true })
  }
  if (path !== '/api/storage/objects') {
    return null
  }
  if (request.method === 'GET') {
    const params = new URL(request.url).searchParams
    const prefix = params.get('prefix') ?? 'attachments/'
    if (!['attachments/', 'provider/'].includes(prefix)) {
      throw new HttpError(400, 'Invalid object prefix')
    }
    const page = await env.FILES.list({
      prefix,
      limit: 100,
      cursor: params.get('cursor') ?? undefined,
    })
    const objects = []
    for (const object of page.objects) {
      objects.push({
        key: object.key,
        etag: object.etag,
        size: object.size,
        uploaded: object.uploaded.toISOString(),
        disposition: await disposition(env, object.key, object.uploaded),
      })
    }
    return json({
      dryRun: true,
      retentionDays: 30,
      objects,
      ...(page.truncated ? { cursor: page.cursor } : {}),
    })
  }
  if (request.method === 'DELETE') {
    const body = await readJsonObject(request)
    if (!keyValid(body.key) || typeof body.etag !== 'string') {
      throw new HttpError(400, 'A dry-run object key and etag are required')
    }
    const object = await env.FILES.head(body.key)
    if (
      !object ||
      object.etag !== body.etag ||
      (await disposition(env, body.key, object.uploaded)) !== 'candidate'
    ) {
      throw new HttpError(
        409,
        'Object changed, is referenced, protected by recovery, or inside its retention period. Run the preview again.'
      )
    }
    const claimed = await env.DB.prepare(
      `INSERT INTO object_gc_claims SELECT ? WHERE NOT (${referenced}) RETURNING key`
    )
      .bind(body.key, body.key, body.key, body.key)
      .all()
    if (!claimed.results.length) {
      throw new HttpError(409, 'Object acquired a reference. Run the preview again.')
    }
    let releaseClaim = false
    try {
      const current = await env.FILES.head(body.key)
      if (
        current?.etag !== body.etag ||
        (await disposition(env, body.key, current.uploaded)) !== 'candidate'
      ) {
        releaseClaim = true
        throw new HttpError(409, 'Object changed. Run the preview again.')
      }
      await env.FILES.delete(body.key)
      releaseClaim = true
    } finally {
      // A rejected delete may have an unknown outcome. Keep its fence until manual verification.
      if (releaseClaim) {
        await env.DB.prepare('DELETE FROM object_gc_claims WHERE key = ?').bind(body.key).run()
      }
    }
    return json({ ok: true })
  }
  return null
}
