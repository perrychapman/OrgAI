// Pure helpers for the slide viewer, stage, strip and compare (docs/design/outputs-2.md sections 12.2 and 13).
import type { OutputNote, SlideBox, SlideParagraph, SlidePreview, SlideShape } from '@shared/types'

const COLOR_RE = /^#[0-9a-fA-F]{6}$/
const DATA_URL_RE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$/

/** A `#rrggbb` colour or undefined (a preview is untrusted data, so every colour is re-checked). */
export function safeColor(c: unknown): string | undefined {
  return typeof c === 'string' && COLOR_RE.test(c) ? c : undefined
}

/** An image data URL of a safe type, else undefined. */
export function safeImageUrl(u: unknown): string | undefined {
  return typeof u === 'string' && u.length < 40_000_000 && DATA_URL_RE.test(u) ? u : undefined
}

const finite = (n: unknown, d = 0): number => (typeof n === 'number' && Number.isFinite(n) ? n : d)

/** Slide width / height; a bad size falls back to 16:9. */
export function slideAspect(size: { w: number; h: number }): number {
  const w = finite(size?.w), h = finite(size?.h)
  return w > 0 && h > 0 ? w / h : 16 / 9
}

/** Font size in cqw of the slide container: points divided by the slide width in points, times 100. */
export function cqwSize(pt: number, slideWidthPt: number): number {
  const w = finite(slideWidthPt) > 0 ? slideWidthPt : 960
  return (Math.min(Math.max(finite(pt, 18), 1), 400) / w) * 100
}

const pct = (n: number): string => `${Math.round(finite(n) * 100000) / 1000}%`

/** Absolute position in percent of the slide. */
export function boxPercent(b: SlideBox): { left: string; top: string; width: string; height: string } {
  return { left: pct(b.x), top: pct(b.y), width: pct(b.w), height: pct(b.h) }
}

/** The bullet label of each paragraph: '•' for disc, "1." per level for numbered, '' for none. */
export function bulletLabels(paragraphs: SlideParagraph[]): string[] {
  const counters: number[] = []
  return paragraphs.map((p) => {
    const level = Math.min(Math.max(Math.floor(finite(p.level)), 0), 8)
    counters.length = level + 1
    if (p.bullet === 'number') {
      counters[level] = (counters[level] ?? 0) + 1
      return `${counters[level]}.`
    }
    counters[level] = 0
    return p.bullet === 'disc' ? '•' : ''
  })
}

export const levelIndentEm = (level: number | undefined): number => Math.min(Math.max(Math.floor(finite(level)), 0), 8) * 1.2

export const ANCHOR_FLEX: Record<'top' | 'middle' | 'bottom', string> = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }

/** The plain text of a shape (text boxes and table cells), for names and region labels. */
export function shapeText(s: SlideShape): string {
  if (s.type === 'text') return s.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join(' ').replace(/\s+/g, ' ').trim()
  if (s.type === 'table') return s.rows.map((r) => r.map((c) => c.map((x) => x.text).join('')).join(' ')).join(' ').replace(/\s+/g, ' ').trim()
  if (s.type === 'placeholder' || s.type === 'image') return (s.alt ?? '').trim()
  return ''
}

const intersects = (a: SlideBox, b: SlideBox): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** Texts of shapes whose box intersects a region (fractions), each cut at 80 chars, at most 8. */
export function labelsInBox(slide: SlidePreview, box: SlideBox): string[] {
  const out: string[] = []
  for (const s of slide.shapes) {
    if (out.length >= 8) break
    if (!intersects(s, box)) continue
    const t = shapeText(s)
    if (t) out.push(t.length > 80 ? `${t.slice(0, 79)}…` : t)
  }
  return out
}

/** "Slide 3: Next steps" (+ ", has 2 open notes"). */
export function thumbName(slide: SlidePreview, openNotes = 0): string {
  const title = (slide.title ?? '').trim()
  const base = title ? `Slide ${slide.n}: ${title}` : `Slide ${slide.n}`
  return openNotes > 0 ? `${base}, has ${openNotes} open ${openNotes === 1 ? 'note' : 'notes'}` : base
}

export const slideCounter = (n: number, total: number): string => `Slide ${n} of ${total}`

/** Open notes per slide number: slide anchors and region anchors with a slide, for one version. */
export function openNotesBySlide(notes: readonly OutputNote[] | null, version: number): Map<number, number> {
  const m = new Map<number, number>()
  for (const n of notes ?? []) {
    if (n.version !== version || n.status !== 'open') continue
    const a = n.anchor
    const slide = a.type === 'slide' ? a.slide : a.type === 'region' ? a.slide : undefined
    if (slide) m.set(slide, (m.get(slide) ?? 0) + 1)
  }
  return m
}

/**
 * The next selected index for a key on the stage or strip, or null when the key is not ours. `vertical` strips use
 * Up/Down; Left/Right and PageUp/PageDown always move; Home/End jump. Clamped, never wraps.
 */
export function slideKey(key: string, index: number, count: number, vertical: boolean): number | null {
  if (count <= 0) return null
  const last = count - 1
  let next: number
  switch (key) {
    case 'ArrowLeft':
    case 'PageUp':
      next = index - 1
      break
    case 'ArrowRight':
    case 'PageDown':
      next = index + 1
      break
    case 'ArrowUp':
      if (!vertical) return null
      next = index - 1
      break
    case 'ArrowDown':
      if (!vertical) return null
      next = index + 1
      break
    case 'Home':
      next = 0
      break
    case 'End':
      next = last
      break
    default:
      return null
  }
  return Math.min(Math.max(next, 0), last)
}

export const FIDELITY_NOTE = 'Preview. Open in PowerPoint for the exact look.'

export function truncatedSlidesLine(n: number | undefined): string | null {
  if (!n || n <= 0) return null
  return `${n === 1 ? '1 more slide is' : `${n} more slides are`} not shown. Open the file to see ${n === 1 ? 'it' : 'them'}.`
}

export type PairStatus = 'same' | 'changed' | 'added' | 'removed'
export const PAIR_WORD: Record<PairStatus, string> = { same: 'Unchanged', changed: 'Changed', added: 'Added', removed: 'Removed' }
export const PAIR_GLYPH: Record<PairStatus, string> = { same: '=', changed: '~', added: '+', removed: '−' }

export interface SlidePair {
  a?: number
  b?: number
  status: PairStatus
}

/** The pairs the filmstrip lists: changed ones only unless unchanged are shown. */
export function visiblePairs(pairs: readonly SlidePair[], showSame: boolean): SlidePair[] {
  return showSame ? [...pairs] : pairs.filter((p) => p.status !== 'same')
}

/** "3 slides changed, 1 added, 1 removed" (spoken once). */
export function compareSummary(pairs: readonly SlidePair[], truncated?: boolean): string {
  const c = (s: PairStatus): number => pairs.filter((p) => p.status === s).length
  const parts: string[] = []
  const word = (n: number, w: string): string => `${n} ${n === 1 ? 'slide' : 'slides'} ${w}`
  if (c('changed')) parts.push(word(c('changed'), 'changed'))
  if (c('added')) parts.push(`${c('added')} added`)
  if (c('removed')) parts.push(`${c('removed')} removed`)
  const text = parts.length ? parts.join(', ') : 'No slides changed'
  return `${text}.${truncated ? ' Only the first slides were compared.' : ''}`
}

/** "Slide 3 changed" / "Slide 4 added" / "Slide 2 (was 3) unchanged". */
export function pairName(p: SlidePair, titleA?: string, titleB?: string): string {
  const n = p.b ?? p.a ?? 0
  const title = (p.b !== undefined ? titleB : titleA)?.trim()
  const lead = p.a !== undefined && p.b !== undefined && p.a !== p.b ? `Slide ${p.b} (was ${p.a})` : `Slide ${n}`
  return `${lead}${title ? `: ${title}` : ''}, ${PAIR_WORD[p.status].toLowerCase()}`
}
