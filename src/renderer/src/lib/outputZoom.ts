// Pure zoom maths for the diagram and SVG previews (docs/design/outputs.md section 12). No React, no DOM.

export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 4
/** One step of the zoom buttons and the + / - keys. */
export const ZOOM_STEP = 1.25
/** Fit never enlarges a drawing past this (a tiny diagram is not blown up to a blur). */
export const FIT_MAX = 2

/** 'fit' follows the box; a number is a fixed scale (1 = 100%). */
export type ZoomValue = 'fit' | number

export function clampZoom(n: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(n * 100) / 100))
}

/** The scale that fits `content` into `box` (both width x height in px), clamped; 1 when either is unusable. */
export function fitScale(content: { w: number; h: number }, box: { w: number; h: number }): number {
  if (!(content.w > 0) || !(content.h > 0) || !(box.w > 0) || !(box.h > 0)) return 1
  // Rounded down, so the fitted drawing never overflows its box by a rounding step (and so never shows a scrollbar).
  const raw = Math.min(box.w / content.w, box.h / content.h)
  return Math.min(FIT_MAX, clampZoom(Math.floor(raw * 100 + 1e-9) / 100))
}

/** The numeric scale a value stands for right now. */
export function scaleOf(value: ZoomValue, content: { w: number; h: number }, box: { w: number; h: number }): number {
  return value === 'fit' ? fitScale(content, box) : clampZoom(value)
}

/** One step in or out from the scale now shown (stepping from Fit starts at its computed scale). */
export function stepZoom(current: number, dir: 'in' | 'out'): number {
  return clampZoom(dir === 'in' ? current * ZOOM_STEP : current / ZOOM_STEP)
}

/** The zoom a key asks for: + / = in, - / _ out, 0 actual size; null for any other key (it keeps its job). */
export function zoomKeyAction(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): 'in' | 'out' | 'actual' | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  if (e.key === '+' || e.key === '=') return 'in'
  if (e.key === '-' || e.key === '_') return 'out'
  if (e.key === '0') return 'actual'
  return null
}

/** "125%" */
export function zoomPercent(scale: number): string {
  return `${Math.round(scale * 100)}%`
}

/** The drawing's own size from an svg element's viewBox, else its width and height attributes; null when neither says. */
export function svgNaturalSize(viewBox: string | null, width: string | null, height: string | null): { w: number; h: number } | null {
  const vb = (viewBox ?? '').trim().split(/[\s,]+/).map(Number)
  if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) return { w: vb[2], h: vb[3] }
  const w = parseFloat(width ?? '')
  const h = parseFloat(height ?? '')
  // A percentage is not a size.
  if (w > 0 && h > 0 && !(width ?? '').includes('%') && !(height ?? '').includes('%')) return { w, h }
  return null
}
