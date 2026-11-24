/** Merge independent tool streams, keeping results in request order and limiting in-flight work. */
export async function* parallelEvents<T>(
  jobs: (() => AsyncGenerator<Record<string, unknown>, T>)[],
  concurrency: number,
  signal: AbortSignal
): AsyncGenerator<Record<string, unknown>, T[]> {
  const active = new Map<
    number,
    {
      iterator: AsyncGenerator<Record<string, unknown>, T>
      next: Promise<{ id: number; value: IteratorResult<Record<string, unknown>, T> }>
    }
  >()
  const results: T[] = []
  let cursor = 0
  const advance = (id: number, iterator: AsyncGenerator<Record<string, unknown>, T>) => {
    active.set(id, { iterator, next: iterator.next().then((value) => ({ id, value })) })
  }
  try {
    while (cursor < jobs.length || active.size) {
      signal.throwIfAborted()
      while (cursor < jobs.length && active.size < concurrency) {
        const id = cursor++
        advance(id, jobs[id]())
      }
      const { id, value } = await Promise.race([...active.values()].map((job) => job.next))
      const job = active.get(id)
      if (!job) {
        throw new Error('Missing parallel tool job')
      }
      if (value.done) {
        results[id] = value.value
        active.delete(id)
      } else {
        // Start the next read only after the consumer accepts this event.
        yield value.value
        advance(id, job.iterator)
      }
    }
    return results
  } finally {
    await Promise.allSettled(
      [...active.values()].map(async (job) => {
        await job.next.catch(() => {})
        await job.iterator.return(undefined as T)
      })
    )
  }
}
