import { HttpError } from './httpError.js'

export const MiB = 1024 * 1024
export const bodyLimits = {
  json: 256 * 1024,
  session: 1_600_000,
  chat: 4 * MiB,
  history: 16 * MiB,
  attachment: 64 * MiB,
  image: 8 * MiB,
  text: 2 * MiB,
  multipart: 9 * MiB,
  expanded: 16 * MiB,
  files: 50,
}

export const checkDeclaredSize = async (request: Request, max: number) => {
  const value = request.headers.get('Content-Length')
  if (value === null) {
    return
  }
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    await request.body?.cancel().catch(() => {})
    throw new HttpError(400, 'Invalid Content-Length')
  }
  if (Number(value) > max) {
    await request.body?.cancel().catch(() => {})
    throw new HttpError(413, `Request exceeds ${max} bytes`)
  }
}

/** Count actual bytes before JSON or multipart parsers allocate their objects. */
export const readBody = async (request: Request, max: number): Promise<Blob> => {
  await checkDeclaredSize(request, max)
  if (!request.body) {
    return new Blob()
  }
  const reader = request.body.getReader()
  const onAbort = () => {
    void reader.cancel(request.signal.reason).catch(() => {})
  }
  request.signal.addEventListener('abort', onAbort, { once: true })
  const parts: Blob[] = []
  let bytes = 0
  try {
    for (;;) {
      request.signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      bytes += value.byteLength
      if (bytes > max) {
        throw new HttpError(413, `Request exceeds ${max} bytes`)
      }
      parts.push(new Blob([value]))
    }
    request.signal.throwIfAborted()
    return new Blob(parts)
  } finally {
    request.signal.removeEventListener('abort', onAbort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Provisional parts are invisible until completion; failed replacements preserve the old object. */
export const putAttachment = async (request: Request, bucket: R2Bucket, key: string) => {
  await checkDeclaredSize(request, bodyLimits.attachment)
  const options = {
    httpMetadata: {
      contentType: request.headers.get('Content-Type') ?? 'application/octet-stream',
    },
  }
  if (!request.body) {
    await bucket.put(key, new Uint8Array(), options)
    return
  }
  const upload = await bucket.createMultipartUpload(key, options)
  const reader = request.body.getReader()
  const onAbort = () => {
    void reader.cancel(request.signal.reason).catch(() => {})
  }
  request.signal.addEventListener('abort', onAbort, { once: true })
  const buffer = new Uint8Array(5 * MiB)
  const parts: R2UploadedPart[] = []
  let filled = 0
  let total = 0
  let completed = false
  try {
    for (;;) {
      request.signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      total += value.byteLength
      if (total > bodyLimits.attachment) {
        throw new HttpError(413, 'Attachment exceeds 64 MiB')
      }
      for (let offset = 0; offset < value.byteLength; ) {
        const length = Math.min(buffer.length - filled, value.byteLength - offset)
        buffer.set(value.subarray(offset, offset + length), filled)
        offset += length
        filled += length
        if (filled === buffer.length) {
          parts.push(await upload.uploadPart(parts.length + 1, buffer))
          filled = 0
        }
      }
    }
    if (filled) {
      parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, filled)))
    }
    request.signal.throwIfAborted()
    if (parts.length) {
      await upload.complete(parts)
    } else {
      await upload.abort()
      await bucket.put(key, new Uint8Array(), options)
    }
    completed = true
  } finally {
    request.signal.removeEventListener('abort', onAbort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
    if (!completed) {
      await upload.abort().catch(() => {})
    }
  }
}
