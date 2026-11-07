import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { ZIP_MAX_ENTRIES, zipProblem } from './zipGuard'

interface Entry {
  name: string
  csize: number
  usize: number
}

/** A zip with only a central directory (no data): enough for the guard, which never inflates. */
function forged(entries: Entry[], opts: { comment?: Buffer; zip64Locator?: boolean; entryCount?: number; cdOffsetOverride?: number } = {}): Buffer {
  const cds = entries.map((e) => {
    const name = Buffer.from(e.name)
    const b = Buffer.alloc(46 + name.length)
    b.writeUInt32LE(0x02014b50, 0)
    b.writeUInt32LE(e.csize >>> 0, 20)
    b.writeUInt32LE(e.usize >>> 0, 24)
    b.writeUInt16LE(name.length, 28)
    name.copy(b, 46)
    return b
  })
  const cd = Buffer.concat(cds)
  const comment = opts.comment ?? Buffer.alloc(0)
  const locator = opts.zip64Locator ? Buffer.alloc(20) : Buffer.alloc(0)
  if (opts.zip64Locator) locator.writeUInt32LE(0x07064b50, 0)
  const eocd = Buffer.alloc(22 + comment.length)
  eocd.writeUInt32LE(0x06054b50, 0)
  const count = opts.entryCount ?? entries.length
  eocd.writeUInt16LE(count, 8)
  eocd.writeUInt16LE(count, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(opts.cdOffsetOverride ?? 0, 16)
  eocd.writeUInt16LE(comment.length, 20)
  comment.copy(eocd, 22)
  return Buffer.concat([cd, locator, eocd])
}

describe('zipProblem', () => {
  it('accepts a real small zip', async () => {
    const z = new JSZip()
    z.file('a.txt', 'hello')
    z.file('dir/b.txt', 'x'.repeat(5000))
    expect(zipProblem(Buffer.from(await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })))).toBeNull()
  })
  it('accepts an empty zip and a zip with a comment', () => {
    expect(zipProblem(forged([]))).toBeNull()
    expect(zipProblem(forged([{ name: 'a', csize: 10, usize: 10 }], { comment: Buffer.from('hi there') }))).toBeNull()
  })
  it('refuses non-zips and tiny buffers', () => {
    expect(zipProblem(Buffer.from('hello'))).toMatch(/too small/)
    expect(zipProblem(Buffer.alloc(100, 1))).toMatch(/not a valid ZIP/)
  })
  it('refuses too many entries', () => {
    expect(zipProblem(forged(Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, i) => ({ name: `f${i}`, csize: 1, usize: 1 }))))).toMatch(/more than/)
    expect(zipProblem(forged(Array.from({ length: ZIP_MAX_ENTRIES }, (_, i) => ({ name: `f${i}`, csize: 1, usize: 1 }))))).toBeNull()
  })
  it('refuses a total over 200 MB', () => {
    const mb = 1024 * 1024
    expect(zipProblem(forged(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, csize: 30 * mb, usize: 50 * mb }))))).toMatch(/200 MB/)
  })
  it('refuses an absurd ratio over 1 MB, allows a small or modest one', () => {
    const mb = 1024 * 1024
    expect(zipProblem(forged([{ name: 'bomb', csize: 1000, usize: 100 * mb }]))).toMatch(/ratio/)
    expect(zipProblem(forged([{ name: 'bomb0', csize: 0, usize: 2 * mb }]))).toMatch(/ratio/)
    expect(zipProblem(forged([{ name: 'small', csize: 1, usize: 900_000 }]))).toBeNull()
    expect(zipProblem(forged([{ name: 'ok', csize: 100_000, usize: 5 * mb }]))).toBeNull()
  })
  it('refuses ZIP64 in any of its forms', () => {
    expect(zipProblem(forged([{ name: 'a', csize: 1, usize: 1 }], { zip64Locator: true }))).toMatch(/ZIP64/)
    expect(zipProblem(forged([{ name: 'a', csize: 0xffffffff, usize: 0xffffffff }]))).toMatch(/ZIP64/)
    expect(zipProblem(forged([], { entryCount: 0xffff }))).toMatch(/ZIP64/)
  })
  it('refuses a forged directory that lies about its count or offset', () => {
    expect(zipProblem(forged([{ name: 'a', csize: 1, usize: 1 }], { entryCount: 5 }))).toMatch(/damaged/)
    expect(zipProblem(forged([{ name: 'a', csize: 1, usize: 1 }], { cdOffsetOverride: 0xfffffff0 }))).toMatch(/damaged/)
    const b = forged([{ name: 'a', csize: 1, usize: 1 }])
    b.writeUInt32LE(0xdeadbeef, 0) // break the entry signature
    expect(zipProblem(b)).toMatch(/damaged/)
  })
})
