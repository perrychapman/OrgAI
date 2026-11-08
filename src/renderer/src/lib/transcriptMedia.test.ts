import { describe, expect, it } from 'vitest'
import { usableTranscriptImage } from './transcriptMedia'

describe('usableTranscriptImage', () => {
  it('accepts raster base64 only', () => {
    expect(usableTranscriptImage({ mediaType: 'image/png', data: 'AAAA' })).toBe(true)
    expect(usableTranscriptImage({ mediaType: 'image/png', data: '' })).toBe(false)
    expect(usableTranscriptImage({ mediaType: 'image/png', data: 'https://example.invalid/a.png' })).toBe(false)
    expect(usableTranscriptImage({ mediaType: 'image/svg+xml' as 'image/png', data: 'AAAA' })).toBe(false)
  })
})
