// Pure logic for output notes (docs/design/outputs-2.md section 11): anchor words, cell names, mark ranges, the blockText
// twin, region maths, pin numbering and the hidden-character check. No DOM, no React.
import type { DocumentBlock, DocumentRun, OutputKind, OutputNote, OutputNoteAnchor, SlideBox } from '@shared/types'
import { OUTPUT_NOTE_LABELS_MAX, OUTPUT_NOTE_LABEL_MAX_CHARS, OUTPUT_NOTE_QUOTE_MAX_CHARS, OUTPUT_NOTE_TEXT_MAX } from '@shared/types'
import { hasHidden } from './hiddenChars'

/** Which way a kind takes notes. 'none' = no notes (pdf, other). */
export type NoteStyle = 'text' | 'block' | 'cells' | 'region' | 'slides' | 'none'

export function noteStyleOf(kind: OutputKind): NoteStyle {
  switch (kind) {
    case 'markdown':
    case 'text':
    case 'json':
      return 'text'
    case 'docx':
      return 'block'
    case 'csv':
    case 'xlsx':
      return 'cells'
    // A diagram is marked where it is drawn; its source pane belongs to the diagram viewer.
    case 'mermaid':
    case 'image':
    case 'svg':
      return 'region'
    case 'pptx':
      return 'slides'
    default:
      return 'none'
  }
}

/** Kinds that have a drawn region tool (a diagram is drawn from mermaid source). */
export function hasRegionTool(kind: OutputKind): boolean {
  return kind === 'pptx' || kind === 'image' || kind === 'svg' || kind === 'mermaid'
}

/** The reason Add note is off, per kind. */
export function noteHint(kind: OutputKind): string {
  switch (noteStyleOf(kind)) {
    case 'cells':
      return 'Select cells to add a note.'
    case 'region':
    case 'slides':
      return 'Mark an area to add a note.'
    default:
      return 'Select text to add a note.'
  }
}

export function emptyNotesText(kind: OutputKind): string {
  switch (noteStyleOf(kind)) {
    case 'cells':
      return 'No notes yet. Select cells, then choose Add note.'
    case 'region':
      return 'No notes yet. Mark an area, then choose Add note.'
    case 'slides':
      return 'No notes yet. Mark an area on a slide, then choose Add note.'
    case 'none':
      return 'Notes are not available for this kind of file.'
    default:
      return 'No notes yet. Select text, then choose Add note.'
  }
}

// ---------- text helpers ----------

export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

export function quoteOf(text: string): string {
  return text.slice(0, OUTPUT_NOTE_QUOTE_MAX_CHARS)
}

/** "A", "B", ... "Z", "AA". */
export function columnName(c: number): string {
  let n = Math.max(0, Math.floor(c)) + 1
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
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

export function normalizeRange(a: { r: number; c: number }, b: { r: number; c: number }): CellRange {
  return { r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) }
}

export function rangeName(g: CellRange): string {
  return g.r1 === g.r2 && g.c1 === g.c2 ? cellName(g.r1, g.c1) : `${cellName(g.r1, g.c1)}:${cellName(g.r2, g.c2)}`
}

export function inRange(g: CellRange, r: number, c: number): boolean {
  return r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2
}

export function cellsAnchor(sheet: string, g: CellRange, firstCellText?: string): OutputNoteAnchor {
  const q = firstCellText ? clip(firstCellText, 80) : ''
  return { type: 'cells', sheet, ...g, ...(q ? { quote: q } : {}) }
}

/** "Cells B2:C4 on Budget" ("Cell B2" for one; no "on" for csv). */
export function cellsDescription(sheet: string, g: CellRange): string {
  const one = g.r1 === g.r2 && g.c1 === g.c2
  return `${one ? 'Cell' : 'Cells'} ${rangeName(g)}${sheet ? ` on ${sheet}` : ''}`
}

export function regionWord(shape: 'box' | 'ellipse'): string {
  return shape === 'ellipse' ? 'circle' : 'box'
}

/** The words for an anchor ("Slide 3, box", "Cells B2:C4 on Budget", "“Tighten the summary…”", "Whole output"). */
export function anchorDescription(a: OutputNoteAnchor): string {
  switch (a.type) {
    case 'text':
    case 'block':
      return a.quote ? `“${clip(a.quote, 60)}”` : 'Selected text'
    case 'cells':
      return cellsDescription(a.sheet, a)
    case 'region':
      return `${a.slide ? `Slide ${a.slide}, ` : 'Marked area, '}${regionWord(a.shape)}`.replace('Marked area, box', 'Marked box').replace('Marked area, circle', 'Marked circle')
    case 'slide':
      return `Slide ${a.slide}`
    case 'whole':
      return 'Whole output'
  }
}

// ---------- mark ranges ----------

export interface TextRange {
  start: number
  end: number
  id: string
  status: OutputNote['status']
}

/** Ranges of the viewed version's notes over a text of `length`, clamped; empty or inverted ranges are dropped. */
export function textRanges(notes: readonly OutputNote[], length: number, pick: (a: OutputNoteAnchor) => { start: number; end: number } | null): TextRange[] {
  const out: TextRange[] = []
  for (const n of notes) {
    const r = pick(n.anchor)
    if (!r) continue
    const start = Math.max(0, Math.min(length, Math.floor(r.start)))
    const end = Math.max(0, Math.min(length, Math.floor(r.end)))
    if (end > start) out.push({ start, end, id: n.id, status: n.status })
  }
  return out
}

export interface Segment {
  start: number
  end: number
  /** Notes covering this span (open ones first). */
  notes: TextRange[]
}

/** Cuts [0, length) at every range edge; spans no note covers have no notes. */
export function segmentsOf(length: number, ranges: readonly TextRange[]): Segment[] {
  const cuts = new Set<number>([0, length])
  for (const r of ranges) {
    cuts.add(r.start)
    cuts.add(r.end)
  }
  const pts = [...cuts].filter((p) => p >= 0 && p <= length).sort((a, b) => a - b)
  const out: Segment[] = []
  for (let i = 0; i + 1 < pts.length; i++) {
    const start = pts[i]
    const end = pts[i + 1]
    const notes = ranges.filter((r) => r.start <= start && r.end >= end).sort((a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved'))
    out.push({ start, end, notes })
  }
  return out
}

/** A mark's status: open if any covering note is open or sent. */
export function markStatus(notes: readonly TextRange[]): 'open' | 'resolved' {
  return notes.some((n) => n.status !== 'resolved') ? 'open' : 'resolved'
}

export const textAnchorRange = (a: OutputNoteAnchor): { start: number; end: number } | null => (a.type === 'text' ? a : null)

// ---------- JSON display vs file text ----------

const isWs = (ch: string): boolean => ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r'

/** End offset: the position in `to` just after as many non-whitespace characters as `from[0..off)` holds (pretty-printed JSON only differs in whitespace). */
export function mapEndByNonWhitespace(from: string, to: string, off: number): number {
  let k = 0
  for (let i = 0; i < Math.min(off, from.length); i++) if (!isWs(from[i])) k++
  if (k === 0) return 0
  let seen = 0
  for (let i = 0; i < to.length; i++) {
    if (!isWs(to[i]) && ++seen === k) return i + 1
  }
  return to.length
}

/** A start offset in `from` mapped to `to`: the position of the first non-whitespace character at or after it. */
export function mapStartByNonWhitespace(from: string, to: string, off: number): number {
  let k = 0
  for (let i = 0; i < Math.min(off, from.length); i++) if (!isWs(from[i])) k++
  let seen = 0
  for (let i = 0; i < to.length; i++) {
    if (!isWs(to[i])) {
      if (seen === k) return i
      seen++
    }
  }
  return to.length
}

// ---------- Markdown: rendered selection -> source range ----------

function wordsOf(s: string): string[] {
  return s.split(/\s+/).filter(Boolean)
}

/** Finds the words as one run in the source (any whitespace between words); returns [start, end) or null. */
function findWords(source: string, words: string[]): [number, number] | null {
  if (!words.length) return null
  const esc = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const m = new RegExp(esc.join('\\s+')).exec(source)
  return m ? [m.index, m.index + m[0].length] : null
}

/**
 * The source range of a selection made in the rendered Markdown. Plain prose maps exactly; text with markup in it (bold,
 * links, a table cell, code) maps to the enclosing source paragraph (blank-line separated) of its first words.
 */
export function mapRenderedToSource(source: string, selected: string): { start: number; end: number } | null {
  const words = wordsOf(selected)
  if (!words.length) return null
  const exact = findWords(source, words)
  if (exact) return { start: exact[0], end: exact[1] }
  for (let n = Math.min(words.length, 8); n >= 1; n--) {
    const hit = findWords(source, words.slice(0, n))
    if (!hit) continue
    let start = source.lastIndexOf('\n\n', hit[0])
    start = start < 0 ? 0 : start + 2
    let end = source.indexOf('\n\n', hit[1])
    if (end < 0) end = source.length
    return { start, end }
  }
  return null
}

/** Where `quote` sits in a rendered text (whitespace tolerant), for drawing marks without touching the rendered tree. */
export function findQuote(rendered: string, quote: string): { start: number; end: number } | null {
  const hit = findWords(rendered, wordsOf(quote).slice(0, 40))
  return hit ? { start: hit[0], end: hit[1] } : null
}

// ---------- docx: the blockText twin (src/main/outputs/diff.ts) ----------

const runText = (runs: readonly DocumentRun[]): string => runs.map((r) => r.text).join('')

/** The plain text of one preview block. MUST match blockText in src/main/outputs/diff.ts. */
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

/** Offset of each list item / table cell inside blockText, in reading order (items: i; cells: row-major). */
export function blockPartOffsets(b: DocumentBlock): number[] {
  const out: number[] = []
  let pos = 0
  if (b.type === 'list') {
    b.items.forEach((it, i) => {
      if (i > 0) pos += 1
      out.push(pos)
      pos += runText(it).length
    })
  } else if (b.type === 'table') {
    b.rows.forEach((row, r) => {
      if (r > 0) pos += 1
      row.forEach((c, j) => {
        if (j > 0) pos += 1
        out.push(pos)
        pos += runText(c).length
      })
    })
  }
  return out
}

// ---------- regions ----------

export const clamp01 = (n: number): number => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0))

export interface RegionBox extends SlideBox {}

/** A box from two corners (fractions), normalised and clamped. */
export function boxFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): RegionBox {
  const x1 = clamp01(Math.min(a.x, b.x))
  const y1 = clamp01(Math.min(a.y, b.y))
  const x2 = clamp01(Math.max(a.x, b.x))
  const y2 = clamp01(Math.max(a.y, b.y))
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

/** Large enough to be a deliberate region (a click is not). */
export function isDeliberate(b: SlideBox): boolean {
  return b.w >= 0.01 && b.h >= 0.01
}

/** The default keyboard box: 20% x 20% of the visible area, centred. */
export function defaultBox(visible: SlideBox): RegionBox {
  const w = visible.w * 0.2
  const h = visible.h * 0.2
  return clampBox({ x: visible.x + (visible.w - w) / 2, y: visible.y + (visible.h - h) / 2, w, h })
}

const MIN_SIDE = 0.01

/** Keeps a box inside 0..1 with a minimum side. */
export function clampBox(b: SlideBox): RegionBox {
  const w = Math.max(MIN_SIDE, Math.min(1, b.w))
  const h = Math.max(MIN_SIDE, Math.min(1, b.h))
  return { x: Math.max(0, Math.min(1 - w, b.x)), y: Math.max(0, Math.min(1 - h, b.y)), w, h }
}

export function moveBox(b: SlideBox, dx: number, dy: number): RegionBox {
  return clampBox({ ...b, x: b.x + dx, y: b.y + dy })
}

export function resizeBox(b: SlideBox, dw: number, dh: number): RegionBox {
  return clampBox({ ...b, w: b.w + dw, h: b.h + dh })
}

/** The step of 8 screen px as fractions of the visible area for a viewport of this pixel size. */
export function stepFractions(visible: SlideBox, viewportW: number, viewportH: number, px = 8): { dx: number; dy: number } {
  return { dx: viewportW > 0 ? (visible.w * px) / viewportW : 0.01, dy: viewportH > 0 ? (visible.h * px) / viewportH : 0.01 }
}

export function boxesIntersect(a: SlideBox, b: SlideBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** At most OUTPUT_NOTE_LABELS_MAX distinct labels of OUTPUT_NOTE_LABEL_MAX_CHARS each (cut, never refused). */
export function cleanLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const l of labels) {
    const t = clip(l, OUTPUT_NOTE_LABEL_MAX_CHARS)
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length >= OUTPUT_NOTE_LABELS_MAX) break
  }
  return out
}

export function regionAnchor(shape: 'box' | 'ellipse', box: SlideBox, slide: number | undefined, labels?: readonly string[]): OutputNoteAnchor {
  const clean = labels ? cleanLabels(labels) : []
  return { type: 'region', ...(slide ? { slide } : {}), shape, x: box.x, y: box.y, w: box.w, h: box.h, ...(clean.length ? { labels: clean } : {}) }
}

/** The visible part of a natural-size drawing, as fractions, for a view `translate(x,y) scale(k)` in a box. */
export function visibleFraction(view: { k: number; x: number; y: number }, box: { w: number; h: number }, natural: { w: number; h: number }): SlideBox {
  if (view.k <= 0 || natural.w <= 0 || natural.h <= 0) return { x: 0, y: 0, w: 1, h: 1 }
  const x1 = clamp01(-view.x / view.k / natural.w)
  const y1 = clamp01(-view.y / view.k / natural.h)
  const x2 = clamp01((box.w - view.x) / view.k / natural.w)
  const y2 = clamp01((box.h - view.y) / view.k / natural.h)
  return { x: x1, y: y1, w: Math.max(MIN_SIDE, x2 - x1), h: Math.max(MIN_SIDE, y2 - y1) }
}

// ---------- panel ----------

/** Pin numbers: the order of the version's notes in the list (all statuses), 1-based. */
export function pinNumbers(notes: readonly OutputNote[], version: number): Map<string, number> {
  const m = new Map<string, number>()
  let n = 0
  for (const note of notes) if (note.version === version) m.set(note.id, ++n)
  return m
}

/** "2 open, 1 resolved" ("Sent" notes count as open; "No notes" when none). */
export function countsLine(notes: readonly OutputNote[]): string {
  const open = notes.filter((n) => n.status !== 'resolved').length
  const done = notes.length - open
  const parts: string[] = []
  if (open) parts.push(`${open} open`)
  if (done) parts.push(`${done} resolved`)
  return parts.length ? parts.join(', ') : 'No notes'
}

export type NoteFilter = 'open' | 'resolved' | 'all'

export function filterNotes(notes: readonly OutputNote[], f: NoteFilter): OutputNote[] {
  if (f === 'all') return [...notes]
  return notes.filter((n) => (f === 'resolved') === (n.status === 'resolved'))
}

export function reviseLabel(n: number): string {
  return n === 0 ? 'Revise with these notes' : `Revise with ${n} ${n === 1 ? 'note' : 'notes'}`
}

/** "7 Nov 11:04" (the year only when it is not this one). */
export function noteStamp(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  const day = `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })}${sameYear ? '' : ` ${d.getFullYear()}`}`
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${day} ${time}`
}

// ---------- composer ----------

export const NOTE_COUNTER_FROM = Math.floor(OUTPUT_NOTE_TEXT_MAX * 0.9)

/** Why a note text cannot be sent, or null. Main refuses the same things. */
export function noteTextProblem(text: string): string | null {
  if (!text.trim()) return null
  if (text.length > OUTPUT_NOTE_TEXT_MAX) return `Keep the note under ${OUTPUT_NOTE_TEXT_MAX.toLocaleString('en-US')} characters.`
  if (hasHidden(text)) return 'Remove the hidden characters from the note first.'
  return null
}

// ---------- keyboard block cursor (docs/design/outputs-2.md 11.2: selecting without a mouse) ----------

export interface Span {
  start: number
  end: number
}

/** Each line of `text` as [start, end) without its line break (blank lines have start === end). */
export function lineSpans(text: string): Span[] {
  const out: Span[] = []
  let at = 0
  for (;;) {
    const nl = text.indexOf('\n', at)
    if (nl < 0) {
      out.push({ start: at, end: text.length })
      return out
    }
    out.push({ start: at, end: nl })
    at = nl + 1
  }
}

/**
 * The offsets covered by items lo..hi (inclusive) of `spans`, leaving out blank items at either end (a note on "a paragraph"
 * should not start with a line break); null when they hold no characters.
 */
export function spanRange(spans: readonly Span[], lo: number, hi: number): Span | null {
  let from = Math.min(lo, hi)
  let to = Math.max(lo, hi)
  while (from <= to && spans[from] && spans[from].end <= spans[from].start) from++
  while (to >= from && spans[to] && spans[to].end <= spans[to].start) to--
  const a = spans[from]
  const b = spans[to]
  if (!a || !b || from > to) return null
  return { start: a.start, end: b.end }
}

/** "Line 4 selected" / "Lines 4 to 6 selected" (the indexes are 0-based). */
export function itemsSentence(one: string, many: string, lo: number, hi: number): string {
  const a = Math.min(lo, hi) + 1
  const b = Math.max(lo, hi) + 1
  return a === b ? `${one} ${a} selected` : `${many} ${a} to ${b} selected`
}

/** Where the cursor goes for a key (null = the key does not move it). `cur` is null before the first move. */
export function moveCursor(key: string, cur: number | null, count: number, page = 10): number | null {
  if (count <= 0) return null
  const last = count - 1
  const clamp = (n: number): number => Math.max(0, Math.min(last, n))
  switch (key) {
    case 'ArrowDown':
      return cur === null ? 0 : clamp(cur + 1)
    case 'ArrowUp':
      return cur === null ? 0 : clamp(cur - 1)
    case 'PageDown':
      return cur === null ? clamp(page - 1) : clamp(cur + page)
    case 'PageUp':
      return cur === null ? 0 : clamp(cur - page)
    case 'Home':
      return 0
    case 'End':
      return last
    default:
      return null
  }
}

/**
 * The source range of rendered Markdown blocks lo..hi: each block's text is mapped to the source (mapRenderedToSource) and
 * the range runs from the first mapped start to the last mapped end. Null when none of the blocks can be placed.
 */
export function renderedBlocksRange(source: string, texts: readonly string[], lo: number, hi: number): Span | null {
  const from = Math.min(lo, hi)
  const to = Math.max(lo, hi)
  let start = Infinity
  let end = -Infinity
  for (let i = from; i <= to; i++) {
    const r = mapRenderedToSource(source, texts[i] ?? '')
    if (!r || r.end <= r.start) continue
    start = Math.min(start, r.start)
    end = Math.max(end, r.end)
  }
  return end > start ? { start, end } : null
}

/** One keyboard-selectable piece of a Word preview: a paragraph, heading or code block whole, each list item and each table cell. */
export interface DocItem {
  block: number
  /** Range inside blockText(block). */
  start: number
  end: number
  label: string
}

export function docItems(blocks: readonly DocumentBlock[]): DocItem[] {
  const out: DocItem[] = []
  blocks.forEach((b, i) => {
    const n = i + 1
    const len = blockText(b).length
    if (b.type === 'heading') out.push({ block: i, start: 0, end: len, label: `Heading ${n}` })
    else if (b.type === 'paragraph') out.push({ block: i, start: 0, end: len, label: `Paragraph ${n}` })
    else if (b.type === 'code') out.push({ block: i, start: 0, end: len, label: `Code block ${n}` })
    else if (b.type === 'list') {
      const offs = blockPartOffsets(b)
      b.items.forEach((it, j) => out.push({ block: i, start: offs[j], end: offs[j] + runText(it).length, label: `List item ${j + 1} of block ${n}` }))
    } else if (b.type === 'table') {
      const offs = blockPartOffsets(b)
      let k = 0
      for (const row of b.rows) {
        for (const c of row) {
          out.push({ block: i, start: offs[k], end: offs[k] + runText(c).length, label: `Cell ${k + 1} of block ${n}` })
          k++
        }
      }
    }
  })
  return out
}

/** The block anchor range of document items lo..hi, which must sit in one block (null otherwise or when empty). */
export function docItemsRange(items: readonly DocItem[], lo: number, hi: number): { index: number; start: number; end: number } | null {
  const a = items[Math.min(lo, hi)]
  const b = items[Math.max(lo, hi)]
  if (!a || !b || a.block !== b.block || b.end <= a.start) return null
  return { index: a.block, start: a.start, end: b.end }
}
