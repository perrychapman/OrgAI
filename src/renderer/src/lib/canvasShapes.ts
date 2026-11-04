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
