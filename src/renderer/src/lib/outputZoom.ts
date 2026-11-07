// The drawing's own size for the diagram, SVG and image viewers. The pan/zoom maths moved to lib/diagramView.ts
// (docs/design/outputs-2.md section 8). No React, no DOM.

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
