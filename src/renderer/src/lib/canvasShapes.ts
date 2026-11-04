/**
 * Node outlines the radial edge clips against (docs/design/canvas-themes.md section 3): a box (card, compact), a
 * circle (station) or a flat-top hexagon with vertices (+-hw, 0) and (+-hw / 2, +-hh) (hex tile). Pure.
 */
export type NodeShape =
  | { kind: 'box'; cx: number; cy: number; hw: number; hh: number }
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'hex'; cx: number; cy: number; hw: number; hh: number }

/** Subway lines: stroke width of a reporting line and the corner radius of a Right angle line. */
export const STATION_LINE_WIDTH = 6
export const STATION_CORNER_RADIUS = 12

/** Gap left between the line and the outline so an arrow tip does not touch the border. */
export const CLIP_GAP = 2

export type Side = 'top' | 'right' | 'bottom' | 'left'

/** A laid-out node: top-left corner and size. */
export interface PlacedBox {
  x: number
  y: number
  width: number
  height: number
}

/** Message handle ids: every node exposes one hidden source and one hidden target per side. */
export const MSG_OUT = 'msg-out'
export const MSG_IN = 'msg-in'
export const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left']
export function msgHandleId(kind: 'out' | 'in', side: Side): string {
  return `${kind === 'out' ? MSG_OUT : MSG_IN}-${side}`
}

/**
 * The sides a message edge leaves and enters by, from the laid-out boxes, so the line runs through open space instead
 * of behind the bodies it joins. The axis is the one with more room between the two boxes (siblings side by side use
 * right to left or left to right, a report below uses bottom to top). A pair joined by a reporting line
 * (`reportingAxis`: 'y' top-down, 'x' left-right) takes the other axis so the message never lies on that line; if the
 * boxes overlap on that axis the message leaves and enters by the same side and loops out and back. Pure.
 */
export function messageSides(from: PlacedBox, to: PlacedBox, reportingAxis?: 'x' | 'y'): { out: Side; in: Side } {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2)
  const dy = to.y + to.height / 2 - (from.y + from.height / 2)
  const gapX = Math.abs(dx) - (from.width + to.width) / 2
  const gapY = Math.abs(dy) - (from.height + to.height) / 2
  const horizontal = reportingAxis ? reportingAxis === 'y' : gapX >= gapY
  const gap = horizontal ? gapX : gapY
  const d = horizontal ? dx : dy
  const [plus, minus]: [Side, Side] = horizontal ? ['right', 'left'] : ['bottom', 'top']
  if (gap < 0) return d >= 0 ? { out: plus, in: plus } : { out: minus, in: minus }
  return d >= 0 ? { out: plus, in: minus } : { out: minus, in: plus }
}

/** Where the ray from the shape's centre toward (tx, ty) leaves the shape grown by `gap`. */
export function exitPoint(shape: NodeShape, tx: number, ty: number, gap: number = CLIP_GAP): { x: number; y: number } {
  const dx = tx - shape.cx
  const dy = ty - shape.cy
  if (dx === 0 && dy === 0) return { x: shape.cx, y: shape.cy }
  let t: number
  if (shape.kind === 'circle') {
    t = (shape.r + gap) / Math.hypot(dx, dy)
  } else if (shape.kind === 'box') {
    const sx = dx === 0 ? Infinity : (shape.hw + gap) / Math.abs(dx)
    const sy = dy === 0 ? Infinity : (shape.hh + gap) / Math.abs(dy)
    t = Math.min(sx, sy)
  } else {
    // Flat-top hexagon: |y| <= hh (flat top and bottom) and the slanted edges satisfy hh * |x| + (hw / 2) * |y| <= hh * hw.
    // Grow the half sizes by the gap so the outline moves out about `gap` along the axes.
    const hw = shape.hw + gap
    const hh = shape.hh + gap
    const sy = dy === 0 ? Infinity : hh / Math.abs(dy)
    const slant = hh * Math.abs(dx) + (hw / 2) * Math.abs(dy)
    const ss = slant === 0 ? Infinity : (hh * hw) / slant
    t = Math.min(sy, ss)
  }
  return { x: shape.cx + dx * t, y: shape.cy + dy * t }
}
