import { cloudFetch, cloudJson } from '../cloud.js'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'
import * as local from './localDb.js'
import { recoverOutbox } from './outbox.js'
import { translate } from '../../i18n/index.js'

type Index = {
  generation: string
  revision: string
  sessions: (SessionSummary & { revision: string })[]
}
let generation = ''
let indexedSessions = new Map<string, SessionSummary & { revision: string }>()
let queue: Promise<unknown> = Promise.resolve()
const lineage = new Map<string, string>()
const pending = new Map<string, Session>()
const durableSnapshots = new WeakMap<Session, Promise<void>>()
const pinQueues = new Map<string, Promise<void>>()
/** Generation needs a local commit and confirmed recovery pins before dispatch. */
export const waitForSnapshot = (session: Session): Promise<void> =>
  durableSnapshots.get(session) ?? Promise.reject(new Error('Snapshot was not queued for saving'))
const writer = crypto.randomUUID()
const recoveredSources = new Map<string, local.PendingCloudSession>()
let recovered = false

const serial = <T>(run: () => Promise<T>): Promise<T> => {
  const task = queue.then(run)
  queue = task.catch(() => {})
  return task
}
export const settleSaves = () => serial(async () => {})

export const pendingIds = () => [...pending.keys()]
export const newStamp = (): NonNullable<Session['cloud']> => ({ revision: null, generation })
/** 内存中的本地修改保存后沿用原 stamp，lineage 记录其已确认的最新版本。 */
export const isSessionCurrent = (session: Session, remoteGeneration: string, revision: string) => {
  const stamp = session.cloud
  return (
    stamp?.generation === remoteGeneration &&
    (lineage.get(`${session.id}:${stamp.generation}:${stamp.revision ?? ''}`) ?? stamp.revision) ===
      revision
  )
}

const cacheSession = (session: Session) => {
  void local.cacheCloudSession(session).catch(local.reportStorageError('cache cloud session'))
}
export const readIndex = async (): Promise<Index> => {
  let index: Index | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    let offset = 0
    let complete = true
    const sessions: Index['sessions'] = []
    let first: Index | undefined
    do {
      const page = (await (
        await cloudFetch(`/sessions?limit=200&offset=${offset}`)
      ).json()) as Index & { nextOffset?: number }
      first ??= page
      if (page.revision !== first.revision || page.generation !== first.generation) {
        complete = false
        break
      }
      sessions.push(...page.sessions)
      if (sessions.length > 10_000) {
        throw new Error('History exceeds the supported index capacity')
      }
      if (page.nextOffset === undefined) {
        break
      }
      if (page.nextOffset <= offset || sessions.length > 10_000) {
        throw new Error('History exceeds the supported index capacity')
      }
      offset = page.nextOffset
    } while (offset <= 10_000)
    if (complete && first) {
      index = { ...first, sessions }
      break
    }
  }
  if (!index) {
    throw new Error('History changed while loading. Retry sync.')
  }
  generation = index.generation
  indexedSessions = new Map(index.sessions.map((session) => [session.id, session]))
  return index
}

export async function verifyGenerationSource(session: Session): Promise<void> {
  // Observe this page's confirmed lineage only after earlier queued writes settle.
  await serial(async () => {})
  const index = await readIndex()
  const remote = index.sessions.find((item) => item.id === session.id)
  if (
    session.cloud?.generation !== index.generation ||
    (remote
      ? !isSessionCurrent(session, index.generation, remote.revision)
      : session.cloud?.revision !== null)
  ) {
    throw new Error(
      'This conversation changed in another page. Keep your local copy, sync and retry.'
    )
  }
}

export const loadSessionSummaries = async (): Promise<SessionSummary[]> => {
  const index = await readIndex()
  if (!recovered) {
    for (const item of await recoverOutbox(
      await local.loadOutbox(),
      index.generation,
      new Set(index.sessions.map((session) => session.id)),
      translate('cloudLocalCopy')
    )) {
      pending.set(item.session.id, item.session)
      recoveredSources.set(item.session.id, item.source)
    }
    recovered = true
  }
  const all = new Map(index.sessions.map((s) => [s.id, toSessionSummary(s)]))
  for (const session of pending.values()) {
    all.set(session.id, toSessionSummary(session))
  }
  return [...all.values()]
}

export const loadSession = async (id: string, prefetch = false): Promise<Session | undefined> => {
  if (pending.has(id)) {
    return pending.get(id)
  }
  const cached = await local.loadCachedCloudSession(id).catch(() => undefined)
  // 缓存自身的版本必须匹配最新列表；不能用 lineage 将旧内容视为新版本。
  if (
    cached?.cloud?.generation === generation &&
    cached.cloud.revision === indexedSessions.get(id)?.revision
  ) {
    cacheSession(cached)
    return cached
  }
  const response = await cloudFetch(`/sessions/${encodeURIComponent(id)}`, {
    priority: prefetch ? 'low' : 'auto',
  })
  const body = (await response.json()) as { session: Session; revision: string; generation: string }
  const session = {
    ...body.session,
    cloud: { revision: body.revision, generation: body.generation },
  }
  cacheSession(session)
  return session
}

async function uploadOriginal(id: string, blob: Blob): Promise<void> {
  // A previous save's HEAD is not proof after owner maintenance deletes an orphan.
  const response = await fetch(`/api/files/${encodeURIComponent(id)}`, {
    method: 'HEAD',
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
  })
  if (response.status === 404) {
    await cloudFetch(`/files/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: blob,
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    })
  } else if (!response.ok) {
    throw new Error(`Attachment sync HTTP ${response.status}`)
  }
}

export const saveSession = (session: Session, files: local.StoredFile[] = []): Promise<void> => {
  // Save the latest local snapshot immediately, even while an earlier network save is queued.
  pending.set(session.id, session)
  const version = crypto.randomUUID()
  const durable = local.putOutbox(session, version, files, writer)
  const pinId = `${writer}_${session.id}`
  const keys = [
    ...new Set(
      session.messages.flatMap((message) =>
        message.role === 'user'
          ? message.files.flatMap((file) => [
              `attachments/${file.id}`,
              ...(file.serverId && /^[a-zA-Z0-9_-]{1,160}$/.test(file.serverId)
                ? [`provider/${file.serverId}`]
                : []),
            ])
          : []
      )
    ),
  ]
  const protectedSnapshot = (pinQueues.get(pinId) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await durable
      await cloudFetch(`/storage/pins/${pinId}`, cloudJson('PUT', { version, keys }))
    })
  pinQueues.set(pinId, protectedSnapshot)
  void protectedSnapshot
    .finally(() => {
      if (pinQueues.get(pinId) === protectedSnapshot) {
        pinQueues.delete(pinId)
      }
    })
    .catch(() => {})
  durableSnapshots.set(session, protectedSnapshot)
  void protectedSnapshot.catch(() => {})
  // The serial network task observes this failure; mark it handled while it waits in the queue.
  void durable.catch(() => {})
  return serial(async () => {
    await protectedSnapshot
    if (!generation) {
      await readIndex()
    }
    const source = session.cloud ?? { revision: null, generation }
    const key = `${session.id}:${source.generation}:${source.revision ?? ''}`
    const revision = lineage.get(key) ?? source.revision
    for (const message of session.messages) {
      if (message.role !== 'user') {
        continue
      }
      for (const file of message.files) {
        const blob = await local.loadFile(file.id)
        if (blob) {
          await uploadOriginal(file.id, blob)
        }
      }
    }
    // Remote readers see a settled snapshot; live generation remains on the originating device.
    const data: Session = {
      ...session,
      cloud: undefined,
      messages: session.messages.map((m) =>
        m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
          ? { ...m, status: 'stopped' }
          : m
      ),
    }
    const result = (await (
      await cloudFetch(
        `/sessions/${encodeURIComponent(session.id)}`,
        cloudJson('PUT', {
          session: data,
          revision,
          generation: source.generation,
        })
      )
    ).json()) as { revision: string }
    lineage.set(key, result.revision)
    cacheSession({ ...data, cloud: { revision: result.revision, generation: source.generation } })
    await forgetRecoveredSource(session.id)
    if (pending.get(session.id) === session) {
      await local.removeOutbox(session.id, version, writer)
      if (pending.get(session.id) === session) {
        pending.delete(session.id)
      }
      // A crash before IndexedDB deletion must leave the recovery reference pinned.
      await cloudFetch(`/storage/pins/${pinId}`, cloudJson('DELETE', { version })).catch(() => {})
    }
  })
}

export const renameSession = async (id: string, title: string): Promise<void> => {
  const session = await loadSession(id)
  if (session) {
    await saveSession({ ...session, title })
  }
}

export const deleteSession = (id: string): Promise<void> =>
  serial(async () => {
    const session = await loadSession(id)
    if (!session?.cloud) {
      throw new Error('Sync this conversation before deleting it')
    }
    const source = session.cloud
    const revision =
      lineage.get(`${id}:${source.generation}:${source.revision ?? ''}`) ?? source.revision
    await cloudFetch(
      `/sessions/${encodeURIComponent(id)}`,
      cloudJson('DELETE', { revision, generation: source.generation })
    )
    pending.delete(id)
    await local.removeOutbox(id, undefined, writer)
    await forgetRecoveredSource(id)
    indexedSessions.delete(id)
    void local.removeCachedCloudSession(id).catch(local.reportStorageError('remove cloud cache'))
  })

export const loadFile = async (id: string): Promise<Blob | undefined> => {
  const cached = await local.loadFile(id)
  if (cached) {
    return cached
  }
  try {
    const blob = await (await cloudFetch(`/files/${encodeURIComponent(id)}`)).blob()
    await local.saveFiles([{ id, blob }])
    return blob
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 404) {
      return undefined
    }
    throw error
  }
}

export const commitStaging = (): Promise<SessionSummary[]> =>
  serial(async () => {
    const index = await readIndex()
    const sessions: SessionSummary[] = []
    const started = (await (
      await cloudFetch('/history/imports', cloudJson('POST', { revision: index.revision }))
    ).json()) as { id: string }
    let replaced: { generation: string }
    const pinId = `import_${started.id}`
    try {
      const keys: string[] = []
      for await (const file of local.stagingFiles()) {
        keys.push(`attachments/${file.id}`)
      }
      await cloudFetch(`/storage/pins/${pinId}`, cloudJson('PUT', { version: started.id, keys }))
      for await (const file of local.stagingFiles()) {
        await uploadOriginal(file.id, file.blob)
      }
      for await (const session of local.stagingSessions()) {
        await cloudFetch(
          `/history/imports/${started.id}`,
          cloudJson('PUT', { session: { ...session, cloud: undefined } })
        )
        sessions.push(toSessionSummary(session))
      }
      replaced = (await (
        await cloudFetch(
          `/history/imports/${started.id}/commit`,
          cloudJson('POST', { count: sessions.length })
        )
      ).json()) as { generation: string }
    } catch (error) {
      // A lost commit response must not turn an applied import into a reported failure.
      const current = await readIndex().catch(() => undefined)
      if (current?.generation === started.id) {
        replaced = { generation: started.id }
      } else {
        await cloudFetch(`/history/imports/${started.id}`, { method: 'DELETE' }).catch(() => {})
        throw error
      }
    }
    generation = replaced.generation
    indexedSessions.clear()
    lineage.clear()
    for (const id of pending.keys()) {
      await local.removeOutbox(id, undefined, writer)
    }
    pending.clear()
    recoveredSources.clear()
    await local.clearStaging()
    await cloudFetch(`/history/imports/${started.id}/pins`, { method: 'DELETE' }).catch(() => {})
    await cloudFetch(`/storage/pins/${pinId}`, cloudJson('DELETE', { version: started.id })).catch(
      () => {}
    )
    return sessions.map(toSessionSummary)
  })

export const forgetPending = async (ids: string[]): Promise<void> => {
  for (const id of ids) {
    pending.delete(id)
    await local.removeOutbox(id, undefined, writer)
    await forgetRecoveredSource(id)
  }
}

const forgetRecoveredSource = async (id: string): Promise<void> => {
  const source = recoveredSources.get(id)
  if (source) {
    await local.removeOutboxSnapshot(source.id, source.version)
    if (recoveredSources.get(id) === source) {
      recoveredSources.delete(id)
    }
  }
}
