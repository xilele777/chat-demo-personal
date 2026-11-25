export type GenerationTimeouts = {
  responseMs: number
  firstEventMs: number
  idleMs: number
  totalMs: number
}

/** Race even transports which fail to propagate cancellation to pending reads. */
export const withSignal = async <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => {
  signal.throwIfAborted()
  let abort: () => void = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([work, cancelled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/** Read a bounded error preview, cancel the remainder before parsing or displaying it. */
export const boundedResponseText = async (
  response: Response,
  maxBytes = 64 * 1024,
  signal: AbortSignal = AbortSignal.timeout(20_000)
): Promise<string> => {
  if (!response.body) {
    return ''
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = '',
    bytes = 0
  try {
    while (bytes < maxBytes) {
      const part = await withSignal(reader.read(), signal)
      if (part.done) {
        return text + decoder.decode()
      }
      const kept = part.value.subarray(0, maxBytes - bytes)
      bytes += kept.byteLength
      text += decoder.decode(kept, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
