import type { CSSProperties, ReactElement } from 'react'
import { GAUGE_START_DEG, GAUGE_SWEEP_DEG, arcPath, gaugeFraction } from '../../lib/gauge'
import { useCountUp } from '../../lib/useCountUp'
import { useReducedMotion } from '../../lib/canvas'
import { LIMITS_MAX, type LimitEntry } from './useLimitEntries'

/**
 * A plan window or budget as an arc (docs/design/dashboard-usage-redesign/project/components/PlanGauge): the arc in
 * --brand-ui-from, --warning from 80%, --danger when limited, and the percentage text in the matching text colour so the
 * level never lives in the arc alone. One text alternative per gauge (the full windows sentence). On arrival the arc
 * traces clockwise and the percentage counts up; otherwise it is drawn at rest.
 */

const SIZE = 44
const STROKE = 5
const R = (SIZE - STROKE) / 2

const TRACK = arcPath(SIZE / 2, SIZE / 2, R, GAUGE_START_DEG, GAUGE_SWEEP_DEG)

/**
 * `still`: the page's Pause motion (the Dashboard passes layout.motionPaused); like reduced motion it draws the gauge at
 * rest with the final percentage, whatever `arrive` says.
 */
export function PlanGauge({ entry, arrive, still = false }: { entry: LimitEntry; arrive: boolean; still?: boolean }): ReactElement {
  const reduced = useReducedMotion()
  const frozen = reduced || still
  const drawing = arrive && !frozen
  const frac = gaugeFraction(entry.pct)
  const shown = useCountUp(entry.pct === null ? null : Math.round(entry.pct), { arriving: drawing, still: frozen })
  const label = [entry.name, entry.main, entry.resets].filter(Boolean).join(', ')
  return (
    <li className="plan-gauge" data-testid="plan-gauge" data-connection={entry.id} data-kind={entry.kind} data-level={entry.level} title={entry.title}>
      <span className="plan-gauge-dial" role="img" aria-label={`${label}. ${entry.title}`}>
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} aria-hidden="true" focusable="false">
          <path className="plan-gauge-track" d={TRACK} pathLength={1} />
          {entry.pct !== null && frac > 0 && (
            <path className={drawing ? 'plan-gauge-fill motion-draw-trace' : 'plan-gauge-fill'} d={TRACK} pathLength={1} style={{ '--frac': frac } as CSSProperties} />
          )}
        </svg>
        <span className="plan-gauge-pct" aria-hidden="true">
          {shown === null ? '' : `${Math.round(shown)}%`}
        </span>
      </span>
      <span className="plan-gauge-text" aria-hidden="true">
        <span className="plan-gauge-name">{entry.name}</span>
        <span className="plan-gauge-main">{entry.main}</span>
        {entry.resets && <span className="plan-gauge-resets">{entry.resets}</span>}
      </span>
    </li>
  )
}

/** At most LIMITS_MAX gauges, then "+N more"; nothing without entries (hidden for API keys and the mock adapter). */
export function PlanGauges({ entries, arrive, still = false, className }: { entries: readonly LimitEntry[]; arrive: boolean; still?: boolean; className?: string }): ReactElement | null {
  const shown = entries.slice(0, LIMITS_MAX)
  const more = entries.length - shown.length
  if (shown.length === 0) return null
  return (
    <ul className={className ? `plan-gauges ${className}` : 'plan-gauges'} data-testid="plan-gauges" aria-label="Plan limits">
      {shown.map((e) => (
        <PlanGauge key={e.id} entry={e} arrive={arrive} still={still} />
      ))}
      {more > 0 && (
        <li className="plan-gauge-more" data-testid="plan-gauge-more">
          +{more} more
        </li>
      )}
    </ul>
  )
}
