import type { PointerEvent, ReactElement } from 'react'
import { scrubSlot, sparkShape, sparkXY, type SparkPoint } from '../../lib/usageDashboard'

export const SPARK_W = 200
export const SPARK_H = 28
const PAD = 3

/**
 * A full-tile-width, 28 px trend line for a KPI tile. The svg stretches (preserveAspectRatio none, non-scaling
 * stroke); dots are positioned spans so they stay round. Decorative and pointer-only: moving over it reports the
 * nearest bucket slot through `onScrub` (only when the slot changes) and marks it; the spend chart is the keyboard
 * path. Unknown-cost buckets are hollow dots on the baseline (a gap, never zero). No animation.
 */
export default function Sparkline({
  points,
  active,
  onScrub,
  area = false,
  draw = false
}: {
  points: readonly SparkPoint[]
  /** The slot being read out, or null. */
  active: number | null
  onScrub: (i: number | null) => void
  /** Fill under each line (redesign: area sparklines on the KPI band and the Your week stat cards). */
  area?: boolean
  /** Wipe in left to right once (page arrival or the person's filter change; motion-draw-wipe). */
  draw?: boolean
}): ReactElement | null {
  const shape = sparkShape(points, SPARK_W, SPARK_H, PAD)
  if (!shape) return null
  // Each line segment closed down to the baseline; a gap (unknown bucket) splits the area as it splits the line.
  const areas = area
    ? shape.lines.map((l) => {
        const pts = l.trim().split(/\s+/)
        const first = pts[0]?.split(',')[0]
        const last = pts[pts.length - 1]?.split(',')[0]
        return first !== undefined && last !== undefined && pts.length > 1 ? `${first},${SPARK_H - PAD} ${l} ${last},${SPARK_H - PAD}` : null
      })
    : []
  const left = (x: number): string => `${(x / SPARK_W) * 100}%`
  const at = (e: PointerEvent<HTMLElement>): number | null => {
    const r = e.currentTarget.getBoundingClientRect()
    if (r.width <= 0) return null
    return scrubSlot((e.clientX - r.left) / r.width, points.length)
  }
  const move = (e: PointerEvent<HTMLElement>): void => {
    const i = at(e)
    if (i !== active) onScrub(i)
  }
  const mark = active === null ? null : sparkXY(points, active, SPARK_W, SPARK_H, PAD)
  return (
    <span
      className="usage-kpi-spark-box"
      data-testid="usage-kpi-spark"
      aria-hidden="true"
      onPointerMove={move}
      onPointerDown={move}
      onPointerLeave={() => onScrub(null)}
      onPointerCancel={() => onScrub(null)}
    >
      <svg
        className={draw ? 'usage-kpi-spark motion-draw-wipe' : 'usage-kpi-spark'}
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        preserveAspectRatio="none"
        focusable="false"
      >
        {areas.map((a, i) => (a ? <polygon key={`a${i}`} points={a} className="spark-area" /> : null))}
        {shape.lines.map((l, i) => (
          <polyline key={i} points={l} fill="none" className="usage-kpi-spark-line" vectorEffect="non-scaling-stroke" />
        ))}
        {shape.partial.map((p, i) => (
          <line
            key={`p${i}`}
            x1={p.x}
            x2={p.x}
            y1={p.y - 5}
            y2={p.y - 2}
            className="usage-kpi-spark-tick"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {shape.hollow.map((p, i) => (
        <span
          key={`h${i}`}
          className="usage-kpi-dot usage-kpi-dot-hollow"
          data-cost-kind="unknown"
          style={{ left: left(p.x), top: p.y }}
        />
      ))}
      {shape.last && <span className="usage-kpi-dot usage-kpi-dot-end" style={{ left: left(shape.last.x), top: shape.last.y }} />}
      {mark && (
        <span
          className="usage-kpi-dot usage-kpi-dot-scrub"
          data-testid="usage-kpi-scrub-dot"
          style={{ left: left(mark.x), top: mark.y }}
        />
      )}
    </span>
  )
}
