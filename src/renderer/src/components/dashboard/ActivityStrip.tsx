import type { CSSProperties, KeyboardEvent, ReactElement } from 'react'
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { formatDuration } from '../../lib/cost'
import { barHeight, dayAriaLabel, dayLedger, dayReadout, ledgerTicks, ledgerTotals, maxDayCost, shortDate, waitedShown, weekdayInitial, type DayBucket } from '../../lib/activityStrip'
import { Cost } from '../ui/Cost'
import { useRovingFocus } from '../connectors/useRovingFocus'
import { useAllSummaries, useNow } from './useDashboardData'

/**
 * The Last 14 days strip (docs/design/dashboard-2.md section 7): 14 native buttons, one per local day, each an
 * aria-hidden SVG of that day's cost (a bar above the baseline) and its runs (one tick per run below it, by outcome).
 * One tab stop (today at rest), arrows move, Enter / Space pins a day, Esc unpins. The readout line below says the
 * hovered, focused or pinned day in words; it is not a live region and nothing here floats over content.
 */

const SIZES = {
  compact: { track: 40, ledger: 30, ticks: 6, height: 74 },
  tall: { track: 72, ledger: 48, ticks: 10, height: 126 }
} as const

const TICK_H = 3
const TICK_PITCH = 5

function DayColumn({
  day,
  index,
  last,
  max,
  size,
  pinned,
  onPin,
  onHover,
  onFocusDay
}: {
  day: DayBucket
  index: number
  last: boolean
  max: number
  size: 'compact' | 'tall'
  pinned: boolean
  onPin: () => void
  onHover: (on: boolean) => void
  onFocusDay: (on: boolean) => void
}): ReactElement {
  const dim = SIZES[size]
  const h = barHeight(day, max, dim.track)
  const top = dim.track - h
  const hollow = day.costKind === 'partial' || day.costKind === 'unknown'
  const circleY = day.costKind === 'unknown' ? dim.track - 4.5 : Math.max(4.5, top - 6)
  const ticks = ledgerTicks(day.outcomes, dim.ticks)
  const style = { '--i': index } as CSSProperties
  return (
    <button
      type="button"
      className="dash-strip-day"
      data-testid="dash-strip-day"
      data-day={day.key}
      data-runs={day.runs}
      data-cost-kind={day.costKind}
      data-today={day.today ? 'true' : undefined}
      data-pinned={pinned ? 'true' : undefined}
      aria-pressed={pinned}
      aria-label={dayAriaLabel(day)}
      onClick={onPin}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onFocus={() => onFocusDay(true)}
      onBlur={() => onFocusDay(false)}
    >
      <svg className="dash-strip-svg" width="100%" height={dim.height} aria-hidden="true" focusable="false">
        <line className="dash-strip-baseline" x1="0" x2="100%" y1={dim.track + 0.5} y2={dim.track + 0.5} />
        {h > 0 && <rect className="dash-strip-bar" data-today={day.today ? 'true' : undefined} x="20%" width="60%" y={top} height={h} rx="2" style={style} />}
        {hollow && <circle className="dash-strip-hollow" cx="50%" cy={circleY} r="3" />}
        {ticks.map((t, i) => {
          const y = dim.track + 3 + i * TICK_PITCH + (t.outcome === 'more' ? 2 : 0)
          return <rect key={i} className="dash-strip-tick" data-outcome={t.outcome} x="20%" width="60%" y={y} height={TICK_H} rx="1" />
        })}
      </svg>
      <span className="dash-strip-labels" aria-hidden="true">
        {(index === 0 || last) && <span className={`dash-strip-end${last ? ' is-last' : ''}`}>{last ? 'Today' : shortDate(day.start)}</span>}
      </span>
      {size === 'tall' && (
        <span className="dash-strip-initial" aria-hidden="true">
          {weekdayInitial(day.start)}
        </span>
      )}
    </button>
  )
}

export function ActivityStrip({ size }: { size: 'compact' | 'tall' }): ReactElement {
  const headingId = useId()
  const summaries = useAllSummaries()
  const now = useNow(60_000)
  const days = useMemo(() => dayLedger(summaries, now), [summaries, now])
  const totals = useMemo(() => ledgerTotals(days), [days])
  const max = useMemo(() => maxDayCost(days), [days])

  const [pinned, setPinned] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const shownKey = hover ?? focused ?? (pinned && days.some((d) => d.key === pinned) ? pinned : null)
  const shown = days.find((d) => d.key === shownKey) ?? days[days.length - 1]

  const groupRef = useRef<HTMLDivElement>(null)
  const roving = useRovingFocus(groupRef, '[data-testid=dash-strip-day]')
  // Today is the tab stop at rest; the hook keeps whichever day has focus.
  useLayoutEffect(() => {
    const group = groupRef.current
    if (!group || group.contains(document.activeElement)) return
    for (const el of group.querySelectorAll<HTMLElement>('[data-testid=dash-strip-day]')) el.tabIndex = el.dataset.today === 'true' ? 0 : -1
  })

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && pinned) {
      e.stopPropagation()
      setPinned(null)
      return
    }
    roving.onKeyDown(e)
  }

  const cost = totals.cost
  return (
    <section className="dash-section dash-strip" data-testid="dash-strip" data-size={size} aria-labelledby={headingId}>
      <div className="dash-strip-head">
        <h2 id={headingId} className="dash-strip-title">
          Last 14 days
        </h2>
        <dl className="dash-strip-totals">
          <div data-testid="dash-strip-runs">
            <dt>Runs</dt>
            <dd className="dash-num">{totals.runs}</dd>
          </div>
          <div data-testid="dash-cost">
            <dt>Cost</dt>
            <dd>
              <Cost value={cost} compact className="dash-num" />
            </dd>
          </div>
          {waitedShown(totals.waitingMs) && (
            <div data-testid="dash-strip-waiting">
              <dt>Waited on you</dt>
              <dd className="dash-num">{formatDuration(totals.waitingMs)}</dd>
            </div>
          )}
        </dl>
      </div>
      <div ref={groupRef} className="dash-strip-days" role="group" aria-label="Runs and cost per day, last 14 days" onKeyDown={onKeyDown} onFocus={roving.onFocus}>
        {days.map((d, i) => (
          <DayColumn
            key={d.key}
            day={d}
            index={i}
            last={i === days.length - 1}
            max={max}
            size={size}
            pinned={pinned === d.key}
            onPin={() => setPinned((p) => (p === d.key ? null : d.key))}
            onHover={(on) => setHover((h) => (on ? d.key : h === d.key ? null : h))}
            onFocusDay={(on) => setFocused((f) => (on ? d.key : f === d.key ? null : f))}
          />
        ))}
      </div>
      <p className="dash-strip-readout" data-testid="dash-strip-readout">
        {totals.runs === 0 ? 'No runs in the last 14 days.' : dayReadout(shown)}
      </p>
    </section>
  )
}
