// Pure view maths and wording for the diagram, SVG and image viewer (docs/design/outputs-2.md section 8).
// No React, no DOM: the pan/zoom surface, overview and source pane call these and the unit tests pin them.

export interface Size {
  w: number
  h: number
}
/** The viewport's box in px. */
export type Box = Size
/** The drawing is drawn at `translate(x, y) scale(k)` with its origin at the viewport's top-left. */
export interface View {
  k: number
  x: number
  y: number
}
export interface Point {
  x: number
  y: number
}

export const ZOOM_MIN = 0.02
export const ZOOM_MAX = 8
/** Fit never enlarges a drawing past this (a tiny diagram is not blown up to a blur). */
export const FIT_MAX = 1.5
export const FIT_PAD = 16
/** One press of + / - or a zoom button. */
export const KEY_ZOOM_STEP = 1.25
/** Pixels an arrow key pans; Shift multiplies it. */
export const PAN_STEP = 48
export const PAN_STEP_BIG = 192
/** At least this much of the drawing (or all of it, if smaller) stays inside the viewport. */
export const KEEP_PX = 64
/** A pointer that moves less than this between down and up is a click, not a drag. */
export const DRAG_SLOP = 4

const usable = (s: Size): boolean => s.w > 0 && s.h > 0 && Number.isFinite(s.w) && Number.isFinite(s.h)

export function clampK(k: number): number {
  if (!Number.isFinite(k)) return 1
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k))
}

/** The scale at which `natural` fits `box` with `pad` px around it: min(area fit, FIT_MAX). No floor: a huge drawing still fits. */
export function fitScale(box: Box, natural: Size, pad = FIT_PAD): number {
  if (!usable(box) || !usable(natural)) return 1
  const availW = Math.max(1, box.w - pad * 2)
  const availH = Math.max(1, box.h - pad * 2)
  return Math.min(FIT_MAX, availW / natural.w, availH / natural.h)
}

/** The fitted view, centred. */
export function fitView(box: Box, natural: Size, pad = FIT_PAD): View {
  const k = fitScale(box, natural, pad)
  return { k, x: (box.w - natural.w * k) / 2, y: (box.h - natural.h * k) / 2 }
}

/** 100%, centred on `about` (a point in viewport px) when given, else on the viewport's centre. */
export function actualView(view: View, box: Box, natural: Size, about?: Point): View {
  const p = about ?? { x: box.w / 2, y: box.h / 2 }
  // A drawing that fits at 100% is centred rather than left under the pointer.
  if (natural.w <= box.w && natural.h <= box.h) return { k: 1, x: (box.w - natural.w) / 2, y: (box.h - natural.h) / 2 }
  return zoomAt(view, p, 1 / view.k)
}

/** Zooms by `factor` keeping the drawing point under `point` (viewport px) where it is. */
export function zoomAt(view: View, point: Point, factor: number): View {
  const k = clampK(view.k * factor)
  const f = k / view.k
  return { k, x: point.x - (point.x - view.x) * f, y: point.y - (point.y - view.y) * f }
}

export function panBy(view: View, dx: number, dy: number): View {
  return { k: view.k, x: view.x + dx, y: view.y + dy }
}

/**
 * Keeps the drawing reachable: at least KEEP_PX of it (or all of it when it is smaller than that) stays inside the box
 * on each axis.
 */
export function clampView(view: View, box: Box, natural: Size, keep = KEEP_PX): View {
  if (!usable(box) || !usable(natural)) return view
  const w = natural.w * view.k
  const h = natural.h * view.k
  const kx = Math.min(keep, w)
  const ky = Math.min(keep, h)
  // The drawing spans [x, x + w]; kx of it must overlap [0, box.w].
  const x = Math.min(box.w - kx, Math.max(kx - w, view.x))
  const y = Math.min(box.h - ky, Math.max(ky - h, view.y))
  return { k: view.k, x, y }
}

/** "60%" */
export function percentLabel(k: number): string {
  return `${Math.round(k * 100)}%`
}

/** What a screen reader hears after a keyboard or button zoom. */
export function zoomSpeech(k: number, fit: boolean): string {
  return fit ? 'Fit to window' : `Zoom ${Math.round(k * 100)} percent`
}

/** The `data-value` of the zoom group: "fit" or the scale to two places. */
export function zoomDataValue(k: number, fit: boolean): string {
  return fit ? 'fit' : String(Math.round(k * 100) / 100)
}

export interface OverviewRects {
  /** The panel (the whole drawing scaled down). */
  panel: Size
  /** Panel px per drawing px. */
  scale: number
  /** The viewport's rectangle in panel px, clipped to the panel. */
  rect: { x: number; y: number; w: number; h: number }
}

/** The overview panel is at most 168 x 120, or a quarter of the viewport's smaller side, whichever is less. */
export function overviewMax(box: Box): Size {
  const quarter = Math.max(24, Math.min(box.w, box.h) * 0.25)
  return { w: Math.min(168, quarter), h: Math.min(120, quarter) }
}

/** The overview panel and the rectangle for the view now shown. */
export function overviewRects(view: View, box: Box, natural: Size): OverviewRects {
  const max = overviewMax(box)
  const scale = usable(natural) ? Math.min(1, max.w / natural.w, max.h / natural.h) : 1
  const panel = { w: Math.max(1, natural.w * scale), h: Math.max(1, natural.h * scale) }
  const x0 = (-view.x / view.k) * scale
  const y0 = (-view.y / view.k) * scale
  const x1 = x0 + (box.w / view.k) * scale
  const y1 = y0 + (box.h / view.k) * scale
  const cx0 = Math.min(panel.w, Math.max(0, x0))
  const cy0 = Math.min(panel.h, Math.max(0, y0))
  const cx1 = Math.min(panel.w, Math.max(0, x1))
  const cy1 = Math.min(panel.h, Math.max(0, y1))
  return { panel, scale, rect: { x: cx0, y: cy0, w: Math.max(0, cx1 - cx0), h: Math.max(0, cy1 - cy0) } }
}

/** The view that centres the drawing point under (px, py) of the overview panel in the viewport. */
export function centerOnOverview(view: View, box: Box, natural: Size, panelPoint: Point): View {
  const { scale } = overviewRects(view, box, natural)
  const nx = Math.min(natural.w, Math.max(0, panelPoint.x / scale))
  const ny = Math.min(natural.h, Math.max(0, panelPoint.y / scale))
  return { k: view.k, x: box.w / 2 - nx * view.k, y: box.h / 2 - ny * view.k }
}

/** The zoom factor for a wheel event: 1.1 per notch (100 px), pinch (ctrl) deltas are continuous. */
export function wheelFactor(deltaY: number, deltaMode: number, ctrl: boolean): number {
  const px = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 100 : 1)
  if (!Number.isFinite(px) || px === 0) return 1
  if (ctrl && Math.abs(px) < 50) return Math.exp(-px * 0.01)
  const clamped = Math.max(-300, Math.min(300, px))
  return Math.pow(1.1, -clamped / 100)
}

export type ViewKey = { type: 'pan'; dx: number; dy: number } | { type: 'zoom'; factor: number } | { type: 'fit' } | { type: 'actual' } | { type: 'overview' } | { type: 'source' } | { type: 'full' }

/** What a key asks of the focused viewport; null for any key that keeps its own job. Arrows scroll the way a scroll area does. */
export function viewKey(e: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): ViewKey | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  const step = e.shiftKey ? PAN_STEP_BIG : PAN_STEP
  switch (e.key) {
    case 'ArrowLeft':
      return { type: 'pan', dx: step, dy: 0 }
    case 'ArrowRight':
      return { type: 'pan', dx: -step, dy: 0 }
    case 'ArrowUp':
      return { type: 'pan', dx: 0, dy: step }
    case 'ArrowDown':
      return { type: 'pan', dx: 0, dy: -step }
    case '+':
    case '=':
      return { type: 'zoom', factor: KEY_ZOOM_STEP }
    case '-':
    case '_':
      return { type: 'zoom', factor: 1 / KEY_ZOOM_STEP }
    case '0':
    case 'Home':
      return { type: 'fit' }
    case '1':
      return { type: 'actual' }
    case 'o':
    case 'O':
      return { type: 'overview' }
    case 's':
    case 'S':
      return { type: 'source' }
    case 'f':
    case 'F':
      return { type: 'full' }
    default:
      return null
  }
}

// ---------- Large diagrams (8.3) ----------

export const LARGE_SHAPES = 40
export const LARGE_FIT = 0.4
/** Over this many bytes of source the drawing waits for "Draw it anyway". */
export const DRAW_GUARD_BYTES = 64 * 1024
export const SHAPE_SELECTOR = 'g.node, g.cluster, .actor, .entity'
export const LABEL_LIST_MAX = 60

export function isLargeDiagram(shapes: number, fit: number): boolean {
  return shapes > LARGE_SHAPES || fit < LARGE_FIT
}

export function largeNote(shapes: number): string {
  const what = shapes > 0 ? `${shapes} ${shapes === 1 ? 'shape' : 'shapes'}` : 'many shapes'
  return `Large diagram, ${what}. Zoom in to read, or open the larger view.`
}

export const GUARD_TEXT = 'This diagram is very large and may be slow to draw.'
export const TRUNCATED_TEXT = 'The preview stops here, so this diagram is not drawn. Open the file to see all of it.'

/** True when the drawing is bigger than the viewport at the scale now shown. */
export function biggerThanViewport(natural: Size, box: Box, k: number): boolean {
  return natural.w * k > box.w + 1 || natural.h * k > box.h + 1
}

/** The visually hidden text of a drawing: its shape labels in order, or a pointer to the source. */
export function diagramText(labels: readonly string[], shapes: number): string {
  if (shapes === 0 && labels.length === 0) return ''
  if (shapes > LABEL_LIST_MAX) return `${shapes} shapes; read the source for the full text.`
  const clean: string[] = []
  for (const raw of labels) {
    const l = raw.replace(/\s+/g, ' ').trim()
    if (l && clean[clean.length - 1] !== l) clean.push(l)
  }
  return clean.length > 0 ? `Contains: ${clean.join(', ')}.` : ''
}

export function hintText(context: 'detail' | 'dialog'): string {
  return context === 'dialog'
    ? 'Drag to move. Scroll or pinch to zoom. Arrow keys move, plus and minus zoom, 0 fits.'
    : 'Drag to move. Ctrl + scroll or pinch to zoom. Arrow keys move, plus and minus zoom, 0 fits.'
}

// ---------- Source and errors (8.6, 8.8) ----------

/** 1-based line and column of a caret index. */
export function lineColumn(text: string, index: number): { line: number; column: number } {
  const at = Math.max(0, Math.min(index, text.length))
  let line = 1
  let last = -1
  for (let i = text.indexOf('\n'); i !== -1 && i < at; i = text.indexOf('\n', i + 1)) {
    line++
    last = i
  }
  return { line, column: at - last }
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/** "812 B", "2.7 KB", "1.2 MB" */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** "Line 4, column 12 · 2.7 KB" */
export function sourceStatus(text: string, caret: number): string {
  const { line, column } = lineColumn(text, caret)
  return `Line ${line}, column ${column} · ${sizeLabel(byteLength(text))}`
}

/** The line number Mermaid names in a message ("Parse error on line 2"), or null. */
export function errorLine(message: string): number | null {
  const m = /\bline\s+(\d{1,6})\b/i.exec(message)
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 ? n : null
}

export function errorSentence(message: string): string {
  const line = errorLine(message)
  return line !== null
    ? `This diagram has a syntax error on line ${line}, so it cannot be drawn. The source is below.`
    : `This diagram cannot be drawn: ${message}.`
}

export const REFUSED_TEXT = 'OrgAI did not show this drawing because it contained active content.'

/** [start, end) of the 1-based line in the text (clamped to the last line), for selecting it. */
export function lineRange(text: string, line: number): { start: number; end: number } {
  let start = 0
  for (let n = 1; n < line; n++) {
    const nl = text.indexOf('\n', start)
    if (nl === -1) break
    start = nl + 1
  }
  const nl = text.indexOf('\n', start)
  return { start, end: nl === -1 ? text.length : nl }
}
