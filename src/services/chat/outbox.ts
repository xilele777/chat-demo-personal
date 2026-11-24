import type { Session } from './types.js'

/** Storage identity differs from the conversation identity for independent editors. */
export type PendingCloudSession = {
  id: string
  session: Session
  version?: string
  writer?: string
}
export const outboxKey = (id: string, writer?: string) =>
  writer ? JSON.stringify([id, writer]) : id

/** Plan recovery without moving/deleting another live page's durable snapshot. */
export const recoverOutbox = async (
  items: PendingCloudSession[],
  generation: string,
  remoteIds: ReadonlySet<string>,
  copyLabel: string
): Promise<{ session: Session; source: PendingCloudSession }[]> => {
  const counts = new Map<string, number>()
  for (const { session } of items) {
    counts.set(session.id, (counts.get(session.id) ?? 0) + 1)
  }
  const copyId = async (source: PendingCloudSession, discriminator = '') => {
    const identity = JSON.stringify([source.id, source.version ?? source.session, discriminator])
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity))
    )
    return 'recovered_' + [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  const title = (session: Session) =>
    session.title.endsWith(` (${copyLabel})`)
      ? session.title
      : `${session.title || session.id} (${copyLabel})`
  const planned = await Promise.all(
    items.map(async (source) => {
      const original = source.session
      const changedGeneration = original.cloud && original.cloud.generation !== generation
      const deleted = original.cloud?.revision != null && !remoteIds.has(original.id)
      if ((counts.get(original.id) ?? 0) === 1 && !changedGeneration && !deleted) {
        return { session: original, source }
      }
      // Stable per durable version, so reloads do not invent another ID for the same copy.
      const id = await copyId(source)
      return {
        source,
        session: {
          ...original,
          id,
          cloud: { revision: null, generation },
          title: title(original),
        },
      }
    })
  )
  // A recovery copy may itself have unsynced edits after another crash. Preserve
  // both versions instead of letting its stable ID collide with the source copy.
  const plannedCounts = new Map<string, number>()
  for (const { session } of planned) {
    plannedCounts.set(session.id, (plannedCounts.get(session.id) ?? 0) + 1)
  }
  return Promise.all(
    planned.map(async (item) =>
      (plannedCounts.get(item.session.id) ?? 0) > 1
        ? {
            ...item,
            session: {
              ...item.session,
              id: await copyId(item.source, 'collision'),
              cloud: { revision: null, generation },
              title: title(item.session),
            },
          }
        : item
    )
  )
}
