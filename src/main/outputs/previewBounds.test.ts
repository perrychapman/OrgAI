import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OUTPUT_PREVIEW_DOC_IMAGES_TOTAL_BYTES, OUTPUT_PREVIEW_DOC_IMAGE_MAX_BYTES } from '@shared/types'
import {
  DOCX_PREVIEW_IMAGES_MAX,
  DOCX_XML_ALLOWANCE,
  isImagePart,
  PREVIEW_MAX_ENTRY_BYTES,
  XLSX_PREVIEW_MAX_XML_BYTES,
  previewDocx,
  previewFile,
  previewXlsx
} from './preview'
import { zipSumSizes, zipVerifyEntries } from './zipGuard'

/** Bounded docx / xlsx reads: Reviewer H1 (images), M1 (parts under any name), M2 (xlsx size) and the duplicate-name Low. */

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-bounds-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const f = (name: string, data: Buffer | string): string => {
  const p = join(dir, name)
  writeFileSync(p, data)
  return p
}

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const deflated = async (z: JSZip): Promise<Buffer> => Buffer.from(await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))

const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const rels = (items: { type: string; target: string }[]): string =>
  `<Relationships xmlns="${NS_REL}">${items.map((r, i) => `<Relationship Id="r${i}" Type="${DOC_REL}/${r.type}" Target="${r.target}"/>`).join('')}</Relationships>`
const body = (inner: string): string => `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${inner}</w:body></w:document>`
const para = (t: string): string => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`
const PICT =
  '<w:p><w:r><w:pict><v:imagedata xmlns:v="urn:schemas-microsoft-com:vml" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rIdImg"/></w:pict></w:r></w:p>'
const IMG_RELS = `<Relationships xmlns="${NS_REL}"><Relationship Id="rIdImg" Type="${DOC_REL}/image" Target="media/image1.png"/></Relationships>`

/** A minimal docx with the given extra parts. */
async function miniDocx(opts: { main?: string; mainTarget?: string; docRels?: string; extra?: Record<string, Buffer | string>; stored?: string[] }): Promise<Buffer> {
  const z = new JSZip()
  z.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Default Extension="xml" ContentType="application/xml"/></Types>')
  z.file('_rels/.rels', rels([{ type: 'officeDocument', target: opts.mainTarget ?? 'word/document.xml' }]))
  z.file(opts.mainTarget?.replace(/^\//, '') ?? 'word/document.xml', opts.main ?? body(para('Hello')))
  if (opts.docRels) z.file('word/_rels/document.xml.rels', opts.docRels)
  for (const [n, d] of Object.entries(opts.extra ?? {})) z.file(n, d, opts.stored?.includes(n) ? { compression: 'STORE' } : {})
  return deflated(z)
}

const REFUSED = /not laid out like a Word document/
const TOO_LARGE_DOC = { kind: 'none', reason: 'This document is too large to preview here. Open it instead.' }
const TOO_LARGE_SHEET = { kind: 'none', reason: 'This workbook is too large to preview here. Open it instead.' }

describe('docx images are bounded before mammoth reads them (H1)', () => {
  it('one image referenced 5,000 times previews with a handful of reads and bounded memory', async () => {
    const png = Buffer.concat([PNG_HEAD, randomBytes(1_500_000)])
    const buf = await miniDocx({
      main: body(para('Start') + PICT.repeat(5000)),
      docRels: IMG_RELS,
      extra: { 'word/media/image1.png': png },
      stored: ['word/media/image1.png']
    })
    const p = f('refs.docx', buf)
    const before = process.memoryUsage().heapUsed
    let peak = 0
    const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().heapUsed - before)), 5)
    const r = await previewFile(p, 'docx')
    clearInterval(timer)
    peak = Math.max(peak, process.memoryUsage().heapUsed - before)
    expect(r.kind).toBe('document')
    if (r.kind === 'document') {
      const images = r.blocks.filter((b) => b.type === 'image').length
      // each read is charged the largest image part (1.5 MB) against the 10 MB total
      expect(images).toBeLessThanOrEqual(Math.floor(OUTPUT_PREVIEW_DOC_IMAGES_TOTAL_BYTES / png.length))
      expect(images).toBeLessThanOrEqual(DOCX_PREVIEW_IMAGES_MAX)
    }
    console.log(`[bounds] 5,000 references: peak heap delta ${Math.round(peak / 1048576)} MB`)
    expect(peak).toBeLessThan(200 * 1024 * 1024)
  }, 60_000)
  it('an image part above the per-image cap is not read, the text still previews', async () => {
    const big = Buffer.concat([PNG_HEAD, randomBytes(OUTPUT_PREVIEW_DOC_IMAGE_MAX_BYTES + 1000)])
    const buf = await miniDocx({ main: body(para('Text stays') + PICT), docRels: IMG_RELS, extra: { 'word/media/image1.png': big }, stored: ['word/media/image1.png'] })
    const r = await previewFile(f('bigimg.docx', buf), 'docx')
    expect(r.kind).toBe('document')
    if (r.kind === 'document') expect(r.blocks.some((b) => b.type === 'image')).toBe(false)
  })
  it('a blip pointing at a hyperlink-type relationship to document.xml, referenced 200 times, reads within the cap', async () => {
    const xml = body(para('Start') + PICT.repeat(200))
    const text = `${xml}<!--${randomBytes(600_000).toString('hex')}-->` // a main part of about 1.2 MB (incompressible), read once per reference
    const hl = `<Relationships xmlns="${NS_REL}"><Relationship Id="rIdImg" Type="${DOC_REL}/hyperlink" Target="document.xml"/></Relationships>`
    const buf = await miniDocx({ main: text, docRels: hl })
    const p = f('blipdoc.docx', buf)
    const before = process.memoryUsage().heapUsed
    let peak = 0
    const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().heapUsed - before)), 5)
    const r = await previewFile(p, 'docx')
    clearInterval(timer)
    peak = Math.max(peak, process.memoryUsage().heapUsed - before)
    expect(r).toMatchObject({ kind: 'document' })
    if (r.kind === 'document') {
      const images = r.blocks.filter((b) => b.type === 'image').length
      // each read costs the decoded length of what was read (about 1.6 MB of base64 -> 1.2 MB), so far fewer than 200 happen
      expect(images).toBeLessThanOrEqual(Math.ceil(OUTPUT_PREVIEW_DOC_IMAGES_TOTAL_BYTES / 1_200_000) + 1)
    }
    console.log(`[bounds] 200 blips at document.xml: peak heap delta ${Math.round(peak / 1048576)} MB`)
    expect(peak).toBeLessThan(200 * 1024 * 1024)
  }, 60_000)
  it('an entry above PREVIEW_MAX_ENTRY_BYTES answers none', async () => {
    const parts =Buffer.concat([PNG_HEAD, randomBytes(PREVIEW_MAX_ENTRY_BYTES + 1000)])
    const buf = await miniDocx({ extra: { 'word/media/huge.png': parts }, stored: ['word/media/huge.png'] })
    expect(buf.length).toBeLessThan(20 * 1024 * 1024)
    expect(await previewFile(f('huge.docx', buf), 'docx')).toEqual(TOO_LARGE_DOC)
  })
})

describe('docx parts come from mammoth\'s own lookup (M1, M3, M4)', () => {
  const filler = (): string => `<x>${'a'.repeat(600 * 1024)}</x>`
  const pkgRels = (typeAttr: string, target: string, pre = ''): string =>
    `<Relationships xmlns="${NS_REL}"><Relationship ${pre}Id="r1" Type="${typeAttr}" Target="${target}"/></Relationships>`
  const withPackageRels = async (xml: string, mainPath: string): Promise<Buffer> => {
    const z = new JSZip()
    z.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
    z.file('_rels/.rels', xml)
    z.file(mainPath, body(para('Hello')))
    return deflated(z)
  }
  it('mammoth._findPartPaths exists (private API, mammoth 1.13.0 pinned) and answers the expected keys', async () => {
    const { _findPartPaths } = await import('mammoth/lib/docx/docx-reader.js')
    const { openArrayBuffer } = await import('mammoth/lib/zipfile.js')
    const buf = await miniDocx({ docRels: rels([{ type: 'styles', target: 'styles.xml' }]), extra: { 'word/styles.xml': '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>' } })
    const paths = await _findPartPaths(await openArrayBuffer(buf))
    expect(Object.keys(paths).sort()).toEqual(['comments', 'endnotes', 'footnotes', 'mainDocument', 'numbering', 'styles'])
    expect(paths.mainDocument).toBe('word/document.xml')
    expect(paths.styles).toBe('word/styles.xml')
    expect(JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).dependencies.mammoth).toBe('1.13.0')
  })
  it('a main part named word/document2.xml previews and is counted', async () => {
    const p = f('d2.docx', await withPackageRels(pkgRels(`${DOC_REL}/officeDocument`, 'word/document2.xml'), 'word/document2.xml'))
    expect((await previewDocx(p)).kind).toBe('document')
    expect(await previewDocx(p, -DOCX_XML_ALLOWANCE + 10)).toEqual(TOO_LARGE_DOC)
  })
  it('a character reference in the Type attribute is read the way mammoth reads it', async () => {
    const t = `http:&#x2F;&#x2F;schemas.openxmlformats.org&#x2F;officeDocument&#x2F;2006&#x2F;relationships&#x2F;officeDocument`
    const p = f('ref.docx', await withPackageRels(pkgRels(t, 'word/other.xml'), 'word/other.xml'))
    expect(await previewDocx(p, -DOCX_XML_ALLOWANCE + 10)).toEqual(TOO_LARGE_DOC)
  })
  it('a prefixed element (p-x:) and a ">" in an earlier attribute are read the way mammoth reads them', async () => {
    const xml = `<Relationships xmlns="${NS_REL}"><Relationship Foo="a>b" Id="r1" Type="${DOC_REL}/officeDocument" Target="word/other.xml"/></Relationships>`
    const p = f('gt.docx', await withPackageRels(xml, 'word/other.xml'))
    expect(await previewDocx(p, -DOCX_XML_ALLOWANCE + 10)).toEqual(TOO_LARGE_DOC)
    const px = `<p-x:Relationships xmlns:p-x="${NS_REL}"><p-x:Relationship Id="r1" Type="${DOC_REL}/officeDocument" Target="word/other.xml"/></p-x:Relationships>`
    const p2 = f('px.docx', await withPackageRels(px, 'word/other.xml'))
    expect(await previewDocx(p2, -DOCX_XML_ALLOWANCE + 10)).toEqual(TOO_LARGE_DOC)
  })
  it('a leading slash on the main target is resolved like mammoth (/word/document.xml passes)', async () => {
    expect((await previewFile(f('slash.docx', await miniDocx({ mainTarget: '/word/document.xml' })), 'docx')).kind).toBe('document')
  })
  it('a styles part pointed at word/media/big.png is refused', async () => {
    const png = Buffer.concat([PNG_HEAD, randomBytes(2000)])
    const buf = await miniDocx({ docRels: rels([{ type: 'styles', target: 'media/big.png' }]), extra: { 'word/media/big.png': png }, stored: ['word/media/big.png'] })
    const r = await previewFile(f('stylespng.docx', buf), 'docx')
    expect(r.kind).toBe('none')
    if (r.kind === 'none') expect(r.reason).toMatch(REFUSED)
  })
  it('a styles part named styles.bin still counts toward the cap', async () => {
    const buf = await miniDocx({ docRels: rels([{ type: 'styles', target: 'styles.bin' }]), extra: { 'word/styles.bin': filler() } })
    const p = f('stylesbin.docx', buf)
    expect(await previewDocx(p, 1000)).toEqual(TOO_LARGE_DOC)
    expect((await previewDocx(p)).kind).toBe('document')
  })
  it('a document with embeddings and fonts previews, however large they are (per-entry cap only)', async () => {
    const buf = await miniDocx({
      extra: { 'word/embeddings/x.xlsx': randomBytes(1_500_000), 'word/fonts/a.odttf': randomBytes(1_500_000), 'word/media/image1.wdp': randomBytes(1_500_000) },
      stored: ['word/embeddings/x.xlsx', 'word/fonts/a.odttf', 'word/media/image1.wdp']
    })
    expect((await previewDocx(f('emb.docx', buf), 1000)).kind).toBe('document')
  })
  it('a report with 400 hyperlinks previews (no 64 KB rels limit)', async () => {
    const links = Array.from({ length: 400 }, (_, i) => `<Relationship Id="h${i}" Type="${DOC_REL}/hyperlink" Target="https://example.com/a/long/path/to/a/report/section-${i}?q=${'x'.repeat(60)}" TargetMode="External"/>`).join('')
    const docRels = `<Relationships xmlns="${NS_REL}">${links}</Relationships>`
    expect(docRels.length).toBeGreaterThan(64 * 1024)
    const r = await previewFile(f('links.docx', await miniDocx({ docRels })), 'docx')
    expect(r.kind).toBe('document')
  })
  it('an embedded style map is ignored (it would turn every paragraph into a heading) and is part of the sum', async () => {
    const buf = await miniDocx({ extra: { 'mammoth/style-map': 'p => h1' } })
    const p = f('stylemap.docx', buf)
    const r = await previewFile(p, 'docx')
    expect(r.kind).toBe('document')
    expect(JSON.stringify(r)).not.toContain('"heading"')
    const withMap = await mammoth.convertToHtml({ buffer: buf })
    expect(withMap.value).toContain('<h1>') // sanity: the map would have applied
    const big = f('stylemapbig.docx', await miniDocx({ extra: { 'mammoth/style-map': filler() } }))
    expect(await previewDocx(big, 1000)).toEqual(TOO_LARGE_DOC)
  })
  it('isImagePart is case-sensitive, single-segment and exceljs-shaped', () => {
    expect(isImagePart('xl/media/image1.png', 'xl/media/')).toBe(true)
    expect(isImagePart('/xl/media/image1.png', 'xl/media/')).toBe(true)
    expect(isImagePart('xl/media/xl/worksheets/sheet1.xml.png', 'xl/media/')).toBe(false)
    expect(isImagePart('XL/media/image1.png', 'xl/media/')).toBe(false)
    expect(isImagePart('word/media/a.b.png', 'word/media/')).toBe(false)
    expect(isImagePart('word/media/a.docx', 'word/media/')).toBe(true) // shape only; images are bounded by bytes read
  })
  it('an embedded style map is ignored (it would turn every paragraph into a heading)', async () => {
    const buf = await miniDocx({ extra: { 'mammoth/style-map': 'p => h1' } })
    const r = await previewFile(f('stylemap.docx', buf), 'docx')
    expect(r.kind).toBe('document')
    expect(JSON.stringify(r)).not.toContain('"heading"')
    const withMap = await mammoth.convertToHtml({ buffer: buf })
    expect(withMap.value).toContain('<h1>') // sanity: the map would have applied
  })
})

describe('xlsx size caps (M2)', () => {
  it('answers none above the cap and previews at it', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('A')
    for (let r = 0; r < 500; r++) ws.addRow(Array.from({ length: 20 }, (_, c) => r + c))
    const p = f('cap.xlsx', Buffer.from(await wb.xlsx.writeBuffer()))
    const sum = zipSumSizes(readFileSync(p), () => true) ?? 0
    expect((await previewXlsx(p, sum)).kind).toBe('sheets')
    expect(await previewXlsx(p, sum - 1)).toEqual(TOO_LARGE_SHEET)
    expect(XLSX_PREVIEW_MAX_XML_BYTES).toBeGreaterThan(sum)
  })
  it('a nested or upper-case media name counts toward the sum, a real image name does not', async () => {
    const wb = new ExcelJS.Workbook()
    wb.addWorksheet('A').addRow(['x'])
    const base = Buffer.from(await wb.xlsx.writeBuffer())
    const sumBase = zipSumSizes(base, () => true) ?? 0
    const filler = randomBytes(300_000)
    for (const name of ['xl/media/xl/worksheets/sheet1.xml.png', 'XL/media/image1.png']) {
      const z = await JSZip.loadAsync(base)
      z.file(name, filler, { compression: 'STORE', createFolders: false })
      const p = f(`media-${name.length}.xlsx`, await deflated(z))
      expect(await previewXlsx(p, sumBase + 1000)).toEqual(TOO_LARGE_SHEET)
    }
    const z = await JSZip.loadAsync(base)
    z.file('xl/media/image1.png', filler, { compression: 'STORE' })
    expect((await previewXlsx(f('media-ok.xlsx', await deflated(z)), sumBase + 1000)).kind).toBe('sheets')
  })
  it('an entry above PREVIEW_MAX_ENTRY_BYTES answers none', async () => {
    const wb =new ExcelJS.Workbook()
    wb.addWorksheet('A').addRow(['x'])
    const z = await JSZip.loadAsync(Buffer.from(await wb.xlsx.writeBuffer()))
    z.file('xl/media/huge.png', randomBytes(PREVIEW_MAX_ENTRY_BYTES + 1000), { compression: 'STORE' })
    expect(await previewFile(f('hugex.xlsx', await deflated(z)), 'xlsx')).toEqual(TOO_LARGE_SHEET)
  })
})

describe('zipGuard duplicate names ignore a leading slash', () => {
  it('"/a.xml" and "a.xml" are one name', async () => {
    const z = new JSZip()
    z.file('a.xml', '<a/>')
    z.file('/a.xml', '<b/>')
    expect(zipVerifyEntries(await deflated(z))).not.toBeNull()
  })
})
