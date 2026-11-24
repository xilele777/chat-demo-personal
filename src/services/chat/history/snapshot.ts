import type { Session } from '../types.js'
import { validSessionStructure } from '../validation.js'
import { settleReply } from '../reply.js'
import { fail } from './errors.js'
import { MANIFEST_PATH } from './paths.js'
import { writeArchive } from './zipWriter.js'
import { readArchive, readEntry, type ArchiveEntry } from './zipReader.js'

export const SNAPSHOT_FORMAT = 'chat-demo-personal'
export const SNAPSHOT_VERSION = 1
const INDEX = 'snapshot/index.json'
const sessionPath = (id: string) => `snapshot/sessions/${encodeURIComponent(id)}.json`
const json = (value: unknown) => new Blob([JSON.stringify(value)], { type: 'application/json' })
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const validId = (value: unknown): value is string =>
  // Legacy local imports may have non-ASCII identifiers. File IDs never become
  // paths; session IDs are encoded, while cloud storage retains its own policy.
  typeof value === 'string' && value.length > 0 && !value.includes('\0')

export const checkSnapshotManifest = (value: unknown): void => {
  if (!record(value) || value.format !== SNAPSHOT_FORMAT) {
    return fail('backupUnrecognized')
  }
  if (typeof value.version === 'number' && value.version > SNAPSHOT_VERSION) {
    return fail('backupNewerVersion')
  }
  if (value.version !== SNAPSHOT_VERSION) {
    return fail('backupInvalidVersion')
  }
}

const readSession = (value: unknown): Session => {
  if (
    !record(value) ||
    !validId(value.id) ||
    typeof value.title !== 'string' ||
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt) ||
    typeof value.updatedAt !== 'number' ||
    !Number.isFinite(value.updatedAt) ||
    (value.pinned !== undefined && typeof value.pinned !== 'boolean') ||
    !validSessionStructure(value)
  ) {
    return fail('backupIncomplete')
  }
  return value as Session
}

/** Preserve message data, but never restore remote revisions, file handles or live execution. */
export const snapshotSession = (original: Session, now = Date.now()): Session => {
  const session = structuredClone(readSession(original))
  delete session.cloud
  session.messages = session.messages.map((message) => {
    if (message.role === 'user') {
      for (const file of message.files) {
        file.serverId = null
        delete file.imageSizeChecked
      }
      return message
    }
    const settled = settleReply(
      message,
      message.status === 'pending' || message.status === 'streaming' ? 'stopped' : message.status,
      now,
      message.error
    )
    for (const tool of settled.mcpTools ?? []) {
      delete tool.approvalId
      if (tool.status === 'running' || tool.status === 'approval') {
        tool.status = 'error'
        tool.output =
          'This tool was unfinished when the backup was made. Its outcome is unknown; verify before retrying.'
      }
    }
    return settled
  })
  return session
}

type FileEntry = { id: string; path: string; size: number; mimeType: string }
export type SnapshotStorage = {
  addStagingSession(session: Session): Promise<void>
  saveStagingFiles(files: { id: string; blob: Blob }[]): Promise<void>
}

/** One original per attachment ID, including text/code files and shared attachments. */
export const exportSnapshot = async (
  sessions: Iterable<Session> | AsyncIterable<Session>,
  loadFile: (id: string) => Promise<Blob | undefined>
): Promise<Blob> => {
  const entries = [
    { name: MANIFEST_PATH, blob: json({ format: SNAPSHOT_FORMAT, version: SNAPSHOT_VERSION }) },
  ]
  const attachments: { name: string; blob: Blob }[] = []
  const fileIndex: FileEntry[] = []
  const missingFiles: string[] = []
  const sessionIds = new Set<string>()
  const fileIds = new Set<string>()
  for await (const original of sessions) {
    const session = snapshotSession(original)
    if (sessionIds.has(session.id)) {
      return fail('backupIncomplete')
    }
    sessionIds.add(session.id)
    for (const message of session.messages) {
      if (message.role !== 'user') {
        continue
      }
      for (const file of message.files) {
        if (!validId(file.id)) {
          return fail('backupInvalidFiles')
        }
        if (fileIds.has(file.id)) {
          continue
        }
        fileIds.add(file.id)
        const blob = await loadFile(file.id)
        if (blob) {
          const path = `snapshot/files/${fileIndex.length}`
          fileIndex.push({
            id: file.id,
            path,
            size: blob.size,
            mimeType: blob.type || file.mimeType,
          })
          attachments.push({ name: path, blob })
        } else {
          missingFiles.push(file.id)
        }
      }
    }
    entries.push({ name: sessionPath(session.id), blob: json(session) })
  }
  entries.push({
    name: INDEX,
    blob: json({ sessions: [...sessionIds], files: fileIndex, missingFiles }),
  })
  return writeArchive(entries.concat(attachments))
}

const readJson = async (entry: ArchiveEntry): Promise<unknown> => {
  try {
    return JSON.parse(await (await readEntry(entry)).text())
  } catch (error) {
    if (error instanceof SyntaxError) {
      return fail('backupInvalidJson')
    }
    throw error
  }
}

/** Validate every declared entry before the caller commits staging to live history. */
export const importSnapshot = async (file: File, storage: SnapshotStorage): Promise<void> => {
  const imported = new Set<string>()
  const referenced = new Set<string>()
  const expected = new Map<string, FileEntry>()
  const stored = new Set<string>()
  let manifest = false
  let indexed = false
  for await (const entry of readArchive(file)) {
    if (!manifest) {
      if (entry.path !== MANIFEST_PATH) {
        return fail('backupUnrecognized')
      }
      checkSnapshotManifest(await readJson(entry))
      manifest = true
      continue
    }
    const match = /^snapshot\/sessions\/[^/]+\.json$/.test(entry.path)
    if (match && !indexed) {
      const session = snapshotSession(readSession(await readJson(entry)))
      if (sessionPath(session.id) !== entry.path || imported.has(session.id)) {
        return fail('backupIncomplete')
      }
      imported.add(session.id)
      for (const message of session.messages) {
        if (message.role === 'user') {
          for (const attachment of message.files) {
            if (!validId(attachment.id)) {
              return fail('backupInvalidFiles')
            }
            referenced.add(attachment.id)
          }
        }
      }
      await storage.addStagingSession(session)
    } else if (entry.path === INDEX && !indexed) {
      const index = await readJson(entry)
      if (
        !record(index) ||
        !Array.isArray(index.sessions) ||
        !index.sessions.every(validId) ||
        new Set(index.sessions).size !== index.sessions.length ||
        index.sessions.length !== imported.size ||
        index.sessions.some((id) => !imported.has(id)) ||
        !Array.isArray(index.files) ||
        !Array.isArray(index.missingFiles) ||
        !index.missingFiles.every(validId) ||
        new Set(index.missingFiles).size !== index.missingFiles.length ||
        index.missingFiles.some((id) => !referenced.has(id))
      ) {
        return fail('backupIncomplete')
      }
      const ids = new Set<string>(index.missingFiles)
      for (const item of index.files) {
        if (
          !record(item) ||
          !validId(item.id) ||
          !referenced.has(item.id) ||
          ids.has(item.id) ||
          typeof item.path !== 'string' ||
          !/^snapshot\/files\/(0|[1-9]\d*)$/.test(item.path) ||
          expected.has(item.path) ||
          !Number.isSafeInteger(item.size) ||
          Number(item.size) < 0 ||
          typeof item.mimeType !== 'string'
        ) {
          return fail('backupInvalidFiles')
        }
        ids.add(item.id)
        expected.set(item.path, item as FileEntry)
      }
      if (ids.size !== referenced.size) {
        return fail('backupInvalidFiles')
      }
      indexed = true
    } else {
      const metadata = expected.get(entry.path)
      if (!indexed || !metadata || stored.has(entry.path) || entry.size !== metadata.size) {
        return fail('backupInvalidFiles')
      }
      const blob = await readEntry(entry)
      await storage.saveStagingFiles([
        { id: metadata.id, blob: new Blob([blob], { type: metadata.mimeType }) },
      ])
      stored.add(entry.path)
    }
  }
  if (!manifest || !indexed || stored.size !== expected.size) {
    return fail('backupIncomplete')
  }
}
