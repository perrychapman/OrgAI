import type { CSSProperties, ReactElement } from 'react'
import type { Schedule } from '@shared/types'
import { scheduleColour, weekDays } from '../../lib/schedulesBoard'
import { showHidden } from '../../lib/hiddenChars'

/**
 * "This week": Monday to Sunday, today highlighted, each day's runs as coloured time chips from the schedules' own
 * rules. Turned-off schedules stay in the strip, faded. A list under the heading reads the same week for a screen
 * reader; the cells themselves are one labelled group each.
 */
export default function WeekStrip({ list, now, globalPaused }: { list: readonly Schedule[]; now: number; globalPaused: boolean }): ReactElement {
  const days = weekDays(list, now, globalPaused)
  return (
    <section className="schedule-week glass" aria-labelledby="schedule-week-h" data-testid="schedule-week">
      <h2 id="schedule-week-h" className="schedule-section-title">
        This week
      </h2>
      <ol className="schedule-week-grid">
        {days.map((d) => (
          <li key={d.index} className={`schedule-day-cell${d.today ? ' is-today' : ''}`} data-testid="schedule-week-day" aria-label={d.label} aria-current={d.today ? 'date' : undefined}>
            <div className="schedule-day-head" aria-hidden="true">
              <span className="schedule-day-name">{d.name}</span>
              <span className="schedule-day-date">{d.date}</span>
            </div>
            <ul className="schedule-day-chips" aria-hidden="true">
              {d.chips.map((c) => (
                <li key={`${c.scheduleId}-${c.at}`} className={`schedule-chip${c.off ? ' is-off' : ''}${c.at < now ? ' is-past' : ''}`} style={{ '--schedule-colour': scheduleColour(list, c.scheduleId) } as CSSProperties} title={`${showHidden(c.name)} at ${c.time}${c.off ? ' (off)' : c.at < now ? ' (already past)' : ''}`}>
                  <span className="schedule-chip-time">{c.time}</span>
                  <span className="schedule-chip-name">{showHidden(c.name)}</span>
                </li>
              ))}
              {d.more > 0 && <li className="schedule-chip-more">+{d.more} more</li>}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  )
}
