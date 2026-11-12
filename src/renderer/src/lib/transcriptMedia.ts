import type { ImageAttachment } from '@shared/types'
import { SUPPORTED_IMAGE_TYPES } from '@shared/defaults'

/** Never turn a stored URL, path, empty payload or unsupported MIME into an image source. */
export function usableTranscriptImage(image: ImageAttachment): boolean {
  return !!image && (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(image.mediaType) && typeof image.data === 'string' && image.data.length > 0 && image.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
}
