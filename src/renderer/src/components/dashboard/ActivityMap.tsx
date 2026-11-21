import type { CSSProperties, ReactElement } from 'react'
import { useId } from 'react'
import { BLOCK_LABELS, firstDayLabel, mapText, MAP_DAYS, todayText, type ActivityMap as ActivityMapModel } from '../../lib/activityMap'

/**
 * The activity map of Your week (docs/design/dashboard-usage-redesign components/ActivityMap): when runs started, 14 local
 * days across and six four-hour blocks down. A cell's strength is its share of the busiest block, mixed from surface-3
 * toward the accent text colour; a block that has not happened yet (later today) is an outline, never a zero; today's
 * column is outlined. The picture is one image with one text alternative that names the busiest blocks, and a footer
 * sentence says today's count in words; neither depends on colour. Columns fade in left to right only while the page
 * arrives (`.motion-draw-col`); under Pause motion and reduced motion they are simply there.
 *
 * Decorative and pointer-less by design: the numbers are in the text alternative and in Usage, which the heading link
 * opens (a 14-day period does not exist yet, so it opens 30 days).
 */

export function ActivityMap({
  map,
  draw,
  pending,
  onOpenUsage
}: {
  map: ActivityMapModel
  /** The columns fade in (page arrival, motion allowed). */
  draw: boolean
  /** History is still loading: reserve the space, draw nothing that could read as zero. */
  pending?: boolean
  onOpenUsage: () => void
}): ReactElement {
  const headId = useId()
  const text = mapText(map)
  const summary = pending ? '' : map.total === 0 ? 'No runs in 14 days' : `${map.total} ${map.total === 1 ? 'run' : 'runs'} · 14 days`
  return (
    <div className="dash-activity" data-testid="dash-activity" aria-labelledby={headId} role="group" data-pending={pending ? '' : undefined}>
      <div className="dash-activity-head">
        <h3 id={headId}>When your team worked</h3>
        {summary && (
          <span className="dash-num dash-activity-total" data-testid="dash-activity-total">
            {summary}
          </span>
        )}
        <button type="button" className="dash-activity-link" data-testid="dash-week-usage" aria-label="Open Usage for the last 30 days" onClick={onOpenUsage}>
          Open Usage
        </button>
      </div>
      {pending ? (
        <div className="dash-heat dash-heat-pending" aria-hidden="true" />
      ) : (
        <>
          <div className="dash-heat" role="img" aria-label={text} data-testid="dash-heat" style={{ '--cols': MAP_DAYS } as CSSProperties}>
            <div className="dash-heat-labels" aria-hidden="true">
              {BLOCK_LABELS.map((label) => (
                <span key={label} className="dash-heat-l dash-num">
                  {label}
                </span>
              ))}
            </div>
            <div className="dash-heat-cols">
              {map.days.map((d, c) => (
                <div
                  key={d.key}
                  className={draw ? 'dash-heat-col motion-draw-col' : 'dash-heat-col'}
                  data-testid="dash-heat-col"
                  data-date={d.key}
                  data-today={d.today ? '' : undefined}
                  style={{ '--col': c } as CSSProperties}
                >
                  {d.cells.map((cell, b) => (
                    <i key={b} className="dash-heat-cell" data-testid="dash-heat-cell" data-state={cell.state} data-runs={cell.runs} style={{ '--v': cell.strength } as CSSProperties} />
                  ))}
                </div>
              ))}
            </div>
          </div>
          <div className="dash-heat-foot">
            <span className="dash-num">{firstDayLabel(map)}</span>
            <span className="dash-heat-scale" aria-hidden="true">
              Fewer
              {[0.1, 0.35, 0.6, 0.9].map((v) => (
                <i key={v} style={{ '--v': v } as CSSProperties} />
              ))}
              More
            </span>
            <span data-testid="dash-activity-today">
              <b>Today</b> · {todayText(map)}
            </span>
          </div>
        </>
      )}
    </div>
  )
}
