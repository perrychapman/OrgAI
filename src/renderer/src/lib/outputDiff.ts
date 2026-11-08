// Pure view models over main's OutputDiff (docs/design/outputs-2.md 12.2). No React, no DOM. The UI says "Changes", never "diff".
import type { DocumentBlock, DocumentRun, OutputDiff, OutputDiffCellChange, OutputDiffMark, SheetCell } from '@shared/types'

type Cells = Extract<OutputDiff, { kind: 'cells' }>
type CellSheet = Cells['sheets'][number]
type BlocksRows = Extract<OutputDiff, { kind: 'blocks' }>['rows']

// ---------- wording ----------

const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many)

/** "12 lines added, 4 removed, 3 changed": zero parts are left out, the noun rides on the first part. */
export function joinParts(parts: { n: number; noun: [string, string]; verb: string }[], everyNoun = false): string {
  const live = parts.filter((p) => p.n > 0)
  return live.map((p, i) => (i === 0 || everyNoun ? `${p.n} ${plural(p.n, p.noun[0], p.noun[1])} ${p.verb}` : `${p.n} ${p.verb}`)).join(', ')
}

export const NO_CHANGES = 'These versions have no changes between them.'

/** Pairs of a hunk's lines: a run of removed lines followed by added lines pairs line i with line i (as main does). */
export function changedLineCount(diff: Extract<OutputDiff, { kind: 'text' }>): number {
  let pairs = 0
  for (const h of diff.hunks) {
    const ls = h.lines
    let i = 0
    while (i < ls.length) {
      if (ls[i].op !== 'del') {
        i++
        continue
      }
      let d = i
      while (d < ls.length && ls[d].op === 'del') d++
      let a = d
      while (a < ls.length && ls[a].op === 'add') a++
      pairs += Math.min(d - i, a - d)
      i = Math.max(a, d)
    }
  }
  return pairs
}

/** The sentence spoken once when a comparison is ready. 'none' and 'slides' answer ''. */
export function summarySentence(diff: OutputDiff): string {
  switch (diff.kind) {
    case 'text': {
      const changed = changedLineCount(diff)
      const added = Math.max(0, diff.added - changed)
      const removed = Math.max(0, diff.removed - changed)
      const s = joinParts([
        { n: added, noun: ['line', 'lines'], verb: 'added' },
        { n: removed, noun: ['line', 'lines'], verb: 'removed' },
        { n: changed, noun: ['line', 'lines'], verb: 'changed' }
      ])
      return s ? `${s}${diff.truncated ? '. More changes are not shown' : ''}` : NO_CHANGES
    }
    case 'blocks': {
      const n = (op: string): number => diff.rows.filter((r) => r.op === op).length
      const s = joinParts([
        { n: n('add'), noun: ['paragraph', 'paragraphs'], verb: 'added' },
        { n: n('del'), noun: ['paragraph', 'paragraphs'], verb: 'removed' },
        { n: n('chg'), noun: ['paragraph', 'paragraphs'], verb: 'changed' }
      ])
      return s ? `${s}${diff.truncated ? '. More changes are not shown' : ''}` : NO_CHANGES
    }
    case 'cells': {
      let cells = 0
      let rowsAdded = 0
      let rowsRemoved = 0
      let sheetsAdded = 0
      let sheetsRemoved = 0
      let truncated = false
      for (const s of diff.sheets) {
        cells += s.changes.length
        for (const r of s.rowOps) {
          if (r.op === 'add') rowsAdded++
          else rowsRemoved++
        }
        if (s.status === 'added') sheetsAdded++
        if (s.status === 'removed') sheetsRemoved++
        if (s.truncated) truncated = true
      }
      const s = joinParts([
        { n: cells, noun: ['cell', 'cells'], verb: 'changed' },
        { n: rowsAdded, noun: ['row', 'rows'], verb: 'added' },
        { n: rowsRemoved, noun: ['row', 'rows'], verb: 'removed' },
        { n: sheetsAdded, noun: ['sheet', 'sheets'], verb: 'added' },
        { n: sheetsRemoved, noun: ['sheet', 'sheets'], verb: 'removed' }
      ], true)
      return s ? `${s}${truncated ? '. More changes are not shown' : ''}` : NO_CHANGES
    }
    default:
      return ''
  }
}

/** How a sheet's status reads on its tab. */
export function sheetStatusWord(s: CellSheet): string {
  if (s.status === 'added') return 'new'
  if (s.status === 'removed') return 'removed'
  if (s.status === 'changed') return 'changed'
  return ''
}

// ---------- marks ----------

export interface Segment {
  text: string
  marked: boolean
}

/** Splits `text` at the marked spans ([start, end) UTF-16 offsets). Out-of-range, reversed and overlapping marks are repaired. */
export function segmentsOf(text: string, marks: readonly OutputDiffMark[] | undefined): Segment[] {
  if (!marks || marks.length === 0) return text ? [{ text, marked: false }] : []
  const spans = marks
    .map(([s, e]) => [Math.max(0, Math.min(text.length, s)), Math.max(0, Math.min(text.length, e))] as const)
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0])
  const out: Segment[] = []
  let at = 0
  for (const [s, e] of spans) {
    const from = Math.max(s, at)
    if (e <= from) continue
    if (from > at) out.push({ text: text.slice(at, from), marked: false })
    out.push({ text: text.slice(from, e), marked: true })
    at = e
  }
  if (at < text.length) out.push({ text: text.slice(at), marked: false })
  return out
}

// ---------- text ----------

export type TextRow =
  | { kind: 'line'; op: 'eq' | 'add' | 'del'; a?: number; b?: number; text: string; marks?: OutputDiffMark[]; change?: number; first?: boolean }
  | { kind: 'gap'; id: string; count: number; aFrom: number; bFrom: number; known: boolean }

/** The lines of a text the way main splits them (CRLF, LF, CR; no trailing empty line). */
export function linesOf(text: string): string[] {
  if (!text) return []
  const l = text.split(/\r\n|\n|\r/)
  if (l.length && l[l.length - 1] === '') l.pop()
  return l
}

/** The unchanged lines the hunks leave out, as gaps (known = their text can be shown from `bLines`). */
export function textRows(diff: Extract<OutputDiff, { kind: 'text' }>, bLines: readonly string[] | null, expanded: ReadonlySet<string>): TextRow[] {
  const rows: TextRow[] = []
  let change = -1
  let inChange = false
  let aNext = 1
  let bNext = 1
  const gap = (aFrom: number, bFrom: number, count: number): void => {
    if (count <= 0) return
    const id = `g${aFrom}-${bFrom}`
    const known = bLines !== null && bFrom - 1 + count <= bLines.length
    if (expanded.has(id) && known) {
      for (let i = 0; i < count; i++) rows.push({ kind: 'line', op: 'eq', a: aFrom + i, b: bFrom + i, text: bLines![bFrom - 1 + i] })
    } else rows.push({ kind: 'gap', id, count, aFrom, bFrom, known })
    inChange = false
  }
  for (const h of diff.hunks) {
    gap(aNext, bNext, h.bStart - bNext)
    for (const l of h.lines) {
      const changed = l.op !== 'eq'
      let first = false
      if (changed && !inChange) {
        change++
        first = true
      }
      inChange = changed
      rows.push({ kind: 'line', op: l.op, a: l.a, b: l.b, text: l.text, marks: l.marks, change: changed ? change : undefined, first: first || undefined })
    }
    aNext = h.aStart + h.aCount
    bNext = h.bStart + h.bCount
  }
  if (bLines && !diff.truncated) gap(aNext, bNext, bLines.length + 1 - bNext)
  return rows
}

/** Row indexes where each change (a run of added / removed lines) begins, in order. */
export function changeStarts(rows: readonly { kind: string; first?: boolean }[]): number[] {
  const out: number[] = []
  rows.forEach((r, i) => {
    if (r.kind === 'line' && r.first) out.push(i)
  })
  return out
}

/** The next change after `current` (-1 = none yet), wrapping; `dir` 1 or -1. Null when there are none. */
export function stepChange(count: number, current: number, dir: 1 | -1): number | null {
  if (count <= 0) return null
  if (current < 0) return dir === 1 ? 0 : count - 1
  return (current + dir + count) % count
}

export type SideCell = { n: number; text: string; marks?: OutputDiffMark[]; op: 'eq' | 'add' | 'del' }
export type SideRow = { kind: 'pair'; left?: SideCell; right?: SideCell; change?: number; first?: boolean } | { kind: 'gap'; id: string; count: number; known: boolean; aFrom: number; bFrom: number }

/** Side-by-side rows: equal lines on both sides, a run of removed lines paired with the added lines after it by index. */
export function sideRows(rows: readonly TextRow[]): SideRow[] {
  const out: SideRow[] = []
  let i = 0
  while (i < rows.length) {
    const r = rows[i]
    if (r.kind === 'gap') {
      out.push(r)
      i++
      continue
    }
    if (r.op === 'eq') {
      out.push({ kind: 'pair', left: { n: r.a ?? 0, text: r.text, op: 'eq' }, right: { n: r.b ?? 0, text: r.text, op: 'eq' } })
      i++
      continue
    }
    const dels: Extract<TextRow, { kind: 'line' }>[] = []
    const adds: Extract<TextRow, { kind: 'line' }>[] = []
    while (i < rows.length) {
      const x = rows[i]
      if (x.kind !== 'line' || x.op === 'eq') break
      if (x.op === 'del') {
        if (adds.length) break
        dels.push(x)
      } else adds.push(x)
      i++
    }
    const n = Math.max(dels.length, adds.length)
    for (let k = 0; k < n; k++) {
      const d = dels[k]
      const a = adds[k]
      const lead = dels[0] ?? adds[0]
      out.push({
        kind: 'pair',
        left: d ? { n: d.a ?? 0, text: d.text, marks: d.marks, op: 'del' } : undefined,
        right: a ? { n: a.b ?? 0, text: a.text, marks: a.marks, op: 'add' } : undefined,
        change: (d ?? a).change,
        first: k === 0 && lead.first ? true : undefined
      })
    }
  }
  return out
}

export function gapText(count: number): string {
  return `${count} unchanged ${plural(count, 'line')}`
}

// ---------- document blocks ----------

const runText = (runs: readonly DocumentRun[]): string => runs.map((r) => r.text).join('')

/** The plain text of one preview block: the string the 'blocks' marks index into. Twin of blockText in src/main/outputs/diff.ts. */
export function blockText(b: DocumentBlock): string {
  switch (b.type) {
    case 'heading':
    case 'paragraph':
      return runText(b.runs)
    case 'list':
      return b.items.map((it) => runText(it)).join('\n')
    case 'table':
      return b.rows.map((r) => r.map((c) => runText(c)).join('\t')).join('\n')
    case 'image':
      return `[image: ${b.alt}]`
    case 'code':
      return b.text
    case 'rule':
      return '---'
    case 'pageBreak':
      return '[page break]'
  }
}

export interface BlockSide {
  index: number
  type: DocumentBlock['type']
  text: string
  /** Heading level, list ordering, table header rows: enough to show the block's shape. */
  level?: number
  ordered?: boolean
  headerRows?: number
}

export type BlockRowView =
  | { kind: 'row'; op: 'eq' | 'add' | 'del' | 'chg'; left?: BlockSide; right?: BlockSide; marksA?: OutputDiffMark[]; marksB?: OutputDiffMark[]; change?: number; first?: boolean }
  | { kind: 'gap'; id: string; from: number; count: number }

const sideOf = (blocks: readonly DocumentBlock[], index: number | undefined): BlockSide | undefined => {
  if (index === undefined) return undefined
  const b = blocks[index]
  if (!b) return undefined
  return { index, type: b.type, text: blockText(b), level: b.type === 'heading' ? b.level : undefined, ordered: b.type === 'list' ? b.ordered : undefined, headerRows: b.type === 'table' ? b.headerRows : undefined }
}

/** Equal runs longer than this collapse to a gap, with one block of context kept beside each change. */
export const BLOCK_COLLAPSE_OVER = 4

export function blockRows(rows: BlocksRows, aBlocks: readonly DocumentBlock[], bBlocks: readonly DocumentBlock[], expanded: ReadonlySet<string>): BlockRowView[] {
  const out: BlockRowView[] = []
  let change = -1
  let prevChanged = false
  const mk = (r: BlocksRows[number]): BlockRowView => {
    const changed = r.op !== 'eq'
    let first = false
    if (changed && !prevChanged) {
      change++
      first = true
    }
    prevChanged = changed
    return { kind: 'row', op: r.op, left: sideOf(aBlocks, r.a), right: sideOf(bBlocks, r.b), marksA: r.marks?.a, marksB: r.marks?.b, change: changed ? change : undefined, first: first || undefined }
  }
  let i = 0
  while (i < rows.length) {
    if (rows[i].op !== 'eq') {
      out.push(mk(rows[i++]))
      continue
    }
    let j = i
    while (j < rows.length && rows[j].op === 'eq') j++
    const run = j - i
    const leadChange = i > 0
    const trailChange = j < rows.length
    const keepHead = leadChange ? 1 : 0
    const keepTail = trailChange ? 1 : 0
    const id = `b${i}`
    if (run > BLOCK_COLLAPSE_OVER && !expanded.has(id)) {
      for (let k = 0; k < keepHead; k++) out.push(mk(rows[i + k]))
      const hidden = run - keepHead - keepTail
      out.push({ kind: 'gap', id, from: i + keepHead, count: hidden })
      prevChanged = false
      for (let k = j - keepTail; k < j; k++) out.push(mk(rows[k]))
    } else for (let k = i; k < j; k++) out.push(mk(rows[k]))
    i = j
  }
  return out
}

export function blockGapText(count: number): string {
  return `${count} unchanged ${plural(count, 'paragraph')}`
}

/** A table block's text as cells with their marks: rows split on "\n", cells on "\t", offsets kept. */
export function tableCells(text: string, marks: readonly OutputDiffMark[] | undefined): Segment[][][] {
  const out: Segment[][][] = []
  let at = 0
  for (const line of text.split('\n')) {
    const row: Segment[][] = []
    let col = at
    for (const cell of line.split('\t')) {
      const local = (marks ?? []).map(([s, e]) => [s - col, e - col] as OutputDiffMark).filter(([s, e]) => e > 0 && s < cell.length)
      row.push(segmentsOf(cell, local))
      col += cell.length + 1
    }
    out.push(row)
    at += line.length + 1
  }
  return out
}

// ---------- cells ----------

export type GridCell = { text: string; op?: 'add' | 'del' | 'chg'; was?: string }
export interface GridRow {
  /** 'eq' rows may still hold changed cells. */
  op: 'eq' | 'add' | 'del'
  /** Row number shown (1-based; B's for kept and added rows, A's for removed ones). */
  n: number
  cells: GridCell[]
  changed: boolean
}

/** A cell value as a reader sees it: numbers with thousands separators, empty as "(empty)" when `empty` is asked for. */
export function valueText(v: string | number | boolean | null | undefined, empty = ''): string {
  if (v === null || v === undefined || v === '') return empty
  if (typeof v === 'number') return Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 10 }) : String(v)
  return String(v)
}

/** "was 1,200, now 1,350" (the tooltip and aria-description of a changed cell). */
export function cellChangeText(ch: Pick<OutputDiffCellChange, 'op' | 'was' | 'now'>): string {
  const was = valueText(ch.was, 'empty')
  const now = valueText(ch.now, 'empty')
  if (ch.op === 'add') return `was empty, now ${now}`
  if (ch.op === 'del') return `was ${was}, now empty`
  return `was ${was}, now ${now}`
}

const cellValue = (c: SheetCell | undefined): string => {
  if (!c) return ''
  const v = valueText(c.v)
  return v === '' && c.f ? `=${c.f}` : v
}

/**
 * The merged grid of one sheet: B's rows in order with the rows removed from A put back where they were. Rows main did not
 * mark pair up in order (kept rows are the same rows in both), so the walk needs only the two row-op lists.
 */
export function mergeGrid(sheet: CellSheet, aRows: readonly (readonly SheetCell[])[], bRows: readonly (readonly SheetCell[])[]): GridRow[] {
  const addRows = new Set(sheet.rowOps.filter((r) => r.op === 'add').map((r) => r.r))
  const delRows = new Set(sheet.rowOps.filter((r) => r.op === 'del').map((r) => r.r))
  const byB = new Map<string, OutputDiffCellChange>()
  const byA = new Map<string, OutputDiffCellChange>()
  for (const ch of sheet.changes) (ch.op === 'del' ? byA : byB).set(`${ch.r},${ch.c}`, ch)
  const out: GridRow[] = []
  let ia = 0
  let ib = 0
  while (ia < aRows.length || ib < bRows.length) {
    if (ia < aRows.length && delRows.has(ia)) {
      out.push({ op: 'del', n: ia + 1, cells: aRows[ia].map((c) => ({ text: cellValue(c), op: 'del' as const })), changed: true })
      ia++
    } else if (ib < bRows.length && addRows.has(ib)) {
      out.push({ op: 'add', n: ib + 1, cells: bRows[ib].map((c) => ({ text: cellValue(c), op: 'add' as const })), changed: true })
      ib++
    } else if (ia < aRows.length && ib < bRows.length) {
      const width = Math.max(aRows[ia].length, bRows[ib].length)
      const cells: GridCell[] = []
      let changed = false
      for (let c = 0; c < width; c++) {
        const hitB = byB.get(`${ib},${c}`)
        const hitA = byA.get(`${ia},${c}`)
        if (hitB) {
          changed = true
          cells.push({ text: cellValue(bRows[ib][c]), op: hitB.op, was: valueText(hitB.was, '') })
        } else if (hitA) {
          changed = true
          cells.push({ text: '', op: 'del', was: valueText(hitA.was, '') })
        } else cells.push({ text: cellValue(bRows[ib][c] ?? aRows[ia][c]) })
      }
      out.push({ op: 'eq', n: ib + 1, cells, changed })
      ia++
      ib++
    } else if (ia < aRows.length) {
      out.push({ op: 'del', n: ia + 1, cells: aRows[ia].map((c) => ({ text: cellValue(c), op: 'del' as const })), changed: true })
      ia++
    } else {
      out.push({ op: 'add', n: ib + 1, cells: bRows[ib].map((c) => ({ text: cellValue(c), op: 'add' as const })), changed: true })
      ib++
    }
  }
  return out
}

/** The rows to draw: only changed ones (plus the first row, usually the header) or all. */
export function visibleGridRows(rows: readonly GridRow[], onlyChanges: boolean): GridRow[] {
  if (!onlyChanges) return [...rows]
  return rows.filter((r, i) => r.changed || i === 0)
}

/** Row indexes (into the visible rows) that hold a change, in order, for Previous / Next change. */
export function gridChangeRows(rows: readonly GridRow[]): number[] {
  const out: number[] = []
  rows.forEach((r, i) => {
    if (r.changed) out.push(i)
  })
  return out
}

const CSV_ROWS_MAX = 500
const CSV_COLS_MAX = 64

/** Lenient RFC 4180 reader, a twin of parseCsv in src/main/outputs/diff.ts (same caps), so row and column indexes line up with the diff. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const n = text.length
  const endField = (): void => {
    if (row.length < CSV_COLS_MAX) row.push(field)
    field = ''
  }
  const endRow = (): void => {
    endField()
    if (rows.length < CSV_ROWS_MAX) rows.push(row)
    row = []
  }
  while (i < n) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"' && field === '') {
      quoted = true
      i++
    } else if (ch === ',') {
      endField()
      i++
    } else if (ch === '\r' || ch === '\n') {
      endRow()
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
      if (rows.length >= CSV_ROWS_MAX) return rows
    } else {
      field += ch
      i++
    }
  }
  if (field !== '' || row.length) endRow()
  return rows
}

/** A csv text as sheet rows (what main compares). A leading byte-order mark is dropped like main does. */
export function gridOfCsv(text: string): SheetCell[][] {
  return csvRows(text.replace(/^﻿/, '')).map((r) => r.map((v): SheetCell => ({ v })))
}

/** The line for a sheet with nothing to compare cell by cell. */
export function sheetNote(s: CellSheet): string | null {
  if (s.status === 'added') return 'This sheet is only in the newer version.'
  if (s.status === 'removed') return 'This sheet is only in the older version.'
  if (s.status === 'same') return 'This sheet has no changes.'
  return null
}
