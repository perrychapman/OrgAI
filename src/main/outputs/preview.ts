import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import ExcelJS from 'exceljs'
import mammoth from 'mammoth'
// The .js extensions matter: mammoth has no "exports" map, so Node's ESM resolver (the externalized main bundle) needs them.
import { _findPartPaths } from 'mammoth/lib/docx/docx-reader.js'
import { openArrayBuffer } from 'mammoth/lib/zipfile.js'
import type { OutputKind, OutputPreview, SheetCell, SheetPreview } from '@shared/types'
import {
  OUTPUT_PREVIEW_COLUMNS_MAX,
  OUTPUT_PREVIEW_DOC_IMAGES_TOTAL_BYTES,
  OUTPUT_PREVIEW_DOC_IMAGE_MAX_BYTES,
  OUTPUT_PREVIEW_IMAGE_MAX_BYTES,
  OUTPUT_PREVIEW_ROWS_MAX,
  OUTPUT_PREVIEW_SHEETS_MAX,
  OUTPUT_PREVIEW_TEXT_MAX_BYTES
} from '@shared/types'
import { htmlToBlocks } from './htmlBlocks'
import { previewPptxFile } from './pptxPreview'
import { svgProblem } from './writers'
import { zipInfo, zipMaxSize, zipProblem, zipSumSizes, zipVerifyEntries } from './zipGuard'

/**
 * previewFile(path, kind): the inline preview of one output file. Never throws; any problem is { kind: 'none', reason }.
 * The caller (service.preview) has already re-checked the path (checkedPath); this still lstats it as a regular file.
 *
 * docx: size <= 20 MB, zipGuard, mammoth.convertToHtml with externalFileAccess: false (always; CVE-2025-11849), and
 * its HTML is untrusted input to htmlBlocks. xlsx: size <= 20 MB, zipGuard (declared uncompressed <= 60 MB), then
 * exceljs' JSZip-based workbook.xlsx.load (exact row totals; shows OUTPUT_PREVIEW_ROWS_MAX rows per sheet and
 * OUTPUT_PREVIEW_SHEETS_MAX sheets). The streaming reader is not used (it walks local headers; Reviewer H1).
 */

const DOC_MAX_BYTES = 20 * 1024 * 1024
const CELL_TEXT_MAX = 2000
const SHEETS_TEXT_BUDGET = 4 * 1024 * 1024

const none = (reason: string): OutputPreview => ({ kind: 'none', reason })

const OPEN_ONLY = 'OrgAI cannot preview this kind of file; open it instead.'

/** Read at most cap + 1 bytes of a regular file. */
function readCapped(path: string, cap: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new Error('not a regular file')
    const want = Math.min(st.size, cap + 1)
    const buf = Buffer.alloc(want)
    let off = 0
    while (off < want) {
      const n = readSync(fd, buf, off, want - off, off)
      if (n <= 0) break
      off += n
    }
    return off === want ? buf : buf.subarray(0, off)
  } finally {
    closeSync(fd)
  }
}

/** The text of at most `max` bytes, cut on a code point boundary. */
function decodeCapped(buf: Buffer, max: number): { text: string; truncated: boolean } {
  let end = Math.min(buf.length, max)
  const truncated = buf.length > max
  if (truncated) {
    let i = end - 1
    let k = 0
    while (i >= 0 && k < 3 && (buf[i] & 0xc0) === 0x80) {
      i--
      k++
    }
    if (i >= 0 && buf[i] >= 0xc0) {
      const need = buf[i] >= 0xf0 ? 4 : buf[i] >= 0xe0 ? 3 : 2
      if (k + 1 < need) end = i
    }
  }
  return { text: buf.toString('utf8', 0, end).replace(/^﻿/, ''), truncated }
}

export function imageType(head: Buffer): 'png' | 'jpeg' | 'gif' | 'webp' | null {
  if (head.length >= 8 && head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG') return 'png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg'
  if (head.length >= 6 && (head.toString('latin1', 0, 6) === 'GIF87a' || head.toString('latin1', 0, 6) === 'GIF89a')) return 'gif'
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  return null
}

// ---------- xlsx ----------

function cellText(s: string, budget: { left: number }): string {
  const t = s.length > CELL_TEXT_MAX ? `${s.slice(0, CELL_TEXT_MAX - 1)}…` : s
  budget.left -= t.length
  return t
}

type Primitive = string | number | boolean | null

/** A cell value reduced to a primitive: dates ISO, rich text flattened, hyperlink text, error text. */
function plainValue(v: unknown, budget: { left: number }, depth = 0): Primitive {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v)
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return cellText(v, budget)
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
  if (typeof v === 'object' && depth < 2) {
    const o = v as Record<string, unknown>
    if (typeof o.error === 'string') return cellText(o.error, budget)
    if (Array.isArray(o.richText)) {
      return cellText(
        o.richText.map((r) => (r && typeof (r as { text?: unknown }).text === 'string' ? (r as { text: string }).text : '')).join(''),
        budget
      )
    }
    if ('formula' in o || 'sharedFormula' in o) return plainValue(o.result, budget, depth + 1)
    if (o.text !== undefined) return plainValue(o.text, budget, depth + 1)
    if (typeof o.hyperlink === 'string') return cellText(o.hyperlink, budget)
  }
  return null
}

function formulaOf(v: unknown): string | undefined {
  if (v && typeof v === 'object') {
    const f = (v as { formula?: unknown }).formula
    if (typeof f === 'string' && f) return f.length > CELL_TEXT_MAX ? f.slice(0, CELL_TEXT_MAX) : f
  }
  return undefined
}

/** One row's cells (columns past the cap dropped) and the widest column seen. Works for the streamed and the loaded Row. */
function readRow(row: ExcelJS.Row, budget: { left: number }): { cells: SheetCell[]; maxCol: number } {
  const out: SheetCell[] = []
  let maxCol = 0
  row.eachCell({ includeEmpty: false }, (cell: ExcelJS.Cell, col: number) => {
    if (col > maxCol) maxCol = col
    if (col > OUTPUT_PREVIEW_COLUMNS_MAX) return
    while (out.length < col - 1) out.push({ v: null })
    const sc: SheetCell = { v: plainValue(cell.value, budget) }
    const f = formulaOf(cell.value)
    if (f) sc.f = f
    const fmt = cell.numFmt
    if (typeof fmt === 'string' && fmt && fmt !== 'General' && fmt.length <= 64) sc.fmt = fmt
    out[col - 1] = sc
  })
  return { cells: out, maxCol }
}

/** Largest uncompressed package the full-load fallback reads (workbook.xlsx.load inflates everything into memory). */
const LOAD_MAX_BYTES = 60 * 1024 * 1024

/** Largest summed non-image package content the xlsx preview loads; measured, see preview.measure.test.ts and ARCHITECTURE.md. */
export const XLSX_PREVIEW_MAX_XML_BYTES = 8 * 1024 * 1024

const XLSX_TOO_LARGE = 'This workbook is too large to preview here. Open it instead.'

export async function previewXlsx(path: string, maxXmlBytes: number = XLSX_PREVIEW_MAX_XML_BYTES): Promise<OutputPreview> {
  const buf = readCapped(path, DOC_MAX_BYTES)
  if (buf.length > DOC_MAX_BYTES) return none('This spreadsheet is larger than 20 MB, so OrgAI does not preview it; open it instead.')
  const zi = zipInfo(buf)
  if (zi.problem) return none(`OrgAI did not preview this spreadsheet: ${zi.problem}`)
  const zv = zipVerifyEntries(buf)
  if (zv) return none(`OrgAI did not preview this spreadsheet: ${zv}`)
  if (zi.totalBytes > LOAD_MAX_BYTES) return none('This spreadsheet expands to more than 60 MB, so OrgAI does not preview it; open it instead.')
  // exceljs holds each part as one string and builds a Cell per <c>: bound the parts it parses (sheets, shared strings,
  // styles and any other non-image part) and any single read.
  const xmlSize = zipSumSizes(buf, (n) => !isImagePart(n, 'xl/media/'))
  const biggest = zipMaxSize(buf, () => true)
  if ((xmlSize !== null && xmlSize > maxXmlBytes) || (biggest !== null && biggest > PREVIEW_MAX_ENTRY_BYTES)) return none(XLSX_TOO_LARGE)
  // Always the JSZip-based full load: it reads the central directory, which zipGuard checked. exceljs' streaming reader
  // walks local headers and was not safe against a crafted descriptor entry (Reviewer H1), so it is not used.
  return (await previewXlsxLoaded(buf)) ?? none('OrgAI could not read this spreadsheet.')
}

/** Full-load reader: exact row and column totals, first OUTPUT_PREVIEW_* shown. Null when it cannot read the file. */
async function previewXlsxLoaded(buf: Buffer): Promise<OutputPreview | null> {
  try {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
    const budget = { left: SHEETS_TEXT_BUDGET }
    const sheets: SheetPreview[] = []
    let truncatedSheets = 0
    for (const ws of wb.worksheets) {
      if (sheets.length >= OUTPUT_PREVIEW_SHEETS_MAX || budget.left <= 0) {
        truncatedSheets++
        continue
      }
      const total = ws.rowCount
      const shown = Math.min(total, OUTPUT_PREVIEW_ROWS_MAX)
      const rows: SheetCell[][] = []
      let maxCol = 0
      for (let r = 1; r <= shown; r++) {
        const rr = readRow(ws.getRow(r), budget)
        if (rr.maxCol > maxCol) maxCol = rr.maxCol
        rows.push(rr.cells)
        if (budget.left <= 0) break
      }
      const sp: SheetPreview = { name: cellText(ws.name, budget), rows }
      if (total > rows.length) sp.truncatedRows = total - rows.length
      for (let r = shown + 1; r <= Math.min(total, shown + 1000); r++) maxCol = Math.max(maxCol, ws.getRow(r).cellCount)
      if (maxCol > OUTPUT_PREVIEW_COLUMNS_MAX) sp.truncatedCols = maxCol - OUTPUT_PREVIEW_COLUMNS_MAX
      sheets.push(sp)
    }
    if (!sheets.length) return none('This spreadsheet has no sheets to show.')
    return { kind: 'sheets', sheets, ...(truncatedSheets ? { truncatedSheets } : {}) }
  } catch {
    return null
  }
}

// ---------- docx ----------

/**
 * Largest word/document.xml (uncompressed) the docx preview converts. mammoth runs on the main thread and its time grows
 * with this size, so a bigger document answers "too large to preview" at once (see preview.measure.test.ts for the table).
 */
export const DOCX_PREVIEW_MAX_XML_BYTES = 3 * 1024 * 1024

/** Room for styles, numbering, theme, rels and content types next to the main part. */
export const DOCX_XML_ALLOWANCE = 512 * 1024

const DOCX_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const DOCX_TOO_LARGE = 'This document is too large to preview here. Open it instead.'

/** No single package entry above this is read by a preview (one read, one string, one buffer). */
export const PREVIEW_MAX_ENTRY_BYTES = 16 * 1024 * 1024

/** Images the docx preview converts at most; later references get no image (and no read). */
export const DOCX_PREVIEW_IMAGES_MAX = 200

/**
 * A true media part: `folder` (case-sensitive, trailing slash) plus ONE segment of the shape exceljs's own media handler
 * accepts (xlsx.js: /xl\/media\/([a-zA-Z0-9]+[.][a-zA-Z0-9]{3,4})$/). Anything else under a media folder (a nested name such
 * as `xl/media/xl/worksheets/sheet1.xml.png`, which exceljs parses as a worksheet) or in another case counts as XML.
 */
export function isImagePart(name: string, folder: string): boolean {
  const n = name.startsWith('/') ? name.slice(1) : name
  if (!n.startsWith(folder)) return false
  return /^[a-zA-Z0-9]+\.[a-zA-Z0-9]{3,4}$/.test(n.slice(folder.length))
}

// mammoth's own part lookup is private API (pinned: package.json has mammoth 1.13.0 exactly, and previewBounds.test.ts asserts
// _findPartPaths exists and answers these keys, so an upgrade fails loudly). It is the one place that knows which parts mammoth reads.
const PART_KEYS = ['mainDocument', 'comments', 'endnotes', 'footnotes', 'numbering', 'styles'] as const
const NOT_WORD = 'its parts are not laid out like a Word document'

function relsOf(part: string): string {
  const i = part.lastIndexOf('/')
  return i < 0 ? `_rels/${part}.rels` : `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`
}

/** The parts mammoth will read (its own lookup), their rels, the package rels, content types and style map; or a refusal. */
async function docxParts(buf: Buffer): Promise<{ names: Set<string> } | { problem: string }> {
  const paths = await _findPartPaths(await openArrayBuffer(buf))
  const names = new Set<string>(['_rels/.rels', '[Content_Types].xml', 'mammoth/style-map'])
  for (const k of PART_KEYS) {
    const raw = paths[k]
    if (typeof raw !== 'string') continue
    const part = raw.startsWith('/') ? raw.slice(1) : raw
    if (!part || part.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return { problem: NOT_WORD }
    // an image part (any case, any depth under a media folder) is never a text part
    if (isImagePart(part, 'word/media/') || /(^|\/)media\/[^/]*\.(png|jpe?g|gif|webp|bmp|tiff?|emf|wmf)$/i.test(part)) return { problem: NOT_WORD }
    names.add(part)
    names.add(relsOf(part))
  }
  return { names }
}

/** previewDocx with the document.xml threshold as a parameter (exported for tests and measurement). */
export async function previewDocx(path: string, maxXmlBytes: number = DOCX_PREVIEW_MAX_XML_BYTES): Promise<OutputPreview> {
  const buf = readCapped(path, DOC_MAX_BYTES)
  if (buf.length > DOC_MAX_BYTES) return none('This document is larger than 20 MB, so OrgAI does not preview it; open it instead.')
  const zp = zipProblem(buf)
  if (zp) return none(`OrgAI did not preview this document: ${zp}`)
  // No single entry may be larger than one bounded read (mammoth can read any entry a relationship names).
  const biggest = zipMaxSize(buf, () => true)
  if (biggest !== null && biggest > PREVIEW_MAX_ENTRY_BYTES) return none(DOCX_TOO_LARGE)
  const cap = maxXmlBytes + DOCX_XML_ALLOWANCE
  // What mammoth's part lookup itself reads before we can ask it: every rels part, the content types and the style map.
  const lookup = zipSumSizes(buf, (n) => n.endsWith('.rels') || n === '[Content_Types].xml' || n === 'mammoth/style-map')
  if (lookup !== null && lookup > cap) return none(DOCX_TOO_LARGE)
  const zv = zipVerifyEntries(buf)
  if (zv) return none(`OrgAI did not preview this document: ${zv}`)
  try {
    const parts = await docxParts(buf)
    if ('problem' in parts) return none(`OrgAI did not preview this document: ${parts.problem}.`)
    // Only the parts mammoth reads count toward the cap (its own list, plus their rels, package rels, content types and the
    // style map, which mammoth always reads); every other entry (embeddings, fonts, other media) stays under the per-entry cap.
    const xmlSize = zipSumSizes(buf, (n) => parts.names.has(n.startsWith('/') ? n.slice(1) : n))
    if (xmlSize !== null && xmlSize > cap) return none(DOCX_TOO_LARGE)
    // Image reads are budgeted by the bytes actually read: mammoth never checks an image relationship's type, so a blip may
    // point at ANY entry, and re-reads and re-encodes it for EVERY reference. Deferred conversions run one at a time, so the
    // overshoot is at most one part, which is at most PREVIEW_MAX_ENTRY_BYTES.
    const imageReads = { count: 0, bytes: 0 }
    const noImage = {} as { src: string } // an <img> with no src: htmlBlocks drops it
    const convertImage = mammoth.images.imgElement(async (image) => {
      if (imageReads.count >= DOCX_PREVIEW_IMAGES_MAX) return noImage
      if (imageReads.bytes >= OUTPUT_PREVIEW_DOC_IMAGES_TOTAL_BYTES) return noImage
      // htmlBlocks drops every other data URL, so a blip aimed at XML or an embedding is never read or charged.
      if (!DOCX_IMAGE_TYPES.has(image.contentType)) return noImage
      imageReads.count++
      const data = await image.read('base64')
      const read = Math.ceil((data.length * 3) / 4)
      imageReads.bytes += read
      if (read > OUTPUT_PREVIEW_DOC_IMAGE_MAX_BYTES) return noImage
      return { src: `data:${image.contentType};base64,${data}` }
    })
    // externalFileAccess: false always: a linked external file must never be read (CVE-2025-11849). includeEmbeddedStyleMap:
    // false means the embedded style map is ignored, not unread (mammoth always reads mammoth/style-map; it is in the sum).
    const r = await mammoth.convertToHtml({ buffer: buf }, { externalFileAccess: false, includeEmbeddedStyleMap: false, convertImage } as Parameters<typeof mammoth.convertToHtml>[1])
    const { blocks, truncated } = htmlToBlocks(r.value)
    if (!blocks.length) return none('This document has no text to show.')
    return { kind: 'document', blocks, ...(truncated ? { truncated: true as const } : {}) }
  } catch (e) {
    return none(`OrgAI could not read this document: ${(e as Error).message}`)
  }
}

// ---------- entry ----------

/** The preview of the file at `path` as `kind`. Never throws. */
export async function previewFile(path: string, kind: OutputKind): Promise<OutputPreview> {
  try {
    const st = lstatSync(path)
    if (st.isSymbolicLink() || !st.isFile()) return none('That file is not a regular file, so OrgAI does not preview it.')
    switch (kind) {
      case 'docx':
        return await previewDocx(path)
      case 'xlsx':
        return await previewXlsx(path)
      case 'pptx':
        return await previewPptxFile(path)
      case 'markdown':
      case 'text':
      case 'csv':
      case 'json':
      case 'mermaid': {
        const { text, truncated } = decodeCapped(readCapped(path, OUTPUT_PREVIEW_TEXT_MAX_BYTES), OUTPUT_PREVIEW_TEXT_MAX_BYTES)
        return { kind: 'text', text, ...(truncated ? { truncated: true as const } : {}) }
      }
      case 'svg': {
        const buf = readCapped(path, OUTPUT_PREVIEW_IMAGE_MAX_BYTES)
        if (buf.length > OUTPUT_PREVIEW_IMAGE_MAX_BYTES) return none('This image is larger than 10 MB, so OrgAI does not preview it; open it instead.')
        const text = buf.toString('utf8').replace(/^﻿/, '')
        const p = svgProblem(text)
        if (p) return none(`OrgAI did not preview this SVG: ${p}`)
        return { kind: 'svg', text }
      }
      case 'image': {
        const buf = readCapped(path, OUTPUT_PREVIEW_IMAGE_MAX_BYTES)
        if (buf.length > OUTPUT_PREVIEW_IMAGE_MAX_BYTES) return none('This image is larger than 10 MB, so OrgAI does not preview it; open it instead.')
        const t = imageType(buf)
        if (!t) return none('This file is not a PNG, JPEG, GIF or WebP image, so OrgAI does not preview it.')
        return { kind: 'image', dataUrl: `data:image/${t};base64,${buf.toString('base64')}` }
      }
      default:
        return none(OPEN_ONLY)
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return none('The file is no longer there.')
    return none(`OrgAI could not read this file: ${(e as Error).message}`)
  }
}
