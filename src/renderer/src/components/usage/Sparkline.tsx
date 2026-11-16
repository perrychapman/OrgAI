import type { ReactElement } from 'react'
import { sparkShape, type SparkPoint } from '../../lib/usageDashboard'

export const SPARK_W = 72
export const SPARK_H = 20

/**
 * A 72x20 trend line for a KPI tile. Decorative: the tile's value and delta carry the meaning, so it is aria-hidden.
 * Unknown-cost buckets are hollow circles on the baseline (never zero); lower-bound buckets get a short tick.
 * No animation.
 */
export default function Sparkline({ points }: { points: readonly SparkPoint[] }): ReactElement | null {
  const shape = sparkShape(points, SPARK_W, SPARK_H, 2)
  if (!shape) return null
  return (
    <svg
      className="usage-kpi-spark"
      data-testid="usage-kpi-spark"
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      width={SPARK_W}
      height={SPARK_H}
      aria-hidden="true"
      focusable="false"
    >
      {shape.lines.map((l, i) => (
        <polyline
          key={i}
          points={l}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
      {shape.partial.map((p, i) => (
        <line key={`p${i}`} x1={p.x} x2={p.x} y1={p.y - 4} y2={p.y - 1.5} stroke="currentColor" strokeWidth={1} />
      ))}
      {shape.hollow.map((p, i) => (
        <circle
          key={`h${i}`}
          cx={p.x}
          cy={p.y}
          r={1.6}
          fill="none"
          stroke="var(--chart-unknown)"
          strokeWidth={1}
          data-cost-kind="unknown"
        />
      ))}
      {shape.last && <circle cx={shape.last.x} cy={shape.last.y} r={1.8} fill="currentColor" />}
    </svg>
  )
}
