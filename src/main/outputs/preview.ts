import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { Readable } from 'node:stream'
import ExcelJS from 'exceljs'
import mammoth from 'mammoth'
import type { OutputKind, OutputPreview, SheetCell, SheetPreview } from '@shared/types'
import {
  OUTPUT_PREVIEW_COLUMNS_MAX,
  OUTPUT_PREVIEW_IMAGE_MAX_BYTES,
  OUTPUT_PREVIEW_ROWS_MAX,
  OUTPUT_PREVIEW_SHEETS_MAX,
  OUTPUT_PREVIEW_TEXT_MAX_BYTES
} from '@shared/types'
import { htmlToBlocks } from './htmlBlocks'
import { svgProblem } from './writers'
import { zipEntryNames, zipEntrySize, zipInfo, zipProblem, zipVerifyEntries } from './zipGuard'

/**
 * previewFile(path, kind): the inline preview of one output file. Never throws; any problem is { kind: 'none', reason }.
 * The caller (service.preview) has already re-checked the path (checkedPath); this still lstats it as a regular file.
 *
 * docx: size <= 20 MB, zipGuard, mammoth.convertToHtml with externalFileAccess: false (always; CVE-2025-11849), and
 * its HTML is untrusted input to htmlBlocks. xlsx: size <= 20 MB, zipGuard, then exceljs' STREAMING reader over the
 * buffer, which stops after OUTPUT_PREVIEW_ROWS_MAX rows per sheet and OUTPUT_PREVIEW_SHEETS_MAX sheets (measured:
 * 10,000 x 26 loads in about 1.1 s with workbook.xlsx.load, the stream reads the first 500 rows in about 0.1 s).
 * The stream cannot know the sheet's true size, so a row count beyond the cap is what was seen before the hard read
 * limit (COUNT_EXTRA_ROWS rows or COUNT_MS ms): a LOWER BOUND, not the total.
 */

const DOC_MAX_BYTES = 20 * 1024 * 1024
const COUNT_EXTRA_ROWS = 20_000
const COUNT_MS = 150
const DEADLINE_MS = 8_000
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
const LOAD_FALLBACK_MAX_BYTES = 60 * 1024 * 1024

async function previewXlsx(path: string): Promise<OutputPreview> {
  const buf = readCapped(path, DOC_MAX_BYTES)
  if (buf.length > DOC_MAX_BYTES) return none('This spreadsheet is larger than 20 MB, so OrgAI does not preview it; open it instead.')
  const zi = zipInfo(buf)
  if (zi.problem) return none(`OrgAI did not preview this spreadsheet: ${zi.problem}`)
  const zv = zipVerifyEntries(buf)
  if (zv) return none(`OrgAI did not preview this spreadsheet: ${zv}`)
  const small = zi.totalBytes <= LOAD_FALLBACK_MAX_BYTES
  // exceljs' streaming reader reads the zip in order: workbook.xml, its rels and sharedStrings.xml must come before the
  // first sheet, or it drops sheets, names them SheetN and leaves string cells empty WITHOUT throwing (measured on
  // re-ordered copies of one workbook). So the stream is used only for a package in that order; any other order, or a
  // stream that throws, takes a full load (bounded by uncompressed size).
  if (small && !streamSafeOrder(zipEntryNames(buf))) {
    const loaded = await previewXlsxLoaded(buf)
    if (loaded) return loaded
  }
  const streamed = await previewXlsxStream(buf)
  if (streamed.kind !== 'none') return streamed
  if (!small) return streamed
  return (await previewXlsxLoaded(buf)) ?? streamed
}

/** True when workbook.xml, its rels and (when present) sharedStrings.xml all precede the first worksheet entry. */
export function streamSafeOrder(names: string[]): boolean {
  const at = (n: string): number => names.indexOf(n)
  const firstSheet = names.findIndex((n) => n.startsWith('xl/worksheets/') && n.endsWith('.xml'))
  if (firstSheet < 0) return true
  const before = (n: string, required: boolean): boolean => {
    const i = at(n)
    return i < 0 ? !required : i < firstSheet
  }
  return before('xl/workbook.xml', true) && before('xl/_rels/workbook.xml.rels', true) && before('xl/sharedStrings.xml', false)
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

async function previewXlsxStream(buf: Buffer): Promise<OutputPreview> {
  const input = Readable.from([buf])
  const started = Date.now()
  const budget = { left: SHEETS_TEXT_BUDGET }
  const sheets: SheetPreview[] = []
  let truncatedSheets = 0
  try {
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(input, { sharedStrings: 'cache', hyperlinks: 'cache', styles: 'cache', worksheets: 'emit', entries: 'emit' })
    for await (const sheet of reader) {
      if (sheets.length >= OUTPUT_PREVIEW_SHEETS_MAX || budget.left <= 0 || Date.now() - started > DEADLINE_MS) {
        truncatedSheets++
        continue
      }
      const rows: SheetCell[][] = []
      let seen = 0
      let extra = 0
      let maxCol = 0
      let countStart = 0
      let lastNumber = 0
      for await (const row of sheet) {
        const number = typeof row.number === 'number' ? row.number : lastNumber + 1
        if (rows.length < OUTPUT_PREVIEW_ROWS_MAX) {
          // keep gaps between row numbers as empty rows (up to the cap)
          while (lastNumber + 1 < number && rows.length < OUTPUT_PREVIEW_ROWS_MAX) {
            rows.push([])
            lastNumber++
          }
          if (rows.length >= OUTPUT_PREVIEW_ROWS_MAX) {
            extra++
            lastNumber = number
            continue
          }
          const rr = readRow(row, budget)
          if (rr.maxCol > maxCol) maxCol = rr.maxCol
          rows.push(rr.cells)
          seen++
          lastNumber = number
          if (budget.left <= 0 || Date.now() - started > DEADLINE_MS) {
            extra++
            break
          }
        } else {
          if (!countStart) countStart = Date.now()
          extra++
          lastNumber = number
          if (extra >= COUNT_EXTRA_ROWS || Date.now() - countStart > COUNT_MS) break
        }
      }
      void seen
      // WorksheetReader.name is set by exceljs from workbook.xml but missing from its typings.
      const sheetName = (sheet as unknown as { name?: unknown }).name
      const sp: SheetPreview = { name: typeof sheetName === 'string' ? cellText(sheetName, budget) : `Sheet${sheets.length + 1}`, rows }
      if (extra > 0) sp.truncatedRows = extra
      if (maxCol > OUTPUT_PREVIEW_COLUMNS_MAX) sp.truncatedCols = maxCol - OUTPUT_PREVIEW_COLUMNS_MAX
      sheets.push(sp)
    }
  } catch (e) {
    if (!sheets.length) return none(`OrgAI could not read this spreadsheet: ${(e as Error).message}`)
  } finally {
    input.destroy()
  }
  if (!sheets.length) return none('This spreadsheet has no sheets to show.')
  return { kind: 'sheets', sheets, ...(truncatedSheets ? { truncatedSheets } : {}) }
}

// ---------- docx ----------

/**
 * Largest word/document.xml (uncompressed) the docx preview converts. mammoth runs on the main thread and its time grows
 * with this size, so a bigger document answers "too large to preview" at once (see preview.measure.test.ts for the table).
 */
export const DOCX_PREVIEW_MAX_XML_BYTES = 3 * 1024 * 1024

const DOCX_TOO_LARGE = 'This document is too large to preview here. Open it instead.'

/** previewDocx with the document.xml threshold as a parameter (exported for tests and measurement). */
export async function previewDocx(path: string, maxXmlBytes: number = DOCX_PREVIEW_MAX_XML_BYTES): Promise<OutputPreview> {
  const buf = readCapped(path, DOC_MAX_BYTES)
  if (buf.length > DOC_MAX_BYTES) return none('This document is larger than 20 MB, so OrgAI does not preview it; open it instead.')
  const zp = zipProblem(buf)
  if (zp) return none(`OrgAI did not preview this document: ${zp}`)
  const xmlSize = zipEntrySize(buf, 'word/document.xml')
  if (xmlSize !== null && xmlSize > maxXmlBytes) return none(DOCX_TOO_LARGE)
  const zv = zipVerifyEntries(buf)
  if (zv) return none(`OrgAI did not preview this document: ${zv}`)
  try {
    // externalFileAccess: false always: a linked external file must never be read (CVE-2025-11849).
    const r = await mammoth.convertToHtml({ buffer: buf }, { externalFileAccess: false } as Parameters<typeof mammoth.convertToHtml>[1])
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
