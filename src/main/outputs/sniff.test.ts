import { describe, expect, it } from 'vitest'
import { OUTPUT_PPTX_TOTAL_MAX_BYTES, READ_DOCUMENT_MAX_BYTES } from '@shared/types'
import { DOCUMENT_HEAD_BYTES, documentReadPlan, type ReadPlan } from './sniff'

const plan = (b: Buffer | number[], size?: number): ReadPlan => {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b)
  return documentReadPlan(buf.subarray(0, DOCUMENT_HEAD_BYTES), size ?? buf.length)
}
const refusal = (p: ReadPlan): string => ('refused' in p ? p.refused : '')
const pad = (head: number[] | string, len = 64): Buffer => {
  const h = typeof head === 'string' ? Buffer.from(head, 'latin1') : Buffer.from(head)
  return Buffer.concat([h, Buffer.alloc(Math.max(0, len - h.length), 0x20)])
}

describe('documentReadPlan reads', () => {
  it('plans a zip and an empty archive, and refuses one over 40 MB', () => {
    expect(plan(pad([0x50, 0x4b, 0x03, 0x04]))).toEqual({ read: 'zip', maxBytes: OUTPUT_PPTX_TOTAL_MAX_BYTES })
    expect(plan(pad([0x50, 0x4b, 0x05, 0x06]))).toEqual({ read: 'zip', maxBytes: OUTPUT_PPTX_TOTAL_MAX_BYTES })
    expect(refusal(plan(pad([0x50, 0x4b, 0x03, 0x04]), OUTPUT_PPTX_TOTAL_MAX_BYTES + 1))).toMatch(/larger than 40 MB/)
  })

  it('plans a compound file with a 1 MB read', () => {
    expect(plan(pad([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toEqual({ read: 'cfb', maxBytes: 1024 * 1024 })
  })

  it('plans text by content, not by extension', () => {
    expect(plan(Buffer.from('hello, world\n'))).toEqual({ read: 'text', maxBytes: READ_DOCUMENT_MAX_BYTES + 4, encoding: 'utf8' })
    expect(plan(Buffer.from('héllo ✓'))).toMatchObject({ read: 'text', encoding: 'utf8' })
    expect(plan(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toMatchObject({ read: 'text', encoding: 'utf8' })
    expect(plan(Buffer.from([0xff, 0xfe, 0x61, 0x00]))).toMatchObject({ read: 'text', encoding: 'utf16le' })
    expect(plan(Buffer.from([0xfe, 0xff, 0x00, 0x61]))).toMatchObject({ read: 'text', encoding: 'utf16be' })
  })

  it('accepts a head cut inside a multi-byte sequence when the file is longer', () => {
    const euro = Buffer.from('€') // 3 bytes
    const head = Buffer.concat([Buffer.from('abc'), euro.subarray(0, 2)])
    expect(documentReadPlan(head, 1000)).toMatchObject({ read: 'text' })
    // the same bytes as a complete file are invalid UTF-8
    expect(refusal(documentReadPlan(head, head.length))).toMatch(/binary file of an unknown type/)
  })
})

describe('documentReadPlan refuses and names the type', () => {
  it('empty', () => {
    expect(refusal(documentReadPlan(Buffer.alloc(0), 0))).toMatch(/empty/)
  })

  it('pdf', () => {
    const r = refusal(plan(pad('%PDF-1.7\n')))
    expect(r).toBe('OrgAI cannot extract text from PDF files yet. If your own Read tool opens PDFs, use it; otherwise ask the user for a .docx or .txt export.')
  })

  it.each([
    ['PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ['JPEG', [0xff, 0xd8, 0xff, 0xe0]],
    ['GIF', Array.from(Buffer.from('GIF89a'))],
    ['WebP', [...Buffer.from('RIFF'), 1, 2, 3, 4, ...Buffer.from('WEBPVP8 ')]],
    ['TIFF', [0x49, 0x49, 0x2a, 0x00]],
    ['ICO', [0x00, 0x00, 0x01, 0x00, 0x01, 0x00]],
    ['HEIC', [0, 0, 0, 0x18, ...Buffer.from('ftypheic')]],
    ['AVIF', [0, 0, 0, 0x18, ...Buffer.from('ftypavif')]]
  ])('image: %s', (name, bytes) => {
    const r = refusal(plan(pad(bytes as number[])))
    expect(r).toContain(name)
    expect(r).toMatch(/image/)
    expect(r).toMatch(/Read tool/)
  })

  it('bmp', () => {
    const bmp = Buffer.alloc(40)
    bmp.write('BM', 0)
    expect(refusal(plan(bmp))).toContain('BMP')
    // plain text that starts with BM is still text
    expect(plan(Buffer.from('BM25 is a ranking function'))).toMatchObject({ read: 'text' })
  })

  it.each([
    ['gzip', [0x1f, 0x8b, 0x08, 0x00]],
    ['7-Zip', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
    ['RAR', Array.from(Buffer.from('Rar!\x1a\x07'))],
    ['bzip2', Array.from(Buffer.from('BZh9'))],
    ['xz', [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]],
    ['Zstandard', [0x28, 0xb5, 0x2f, 0xfd]]
  ])('archive: %s', (name, bytes) => {
    const r = refusal(plan(pad(bytes as number[])))
    expect(r).toContain(name)
    expect(r).toMatch(/archive/)
  })

  it('tar by the ustar marker', () => {
    const tar = Buffer.alloc(512)
    tar.write('ustar', 257, 'latin1')
    expect(refusal(plan(tar))).toContain('tar archive')
  })

  it.each([
    ['Windows', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)])],
    ['Linux (ELF)', Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(100)])],
    ['macOS (Mach-O)', Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(100)])]
  ])('executable: %s', (name, buf) => {
    expect(refusal(plan(buf))).toContain(name)
    expect(refusal(plan(buf))).toMatch(/executable/)
  })

  it('a text file that starts with MZ is still text', () => {
    expect(plan(Buffer.from('MZ is a stock ticker'))).toMatchObject({ read: 'text' })
  })

  it('sqlite', () => {
    expect(refusal(plan(Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(100)])))).toContain('SQLite database')
  })

  it.each([
    ['MP3', Array.from(Buffer.from('ID3\x03\x00'))],
    ['Ogg', Array.from(Buffer.from('OggS\x00'))],
    ['WAV', [...Buffer.from('RIFF'), 1, 2, 3, 4, ...Buffer.from('WAVEfmt ')]],
    ['AVI', [...Buffer.from('RIFF'), 1, 2, 3, 4, ...Buffer.from('AVI LIST')]],
    ['MP4', [0, 0, 0, 0x18, ...Buffer.from('ftypisom')]],
    ['QuickTime', [0, 0, 0, 0x14, ...Buffer.from('ftypqt  ')]],
    ['Matroska', [0x1a, 0x45, 0xdf, 0xa3]]
  ])('audio or video: %s', (name, bytes) => {
    const r = refusal(plan(pad(bytes as number[])))
    expect(r).toContain(name)
    expect(r).toMatch(/no text/)
  })

  it('unknown binary: NUL bytes or invalid UTF-8', () => {
    expect(refusal(plan(Buffer.from([0x61, 0x00, 0x62, 0x00, 0x63])))).toMatch(/binary file of an unknown type/)
    expect(refusal(plan(Buffer.from([0x61, 0xff, 0xfe, 0xfd, 0x62])))).toMatch(/binary file of an unknown type/)
  })

  it('every refusal is a plain sentence without em dashes or a REFUSED prefix', () => {
    const samples = [
      Buffer.alloc(0),
      pad('%PDF-'),
      pad([0x89, 0x50, 0x4e, 0x47]),
      pad([0x1f, 0x8b]),
      pad([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.from([0, 1, 2, 3])
    ]
    for (const s of samples) {
      const r = refusal(documentReadPlan(s, s.length))
      expect(r).not.toBe('')
      expect(r).not.toMatch(/—|REFUSED/)
      expect(r).toMatch(/\.$/)
    }
  })
})
