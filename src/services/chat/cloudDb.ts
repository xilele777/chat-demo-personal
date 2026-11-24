import { cloudFetch, cloudJson } from '../cloud.js'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'
import * as local from './localDb.js'

type Index = {
  generation: string
  revision: string
  sessions: (SessionSummary & { revision: string })[]
}
let generation = ''
let indexedSessions = new Map<string, SessionSummary & { revision: string }>()
let queue: Promise<unknown> = Promise.resolve()
const lineage = new Map<string, string>()
const confirmedFiles = new Set<string>()
const pending = new Map<string, Session>()
let recovered = false

const serial = <T>(run: () => Promise<T>): Promise<T> => {
  const task = queue.then(run)
  queue = task.catch(() => {})
  return task
}

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
  const index = (await (await cloudFetch('/sessions')).json()) as Index
  generation = index.generation
  indexedSessions = new Map(index.sessions.map((session) => [session.id, session]))
  return index
}

export const loadSessionSummaries = async (): Promise<SessionSummary[]> => {
  const index = await readIndex()
  if (!recovered) {
    for (const item of await local.loadOutbox()) {
      pending.set(item.id, item.session)
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
  if (confirmedFiles.has(id)) {
    return
  }
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
  confirmedFiles.add(id)
}

export const saveSession = (session: Session, files: local.StoredFile[] = []): Promise<void> => {
  // Save the latest local snapshot immediately, even while an earlier network save is queued.
  pending.set(session.id, session)
  const version = crypto.randomUUID()
  const durable = Promise.all([local.putOutbox(session, version), local.saveFiles(files)])
  // The serial network task observes this failure; mark it handled while it waits in the queue.
  void durable.catch(() => {})
  return serial(async () => {
    await durable
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
        if (confirmedFiles.has(file.id)) {
          continue
        }
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
    if (pending.get(session.id) === session) {
      pending.delete(session.id)
      await local.removeOutbox(session.id, version)
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
    await local.removeOutbox(id)
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
    const sessions = await local.loadStagingSessions()
    for (const file of await local.loadStagingFiles()) {
      await uploadOriginal(file.id, file.blob)
    }
    const replaced = (await (
      await cloudFetch(
        '/history',
        cloudJson('PUT', {
          revision: index.revision,
          sessions: sessions.map((s) => ({ ...s, cloud: undefined })),
        })
      )
    ).json()) as { generation: string }
    generation = replaced.generation
    indexedSessions.clear()
    lineage.clear()
    for (const id of pending.keys()) {
      await local.removeOutbox(id)
    }
    pending.clear()
    await local.clearStaging()
    return sessions.map(toSessionSummary)
  })

export const forgetPending = async (ids: string[]): Promise<void> => {
  for (const id of ids) {
    pending.delete(id)
    await local.removeOutbox(id)
  }
}
