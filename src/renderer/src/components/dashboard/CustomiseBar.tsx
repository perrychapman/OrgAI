import type { ReactElement } from 'react'
import { useId, useMemo } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { Button } from '../ui/Button'
import { FOCUS_FIGURES, FOCUS_TITLES, type FocusFigure } from '../../lib/dashboardLayout'
import { hasDecisionsCard, weekRecap } from '../../lib/weekRecap'
import { useAllSummaries, useNow } from './useDashboardData'

/** Why Decisions cannot lead yet; the radio is disabled while this is true. */
export const DECISIONS_UNAVAILABLE = 'Decisions is not drawn yet: no run this week carries decision counts.'

/**
 * The Customise bar (shown only while customising): the one-line help, the lead figure of Your week as a captioned radio
 * group, and Reset layout. A figure that Your week does not draw (Decisions until a run of the week carries the count) is
 * disabled with its reason in view, not accepted as a choice that changes nothing. Mounted only while customising, so its
 * subscription to the run summaries costs the page nothing otherwise.
 */
export function CustomiseBar({ focus, onFocus, onReset }: { focus: FocusFigure; onFocus: (focus: FocusFigure) => void; onReset: () => void }): ReactElement {
  const summaries = useAllSummaries()
  const projects = useAppStore((s) => s.projects)
  const now = useNow(60_000)
  const decisions = useMemo(() => hasDecisionsCard(weekRecap(summaries, projects, now)), [summaries, projects, now])
  const name = useId()
  const captionId = useId()
  const reasonId = useId()
  return (
    <div className="dash-customise-bar motion-fade" id="dash-customise-bar" data-testid="dash-customise-bar">
      <p>Move, hide or show sections. Changes save as you go.</p>
      <div className="dash-lead-field">
        <span className="dash-lead-caption" id={captionId} data-testid="dash-lead-caption">
          Lead figure in Your week
        </span>
        <div className="seg" role="radiogroup" aria-labelledby={captionId} aria-describedby={decisions ? undefined : reasonId} data-testid="dash-lead-group">
          {FOCUS_FIGURES.map((f) => {
            const inert = f === 'decisions' && !decisions
            return (
              <label key={f} className={`seg-item${focus === f ? ' on' : ''}${inert ? ' is-inert' : ''}`} title={inert ? DECISIONS_UNAVAILABLE : undefined}>
                <input type="radio" name={name} value={f} checked={focus === f} disabled={inert} onChange={() => onFocus(f)} />
                {FOCUS_TITLES[f]}
              </label>
            )
          })}
        </div>
        {!decisions && (
          <span className="dash-lead-reason" id={reasonId} data-testid="dash-lead-reason">
            {DECISIONS_UNAVAILABLE}
          </span>
        )}
      </div>
      <Button variant="ghost" size="sm" testId="dash-customise-reset" onClick={onReset}>
        Reset layout
      </Button>
    </div>
  )
}
