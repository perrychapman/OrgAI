import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OUTPUT_PREVIEW_COLUMNS_MAX, OUTPUT_PREVIEW_IMAGE_MAX_BYTES, OUTPUT_PREVIEW_ROWS_MAX, OUTPUT_PREVIEW_SHEETS_MAX, OUTPUT_PREVIEW_TEXT_MAX_BYTES } from '@shared/types'
import { markdownToDocx } from './markdownDoc'
import { DOCX_PREVIEW_MAX_XML_BYTES, previewDocx, previewFile, streamSafeOrder } from './preview'
import { renderProduced } from './writers'
import { zipEntryNames, zipEntrySize, zipVerifyEntries } from './zipGuard'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-preview-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const f = (name: string, data: Buffer | string): string => {
  const p = join(dir, name)
  writeFileSync(p, data)
  return p
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

describe('text-like kinds', () => {
  it('reads text, flags truncation and never splits a code point', async () => {
    expect(await previewFile(f('a.md', '# hi\né'), 'markdown')).toEqual({ kind: 'text', text: '# hi\né' })
    const big = 'a'.repeat(OUTPUT_PREVIEW_TEXT_MAX_BYTES - 1) + '€' + 'tail' // the euro sign straddles the cap
    const r = await previewFile(f('b.txt', big), 'text')
    expect(r.kind).toBe('text')
    if (r.kind === 'text') {
      expect(r.truncated).toBe(true)
      expect(r.text).not.toContain('�')
      expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(OUTPUT_PREVIEW_TEXT_MAX_BYTES)
    }
    for (const [name, kind] of [['c.csv', 'csv'], ['d.json', 'json'], ['e.mmd', 'mermaid']] as const) {
      expect((await previewFile(f(name, 'x'), kind)).kind).toBe('text')
    }
  })
  it('strips a BOM', async () => {
    expect(await previewFile(f('bom.txt', '﻿hi'), 'text')).toEqual({ kind: 'text', text: 'hi' })
  })
})

describe('svg and image', () => {
  it('previews a safe svg and refuses a hostile one with a reason', async () => {
    expect((await previewFile(f('a.svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'), 'svg')).kind).toBe('svg')
    const bad = await previewFile(f('b.svg', '<svg><script>alert(1)</script></svg>'), 'svg')
    expect(bad.kind).toBe('none')
    if (bad.kind === 'none') expect(bad.reason).toMatch(/script/)
    expect((await previewFile(f('c.svg', '<svg onload="x()"/>'), 'svg')).kind).toBe('none')
  })
  it('images are sniffed, not trusted by extension', async () => {
    const ok = await previewFile(f('a.png', PNG), 'image')
    expect(ok).toEqual({ kind: 'image', dataUrl: `data:image/png;base64,${PNG.toString('base64')}` })
    // a png named .jpg is still shown as what it is
    expect(((await previewFile(f('b.jpg', PNG), 'image')) as { dataUrl: string }).dataUrl).toMatch(/^data:image\/png/)
    expect((await previewFile(f('c.png', '<svg onload="alert(1)"/>'), 'image')).kind).toBe('none')
    expect((await previewFile(f('d.png', Buffer.concat([PNG, Buffer.alloc(OUTPUT_PREVIEW_IMAGE_MAX_BYTES)])), 'image')).kind).toBe('none')
    const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')
    expect(((await previewFile(f('e.gif', gif), 'image')) as { dataUrl: string }).dataUrl).toMatch(/^data:image\/gif;base64,/)
  })
})

describe('other', () => {
  it('pdf and other are open-only', async () => {
    for (const kind of ['pdf', 'other'] as const) {
      const r = await previewFile(f(`x.${kind}`, 'x'), kind)
      expect(r).toEqual({ kind: 'none', reason: 'OrgAI cannot preview this kind of file; open it instead.' })
    }
  })
  it('never throws: missing file, directory, symlink', async () => {
    expect((await previewFile(join(dir, 'nope.txt'), 'text')).kind).toBe('none')
    mkdirSync(join(dir, 'd'))
    expect((await previewFile(join(dir, 'd'), 'text')).kind).toBe('none')
    const target = f('t.txt', 'x')
    try {
      symlinkSync(target, join(dir, 'l.txt'), 'file')
      expect((await previewFile(join(dir, 'l.txt'), 'text')).kind).toBe('none')
    } catch {
      /* no symlink privilege */
    }
  })
})

describe('xlsx', () => {
  const book = async (build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> => {
    const wb = new ExcelJS.Workbook()
    build(wb)
    return Buffer.from(await wb.xlsx.writeBuffer())
  }
  it('values, formulas, dates, rich text, hyperlinks, errors and formats', async () => {
    const buf = await book((wb) => {
      const ws = wb.addWorksheet('Data')
      ws.addRow(['n', 'when', 'f', 'rt', 'link', 'err'])
      const r = ws.addRow([1234.5, new Date(Date.UTC(2026, 10, 7, 12)), { formula: 'A2*2', result: 2469 }, { richText: [{ text: 'a' }, { text: 'b' }] }, { text: 'site', hyperlink: 'https://x.example' }, { error: '#DIV/0!' }])
      r.getCell(1).numFmt = '#,##0.00'
      ws.addRow([true, null, 'x'])
      wb.addWorksheet('Two').addRow(['second'])
    })
    const r = await previewFile(f('a.xlsx', buf), 'xlsx')
    expect(r.kind).toBe('sheets')
    if (r.kind !== 'sheets') return
    expect(r.sheets.map((s) => s.name)).toEqual(['Data', 'Two'])
    const row = r.sheets[0].rows[1]
    expect(row[0]).toEqual({ v: 1234.5, fmt: '#,##0.00' })
    expect(row[1].v).toBe('2026-11-07T12:00:00.000Z')
    expect(row[2]).toEqual({ v: 2469, f: 'A2*2' })
    expect(row[3].v).toBe('ab')
    expect(row[4].v).toBe('site')
    expect(row[5].v).toBe('#DIV/0!')
    expect(r.sheets[0].rows[2][0].v).toBe(true)
    expect(JSON.stringify(r)).not.toContain('General')
  })
  it('caps rows, columns and sheets', async () => {
    const buf = await book((wb) => {
      const ws = wb.addWorksheet('Big')
      for (let i = 0; i < OUTPUT_PREVIEW_ROWS_MAX + 40; i++) ws.addRow(Array.from({ length: OUTPUT_PREVIEW_COLUMNS_MAX + 6 }, (_, c) => i + c))
      for (let s = 0; s < OUTPUT_PREVIEW_SHEETS_MAX + 3; s++) wb.addWorksheet(`S${s}`).addRow([s])
    })
    const r = await previewFile(f('big.xlsx', buf), 'xlsx')
    if (r.kind !== 'sheets') throw new Error('expected sheets')
    const big = r.sheets[0]
    expect(big.rows.length).toBe(OUTPUT_PREVIEW_ROWS_MAX)
    expect(big.rows[0].length).toBe(OUTPUT_PREVIEW_COLUMNS_MAX)
    expect(big.truncatedRows).toBe(40)
    expect(big.truncatedCols).toBe(6)
    expect(r.sheets.length).toBe(OUTPUT_PREVIEW_SHEETS_MAX)
    expect(r.truncatedSheets).toBe(4)
  })
  it('a produced workbook with a "formula" string shows the text, no formula', async () => {
    const buf = await renderProduced({ kind: 'xlsx', title: 't', content: { sheets: [{ name: 'F', rows: [['=1+1']] }] } })
    const r = await previewFile(f('f.xlsx', buf), 'xlsx')
    if (r.kind !== 'sheets') throw new Error(`expected sheets: ${JSON.stringify(r)}`)
    expect(r.sheets[0].rows[0][0]).toEqual({ v: '=1+1' })
  })
  it('falls back to a full load when the stream cannot read the zip order', async () => {
    const buf = await book((wb) => {
      const ws = wb.addWorksheet('Data')
      ws.addRow(['n', 'text'])
      ws.addRow([42, 'forced fallback'])
      wb.addWorksheet('Two').addRow(['second'])
    })
    const src = await JSZip.loadAsync(buf)
    const names = Object.keys(src.files).filter((n) => !src.files[n].dir)
    const reorder = async (first: string[], last: string[]): Promise<Buffer> => {
      const mid = names.filter((n) => !first.includes(n) && !last.includes(n))
      const out = new JSZip()
      for (const n of [...first, ...mid, ...last]) out.file(n, await src.files[n].async('nodebuffer'))
      return deflated(out)
    }
    const check = async (name: string, data: Buffer): Promise<void> => {
      const r = await previewFile(f(name, data), 'xlsx')
      if (r.kind !== 'sheets') throw new Error(`expected sheets: ${JSON.stringify(r)}`)
      expect(r.sheets.map((s) => s.name)).toEqual(['Data', 'Two'])
      expect(r.sheets[0].rows[1].map((c) => c.v)).toEqual([42, 'forced fallback'])
      expect(r.sheets[1].rows[0][0].v).toBe('second')
    }
    // workbook.xml and the shared strings after the sheets: exceljs' stream answers wrongly here (measured: one sheet named
    // Data, string cells empty), so the preview must take the full load
    const unsafe = await reorder([], ['xl/_rels/workbook.xml.rels', 'xl/workbook.xml', 'xl/sharedStrings.xml'])
    expect(streamSafeOrder(zipEntryNames(unsafe))).toBe(false)
    const streamedOnly = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([unsafe]), { sharedStrings: 'cache', hyperlinks: 'cache', styles: 'cache', worksheets: 'emit', entries: 'emit' })
    const seen: unknown[] = []
    try {
      for await (const sheet of streamedOnly) for await (const row of sheet) seen.push(row.values)
    } catch {
      seen.push('threw')
    }
    expect(JSON.stringify(seen)).not.toContain('forced fallback') // the stream alone cannot give the right content
    await check('unsafe.xlsx', unsafe)
    // the order the stream needs, with the rels before workbook.xml (the reported exceljs trigger)
    const safe = await reorder(['[Content_Types].xml', 'xl/_rels/workbook.xml.rels', 'xl/workbook.xml', 'xl/sharedStrings.xml'], [])
    expect(streamSafeOrder(zipEntryNames(safe))).toBe(true)
    await check('safe.xlsx', safe)
  })
  it('corrupt and bomb files answer none', async () => {
    expect((await previewFile(f('bad.xlsx', Buffer.from('not a zip at all, definitely')), 'xlsx')).kind).toBe('none')
    const z = new JSZip()
    z.file('[Content_Types].xml', 'x'.repeat(10))
    const garbage = Buffer.from(await z.generateAsync({ type: 'uint8array' }))
    expect((await previewFile(f('g.xlsx', garbage), 'xlsx')).kind).toBe('none')
    const bomb = new JSZip()
    bomb.file('big.bin', Buffer.alloc(30 * 1024 * 1024), { compression: 'DEFLATE', compressionOptions: { level: 9 } })
    const r = await previewFile(f('bomb.xlsx', Buffer.from(await bomb.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))), 'xlsx')
    expect(r.kind).toBe('none')
    if (r.kind === 'none') expect(r.reason).toMatch(/ratio/)
  })
})

/** A copy of a zip whose directory (and, unless `centralOnly`, local header) claims `claim` bytes for entry `name`. */
function lieAboutSize(zip: Buffer, name: string, claim: number, centralOnly = false): Buffer {
  const out = Buffer.from(zip)
  const eocd = out.length - 22 // JSZip writes no archive comment
  let p = out.readUInt32LE(eocd + 16)
  const n = out.readUInt16LE(eocd + 10)
  for (let i = 0; i < n; i++) {
    const nameLen = out.readUInt16LE(p + 28)
    const extraLen = out.readUInt16LE(p + 30)
    const commentLen = out.readUInt16LE(p + 32)
    if (out.toString('utf8', p + 46, p + 46 + nameLen) === name) {
      out.writeUInt32LE(claim, p + 24)
      if (!centralOnly) out.writeUInt32LE(claim, out.readUInt32LE(p + 42) + 22)
      return out
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`no entry ${name}`)
}

const deflated = async (z: JSZip): Promise<Buffer> => Buffer.from(await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))

describe('declared sizes that lie', () => {
  const big = (): Buffer => Buffer.alloc(20 * 1024 * 1024)
  it('a docx whose entry claims 1 KB but inflates to 20 MB answers none quickly', async () => {
    const z = await JSZip.loadAsync(await markdownToDocx('hello', 'T'))
    z.file('word/media/big.bin', big(), { compression: 'DEFLATE', compressionOptions: { level: 9 } })
    const honest = await deflated(z)
    for (const centralOnly of [false, true]) {
      const t0 = Date.now()
      const r = await previewFile(f(`lie-${centralOnly}.docx`, lieAboutSize(honest, 'word/media/big.bin', 1000, centralOnly)), 'docx')
      expect(r.kind).toBe('none')
      if (r.kind === 'none') expect(r.reason).toMatch(/does not match its directory/)
      expect(Date.now() - t0).toBeLessThan(4000)
    }
  })
  it('an xlsx whose entry claims 1 KB but inflates to 20 MB answers none quickly', async () => {
    const wb = new ExcelJS.Workbook()
    wb.addWorksheet('A').addRow(['x'])
    const z = await JSZip.loadAsync(Buffer.from(await wb.xlsx.writeBuffer()))
    z.file('xl/media/big.bin', big(), { compression: 'DEFLATE', compressionOptions: { level: 9 } })
    const honest = await deflated(z)
    for (const centralOnly of [false, true]) {
      const t0 = Date.now()
      const r = await previewFile(f(`lie-${centralOnly}.xlsx`, lieAboutSize(honest, 'xl/media/big.bin', 1000, centralOnly)), 'xlsx')
      expect(r.kind).toBe('none')
      if (r.kind === 'none') expect(r.reason).toMatch(/does not match its directory/)
      expect(Date.now() - t0).toBeLessThan(4000)
    }
  })
  it('an honest package passes and an unsupported compression method is refused', async () => {
    const buf = await markdownToDocx('hello', 'T')
    expect(zipVerifyEntries(buf)).toBeNull()
    const z = new JSZip()
    z.file('a.txt', 'hello', { compression: 'STORE' })
    const stored = await deflated(z)
    expect(zipVerifyEntries(stored)).toBeNull()
    const bad = Buffer.from(stored)
    bad.writeUInt16LE(12, bad.readUInt32LE(bad.length - 22 + 16) + 10) // central method 12 (bzip2)
    expect(zipVerifyEntries(bad)).not.toBeNull()
  })
})

describe('docx size cut-off', () => {
  it('previews at the threshold and answers none just over it', async () => {
    const md = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} with some words.`).join('\n\n')
    const p = f('cut.docx', await markdownToDocx(md, 'T'))
    const xml = zipEntrySize(readFileSync(p), 'word/document.xml')
    if (xml === null) throw new Error('no document.xml')
    expect(xml).toBeGreaterThan(1000)
    expect((await previewDocx(p, xml)).kind).toBe('document')
    const over = await previewDocx(p, xml - 1)
    expect(over).toEqual({ kind: 'none', reason: 'This document is too large to preview here. Open it instead.' })
    expect((await previewFile(p, 'docx')).kind).toBe('document')
    expect(DOCX_PREVIEW_MAX_XML_BYTES).toBeGreaterThan(xml)
  })
  it('a package with no document.xml keeps the old behaviour (mammoth reports)', async () => {
    const z = new JSZip()
    z.file('hello.txt', 'x')
    const r = await previewDocx(f('nodoc.docx', await deflated(z)), 1)
    expect(r.kind).toBe('none')
    if (r.kind === 'none') expect(r.reason).not.toMatch(/too large/)
  })
})

describe('docx', () => {
  it('renders blocks from a document', async () => {
    const buf = await markdownToDocx('# Title\n\nhello **bold** and *it*\n\n- a\n- b\n\n| h1 | h2 |\n|---|---|\n| 1 | 2 |', 'T')
    const r = await previewFile(f('a.docx', buf), 'docx')
    expect(r.kind).toBe('document')
    if (r.kind === 'document') expect(r.blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'table'])
  })
  it('corrupt, bomb and non-zip files answer none', async () => {
    expect((await previewFile(f('bad.docx', Buffer.from('nope')), 'docx')).kind).toBe('none')
    const z = new JSZip()
    z.file('word/document.xml', '<broken')
    expect((await previewFile(f('b.docx', Buffer.from(await z.generateAsync({ type: 'uint8array' }))), 'docx')).kind).toBe('none')
    const bomb = new JSZip()
    bomb.file('word/document.xml', Buffer.alloc(30 * 1024 * 1024), { compression: 'DEFLATE', compressionOptions: { level: 9 } })
    expect((await previewFile(f('bomb.docx', Buffer.from(await bomb.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))), 'docx')).kind).toBe('none')
  })
  it('does not read a linked external file (externalFileAccess false)', async () => {
    const secret = f('secret.png', PNG)
    const buf = await markdownToDocx('hello', 'T')
    const z = await JSZip.loadAsync(buf)
    const doc = await z.file('word/document.xml')!.async('string')
    const rels = (await z.file('word/_rels/document.xml.rels')?.async('string')) ?? '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
    const uri = `file:///${secret.replace(/\\/g, '/')}`
    z.file('word/_rels/document.xml.rels', rels.replace('</Relationships>', `<Relationship Id="rIdExt1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${uri}" TargetMode="External"/></Relationships>`))
    z.file(
      'word/document.xml',
      doc.replace(
        '<w:body>',
        '<w:body><w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><pic:blipFill><a:blip r:link="rIdExt1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
      )
    )
    const r = await previewFile(f('ext.docx', Buffer.from(await z.generateAsync({ type: 'uint8array' }))), 'docx')
    expect(JSON.stringify(r)).not.toContain(PNG.toString('base64'))
  })
  it('round trip: markdown -> docx -> preview -> blocks', async () => {
    const md = '# Plan\n\nIntro with **bold** and *italic* and `code` and [a link](https://example.org/x).\n\n- one\n- two\n\n1. first\n2. second\n\n| Name | Qty |\n|---|---|\n| apple | 3 |\n\n```\nlet x = 1\n```\n'
    const r = await previewFile(f('rt.docx', await markdownToDocx(md, 'Plan')), 'docx')
    if (r.kind !== 'document') throw new Error('expected a document')
    const types = r.blocks.map((b) => b.type)
    expect(types[0]).toBe('heading')
    expect(r.blocks[0]).toMatchObject({ type: 'heading', level: 1, runs: [{ text: 'Plan' }] })
    const para = r.blocks[1]
    if (para.type !== 'paragraph') throw new Error('paragraph expected')
    expect(para.runs.some((x) => x.bold && x.text === 'bold')).toBe(true)
    expect(para.runs.some((x) => x.italic && x.text === 'italic')).toBe(true)
    expect(para.runs.some((x) => x.href === 'https://example.org/x' && x.text === 'a link')).toBe(true)
    const lists = r.blocks.filter((b) => b.type === 'list')
    expect(lists).toHaveLength(2)
    expect(lists[0]).toMatchObject({ ordered: false })
    expect(lists[1]).toMatchObject({ ordered: true })
    const table = r.blocks.find((b) => b.type === 'table')
    expect(table).toBeTruthy()
    if (table && table.type === 'table') {
      expect(table.rows.map((row) => row.map((c) => c.map((x) => x.text).join('')))).toEqual([['Name', 'Qty'], ['apple', '3']])
    }
    expect(JSON.stringify(r.blocks)).toContain('let x = 1')
  })
})
