import type { ReactElement } from 'react'
import { useId, useState } from 'react'
import type { HistoryState } from './useScheduleInsights'
import { runBars, runBarsSummary, usdText, type RunBar, type RunBarKind } from '../../lib/schedulesBoard'

const BAR_W = 9
const GAP = 4
const BAR_AREA = 22
const MARK_AREA = 9
const SLOT = BAR_W + GAP

function markPath(kind: RunBarKind, cx: number, cy: number): ReactElement {
  const r = 3
  switch (kind) {
    case 'error':
      return <path d={`M${cx - r} ${cy - r}L${cx + r} ${cy + r}M${cx + r} ${cy - r}L${cx - r} ${cy + r}`} className="runbars-mark-line" />
    case 'stopped':
      return <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} className="runbars-mark-fill" />
    case 'needs-you':
      return <path d={`M${cx} ${cy - r}L${cx + r} ${cy + r}L${cx - r} ${cy + r}Z`} className="runbars-mark-fill" />
    case 'running':
      return <circle cx={cx} cy={cy} r={r} className="runbars-mark-ring" />
    default:
      return <circle cx={cx} cy={cy} r={r} className="runbars-mark-fill" />
  }
}

/**
 * The last runs of one schedule as small bars: height = cost, shape under the bar = outcome (circle finished, cross
 * failed, square stopped, triangle needed you, open ring still running), dashed stub = cost unknown. Inline SVG, tokens
 * only. The group is focusable: Left / Right read one run in the line below; the label carries every run in words.
 */
export default function RunBars({ state, testId = 'schedule-runbars' }: { state: HistoryState | undefined; testId?: string }): ReactElement {
  const uid = useId()
  const [active, setActive] = useState<number | null>(null)
  if (!state || state.status === 'loading') return <span className="runbars-note" data-testid={testId} data-status="loading">Loading recent runs…</span>
  if (state.status === 'failed') return <span className="runbars-note" data-testid={testId} data-status="failed">Recent runs could not be loaded.</span>
  if (!state.entries) return <span className="runbars-note" data-testid={testId} data-status="unknown">Recent runs unknown.</span>
  const bars = runBars(state.entries)
  if (bars.length === 0) return <span className="runbars-note" data-testid={testId} data-status="empty">No runs yet.</span>
  const max = Math.max(0.0001, ...bars.map((b) => b.costUsd ?? 0))
  const width = bars.length * SLOT - GAP
  const summary = runBarsSummary(bars)
  const full = `${summary} ${bars.map((b) => b.label).join('; ')}.`
  const shown: RunBar | null = active !== null ? (bars[active] ?? null) : null
  const move = (d: number): void => setActive((a) => Math.min(bars.length - 1, Math.max(0, (a ?? (d > 0 ? -1 : bars.length)) + d)))
  return (
    <span className="runbars" data-testid={testId} data-status="ok">
      <span
        className="runbars-chart"
        role="group"
        tabIndex={0}
        aria-label={full}
        aria-describedby={`${uid}-read`}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') (e.preventDefault(), move(1))
          else if (e.key === 'ArrowLeft') (e.preventDefault(), move(-1))
          else if (e.key === 'Escape' && active !== null) (e.stopPropagation(), setActive(null))
        }}
        onBlur={() => setActive(null)}
      >
        <svg width={width} height={BAR_AREA + MARK_AREA} viewBox={`0 0 ${width} ${BAR_AREA + MARK_AREA}`} aria-hidden="true" focusable="false">
          {bars.map((b, i) => {
            const x = i * SLOT
            const known = b.costUsd !== null
            const h = known ? Math.max(3, Math.round(((b.costUsd as number) / max) * BAR_AREA)) : 6
            return (
              <g key={b.id} className={`runbars-bar kind-${b.kind}${active === i ? ' is-active' : ''}`} onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(null)}>
                <rect x={x} y={BAR_AREA - h} width={BAR_W} height={h} rx={1.5} className={known ? 'runbars-fill' : 'runbars-unknown'} />
                {markPath(b.kind, x + BAR_W / 2, BAR_AREA + MARK_AREA / 2)}
              </g>
            )
          })}
        </svg>
      </span>
      <span id={`${uid}-read`} className="runbars-read" data-testid={`${testId}-readout`}>
        {shown ? shown.label : `${summary}${bars.some((b) => b.costUsd !== null) ? ` Tallest bar ${usdText(max)}.` : ' Costs unknown.'}`}
      </span>
    </span>
  )
}
