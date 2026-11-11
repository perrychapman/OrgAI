/** A remote response body exceeded its configured byte limit. */
export class ResponseBodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Response body exceeds the ${maxBytes}-byte limit.`)
    this.name = 'ResponseBodyTooLargeError'
  }
}

/** Read a response body as UTF-8, enforcing the limit against streamed bytes, not decoded characters. */
export async function readCappedResponseText(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelResponseBody(res)
    throw new ResponseBodyTooLargeError(maxBytes)
  }
  if (!res.body) return ''

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) throw new ResponseBodyTooLargeError(maxBytes)
      chunks.push(value)
    }
    return Buffer.concat(chunks, total).toString('utf8')
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}

/** Stop consuming a response whose body is intentionally unused. */
export async function cancelResponseBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {})
}
