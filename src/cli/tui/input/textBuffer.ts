/**
 * The Composer's multi-line text buffer (W4-T4). Pure and immutable: every edit returns a new buffer. The cursor is a
 * code-unit offset into `text` that always sits on a grapheme boundary; moves and deletes step by grapheme, so an
 * emoji or a combined character is one step. Readline-style edits: Ctrl+A / Ctrl+E (line start / end), Ctrl+U (kill to
 * line start), Ctrl+K (kill to line end), Ctrl+W (kill the previous whitespace-delimited word).
 */

export interface TextBuffer {
  readonly text: string
  readonly cursor: number
}

export const EMPTY_BUFFER: TextBuffer = { text: '', cursor: 0 }

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (g) => g.segment)
}

function prevBoundary(text: string, at: number): number {
  if (at <= 0) return 0
  // Segment only the current line's head: lines never join graphemes across '\n'.
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  if (lineStart === at) return at - 1
  const parts = graphemes(text.slice(lineStart, at))
  return at - (parts[parts.length - 1]?.length ?? 1)
}

function nextBoundary(text: string, at: number): number {
  if (at >= text.length) return text.length
  if (text[at] === '\n') return at + 1
  let lineEnd = text.indexOf('\n', at)
  if (lineEnd < 0) lineEnd = text.length
  const first = segmenter.segment(text.slice(at, lineEnd))[Symbol.iterator]().next()
  return at + (first.done ? 1 : first.value.segment.length)
}

const lineStartOf = (text: string, at: number): number => text.lastIndexOf('\n', at - 1) + 1
function lineEndOf(text: string, at: number): number {
  const i = text.indexOf('\n', at)
  return i < 0 ? text.length : i
}

const clampCursor = (b: TextBuffer): number => Math.max(0, Math.min(b.text.length, b.cursor))

export function insertText(b: TextBuffer, s: string): TextBuffer {
  if (!s) return b
  const c = clampCursor(b)
  return { text: b.text.slice(0, c) + s + b.text.slice(c), cursor: c + s.length }
}

export function backspace(b: TextBuffer): TextBuffer {
  const c = clampCursor(b)
  if (c === 0) return b
  const p = prevBoundary(b.text, c)
  return { text: b.text.slice(0, p) + b.text.slice(c), cursor: p }
}

export function deleteForward(b: TextBuffer): TextBuffer {
  const c = clampCursor(b)
  if (c >= b.text.length) return b
  const n = nextBoundary(b.text, c)
  return { text: b.text.slice(0, c) + b.text.slice(n), cursor: c }
}

export const moveLeft = (b: TextBuffer): TextBuffer => ({ text: b.text, cursor: prevBoundary(b.text, clampCursor(b)) })
export const moveRight = (b: TextBuffer): TextBuffer => ({ text: b.text, cursor: nextBoundary(b.text, clampCursor(b)) })
export const lineHome = (b: TextBuffer): TextBuffer => ({ text: b.text, cursor: lineStartOf(b.text, clampCursor(b)) })
export const lineEnd = (b: TextBuffer): TextBuffer => ({ text: b.text, cursor: lineEndOf(b.text, clampCursor(b)) })

/** The cursor's line and column (in graphemes). */
export function cursorPosition(b: TextBuffer): { line: number; col: number } {
  const c = clampCursor(b)
  const before = b.text.slice(0, c)
  const line = before.split('\n').length - 1
  const start = lineStartOf(b.text, c)
  return { line, col: graphemes(b.text.slice(start, c)).length }
}

function offsetAt(text: string, line: number, col: number): number {
  const lines = text.split('\n')
  let off = 0
  for (let i = 0; i < line; i++) off += lines[i].length + 1
  const parts = graphemes(lines[line] ?? '')
  for (let i = 0; i < Math.min(col, parts.length); i++) off += parts[i].length
  return off
}

/** Up one line keeping the column; on the first line, false (the caller may use Up for something else). */
export function moveUp(b: TextBuffer): TextBuffer | null {
  const { line, col } = cursorPosition(b)
  if (line === 0) return null
  return { text: b.text, cursor: offsetAt(b.text, line - 1, col) }
}

export function moveDown(b: TextBuffer): TextBuffer | null {
  const { line, col } = cursorPosition(b)
  if (line >= b.text.split('\n').length - 1) return null
  return { text: b.text, cursor: offsetAt(b.text, line + 1, col) }
}

/** Alt+B: to the start of the previous word (whitespace-delimited; crosses line breaks). */
export function wordLeft(b: TextBuffer): TextBuffer {
  const c = clampCursor(b)
  let i = c
  while (i > 0 && /\s/.test(b.text[i - 1])) i--
  while (i > 0 && !/\s/.test(b.text[i - 1])) i--
  return { text: b.text, cursor: i }
}

/** Alt+F: to the end of the next word (whitespace-delimited; crosses line breaks). */
export function wordRight(b: TextBuffer): TextBuffer {
  const c = clampCursor(b)
  let i = c
  while (i < b.text.length && /\s/.test(b.text[i])) i++
  while (i < b.text.length && !/\s/.test(b.text[i])) i++
  return { text: b.text, cursor: i }
}

/** Ctrl+U: delete from the line start to the cursor. */
export function killToLineStart(b: TextBuffer): TextBuffer {
  const c = clampCursor(b)
  const s = lineStartOf(b.text, c)
  return { text: b.text.slice(0, s) + b.text.slice(c), cursor: s }
}

/** Ctrl+K: delete from the cursor to the line end. */
export function killToLineEnd(b: TextBuffer): TextBuffer {
  const c = clampCursor(b)
  const e = lineEndOf(b.text, c)
  return { text: b.text.slice(0, c) + b.text.slice(e), cursor: c }
}

/** Ctrl+W: delete the whitespace-delimited word before the cursor (and the spaces after it), within the line. */
export function killWordBack(b: TextBuffer): TextBuffer {
  const c = clampCursor(b)
  const s = lineStartOf(b.text, c)
  let i = c
  while (i > s && (b.text[i - 1] === ' ' || b.text[i - 1] === '\t')) i--
  while (i > s && b.text[i - 1] !== ' ' && b.text[i - 1] !== '\t') i--
  return { text: b.text.slice(0, i) + b.text.slice(c), cursor: i }
}

// ---------- Display ----------

const WIDE = /[\p{Extended_Pictographic}ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u
const ZERO = /^[\p{Mn}\p{Me}‌‍️]+$/u

/** Terminal columns of one grapheme (0, 1 or 2; an approximation of wcwidth). */
export function graphemeWidth(g: string): number {
  if (g === '') return 0
  if (ZERO.test(g)) return 0
  const cp = g.codePointAt(0) ?? 0
  if (cp < 0x20) return 0
  if (WIDE.test(g)) return 2
  return 1
}

/** One visual row: its graphemes and where the cursor sits on it (the cursor's grapheme index, or undefined). */
export interface VisualRow {
  cells: string[]
  /** Cursor before cells[cursorAt]; equal to cells.length = after the last cell. */
  cursorAt?: number
}

/** Wraps the buffer to `width` columns (hard lines first, then by width); exactly one row carries the cursor. */
export function wrapBuffer(b: TextBuffer, width: number): VisualRow[] {
  const w = Math.max(1, Math.floor(width))
  const c = clampCursor(b)
  const rows: VisualRow[] = []
  let off = 0
  for (const line of b.text.split('\n')) {
    let row: VisualRow = { cells: [] }
    let used = 0
    const lineStart = off
    if (c === lineStart) row.cursorAt = 0
    for (const g of graphemes(line)) {
      const gw = graphemeWidth(g)
      // Wrap before a cell that does not fit; the cursor stays with the cell it precedes.
      if (used + gw > w && row.cells.length > 0) {
        const atStart = row.cursorAt === row.cells.length
        if (atStart) delete row.cursorAt
        rows.push(row)
        row = { cells: [] }
        used = 0
        if (atStart) row.cursorAt = 0
      }
      row.cells.push(g)
      used += gw
      off += g.length
      if (c === off) row.cursorAt = row.cells.length
    }
    // A cursor at the end of a full row moves to a fresh row only when the row has no room left.
    if (row.cursorAt === row.cells.length && used >= w && row.cells.length > 0) {
      delete row.cursorAt
      rows.push(row)
      row = { cells: [], cursorAt: 0 }
    }
    rows.push(row)
    off += 1 // the '\n'
  }
  return rows
}
