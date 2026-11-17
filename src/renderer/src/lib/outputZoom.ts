// The drawing's own size and its opening view for the diagram, SVG and image viewers. The pan/zoom maths moved to
// lib/diagramView.ts (docs/design/outputs-2.md section 8). No React, no DOM.
import { FIT_PAD, fitScale, type Box, type Size, type View } from './diagramView'

/** Vector drawings open at least this large (a wide, short diagram is panned, not shrunk to a sliver). */
export const VECTOR_FLOOR = 0.6
/** A diagram opens at most this large. */
export const DIAGRAM_OPEN_MAX = 2
/** An SVG is crisp at any size, so it may fill a big area. */
export const SVG_OPEN_MAX = 4
/** A raster image opens at 100% at most (never blown up to a blur). */
export const IMAGE_OPEN_MAX = 1

export interface InitialViewOptions {
  /** The smallest scale worth opening at. Used only when the drawing at that scale still fits the box's height. Default none. */
  floor?: number
  /** The largest scale to open at. Default 1. */
  max?: number
  /** Empty px kept around the drawing. Default FIT_PAD. */
  pad?: number
}

/**
 * The view a drawing opens in: contained in the box (min of the width and height ratios), no larger than `max`. When that
 * would be smaller than `floor` but the drawing at `floor` still fits the box's height, it opens at `floor` aligned to the
 * start, so the user pans sideways instead of reading a 25 px sliver. An unusable box or size gives 100% at the origin.
 */
export function initialView(natural: Size, box: Box, { floor = 0, max = 1, pad = FIT_PAD }: InitialViewOptions = {}): View {
  const ok = (s: Size): boolean => Number.isFinite(s.w) && Number.isFinite(s.h) && s.w > 0 && s.h > 0
  if (!ok(natural) || !ok(box)) return { k: 1, x: 0, y: 0 }
  const contain = fitScale(box, natural, pad, max)
  const lowest = Math.min(floor, max)
  const availH = Math.max(1, box.h - pad * 2)
  if (lowest > 0 && contain < lowest && natural.h * lowest <= availH + 0.5) {
    return { k: lowest, x: pad, y: (box.h - natural.h * lowest) / 2 }
  }
  return { k: contain, x: (box.w - natural.w * contain) / 2, y: (box.h - natural.h * contain) / 2 }
}

/** The drawing's own size from an svg element's viewBox, else its width and height attributes; null when neither says. */
export function svgNaturalSize(viewBox: string | null, width: string | null, height: string | null): { w: number; h: number } | null {
  const vb = (viewBox ?? '').trim().split(/[\s,]+/).map(Number)
  if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) return { w: vb[2], h: vb[3] }
  const w = parseFloat(width ?? '')
  const h = parseFloat(height ?? '')
  // A percentage is not a size.
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 && !(width ?? '').includes('%') && !(height ?? '').includes('%')) return { w, h }
  return null
}
