/**
 * documentText: the text of an Office file or a text file for the read_document tool. The caller has already read the
 * bytes from an open handle (this touches no file system) and chose `plan` with documentReadPlan. Everything goes through
 * the existing preview guards: zipGuard, loadXlsxWorkbook, previewDocxBuffer and previewPptxBuffer; there is no second
 * parser. Never throws; every problem is { refused: <one plain sentence> }.
 */
import type ExcelJS from 'exceljs'
import {
  READ_DOCUMENT_COLUMNS_MAX,
  READ_DOCUMENT_MAX_BYTES,
  READ_DOCUMENT_ROWS_DEFAULT,
  READ_DOCUMENT_ROWS_MAX
} from '@shared/types'
import { loadXlsxWorkbook, plainValue, previewDocxBuffer } from './preview'
import { previewPptxBuffer } from './pptxPreview'
import { blocksToMarkdown, slideText, tab, utf8End } from './readText'
import type { ReadPlan } from './sniff'
import { zipEntryNames, zipInfo } from './zipGuard'

export interface DocumentWindow {
  sheet?: string
  startRow?: number
  rows?: number
  startColumn?: number
  columns?: number
  part?: number
}

export interface DocumentSheetInfo {
  name: string
  rows: number
  columns: number
  hidden?: boolean
}

export type DocumentText =
  | { format: 'xlsx' | 'docx' | 'pptx' | 'text'; text: string; truncated: boolean; notes: string[]; sheets?: DocumentSheetInfo[] }
  | { refused: string }

const SHEETS_LISTED_MAX = 100
const SHEET_NAMES_IN_REFUSAL = 50
const EXPORT_HINT = 'Ask the user for a fresh copy or a CSV / PDF export.'

const refused = (s: string): { refused: string } => ({ refused: s })
const num = (n: number): string => n.toLocaleString('en-US')

/** Column letters for a 1-based column index (1 = A, 27 = AA). */
function colLetter(n: number): string {
  let s = ''
  let c = n
  while (c > 0) {
    const r = (c - 1) % 26
    s = String.fromCharCode(65 + r) + s
    c = Math.floor((c - 1) / 26)
  }
  return s
}

function intIn(v: number | undefined, def: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def
  return Math.max(min, Math.min(max, Math.floor(v)))
}

/** The bytes of `s` cut to at most `max` bytes on a code point boundary. */
function cutUtf8(s: string, max: number): { text: string; cut: boolean } {
  const b = Buffer.from(s, 'utf8')
  if (b.length <= max) return { text: s, cut: false }
  return { text: b.toString('utf8', 0, utf8End(b, max)), cut: true }
}

// ---------- entry ----------

export async function documentText(
  buf: Buffer,
  plan: Exclude<ReadPlan, { refused: string }>,
  window: DocumentWindow,
  fileSize: number
): Promise<DocumentText> {
  try {
    switch (plan.read) {
      case 'zip':
        return await zipText(buf, window)
      case 'cfb':
        return cfbRefusal(buf)
      case 'text':
        return textOf(buf, plan.encoding, fileSize)
    }
  } catch (e) {
    return refused(`OrgAI could not read this file: ${(e as Error).message}`)
  }
}

// ---------- zip ----------

type Package = 'xlsx' | 'docx' | 'pptx'
const WHAT: Record<Package, string> = { xlsx: 'a workbook', docx: 'a document', pptx: 'a deck' }

/** The sentence for a package that looks like Office but would not open. */
function damaged(pkg: Package): { refused: string } {
  return refused(`This looks like ${WHAT[pkg]} but OrgAI could not open it: it may be damaged or not a real Office file. ${EXPORT_HINT}`)
}

function tooLarge(pkg: Package): { refused: string } {
  return refused(`This ${pkg === 'xlsx' ? 'workbook' : pkg === 'docx' ? 'document' : 'deck'} is too large for OrgAI to read. Ask the user for a ${pkg === 'xlsx' ? 'CSV export of the sheet needed' : 'smaller copy or a text export of the part needed'}.`)
}

/** A preview's refusal reason as an agent-facing sentence. */
function fromPreviewReason(pkg: Package, reason: string): { refused: string } {
  if (/too large|larger than|more than \d+ MB/i.test(reason)) return tooLarge(pkg)
  if (/macros/i.test(reason)) return refused(`This ${pkg === 'pptx' ? 'deck' : 'file'} contains macros, so OrgAI does not read it. Ask the user for a copy saved without macros (.pptx), or a text export.`)
  return damaged(pkg)
}

async function zipText(buf: Buffer, window: DocumentWindow): Promise<DocumentText> {
  const zi = zipInfo(buf)
  const names = zi.problem ? [] : zipEntryNames(buf)
  if (zi.problem) {
    return refused(`This looks like a zip-based file (an Office document or an archive) but OrgAI could not open it: it may be damaged. ${EXPORT_HINT}`)
  }
  if (!names.length) return refused('This is an empty zip archive, so there is nothing to read.')
  const has = (n: string): boolean => names.includes(n)
  if (has('xl/workbook.xml')) return await xlsxText(buf, window)
  if (has('word/document.xml')) return await docxText(buf, window)
  if (has('ppt/presentation.xml')) return await pptxText(buf, window)
  if (has('mimetype') || (has('content.xml') && has('META-INF/manifest.xml'))) {
    return refused('This is an OpenDocument file (.ods, .odt or .odp). OrgAI reads only .xlsx, .docx and .pptx; ask the user to save it in one of those formats or export a CSV.')
  }
  return refused('This is a zip archive, which holds other files and has no text of its own. Ask the user to extract it and name the file inside that you need.')
}

// ---------- xlsx ----------

function sheetInfo(ws: ExcelJS.Worksheet): DocumentSheetInfo {
  const info: DocumentSheetInfo = { name: ws.name, rows: ws.rowCount, columns: ws.columnCount }
  if (ws.state && ws.state !== 'visible') info.hidden = true
  return info
}

function cellString(v: unknown, budget: { left: number }): string {
  let p = plainValue(v, budget)
  if (p === null && v && typeof v === 'object' && typeof (v as { formula?: unknown }).formula === 'string') p = `=${(v as { formula: string }).formula}`
  return tab(p)
}

async function xlsxText(buf: Buffer, window: DocumentWindow): Promise<DocumentText> {
  const loaded = await loadXlsxWorkbook(buf)
  if ('problem' in loaded) {
    if (loaded.kind === 'size' || loaded.kind === 'expanded' || loaded.kind === 'large') return tooLarge('xlsx')
    return damaged('xlsx')
  }
  const sheetsAll = loaded.wb.worksheets
  if (!sheetsAll.length) return refused('This workbook has no sheets to read.')
  const notes: string[] = []
  const sheets = sheetsAll.slice(0, SHEETS_LISTED_MAX).map(sheetInfo)
  if (sheetsAll.length > SHEETS_LISTED_MAX) notes.push(`The workbook has ${num(sheetsAll.length)} sheets; the first ${SHEETS_LISTED_MAX} are listed.`)

  let ws: ExcelJS.Worksheet | undefined
  if (window.sheet === undefined) ws = sheetsAll[0]
  else {
    const want = window.sheet
    ws = sheetsAll.find((s) => s.name === want) ?? sheetsAll.find((s) => s.name.toLowerCase() === want.toLowerCase())
    if (!ws) {
      const list = sheetsAll.slice(0, SHEET_NAMES_IN_REFUSAL).map((s) => `"${s.name}"`).join(', ')
      const more = sheetsAll.length > SHEET_NAMES_IN_REFUSAL ? ` and ${sheetsAll.length - SHEET_NAMES_IN_REFUSAL} more` : ''
      return refused(`This workbook has no sheet named "${want}". Its sheets are: ${list}${more}.`)
    }
  }
  if (sheetsAll.length > 1 && window.sheet === undefined) notes.push(`The workbook has ${sheetsAll.length} sheets; this is the first. Use sheet to read another.`)

  const total = ws.rowCount
  const sheetCols = ws.columnCount
  const startRow = intIn(window.startRow, 1, 1, Number.MAX_SAFE_INTEGER)
  const rowsWanted = window.rows === undefined ? READ_DOCUMENT_ROWS_DEFAULT : intIn(window.rows, READ_DOCUMENT_ROWS_DEFAULT, 1, Number.MAX_SAFE_INTEGER)
  const rowsCount = Math.min(rowsWanted, READ_DOCUMENT_ROWS_MAX)
  if (rowsWanted > READ_DOCUMENT_ROWS_MAX) notes.push(`rows was reduced to ${num(READ_DOCUMENT_ROWS_MAX)}, the most one call returns.`)
  const startCol = intIn(window.startColumn, 1, 1, Number.MAX_SAFE_INTEGER)
  const colsWanted = window.columns === undefined ? READ_DOCUMENT_COLUMNS_MAX : intIn(window.columns, READ_DOCUMENT_COLUMNS_MAX, 1, Number.MAX_SAFE_INTEGER)
  const colsCount = Math.min(colsWanted, READ_DOCUMENT_COLUMNS_MAX)
  if (colsWanted > READ_DOCUMENT_COLUMNS_MAX) notes.push(`columns was reduced to ${READ_DOCUMENT_COLUMNS_MAX}, the most one call returns.`)

  if (total === 0) {
    notes.push(`Sheet "${ws.name}" is empty.`)
    return { format: 'xlsx', text: '', truncated: false, notes, sheets }
  }
  if (startRow > total) return refused(`Sheet "${ws.name}" has only ${num(total)} rows, so startRow ${num(startRow)} is past the end.`)

  const lastCol = Math.min(startCol + colsCount - 1, Math.max(sheetCols, startCol))
  const colIdx: number[] = []
  for (let c = startCol; c <= lastCol; c++) colIdx.push(c)
  const header = ['row', ...colIdx.map(colLetter)].join('\t')
  const lines: string[] = [header]
  let bytes = Buffer.byteLength(header, 'utf8') + 1
  const budget = { left: Number.MAX_SAFE_INTEGER }
  const endRow = Math.min(total, startRow + rowsCount - 1)
  let shownTo = startRow - 1
  let byteStop = false
  for (let r = startRow; r <= endRow; r++) {
    const cells = new Map<number, string>()
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell: ExcelJS.Cell, col: number) => {
      if (col < startCol || col > lastCol) return
      cells.set(col, cellString(cell.value, budget))
    })
    let line = `${r}\t${colIdx.map((c) => cells.get(c) ?? '').join('\t')}`
    let lineBytes = Buffer.byteLength(line, 'utf8') + 1
    if (bytes + lineBytes > READ_DOCUMENT_MAX_BYTES) {
      if (r === startRow) {
        // one row alone is over the limit: show what fits of it
        const cut = cutUtf8(line, READ_DOCUMENT_MAX_BYTES - bytes - 1)
        line = cut.text
        lineBytes = Buffer.byteLength(line, 'utf8') + 1
        notes.push(`Row ${num(r)} was cut at the ${READ_DOCUMENT_MAX_BYTES / 1024} KB size limit; read fewer columns with columns and startColumn.`)
        lines.push(line)
        bytes += lineBytes
        shownTo = r
      }
      byteStop = true
      break
    }
    lines.push(line)
    bytes += lineBytes
    shownTo = r
  }
  const moreRows = shownTo < total
  const rowNote = `Sheet "${ws.name}": rows ${num(startRow)} to ${num(shownTo)} of ${num(total)} shown.`
  if (shownTo >= startRow) notes.push(moreRows && !byteStop ? `${rowNote} Next: startRow ${num(shownTo + 1)}.` : rowNote)
  if (byteStop) notes.push(`Stopped after row ${num(shownTo)} to stay under the ${READ_DOCUMENT_MAX_BYTES / 1024} KB size limit. Next: startRow ${num(shownTo + 1)}.`)
  const moreCols = sheetCols > lastCol
  if (moreCols) notes.push(`Columns ${colLetter(startCol)} to ${colLetter(lastCol)} of ${num(sheetCols)} shown; more with startColumn ${lastCol + 1}.`)
  else if (startCol > 1) notes.push(`Columns ${colLetter(startCol)} to ${colLetter(lastCol)} of ${num(sheetCols)} shown.`)
  return { format: 'xlsx', text: lines.join('\n'), truncated: moreRows || moreCols, notes, sheets }
}

// ---------- docx / pptx ----------

/** `text` split into parts of at most READ_DOCUMENT_MAX_BYTES on UTF-8 boundaries; the chosen part and the count. */
function partOf(text: string, window: DocumentWindow): { text: string; part: number; parts: number } | { refused: string } {
  const b = Buffer.from(text, 'utf8')
  const bounds: Array<[number, number]> = []
  for (let s = 0; s < b.length; ) {
    let e = Math.min(s + READ_DOCUMENT_MAX_BYTES, b.length)
    if (e < b.length) {
      const cut = utf8End(b, e)
      if (cut > s) e = cut
    }
    bounds.push([s, e])
    s = e
  }
  if (!bounds.length) bounds.push([0, 0])
  const want = intIn(window.part, 1, 1, Number.MAX_SAFE_INTEGER)
  if (want > bounds.length) return { refused: `This file has ${bounds.length} part${bounds.length === 1 ? '' : 's'}, so part ${num(want)} is past the end.` }
  const [s, e] = bounds[want - 1]
  return { text: b.toString('utf8', s, e), part: want, parts: bounds.length }
}

function partNotes(part: number, parts: number): string[] {
  if (parts <= 1) return []
  return [part < parts ? `Part ${part} of ${parts}; next: part ${part + 1}.` : `Part ${part} of ${parts}.`]
}

async function docxText(buf: Buffer, window: DocumentWindow): Promise<DocumentText> {
  const p = await previewDocxBuffer(buf)
  if (p.kind === 'none') {
    if (p.reason === 'This document has no text to show.') return { format: 'docx', text: '', truncated: false, notes: ['The document has no text.'] }
    return fromPreviewReason('docx', p.reason)
  }
  if (p.kind !== 'document') return damaged('docx')
  const cut = partOf(blocksToMarkdown(p.blocks), window)
  if ('refused' in cut) return cut
  const notes = partNotes(cut.part, cut.parts)
  if (p.truncated) notes.push('The document is longer than OrgAI reads, so its end is not included.')
  return { format: 'docx', text: cut.text, truncated: !!p.truncated || cut.part < cut.parts, notes }
}

async function pptxText(buf: Buffer, window: DocumentWindow): Promise<DocumentText> {
  const p = await previewPptxBuffer(buf)
  if (p.kind === 'none') {
    if (p.reason === 'This deck has no slides to show.') return { format: 'pptx', text: '', truncated: false, notes: ['The deck has no slides.'] }
    return fromPreviewReason('pptx', p.reason)
  }
  if (p.kind !== 'slides') return damaged('pptx')
  const cut = partOf(p.slides.map(slideText).join('\n\n'), window)
  if ('refused' in cut) return cut
  const notes = partNotes(cut.part, cut.parts)
  if (p.truncatedSlides) notes.push(`${num(p.truncatedSlides)} more slide${p.truncatedSlides === 1 ? '' : 's'} past OrgAI's limit are not included.`)
  return { format: 'pptx', text: cut.text, truncated: !!p.truncatedSlides || cut.part < cut.parts, notes }
}

// ---------- compound (OLE2) files ----------

const utf16 = (s: string): Buffer => Buffer.from(s, 'utf16le')

function cfbRefusal(buf: Buffer): DocumentText {
  const has = (s: string): boolean => buf.includes(utf16(s))
  const convert = 'OrgAI reads only the newer formats'
  if (has('EncryptedPackage') || has('EncryptionInfo')) {
    return refused('This is a password-protected Office file, which OrgAI cannot open. Ask the user for an unprotected copy or an export (.docx, .xlsx, .pptx or CSV).')
  }
  if (has('Workbook') || has('Book')) {
    return refused(`This is a legacy .xls workbook (Excel 97 to 2003). ${convert}; ask the user to save it as .xlsx or export a CSV.`)
  }
  if (has('WordDocument')) return refused(`This is a legacy .doc document (Word 97 to 2003). ${convert}; ask the user to save it as .docx or export a .txt.`)
  if (has('PowerPoint Document')) return refused(`This is a legacy .ppt presentation (PowerPoint 97 to 2003). ${convert}; ask the user to save it as .pptx or export the text.`)
  if (has('__substg1.0_')) return refused('This is an Outlook .msg message, which OrgAI cannot read. Ask the user to paste the message text or export it as a text file.')
  return refused(`This is an older Office or other compound file that OrgAI cannot read. ${convert}; ask the user to save it as .xlsx, .docx or .pptx, or export a CSV or text copy.`)
}

// ---------- text ----------

function textOf(buf: Buffer, encoding: 'utf8' | 'utf16le' | 'utf16be', fileSize: number): DocumentText {
  let decoded: string
  if (encoding === 'utf8') {
    const start = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0
    // a read cut inside a multi-byte sequence loses that partial tail
    const end = buf.length < fileSize ? utf8End(buf, buf.length) : buf.length
    decoded = buf.toString('utf8', start, end)
  } else {
    const even = buf.length - (buf.length % 2)
    let body = buf.subarray(2, even)
    if (encoding === 'utf16be') body = Buffer.from(body).swap16()
    decoded = body.toString('utf16le')
    // a lone high surrogate at the read's end is half a character
    if (buf.length < fileSize && /[\ud800-\udbff]$/.test(decoded)) decoded = decoded.slice(0, -1)
  }
  const cut = cutUtf8(decoded, READ_DOCUMENT_MAX_BYTES)
  const unreadFile = buf.length < fileSize
  const truncated = cut.cut || unreadFile
  const notes: string[] = []
  if (truncated) {
    const shown = Buffer.byteLength(cut.text, 'utf8')
    notes.push(
      `Showing the first ${num(shown)} bytes of text from a file of ${num(fileSize)} bytes. Your own Read tool can page through text files.`
    )
  }
  return { format: 'text', text: cut.text, truncated, notes }
}
