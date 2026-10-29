import { describe, expect, it } from 'vitest'
import { MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_BYTES } from '@shared/defaults'
import { decodedLength, hasContent, sanitizeImages } from './attachments'

const PNG = 'iVBORw0KGgo='

function collect() {
  const warnings: string[] = []
  return { warnings, warn: (m: string) => warnings.push(m) }
}

describe('sanitizeImages', () => {
  it('keeps valid images as fresh plain objects', () => {
    const input = { mediaType: 'image/png', data: PNG, name: 'a.png', extra: 1 }
    const { warnings, warn } = collect()
    const out = sanitizeImages([input], warn)
    expect(out).toEqual([{ mediaType: 'image/png', data: PNG, name: 'a.png' }])
    expect(out[0]).not.toBe(input)
    expect(warnings).toEqual([])
  })

  it('omits name when absent or not a string', () => {
    const out = sanitizeImages([{ mediaType: 'image/gif', data: PNG }, { mediaType: 'image/webp', data: PNG, name: 5 }])
    expect(out.map((i) => 'name' in i)).toEqual([false, false])
  })

  it('returns [] for non-arrays without throwing', () => {
    const { warnings, warn } = collect()
    expect(sanitizeImages(undefined, warn)).toEqual([])
    expect(sanitizeImages(null, warn)).toEqual([])
    expect(warnings).toEqual([])
    expect(sanitizeImages('x', warn)).toEqual([])
    expect(sanitizeImages({}, warn)).toEqual([])
    expect(warnings).toHaveLength(2)
  })

  it('drops non-objects, bad types, bad data, each with a warning', () => {
    const { warnings, warn } = collect()
    const out = sanitizeImages(
      [
        null,
        'str',
        [],
        { mediaType: 'image/svg+xml', data: PNG, name: 'x.svg' },
        { mediaType: 'image/png' },
        { mediaType: 'image/png', data: '' },
        { mediaType: 'image/png', data: 42 },
        { mediaType: 'image/png', data: 'not base64!!' },
        { mediaType: 'image/png', data: 'A' },
        { mediaType: 'image/png', data: 'AA=A' },
        { mediaType: 'image/png', data: PNG, name: 'ok' }
      ],
      warn
    )
    expect(out).toEqual([{ mediaType: 'image/png', data: PNG, name: 'ok' }])
    expect(warnings).toHaveLength(10)
    expect(warnings[3]).toContain('x.svg')
    expect(warnings[3]).toContain('unsupported')
    expect(warnings[0]).toContain('image 1')
  })

  it('strips a data URL prefix and whitespace', () => {
    const out = sanitizeImages([{ mediaType: 'image/png', data: `data:image/png;base64,${PNG.slice(0, 4)}\n${PNG.slice(4)}` }])
    expect(out[0].data).toBe(PNG)
  })

  it('enforces the decoded size limit without allocating', () => {
    const atLimit = 'A'.repeat((MAX_IMAGE_BYTES / 3) * 4)
    const over = 'A'.repeat((MAX_IMAGE_BYTES / 3) * 4 + 4)
    const { warnings, warn } = collect()
    const out = sanitizeImages([{ mediaType: 'image/png', data: atLimit }, { mediaType: 'image/png', data: over, name: 'big' }], warn)
    expect(out).toHaveLength(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('big')
  })

  it('caps images per message', () => {
    const { warnings, warn } = collect()
    const many = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 3 }, () => ({ mediaType: 'image/png', data: PNG }))
    expect(sanitizeImages(many, warn)).toHaveLength(MAX_IMAGES_PER_MESSAGE)
    expect(warnings).toHaveLength(3)
  })

  it('does not count dropped images against the cap', () => {
    const items = [...Array.from({ length: 5 }, () => null), ...Array.from({ length: MAX_IMAGES_PER_MESSAGE }, () => ({ mediaType: 'image/png', data: PNG }))]
    expect(sanitizeImages(items)).toHaveLength(MAX_IMAGES_PER_MESSAGE)
  })
})

describe('decodedLength', () => {
  it('accounts for padding', () => {
    expect(decodedLength('QQ==')).toBe(1)
    expect(decodedLength('QUI=')).toBe(2)
    expect(decodedLength('QUJD')).toBe(3)
    expect(decodedLength(PNG)).toBe(8)
  })
})

describe('hasContent', () => {
  it('is true for text or images', () => {
    expect(hasContent('  ', [])).toBe(false)
    expect(hasContent('hi', [])).toBe(true)
    expect(hasContent('', [{ mediaType: 'image/png', data: PNG }])).toBe(true)
  })
})
