/**
 * outputs:compare in main (OutputDiff, data only). Never throws.
 *
 * text kinds (markdown, text, json, mermaid, svg): line diff, 3 lines of context per hunk, word marks on paired changed lines
 * (a run of deleted lines followed by added lines pairs line i with line i), 1-based line numbers, added / removed counts over
 * the whole script; past OUTPUT_DIFF_TEXT_LINES_MAX changed lines the hunks stop and `truncated` is set (so does a file
 * over OUTPUT_TEXT_MAX_BYTES, of which the first OUTPUT_TEXT_MAX_BYTES are compared).
 * docx: 'blocks' over the preview blocks; `a` / `b` are 0-based block indexes; marks are UTF-16 offsets into `blockText(block)`.
 * xlsx / csv: 'cells' per sheet (csv: RFC 4180, one sheet named ''), within the preview caps (500 rows x 64 columns); rows
 * are aligned by content so an inserted row is a rowOp, not a column of changes; cell `r` / `c` are 0-based in B for 'add' and
 * 'chg' and in A for 'del'; rowOps `r` is 0-based in B for 'add' and in A for 'del'.
 * pptx: 'slides', aligned by title (Myers over titles, or a content digest when untitled), gaps paired by index (changed),
 * the rest added / removed; `a` / `b` are 1-based slide numbers.
 * Cost is bounded by diffCore (Myers D capped at 1,500, then a coarse delete-all / add-all fallback).
 */
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import type { DocumentBlock, DocumentRun, OutputDiff, OutputDiffHunk, OutputDiffLine, OutputDiffMark, OutputKind, SheetCell, SheetPreview, SlidePreview } from '@shared/types'
import { OUTPUT_DIFF_SLIDES_MAX, OUTPUT_DIFF_TEXT_LINES_MAX, OUTPUT_PREVIEW_COLUMNS_MAX, OUTPUT_PREVIEW_ROWS_MAX, OUTPUT_TEXT_MAX_BYTES } from '@shared/types'
import { diffOps, wordMarks, type DiffOp } from './diffCore'
import { previewFile } from './preview'
import { utf8End } from './readText'

const CONTEXT = 3
type Prim = string | number | boolean | null

function readText(path: string): { text: string; truncated: boolean } {
  const fd = openSync(path, 'r')
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new Error('not a regular file')
    const want = Math.min(st.size, OUTPUT_TEXT_MAX_BYTES)
    const buf = Buffer.alloc(want)
    let off = 0
    while (off < want) {
      const n = readSync(fd, buf, off, want - off, off)
      if (n <= 0) break
      off += n
    }
    const cut = st.size > OUTPUT_TEXT_MAX_BYTES
    return { text: buf.toString('utf8', 0, cut ? utf8End(buf, off) : off).replace(/^﻿/, ''), truncated: cut }
  } finally {
    closeSync(fd)
  }
}

const linesOf = (t: string): string[] => {
  if (!t) return []
  const l = t.split(/\r\n|\n|\r/)
  if (l.length && l[l.length - 1] === '') l.pop()
  return l
}

// ---------- text ----------

export function diffText(aText: string, bText: string, inputTruncated = false): OutputDiff {
  const A = linesOf(aText)
  const B = linesOf(bText)
  const ops = diffOps(A, B)
  let added = 0
  let removed = 0
  for (const o of ops) {
    if (o.op === 'add') added++
    else if (o.op === 'del') removed++
  }
  const aPre = new Int32Array(ops.length + 1)
  const bPre = new Int32Array(ops.length + 1)
  ops.forEach((o, k) => {
    aPre[k + 1] = aPre[k] + (o.op === 'add' ? 0 : 1)
    bPre[k + 1] = bPre[k] + (o.op === 'del' ? 0 : 1)
  })
  const hunks: OutputDiffHunk[] = []
  let truncated = inputTruncated
  let changedSeen = 0
  let i = 0
  while (i < ops.length) {
    while (i < ops.length && ops[i].op === 'eq') i++
    if (i >= ops.length) break
    const start = Math.max(0, i - CONTEXT)
    // extend while the next change is within 2 * CONTEXT equal lines
    let lastChange = i
    for (let j = i; j < ops.length; j++) {
      if (ops[j].op !== 'eq') lastChange = j
      else if (j - lastChange > 2 * CONTEXT) break
    }
    const stop = Math.min(ops.length, lastChange + CONTEXT + 1)
    const slice = ops.slice(start, stop)
    const lines: OutputDiffLine[] = []
    let cut = false
    for (const o of slice) {
      if (o.op !== 'eq') {
        if (changedSeen >= OUTPUT_DIFF_TEXT_LINES_MAX) {
          cut = true
          break
        }
        changedSeen++
      }
      if (o.op === 'eq') lines.push({ op: 'eq', a: o.a + 1, b: o.b + 1, text: A[o.a] })
      else if (o.op === 'del') lines.push({ op: 'del', a: o.a + 1, text: A[o.a] })
      else lines.push({ op: 'add', b: o.b + 1, text: B[o.b] })
    }
    pairMarks(lines)
    if (lines.length) {
      const aCount = lines.filter((l) => l.a !== undefined).length
      const bCount = lines.filter((l) => l.b !== undefined).length
      hunks.push({ aStart: aPre[start] + 1, aCount, bStart: bPre[start] + 1, bCount, lines })
    }
    if (cut) {
      truncated = true
      break
    }
    i = stop
  }
  return { kind: 'text', hunks, added, removed, ...(truncated ? { truncated: true as const } : {}) }
}

/** Pair each run of deleted lines with the added lines right after it and add word marks. */
function pairMarks(lines: OutputDiffLine[]): void {
  let i = 0
  while (i < lines.length) {
    if (lines[i].op !== 'del') {
      i++
      continue
    }
    let d = i
    while (d < lines.length && lines[d].op === 'del') d++
    let a = d
    while (a < lines.length && lines[a].op === 'add') a++
    const n = Math.min(d - i, a - d)
    for (let k = 0; k < n; k++) {
      const del = lines[i + k]
      const add = lines[d + k]
      const m = wordMarks(del.text, add.text)
      if (m.a.length) del.marks = m.a
      if (m.b.length) add.marks = m.b
    }
    i = Math.max(a, d)
  }
}

// ---------- docx ----------

const runText = (runs: DocumentRun[]): string => runs.map((r) => r.text).join('')

/** The plain text of one preview block (the string the 'blocks' marks index into). */
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

type BlockRow = { op: 'eq' | 'add' | 'del' | 'chg'; a?: number; b?: number; marks?: { a?: OutputDiffMark[]; b?: OutputDiffMark[] } }

function diffBlocks(a: DocumentBlock[], b: DocumentBlock[], truncatedIn: boolean): OutputDiff {
  const ta = a.map((x) => `${x.type}:${blockText(x)}`)
  const tb = b.map((x) => `${x.type}:${blockText(x)}`)
  const ops = diffOps(ta, tb)
  const rows: BlockRow[] = []
  let changed = 0
  let truncated = truncatedIn
  for (let i = 0; i < ops.length && !truncated; ) {
    const o = ops[i]
    if (o.op === 'eq') {
      rows.push({ op: 'eq', a: o.a, b: o.b })
      i++
      continue
    }
    let d = i
    const dels: DiffOp[] = []
    while (d < ops.length && ops[d].op === 'del') dels.push(ops[d++])
    const adds: DiffOp[] = []
    while (d < ops.length && ops[d].op === 'add') adds.push(ops[d++])
    // an add first (Myers may emit add before del): collect the other side too
    if (!dels.length && adds.length) while (d < ops.length && ops[d].op === 'del') dels.push(ops[d++])
    const n = Math.min(dels.length, adds.length)
    for (let k = 0; k < n; k++) {
      if (changed++ >= OUTPUT_DIFF_TEXT_LINES_MAX) {
        truncated = true
        break
      }
      const ba = a[dels[k].a]
      const bb = b[adds[k].b]
      const row: BlockRow = { op: 'chg', a: dels[k].a, b: adds[k].b }
      if (ba.type === bb.type) {
        const m = wordMarks(blockText(ba), blockText(bb))
        if (m.a.length || m.b.length) row.marks = { ...(m.a.length ? { a: m.a } : {}), ...(m.b.length ? { b: m.b } : {}) }
      }
      rows.push(row)
    }
    for (const x of dels.slice(n)) {
      if (changed++ >= OUTPUT_DIFF_TEXT_LINES_MAX) truncated = true
      else rows.push({ op: 'del', a: x.a })
    }
    for (const x of adds.slice(n)) {
      if (changed++ >= OUTPUT_DIFF_TEXT_LINES_MAX) truncated = true
      else rows.push({ op: 'add', b: x.b })
    }
    i = d
  }
  return { kind: 'blocks', rows, ...(truncated ? { truncated: true as const } : {}) }
}

// ---------- sheets ----------

interface Grid {
  name: string
  rows: SheetCell[][]
}

/** RFC 4180: quoted fields, doubled quotes, CRLF or LF, embedded newlines; capped at the preview rows and columns. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const n = text.length
  const endField = (): void => {
    if (row.length < OUTPUT_PREVIEW_COLUMNS_MAX) row.push(field)
    field = ''
  }
  const endRow = (): void => {
    endField()
    if (rows.length < OUTPUT_PREVIEW_ROWS_MAX) rows.push(row)
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
      if (rows.length >= OUTPUT_PREVIEW_ROWS_MAX) return rows
    } else {
      field += ch
      i++
    }
  }
  if (field !== '' || row.length) endRow()
  return rows
}

const same = (x: SheetCell | undefined, y: SheetCell | undefined): boolean => (x?.v ?? null) === (y?.v ?? null) && (x?.f ?? '') === (y?.f ?? '')
const rowKey = (r: SheetCell[]): string => {
  let end = r.length
  while (end > 0 && (r[end - 1]?.v ?? null) === null && !r[end - 1]?.f) end--
  return JSON.stringify(r.slice(0, end).map((c) => [c?.v ?? null, c?.f ?? null]))
}

type SheetDiff = { name: string; status: 'same' | 'changed' | 'added' | 'removed'; changes: { r: number; c: number; op: 'add' | 'del' | 'chg'; was?: Prim; now?: Prim }[]; rowOps: { r: number; op: 'add' | 'del' }[]; truncated?: true }

function cellDiffs(ar: SheetCell[], br: SheetCell[], aIdx: number, bIdx: number, out: SheetDiff['changes']): void {
  const w = Math.max(ar.length, br.length)
  for (let c = 0; c < w; c++) {
    const x = ar[c]
    const y = br[c]
    if (same(x, y)) continue
    const xv = x?.v ?? null
    const yv = y?.v ?? null
    if (c >= ar.length || (xv === null && !x?.f)) {
      if (yv !== null || y?.f) out.push({ r: bIdx, c, op: 'add', now: yv ?? (y?.f ? `=${y.f}` : null) })
    } else if (c >= br.length || (yv === null && !y?.f)) {
      out.push({ r: aIdx, c, op: 'del', was: xv ?? (x?.f ? `=${x.f}` : null) })
    } else if (xv !== yv) out.push({ r: bIdx, c, op: 'chg', was: xv, now: yv })
    else out.push({ r: bIdx, c, op: 'chg', was: x?.f ? `=${x.f}` : xv, now: y?.f ? `=${y.f}` : yv })
  }
}

function diffSheet(name: string, a: SheetCell[][], b: SheetCell[][]): SheetDiff {
  const ops = diffOps(a.map(rowKey), b.map(rowKey))
  const out: SheetDiff = { name, status: 'same', changes: [], rowOps: [] }
  let count = 0
  const room = (): boolean => {
    if (count++ < OUTPUT_DIFF_TEXT_LINES_MAX) return true
    out.truncated = true
    return false
  }
  for (let i = 0; i < ops.length && !out.truncated; ) {
    if (ops[i].op === 'eq') {
      i++
      continue
    }
    const dels: DiffOp[] = []
    const adds: DiffOp[] = []
    let j = i
    while (j < ops.length && ops[j].op !== 'eq') {
      if (ops[j].op === 'del') dels.push(ops[j])
      else adds.push(ops[j])
      j++
    }
    const n = Math.min(dels.length, adds.length)
    for (let k = 0; k < n; k++) {
      const tmp: SheetDiff['changes'] = []
      cellDiffs(a[dels[k].a] ?? [], b[adds[k].b] ?? [], dels[k].a, adds[k].b, tmp)
      for (const ch of tmp) if (room()) out.changes.push(ch)
    }
    for (const d of dels.slice(n)) if (room()) out.rowOps.push({ r: d.a, op: 'del' })
    for (const x of adds.slice(n)) if (room()) out.rowOps.push({ r: x.b, op: 'add' })
    i = j
  }
  if (out.changes.length || out.rowOps.length) out.status = 'changed'
  return out
}

function diffGrids(a: Grid[], b: Grid[], truncated: boolean): OutputDiff {
  const sheets: SheetDiff[] = []
  const bByName = new Map(b.map((g) => [g.name, g]))
  const seen = new Set<string>()
  for (const ga of a) {
    const gb = bByName.get(ga.name)
    seen.add(ga.name)
    if (!gb) sheets.push({ name: ga.name, status: 'removed', changes: [], rowOps: [] })
    else sheets.push(diffSheet(ga.name, ga.rows, gb.rows))
  }
  for (const gb of b) if (!seen.has(gb.name)) sheets.push({ name: gb.name, status: 'added', changes: [], rowOps: [] })
  if (truncated && sheets.length) sheets[sheets.length - 1].truncated = true
  return { kind: 'cells', sheets }
}

const gridsOf = (sheets: SheetPreview[]): Grid[] => sheets.map((s) => ({ name: s.name, rows: s.rows }))

// ---------- slides ----------

function slideSig(s: SlidePreview): string {
  return createHash('sha1').update(JSON.stringify([s.background ?? null, s.shapes, s.notes ?? null])).digest('hex')
}

function diffSlides(a: SlidePreview[], b: SlidePreview[], truncated: boolean): OutputDiff {
  const key = (s: SlidePreview): string => (s.title && s.title.trim() ? `t:${s.title.trim().toLowerCase()}` : `c:${slideSig(s)}`)
  const ops = diffOps(a.map(key), b.map(key))
  const pairs: { a?: number; b?: number; status: 'same' | 'changed' | 'added' | 'removed' }[] = []
  for (let i = 0; i < ops.length; ) {
    const o = ops[i]
    if (o.op === 'eq') {
      pairs.push({ a: a[o.a].n, b: b[o.b].n, status: slideSig(a[o.a]) === slideSig(b[o.b]) ? 'same' : 'changed' })
      i++
      continue
    }
    const dels: DiffOp[] = []
    const adds: DiffOp[] = []
    let j = i
    while (j < ops.length && ops[j].op !== 'eq') {
      if (ops[j].op === 'del') dels.push(ops[j])
      else adds.push(ops[j])
      j++
    }
    const n = Math.min(dels.length, adds.length)
    for (let k = 0; k < n; k++) pairs.push({ a: a[dels[k].a].n, b: b[adds[k].b].n, status: slideSig(a[dels[k].a]) === slideSig(b[adds[k].b]) ? 'same' : 'changed' })
    for (const d of dels.slice(n)) pairs.push({ a: a[d.a].n, status: 'removed' })
    for (const x of adds.slice(n)) pairs.push({ b: b[x.b].n, status: 'added' })
    i = j
  }
  const capped = pairs.length > OUTPUT_DIFF_SLIDES_MAX
  return { kind: 'slides', pairs: capped ? pairs.slice(0, OUTPUT_DIFF_SLIDES_MAX) : pairs, ...(truncated || capped ? { truncated: true as const } : {}) }
}

// ---------- entry ----------

const TEXT_KINDS: ReadonlySet<OutputKind> = new Set(['markdown', 'text', 'json', 'mermaid', 'svg'])

export async function compareFilesImpl(aPath: string, bPath: string, kind: OutputKind): Promise<OutputDiff> {
  try {
    if (TEXT_KINDS.has(kind)) {
      const a = readText(aPath)
      const b = readText(bPath)
      return diffText(a.text, b.text, a.truncated || b.truncated)
    }
    if (kind === 'csv') {
      const a = readText(aPath)
      const b = readText(bPath)
      const toGrid = (t: string): Grid => ({ name: '', rows: parseCsv(t).map((r) => r.map((v): SheetCell => ({ v }))) })
      return diffGrids([toGrid(a.text)], [toGrid(b.text)], a.truncated || b.truncated)
    }
    if (kind === 'docx' || kind === 'xlsx' || kind === 'pptx') {
      const [pa, pb] = [await previewFile(aPath, kind), await previewFile(bPath, kind)]
      if (pa.kind === 'none') return { kind: 'none', reason: `The older version cannot be compared: ${pa.reason}` }
      if (pb.kind === 'none') return { kind: 'none', reason: `The newer version cannot be compared: ${pb.reason}` }
      if (kind === 'docx' && pa.kind === 'document' && pb.kind === 'document') return diffBlocks(pa.blocks, pb.blocks, !!pa.truncated || !!pb.truncated)
      if (kind === 'xlsx' && pa.kind === 'sheets' && pb.kind === 'sheets') return diffGrids(gridsOf(pa.sheets), gridsOf(pb.sheets), !!(pa.truncatedSheets || pb.truncatedSheets || pa.sheets.some((s) => s.truncatedRows || s.truncatedCols) || pb.sheets.some((s) => s.truncatedRows || s.truncatedCols)))
      if (kind === 'pptx' && pa.kind === 'slides' && pb.kind === 'slides') return diffSlides(pa.slides, pb.slides, !!(pa.truncatedSlides || pb.truncatedSlides))
      return { kind: 'none', reason: 'OrgAI could not compare these versions.' }
    }
    return { kind: 'none', reason: 'OrgAI cannot compare this kind of file as text; view the versions side by side instead.' }
  } catch (e) {
    return { kind: 'none', reason: `OrgAI could not compare these versions: ${(e as Error).message}` }
  }
}
