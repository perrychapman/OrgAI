import { describe, expect, it } from 'vitest'
import { readCappedResponseText, ResponseBodyTooLargeError } from './readCapped'

describe('readCappedResponseText', () => {
  it('counts UTF-8 bytes instead of JavaScript string characters', async () => {
    const response = new Response('€€')
    await expect(readCappedResponseText(response, 5)).rejects.toBeInstanceOf(ResponseBodyTooLargeError)
  })

  it('cancels a chunked response as soon as the byte cap is exceeded', async () => {
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x61, 0x62]))
        controller.enqueue(new Uint8Array([0x63, 0x64]))
      },
      cancel() {
        cancelled = true
      }
    }))
    await expect(readCappedResponseText(response, 3)).rejects.toBeInstanceOf(ResponseBodyTooLargeError)
    expect(cancelled).toBe(true)
  })
})
