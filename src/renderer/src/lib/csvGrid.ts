// The CSV cell grid's pure model (docs/design/outputs-2.md section 9, "CSV cell grid"): RFC 4180 parse and serialize, the
// rules for when the grid is not offered, row / column edits, a bounded undo stack and cell names. No React, no DOM.

export const CSV_GRID_MAX_ROWS = 5000
export const CSV_GRID_MAX_COLS = 64
/** The share of rows with a different cell count above which the file is better edited as text. */
export const CSV_RAGGED_SHARE = 0.1
export const CSV_UNDO_STEPS = 100
/** Shown in place of the grid when it is not offered. */
export const CSV_AS_TEXT_LINE = 'This file is better edited as text.'
export const CSV_FORMULA_NOTE = 'Some cells start with = and are saved as text. OrgAI does not calculate formulas.'

export type Eol = '\r\n' | '\n'

export interface CsvModel {
  /** Rectangular: every row has `cols` cells. */
  rows: string[][]
  eol: Eol
  /** The text ended with a line break. */
  trailingNewline: boolean
}

export type CsvParse = { ok: true; model: CsvModel } | { ok: false; reason: 'delimiter' | 'quotes' | 'mixed-endings' | 'too-big' | 'ragged' }

/** Rows of fields, or a reason the quoting cannot be followed. Only a comma separates fields. */
function scan(text: string): { rows: string[][]; crlf: number; lf: number; trailing: boolean } | 'quotes' {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let i = 0
  let crlf = 0
  let lf = 0
  let atFieldStart = true
  let trailing = false
  const n = text.length
  const endRow = (): void => {
    row.push(field)
    rows.push(row)
    row = []
    field = ''
    atFieldStart = true
  }
  while (i < n) {
    const ch = text[i]
    if (atFieldStart && ch === '"') {
      i++
      let closed = false
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            field += '"'
            i += 2
            continue
          }
          i++
          closed = true
          break
        }
        field += text[i]
        i++
      }
      if (!closed) return 'quotes'
      // Only a comma, a line break or the end may follow a closing quote.
      const next = text[i]
      if (i < n && next !== ',' && next !== '\n' && next !== '\r') return 'quotes'
      atFieldStart = false
      continue
    }
    if (ch === '"') return 'quotes'
    if (ch === ',') {
      row.push(field)
      field = ''
      atFieldStart = true
      i++
      continue
    }
    if (ch === '\r') {
      if (text[i + 1] !== '\n') return 'quotes'
      crlf++
      i += 2
      endRow()
      if (i >= n) trailing = true
      continue
    }
    if (ch === '\n') {
      lf++
      i++
      endRow()
      if (i >= n) trailing = true
      continue
    }
    field += ch
    atFieldStart = false
    i++
  }
  if (!trailing) endRow()
  return { rows, crlf, lf, trailing }
}

/** Parses a CSV text for the grid, or says why the grid is not offered. */
export function parseCsv(text: string): CsvParse {
  const first = text.split(/\r?\n/, 1)[0] ?? ''
  if (!first.includes(',') && (first.includes(';') || first.includes('\t') || first.includes('|'))) return { ok: false, reason: 'delimiter' }
  const s = scan(text)
  if (s === 'quotes') return { ok: false, reason: 'quotes' }
  if (s.crlf > 0 && s.lf > 0) return { ok: false, reason: 'mixed-endings' }
  const rows = s.rows.length === 0 ? [['']] : s.rows
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0)
  if (rows.length > CSV_GRID_MAX_ROWS || cols > CSV_GRID_MAX_COLS) return { ok: false, reason: 'too-big' }
  const common = mostCommonLength(rows)
  const off = rows.filter((r) => r.length !== common).length
  if (rows.length > 0 && off / rows.length > CSV_RAGGED_SHARE) return { ok: false, reason: 'ragged' }
  const padded = rows.map((r) => (r.length === cols ? r : [...r, ...Array<string>(cols - r.length).fill('')]))
  return { ok: true, model: { rows: padded, eol: s.crlf > 0 ? '\r\n' : '\n', trailingNewline: s.trailing } }
}

function mostCommonLength(rows: string[][]): number {
  const counts = new Map<number, number>()
  for (const r of rows) counts.set(r.length, (counts.get(r.length) ?? 0) + 1)
  let best = 0
  let bestN = -1
  for (const [len, n] of counts) {
    if (n > bestN) {
      best = len
      bestN = n
    }
  }
  return best
}

/** One field, quoted when it holds a comma, quote, CR or LF, or edge whitespace-free empty ambiguity. */
export function quoteField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** The text of a model: RFC 4180 quoting, its own line ending and trailing newline. A cell is written as typed. */
export function serializeCsv(model: CsvModel): string {
  const body = model.rows.map((r) => r.map(quoteField).join(',')).join(model.eol)
  // A lone empty cell would read back as an empty file; one empty row needs its quotes only when more follow.
  return model.trailingNewline && model.rows.length > 0 ? body + model.eol : body
}

/** True when any cell starts with `=` (the note line says it is saved as text). */
export function hasFormulaCells(model: CsvModel): boolean {
  return model.rows.some((r) => r.some((c) => c.startsWith('=')))
}

/** The not-offered reasons in plain words (the line under "Edit as text"). */
export function notOfferedLine(reason: Extract<CsvParse, { ok: false }>['reason']): string {
  switch (reason) {
    case 'too-big':
      return `This file has more than ${CSV_GRID_MAX_ROWS.toLocaleString('en-US')} rows or ${CSV_GRID_MAX_COLS} columns. ${CSV_AS_TEXT_LINE}`
    case 'delimiter':
      return `This file does not use commas. ${CSV_AS_TEXT_LINE}`
    default:
      return CSV_AS_TEXT_LINE
  }
}

// ---- cell names ----

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
export function columnName(c: number): string {
  let n = Math.max(0, Math.floor(c)) + 1
  let out = ''
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

export function cellName(r: number, c: number): string {
  return `${columnName(c)}${r + 1}`
}

export interface CellRange {
  r1: number
  c1: number
  r2: number
  c2: number
}

/** Ordered corners (anchor and focus in either direction). */
export function normalizeRange(a: { r: number; c: number }, b: { r: number; c: number }): CellRange {
  return { r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) }
}

/** "B2" for one cell, "B2:C4" for a range. */
export function rangeName(r: CellRange): string {
  return r.r1 === r.r2 && r.c1 === r.c2 ? cellName(r.r1, r.c1) : `${cellName(r.r1, r.c1)}:${cellName(r.r2, r.c2)}`
}

export function describeRange(r: CellRange): string {
  return r.r1 === r.r2 && r.c1 === r.c2 ? `Cell ${rangeName(r)}` : `Cells ${rangeName(r)}`
}

// ---- edits (pure; each returns new rows) ----

export function setCell(rows: string[][], r: number, c: number, value: string): string[][] {
  if (rows[r]?.[c] === undefined || rows[r][c] === value) return rows
  return rows.map((row, i) => (i === r ? row.map((v, j) => (j === c ? value : v)) : row))
}

/** A blank row inserted at index `at` (0..length). Null when over the row limit. */
export function addRowAt(rows: string[][], at: number): string[][] | null {
  if (rows.length >= CSV_GRID_MAX_ROWS) return null
  const cols = rows[0]?.length ?? 1
  const i = Math.max(0, Math.min(rows.length, at))
  return [...rows.slice(0, i), Array<string>(cols).fill(''), ...rows.slice(i)]
}

export function addColAt(rows: string[][], at: number): string[][] | null {
  const cols = rows[0]?.length ?? 1
  if (cols >= CSV_GRID_MAX_COLS) return null
  const i = Math.max(0, Math.min(cols, at))
  return rows.map((r) => [...r.slice(0, i), '', ...r.slice(i)])
}

/** Null when it would leave no rows. */
export function deleteRowAt(rows: string[][], at: number): string[][] | null {
  if (rows.length <= 1 || at < 0 || at >= rows.length) return null
  return rows.filter((_, i) => i !== at)
}

export function deleteColAt(rows: string[][], at: number): string[][] | null {
  const cols = rows[0]?.length ?? 1
  if (cols <= 1 || at < 0 || at >= cols) return null
  return rows.map((r) => r.filter((_, i) => i !== at))
}

// ---- undo ----

export interface UndoStack<T> {
  past: T[]
  present: T
  future: T[]
}

export function undoStart<T>(present: T): UndoStack<T> {
  return { past: [], present, future: [] }
}

/** A new present; the old one joins the past (the oldest step drops past `limit`). Same value: no change. */
export function undoPush<T>(s: UndoStack<T>, next: T, limit = CSV_UNDO_STEPS): UndoStack<T> {
  if (Object.is(next, s.present)) return s
  const past = [...s.past, s.present]
  return { past: past.length > limit ? past.slice(past.length - limit) : past, present: next, future: [] }
}

export function undoBack<T>(s: UndoStack<T>): UndoStack<T> {
  if (s.past.length === 0) return s
  return { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present, ...s.future] }
}

export function undoForward<T>(s: UndoStack<T>): UndoStack<T> {
  if (s.future.length === 0) return s
  return { past: [...s.past, s.present], present: s.future[0], future: s.future.slice(1) }
}
