import { openDB } from 'idb'

const busy = () =>
  new Error(
    'Another page is generating or importing history. Wait for it to finish, then sync and retry.'
  )
const prefix = 'personal-chat:'
let channel: BroadcastChannel | undefined
const notify = () => {
  if (typeof BroadcastChannel !== 'undefined') {
    channel ??= new BroadcastChannel(`${prefix}changes`)
    channel.postMessage({ type: 'settled' })
  }
}

async function hold(name: string, mode: LockMode): Promise<() => void> {
  let release!: () => void
  const lifetime = new Promise<void>((resolve) => {
    release = resolve
  })
  return new Promise((resolve, reject) => {
    void navigator.locks
      .request(name, { mode, ifAvailable: true }, async (lock) => {
        if (!lock) {
          reject(busy())
          return
        }
        resolve(release)
        await lifetime
      })
      .catch(reject)
  })
}

/** Web Locks release on page death. Older browsers use one transactional, conservative lease. */
export async function acquireChatWork(sessionId?: string): Promise<() => void> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    const releaseHistory = await hold(`${prefix}history`, sessionId ? 'shared' : 'exclusive')
    let releaseSession: (() => void) | undefined
    try {
      if (sessionId) {
        releaseSession = await hold(`${prefix}session:${sessionId}`, 'exclusive')
      }
    } catch (error) {
      releaseHistory()
      throw error
    }
    return () => {
      releaseSession?.()
      releaseHistory()
      notify()
    }
  }
  // No heartbeat takeover: background throttling must not give another page an active lease.
  // Wall-clock expiry cannot prove a suspended page or its Worker has stopped.
  // Keep abandoned leases until explicit maintenance after closing every page.
  const db = await openDB('personal-chat-coordination', 1, {
    upgrade(db) {
      db.createObjectStore('leases')
    },
  })
  const token = crypto.randomUUID()
  const tx = db.transaction('leases', 'readwrite')
  const lease = (await tx.store.get('work')) as { token: string; expires: number } | undefined
  if (lease) {
    await tx.done
    db.close()
    throw lease.expires > Date.now()
      ? busy()
      : new Error(
          'A previous page still owns the recovery lease. Close all app pages, then remove only the personal-chat-coordination IndexedDB database before retrying.'
        )
  }
  await tx.store.put({ token, expires: Date.now() + 50 * 60_000 }, 'work')
  await tx.done
  return () => {
    void (async () => {
      const cleanup = db.transaction('leases', 'readwrite')
      if ((await cleanup.store.get('work'))?.token === token) {
        await cleanup.store.delete('work')
      }
      await cleanup.done
      db.close()
      notify()
    })()
  }
}

export function bindChatCoordination(onChange: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') {
    return () => {}
  }
  const listener = new BroadcastChannel(`${prefix}changes`)
  listener.onmessage = (event) => {
    if (event.data?.type === 'settled') {
      onChange()
    }
  }
  return () => listener.close()
}
