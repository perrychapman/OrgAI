import { describe, expect, it } from 'vitest'
import { normalizeTranscriptContent, normalizeTranscriptMedia, TRANSCRIPT_MEDIA_MAX_COUNT } from './transcriptMedia'

const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64')
const image = { type: 'image', data, mimeType: 'image/png' }
describe('transcript media normalization', () => {
  it('retains mixed text and raster order with a backward-compatible fallback', () => {
    const result = normalizeTranscriptContent([{ type: 'text', text: 'before' }, image, { type: 'text', text: 'after' }])
    expect(result.parts?.map(p => p.type)).toEqual(['text', 'media', 'text'])
    expect(result.content).toBe('before\n[Image]\nafter')
    expect(normalizeTranscriptMedia({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })).toEqual({ kind: 'image', image: { mediaType: 'image/png', data } })
  })
  it('never retains a remote URL, path, executable media, or resource bytes', () => {
    for (const source of [ { type: 'image', source: { type: 'url', url: 'https://private/secret' } }, { type: 'imageView', path: 'C:\\private.png' }, { type: 'resource', resource: { blob: 'secret' } }, { type: 'image', data: Buffer.from('<svg/>').toString('base64'), mimeType: 'image/svg+xml' } ]) {
      expect(normalizeTranscriptMedia(source).kind).toBe('unsupported')
      expect(JSON.stringify(normalizeTranscriptMedia(source))).not.toMatch(/private|secret|svg\//)
    }
  })
  it('bounds media count and total decoded bytes while retaining later text', () => {
    const counted = normalizeTranscriptContent([...Array(100).fill(image), { type: 'text', text: 'last' }])
    expect(counted.parts?.filter(p => p.type === 'media' && p.media.kind === 'image')).toHaveLength(TRANSCRIPT_MEDIA_MAX_COUNT)
    expect(counted.content).toContain('last')
    const large = Buffer.alloc(4 * 1024 * 1024)
    Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(large)
    const bounded = normalizeTranscriptContent(Array(4).fill({ ...image, data: large.toString('base64') }))
    expect(bounded.parts?.filter(p => p.type === 'media' && p.media.kind === 'image')).toHaveLength(2)
  })
})
