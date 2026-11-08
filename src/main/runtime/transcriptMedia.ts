import type { ImageAttachment, TranscriptBlock, TranscriptContentPart, TranscriptMedia } from '../../shared/types'
import { decodedLength, sanitizeImages } from './attachments'

export const TRANSCRIPT_MEDIA_MAX_COUNT = 8
export const TRANSCRIPT_MEDIA_MAX_BYTES = 10 * 1024 * 1024
export const TRANSCRIPT_PARTS_MAX = 128
export const TRANSCRIPT_TEXT_MAX = 64 * 1024

const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const label = (v: unknown): string | undefined => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160) : undefined

/** Never reads a path, resolves a resource, or fetches a URL supplied by a provider. */
export function normalizeTranscriptMedia(raw: unknown): TranscriptMedia {
  const r = object(raw)
  const source = object(r.source)
  const mediaType = label(r.mimeType ?? r.mediaType ?? source.media_type)
  const name = label(r.name)
  const data = source.type === 'base64' ? source.data : r.data
  if ((r.type === 'image' || r.kind === 'image') && typeof data === 'string' && data.length <= Math.ceil(TRANSCRIPT_MEDIA_MAX_BYTES * 4 / 3) + 4) {
    const image = sanitizeImages([{ mediaType: mediaType ?? 'image/png', data, name }])[0]
    if (image) return { kind: 'image', image }
  }
  return { kind: 'unsupported', ...(mediaType ? { mediaType } : {}), ...(name ? { name } : {}), reason: 'Media unavailable: unsupported format, source, or size.' }
}

export function normalizeTranscriptContent(content: unknown): { content: string; parts?: TranscriptContentPart[] } {
  if (typeof content === 'string') return { content: content.slice(0, TRANSCRIPT_TEXT_MAX) }
  if (!Array.isArray(content)) return { content: '[Unsupported tool result]' }
  const parts: TranscriptContentPart[] = []
  let bytes = 0
  let count = 0
  let omitted = false
  let textChars = 0
  for (const raw of content.slice(0, TRANSCRIPT_PARTS_MAX)) {
    const r = object(raw)
    if (r.type === 'text' && typeof r.text === 'string') {
      const text = r.text.slice(0, Math.max(0, TRANSCRIPT_TEXT_MAX - textChars))
      textChars += text.length
      if (text) parts.push({ type: 'text', text })
    } else {
      if (count >= TRANSCRIPT_MEDIA_MAX_COUNT) {
        if (!omitted) parts.push({ type: 'media', media: { kind: 'unsupported', reason: 'Media omitted: transcript entry limit exceeded.' } })
        omitted = true
        continue
      }
      let media = normalizeTranscriptMedia(raw)
      count++
      if (media.kind === 'image') {
        const size = decodedLength(media.image.data)
        if (count > TRANSCRIPT_MEDIA_MAX_COUNT || bytes + size > TRANSCRIPT_MEDIA_MAX_BYTES) media = { kind: 'unsupported', reason: 'Media omitted: transcript entry limit exceeded.' }
        else bytes += size
      }
      parts.push({ type: 'media', media })
    }
  }
  if (content.length > TRANSCRIPT_PARTS_MAX) parts.push({ type: 'text', text: '[Additional tool result content omitted]' })
  return { content: parts.map(p => p.type === 'text' ? p.text : p.media.kind === 'image' ? '[Image]' : `[${p.media.reason}]`).join('\n'), parts }
}

/** Applies the same transformation to every image-bearing location, without mutating live entries. */
export function mapTranscriptImages(block: TranscriptBlock, map: (image: ImageAttachment) => ImageAttachment): TranscriptBlock {
  const media = (m: TranscriptMedia): TranscriptMedia => m.kind === 'image' ? { ...m, image: map(m.image) } : m
  if (block.kind === 'user' && Array.isArray(block.images)) return { ...block, images: block.images.map(map) }
  if (block.kind === 'media') return { ...block, media: media(block.media) }
  if (block.kind === 'tool_result' && Array.isArray(block.parts)) return { ...block, parts: block.parts.map(p => p.type === 'media' ? { ...p, media: media(p.media) } : p) }
  return block
}
