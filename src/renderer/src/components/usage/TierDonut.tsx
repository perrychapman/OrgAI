import type { CSSProperties, ReactElement } from 'react'
import { arcPath, donutSegments } from '../../lib/gauge'
import { pageCost, percentText } from '../../lib/usageEfficiency'
import type { TierKey, TierPart } from '../../lib/usageStaffing'
import { useDrawKey } from './useDrawKey'
import '../../styles/usage-donut.css'

/** Tier colours: the chart series in order (the neighbours alternate bright and mid), the remainder in chart-other. */
export const TIER_FILL: Record<TierKey, string> = {
  top: 'var(--chart-s1)',
  deep: 'var(--chart-s2)',
  everyday: 'var(--chart-s3)',
  fast: 'var(--chart-s4)',
  other: 'var(--chart-other)'
}

const SIZE = 120
const R = 46
const GAP_DEG = 2

/** The donut's one text alternative: every part with its cost and share, then the total. Same words as the legend. */
export function donutText(parts: readonly TierPart[], total: number): string {
  return `Cost by tier, ${pageCost(total)} in all. ${parts.map((p) => `${p.label} ${pageCost(p.costUsd)}, ${percentText(p.share)}`).join('. ')}.`
}

/**
 * Cost by tier as a donut: one arc per tier in chart colours with a gap between, tracing clockwise on arrival and on the
 * person's own filter change. Decorative to assistive tech: the legend list beside it (and the table under it) carry every
 * figure, and the whole drawing has one text alternative.
 */
export default function TierDonut({ parts, total, arriving, drawSeq }: { parts: readonly TierPart[]; total: number; arriving: boolean; drawSeq: number }): ReactElement {
  const segments = donutSegments(
    parts.map((p) => p.costUsd),
    GAP_DEG
  )
  const signature = parts.map((p) => `${p.key}:${p.costUsd}`).join(',')
  const { draw, key } = useDrawKey(drawSeq, signature, arriving)
  return (
    <div className="usage-donut" role="img" aria-label={donutText(parts, total)} data-testid="usage-tier-donut">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} aria-hidden="true" focusable="false">
        <circle className="usage-donut-track" cx={SIZE / 2} cy={SIZE / 2} r={R} />
        <g key={key}>
          {segments.map((s) => {
            const part = parts[s.index]!
            return (
              <path
                key={part.key}
                className={draw ? 'usage-donut-seg motion-draw-trace' : 'usage-donut-seg'}
                d={arcPath(SIZE / 2, SIZE / 2, R, s.startDeg, s.sweepDeg)}
                pathLength={1}
                stroke={TIER_FILL[part.key]}
                style={{ '--draw-delay': `calc(${Math.min(s.index, 5)} * var(--motion-stagger))` } as CSSProperties}
                data-testid="usage-tier-seg"
                data-tier={part.key}
              />
            )
          })}
        </g>
      </svg>
      <span className="usage-donut-center" aria-hidden="true">
        <span className="usage-donut-total">{pageCost(total)}</span>
        <span>in all</span>
      </span>
    </div>
  )
}
