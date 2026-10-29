import { MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_BYTES, SUPPORTED_IMAGE_TYPES } from '@shared/defaults'
import type { ImageAttachment, ImageMediaType } from '@shared/types'

const DATA_URL_PREFIX = /^data:([^;,]+);base64,/i
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** Decoded byte length of a base64 string, without allocating. Assumes the string already matched BASE64. */
export function decodedLength(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  const chars = b64.length - padding
  return Math.floor((chars * 3) / 4)
}

/**
 * Validate images from the renderer (untrusted IPC input) before they reach a provider or the store.
 * Never throws. Each dropped image produces one `warn` naming the reason. A stray `data:<type>;base64,`
 * prefix is stripped and accepted (the declared mediaType still decides support). Returns fresh plain
 * objects so nothing unexpected is persisted.
 */
export function sanitizeImages(images: unknown, warn: (message: string) => void = () => {}): ImageAttachment[] {
  if (images === undefined || images === null) return []
  if (!Array.isArray(images)) {
    warn('Dropped images: expected an array')
    return []
  }
  const out: ImageAttachment[] = []
  images.forEach((raw: unknown, index: number) => {
    const label = (name?: unknown): string => `image ${index + 1}${typeof name === 'string' && name ? ` (${name})` : ''}`
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      warn(`Dropped ${label()}: not an object`)
      return
    }
    const r = raw as Record<string, unknown>
    const name = typeof r.name === 'string' && r.name ? r.name : undefined
    if (out.length >= MAX_IMAGES_PER_MESSAGE) {
      warn(`Dropped ${label(name)}: more than ${MAX_IMAGES_PER_MESSAGE} images in one message`)
      return
    }
    if (typeof r.mediaType !== 'string' || !(SUPPORTED_IMAGE_TYPES as readonly string[]).includes(r.mediaType)) {
      warn(`Dropped ${label(name)}: unsupported media type ${String(r.mediaType)}`)
      return
    }
    if (typeof r.data !== 'string' || r.data.length === 0) {
      warn(`Dropped ${label(name)}: missing data`)
      return
    }
    const data = r.data.replace(DATA_URL_PREFIX, '').replace(/\s+/g, '')
    if (data.length === 0 || data.length % 4 === 1 || !BASE64.test(data)) {
      warn(`Dropped ${label(name)}: data is not valid base64`)
      return
    }
    if (decodedLength(data) > MAX_IMAGE_BYTES) {
      warn(`Dropped ${label(name)}: larger than ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`)
      return
    }
    const image: ImageAttachment = { mediaType: r.mediaType as ImageMediaType, data }
    if (name) image.name = name
    out.push(image)
  })
  return out
}

/** Is there anything to send: non-blank text or at least one image? */
export function hasContent(text: string, images: readonly ImageAttachment[]): boolean {
  return text.trim().length > 0 || images.length > 0
}
