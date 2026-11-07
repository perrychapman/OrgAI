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
import { zipProblem } from './zipGuard'

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
const COUNT_MS = 400
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

async function previewXlsx(path: string): Promise<OutputPreview> {
  const buf = readCapped(path, DOC_MAX_BYTES)
  if (buf.length > DOC_MAX_BYTES) return none('This spreadsheet is larger than 20 MB, so OrgAI does not preview it; open it instead.')
  const zp = zipProblem(buf)
  if (zp) return none(`OrgAI did not preview this spreadsheet: ${zp}`)
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
          const out: SheetCell[] = []
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
          rows.push(out)
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
      const sp: SheetPreview = { name: typeof sheet.name === 'string' ? cellText(sheet.name, budget) : `Sheet${sheets.length + 1}`, rows }
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

async function previewDocx(path: string): Promise<OutputPreview> {
  const buf = readCapped(path, DOC_MAX_BYTES)
  if (buf.length > DOC_MAX_BYTES) return none('This document is larger than 20 MB, so OrgAI does not preview it; open it instead.')
  const zp = zipProblem(buf)
  if (zp) return none(`OrgAI did not preview this document: ${zp}`)
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
