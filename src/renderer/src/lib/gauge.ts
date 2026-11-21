/**
 * Arc geometry for the redesign's gauges (PlanGauge, the Usage burn dial, the Cost by tier donut). Pure SVG path maths:
 * angles in degrees, 0 at twelve o'clock, clockwise. Draw the track and the fill with `pathLength="1"` so the fill is
 * `stroke-dasharray: <fraction> 1` and the trace recipe (`motion-draw-trace`) works for any arc length.
 */

const rad = (deg: number): number => ((deg - 90) * Math.PI) / 180

/** A point on a circle at `deg` (0 = top, clockwise). */
export function polar(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  return { x: cx + r * Math.cos(rad(deg)), y: cy + r * Math.sin(rad(deg)) }
}

/** An SVG arc path from `startDeg` sweeping `sweepDeg` clockwise (0 < sweep < 360; a full circle is two halves). */
export function arcPath(cx: number, cy: number, r: number, startDeg: number, sweepDeg: number): string {
  const sweep = Math.max(0, Math.min(359.999, sweepDeg))
  const a = polar(cx, cy, r, startDeg)
  const b = polar(cx, cy, r, startDeg + sweep)
  const large = sweep > 180 ? 1 : 0
  const f = (n: number): string => (Math.round(n * 1000) / 1000).toString()
  return `M ${f(a.x)} ${f(a.y)} A ${f(r)} ${f(r)} 0 ${large} 1 ${f(b.x)} ${f(b.y)}`
}

/** A percentage (or null) as an arc fraction, clamped to 0..1. */
export function gaugeFraction(pct: number | null | undefined): number {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return 0
  return Math.min(1, Math.max(0, pct / 100))
}

/** The plan gauge's open arc: 270 degrees, gap at the bottom. */
export const GAUGE_START_DEG = -135
export const GAUGE_SWEEP_DEG = 270

/** Donut segments: each value's start and sweep in degrees, in order, a `gapDeg` between neighbours. Zero values drop. */
export function donutSegments(values: readonly number[], gapDeg = 2): { index: number; startDeg: number; sweepDeg: number; share: number }[] {
  const total = values.reduce((s, v) => s + (Number.isFinite(v) && v > 0 ? v : 0), 0)
  if (total <= 0) return []
  const parts = values.map((v, index) => ({ index, v: Number.isFinite(v) && v > 0 ? v : 0 })).filter((p) => p.v > 0)
  const gap = parts.length > 1 ? gapDeg : 0
  let at = 0
  return parts.map((p) => {
    const share = p.v / total
    const span = share * 360
    const seg = { index: p.index, startDeg: at + gap / 2, sweepDeg: Math.max(0, span - gap), share }
    at += span
    return seg
  })
}
