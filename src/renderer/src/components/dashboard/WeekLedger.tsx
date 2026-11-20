import type { KeyboardEvent, ReactElement } from 'react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useRovingFocus } from '../connectors/useRovingFocus'
import { barHeight, columnLabels, dayAriaLabel, dayReadout, maxDayRuns, trackHeight, type DayBucket } from '../../lib/activityStrip'

/**
 * The 7-day ledger of Your week (docs/design/dashboard-overhaul.md 7.7.1, micro-visualisation): one fact, runs per day.
 * Seven equal columns, oldest left, today right; each column is a native button (one Tab stop, roving) holding a bar on a
 * linear scale from zero (at least 2 px for a day with runs, only the baseline hairline for none) and, for a day with a
 * failed run, a hollow ring above the bar. The readout line under the columns is a plain paragraph (not live) that says
 * today, or the hovered, focused or pinned day. Arrows, Home and End move; Enter or Space pins (aria-pressed); Esc unpins.
 * Nothing here animates.
 */

function DayColumn({
  day,
  labels,
  max,
  track,
  pinned,
  onPin,
  onHover,
  onFocusDay
}: {
  day: DayBucket
  labels: ReturnType<typeof columnLabels>[number]
  max: number
  track: number
  pinned: boolean
  onPin: () => void
  onHover: (on: boolean) => void
  onFocusDay: (on: boolean) => void
}): ReactElement {
  const h = barHeight(day.runs, max, track)
  const failed = day.outcomes.failed > 0
  return (
    <button
      type="button"
      className="dash-strip-day"
      data-testid="dash-strip-day"
      data-day={day.key}
      data-runs={day.runs}
      data-failed={failed ? 'true' : undefined}
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
      <span className="dash-strip-track" data-track={track} style={{ height: track }} aria-hidden="true">
        {failed && <span className="dash-strip-ring" data-testid="dash-strip-ring" style={{ bottom: h + 3 }} />}
        {h > 0 && <span className="dash-strip-bar" data-testid="dash-strip-bar" style={{ height: h }} />}
      </span>
      <span className="dash-strip-labels" aria-hidden="true">
        <span className="dash-strip-initial">{labels.initial}</span>
        <span className="dash-strip-end" data-end={labels.end === 'Today' ? 'today' : labels.end ? 'first' : undefined}>
          {labels.end}
        </span>
      </span>
    </button>
  )
}

export function WeekLedger({ days, wide }: { days: readonly DayBucket[]; wide: boolean }): ReactElement {
  const track = trackHeight(wide)
  const max = useMemo(() => maxDayRuns(days), [days])
  const labels = useMemo(() => columnLabels(days), [days])

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
    // Esc unpins the readout and stops there, so it does not also leave customise mode.
    if (e.key === 'Escape' && pinned) {
      e.stopPropagation()
      setPinned(null)
      return
    }
    roving.onKeyDown(e)
  }

  return (
    <div className="dash-ledger" data-testid="dash-strip" data-track={track}>
      <div ref={groupRef} className="dash-strip-days" role="group" aria-label="Runs per day, last 7 days" data-track={track} onKeyDown={onKeyDown} onFocus={roving.onFocus}>
        {days.map((d, i) => (
          <DayColumn
            key={d.key}
            day={d}
            labels={labels[i]}
            max={max}
            track={track}
            pinned={pinned === d.key}
            onPin={() => setPinned((p) => (p === d.key ? null : d.key))}
            onHover={(on) => setHover((h) => (on ? d.key : h === d.key ? null : h))}
            onFocusDay={(on) => setFocused((f) => (on ? d.key : f === d.key ? null : f))}
          />
        ))}
      </div>
      <p className="dash-strip-readout" data-testid="dash-strip-readout">
        {dayReadout(shown)}
      </p>
    </div>
  )
}
