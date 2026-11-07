import { Document, Packer, Paragraph } from 'docx'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { previewFile } from './preview'
import { ZIP_MAX_ENTRIES, zipEntrySize, zipProblem, zipVerifyEntries } from './zipGuard'

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

describe('zipEntrySize', () => {
  it('reads the uncompressed size of a named entry from a real zip', async () => {
    const z = new JSZip()
    z.file('a.txt', 'hello')
    z.file('word/document.xml', 'x'.repeat(5000))
    const buf = Buffer.from(await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
    expect(zipEntrySize(buf, 'word/document.xml')).toBe(5000)
    expect(zipEntrySize(buf, 'a.txt')).toBe(5)
  })
  it('is null for a missing entry (exact match only), a refused package and a non-zip', () => {
    const f = forged([{ name: 'word/document.xml', csize: 10, usize: 99 }])
    expect(zipEntrySize(f, 'word/document.xml')).toBe(99)
    expect(zipEntrySize(f, 'word/Document.xml')).toBeNull()
    expect(zipEntrySize(f, 'document.xml')).toBeNull()
    expect(zipEntrySize(forged([{ name: 'word/document.xml', csize: 1, usize: 5 * 1024 * 1024 }]), 'word/document.xml')).toBeNull()
    expect(zipEntrySize(Buffer.from('nope'), 'a')).toBeNull()
  })
})

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

describe('zipVerifyEntries: archives the unzip libraries could read differently', () => {
  const EOCD = 0x06054b50
  const deflate = async (z: JSZip, streamFiles = false): Promise<Buffer> => Buffer.from(await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE', streamFiles }))
  const three = (): JSZip => new JSZip().file('a.txt', 'alpha '.repeat(50)).file('b.txt', 'beta '.repeat(50)).file('c.txt', 'gamma '.repeat(50))
  const recordEnd = (z: Buffer, p: number): number => p + 46 + z.readUInt16LE(p + 28) + z.readUInt16LE(p + 30) + z.readUInt16LE(p + 32)
  /** Move every directory offset at or past `at` by n and the directory offset too (the bytes are already inserted). */
  function shiftOffsets(out: Buffer, at: number, n: number): Buffer {
    const eocd = out.length - 22
    const cdOffset = out.readUInt32LE(eocd + 16)
    let p = cdOffset + n
    for (let i = 0; i < out.readUInt16LE(eocd + 10); i++) {
      const o = out.readUInt32LE(p + 42)
      if (o >= at) out.writeUInt32LE(o + n, p + 42)
      p = recordEnd(out, p)
    }
    out.writeUInt32LE(cdOffset + n, eocd + 16)
    return out
  }
  /** Insert `n` junk bytes at `at` inside the local-entry region, keeping the directory self-consistent. */
  const insertAt = (zip: Buffer, at: number, n: number): Buffer => shiftOffsets(Buffer.concat([zip.subarray(0, at), Buffer.alloc(n, 0x41), zip.subarray(at)]), at, n)
  const localOffsets = (zip: Buffer): number[] => {
    const eocd = zip.length - 22
    let p = zip.readUInt32LE(eocd + 16)
    const r: number[] = []
    for (let i = 0; i < zip.readUInt16LE(eocd + 10); i++) {
      r.push(zip.readUInt32LE(p + 42))
      p = recordEnd(zip, p)
    }
    return r
  }

  it('accepts honest packages: jszip (stored, deflated, with data descriptors), exceljs and docx output', async () => {
    expect(zipVerifyEntries(await deflate(three()))).toBeNull()
    expect(zipVerifyEntries(Buffer.from(await three().generateAsync({ type: 'uint8array' })))).toBeNull()
    const streamed = await deflate(three(), true)
    expect(streamed.readUInt16LE(streamed.readUInt32LE(streamed.length - 22 + 16) + 8) & 8).toBe(8) // really uses descriptors
    expect(zipVerifyEntries(streamed)).toBeNull()
    const wb = new ExcelJS.Workbook()
    wb.addWorksheet('A').addRow(['x', 1])
    expect(zipVerifyEntries(Buffer.from(await wb.xlsx.writeBuffer()))).toBeNull()
    expect(zipVerifyEntries(Buffer.from(await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('hi')] }] }))))).toBeNull()
  })
  it('refuses an unlisted local entry before the listed ones (and the xlsx preview never reaches its stream)', async () => {
    const wb = new ExcelJS.Workbook()
    wb.addWorksheet('A').addRow(['x'])
    const real = Buffer.from(await wb.xlsx.writeBuffer())
    const hidden = Buffer.from(await new JSZip().file('xl/worksheets/evil.xml', 'x'.repeat(5000)).generateAsync({ type: 'uint8array' }))
    const localOnly = hidden.subarray(0, hidden.readUInt32LE(hidden.length - 22 + 16)) // its local entry, no directory record
    const withExtra = shiftOffsets(Buffer.concat([localOnly, real]), 0, localOnly.length) // the directory stays self-consistent
    expect(zipVerifyEntries(withExtra)).toMatch(/does not match its directory/)
    const dir = mkdtempSync(join(tmpdir(), 'orgai-zipguard-'))
    try {
      const path = join(dir, 'x.xlsx')
      writeFileSync(path, withExtra)
      const t0 = Date.now()
      const r = await previewFile(path, 'xlsx')
      expect(r.kind).toBe('none')
      if (r.kind === 'none') expect(r.reason).toMatch(/does not match its directory/)
      expect(Date.now() - t0).toBeLessThan(2000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('refuses a directory record past the declared count', async () => {
    const z = await deflate(three())
    const eocd = z.length - 22
    z.writeUInt16LE(2, eocd + 8)
    z.writeUInt16LE(2, eocd + 10) // declares 2 of 3, cdSize still spans all three
    expect(zipProblem(z)).toMatch(/damaged/)
    expect(zipVerifyEntries(z)).toMatch(/damaged/)
  })
  it('refuses a fake end-of-directory record inside the comment', async () => {
    const z = await deflate(three())
    const sig = Buffer.alloc(4)
    sig.writeUInt32LE(EOCD, 0)
    for (const tail of [Buffer.concat([sig, Buffer.alloc(18)]), Buffer.concat([Buffer.from('xx'), sig, Buffer.from('yy')])]) {
      const withComment = Buffer.concat([z, tail])
      withComment.writeUInt16LE(tail.length, z.length - 22 + 20)
      expect(zipVerifyEntries(withComment)).toMatch(/damaged/)
    }
  })
  it('refuses cdOffset + cdSize short of the end-of-directory record', async () => {
    const z = await deflate(three())
    const eocd = z.length - 22
    expect(zipVerifyEntries(Buffer.concat([z.subarray(0, eocd), Buffer.alloc(10, 0x41), z.subarray(eocd)]))).toMatch(/damaged/)
  })
  it('refuses a gap between entries and bytes left over before the directory', async () => {
    const z = await deflate(three())
    expect(zipVerifyEntries(insertAt(z, localOffsets(z)[1], 5))).toMatch(/does not match its directory/)
    expect(zipVerifyEntries(insertAt(z, z.readUInt32LE(z.length - 22 + 16), 5))).toMatch(/does not match its directory/)
  })
  it('refuses duplicate names, also when only the case differs', async () => {
    const z = await deflate(three())
    expect(zipVerifyEntries(Buffer.from(z.toString('latin1').replaceAll('b.txt', 'a.txt'), 'latin1'))).toMatch(/does not match its directory/)
    expect(zipVerifyEntries(Buffer.from(z.toString('latin1').replaceAll('b.txt', 'A.txt'), 'latin1'))).toMatch(/does not match its directory/)
  })
  it('refuses two entries at one local offset (overlap)', async () => {
    const z = await deflate(three())
    z.writeUInt32LE(0, recordEnd(z, z.readUInt32LE(z.length - 22 + 16)) + 42) // second record points at the first entry
    expect(zipVerifyEntries(z)).toMatch(/does not match its directory/)
  })

  describe('data descriptor entries (flag 0x08), as unzipper would read them', () => {
    const SIG = Buffer.from([0x50, 0x4b, 0x07, 0x08])
    it('refuses a local size that is neither 0 nor the directory size', async () => {
      const z = await deflate(three(), true)
      expect(zipVerifyEntries(z)).toBeNull()
      const o = localOffsets(z)[0]
      for (const [at, v] of [[18, 1], [22, 7], [18, 0xffffffff]] as const) {
        const bad = Buffer.from(z)
        bad.writeUInt32LE(v, o + at)
        expect(zipVerifyEntries(bad)).toMatch(/does not match its directory/)
      }
    })
    it('refuses an unsigned descriptor', async () => {
      const z = await deflate(three(), true)
      const o = localOffsets(z)[0]
      const cs = z.readUInt32LE(o + 18) || z.readUInt32LE(z.readUInt32LE(z.length - 22 + 16) + 20)
      const sigAt = o + 30 + z.readUInt16LE(o + 26) + z.readUInt16LE(o + 28) + cs
      expect(z.subarray(sigAt, sigAt + 4).equals(SIG)).toBe(true)
      const unsigned = shiftOffsets(Buffer.concat([z.subarray(0, sigAt), z.subarray(sigAt + 4)]), sigAt, -4)
      expect(zipVerifyEntries(unsigned)).toMatch(/does not match its directory/)
    })
    it('refuses a descriptor signature inside the entry data', async () => {
      const z = await deflate(three(), true)
      const o = localOffsets(z)[0]
      const start = o + 30 + z.readUInt16LE(o + 26) + z.readUInt16LE(o + 28)
      const bad = Buffer.from(z)
      SIG.copy(bad, start + 2)
      expect(zipVerifyEntries(bad)).toMatch(/does not match its directory/)
    })
    it('refuses a stored entry with flag 0x08', async () => {
      const z = Buffer.from(await new JSZip().file('a.txt', 'hello').generateAsync({ type: 'uint8array' }))
      const o = localOffsets(z)[0]
      const cd = z.readUInt32LE(z.length - 22 + 16)
      const withDescriptor = Buffer.concat([z.subarray(0, cd), Buffer.alloc(16), z.subarray(cd)])
      withDescriptor.writeUInt16LE(8, o + 6)
      shiftOffsets(withDescriptor, cd, 16)
      expect(zipVerifyEntries(withDescriptor)).toMatch(/does not match its directory/)
    })
  })

  describe('names the unzip libraries could read differently', () => {
    /** One stored entry with a chosen name, flags and extra field. */
    function tiny(name: Buffer, flags: number, extra: Buffer): Buffer {
      const data = Buffer.from('hi')
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(flags, 6)
      local.writeUInt32LE(2, 18)
      local.writeUInt32LE(2, 22)
      local.writeUInt16LE(name.length, 26)
      local.writeUInt16LE(extra.length, 28)
      const lpart = Buffer.concat([local, name, extra, data])
      const cen = Buffer.alloc(46)
      cen.writeUInt32LE(0x02014b50, 0)
      cen.writeUInt16LE(flags, 8)
      cen.writeUInt32LE(2, 20)
      cen.writeUInt32LE(2, 24)
      cen.writeUInt16LE(name.length, 28)
      cen.writeUInt16LE(extra.length, 30)
      const cd = Buffer.concat([cen, name, extra])
      const eocd = Buffer.alloc(22)
      eocd.writeUInt32LE(0x06054b50, 0)
      eocd.writeUInt16LE(1, 8)
      eocd.writeUInt16LE(1, 10)
      eocd.writeUInt32LE(cd.length, 12)
      eocd.writeUInt32LE(lpart.length, 16)
      return Buffer.concat([lpart, cd, eocd])
    }
    it('accepts an ASCII name, and a non-ASCII name flagged UTF-8', () => {
      expect(zipVerifyEntries(tiny(Buffer.from('a.txt'), 0, Buffer.alloc(0)))).toBeNull()
      expect(zipVerifyEntries(tiny(Buffer.from('é.txt'), 0x800, Buffer.alloc(0)))).toBeNull()
    })
    it('refuses a Unicode Path extra field (0x7075)', () => {
      const extra = Buffer.alloc(4 + 6)
      extra.writeUInt16LE(0x7075, 0)
      extra.writeUInt16LE(6, 2)
      expect(zipProblem(tiny(Buffer.from('a.txt'), 0, extra))).toMatch(/name/)
      expect(zipVerifyEntries(tiny(Buffer.from('a.txt'), 0, extra))).toMatch(/name/)
    })
    it('refuses a non-ASCII name without the UTF-8 flag', () => {
      expect(zipProblem(tiny(Buffer.from('é.txt'), 0, Buffer.alloc(0)))).toMatch(/name/)
    })
  })
})
