import type { ReactElement } from 'react'
import type { Schedule } from '@shared/types'
import type { ScheduleRowView } from '@shared/view/schedules'
import { detailFacts } from '../../lib/schedulesBoard'
import { showHidden } from '../../lib/hiddenChars'

/**
 * The selected schedule beside the list: name, where it runs, the task text, the plain facts and the last result.
 * Read-only: every action (run now, edit, delete, pause) lives on the row, so each has one place and one test id.
 * The last-runs bars wait for per-run cost from main (docs/design/ui-overhaul); nothing is drawn from made-up data.
 */
export default function ScheduleDetail({ schedule, row }: { schedule: Schedule; row: ScheduleRowView }): ReactElement {
  const facts = detailFacts(schedule, row.timing)
  return (
    <aside className="schedule-detail glass" aria-label="Selected schedule" data-testid="schedule-detail" data-schedule-id={schedule.id}>
      <div>
        <h2 className="schedule-detail-name" data-testid="schedule-detail-name">
          {showHidden(schedule.name)}
        </h2>
        <p className="schedule-detail-sub">{showHidden(row.target)}</p>
      </div>
      <p className="schedule-detail-task" data-testid="schedule-detail-task">
        {showHidden(schedule.prompt)}
      </p>
      <dl className="schedule-detail-facts">
        {facts.map((f) => (
          <div key={f.label} className="schedule-detail-fact">
            <dt>{f.label}</dt>
            <dd>{showHidden(f.value)}</dd>
          </div>
        ))}
      </dl>
      <p className="schedule-detail-note" data-testid="schedule-detail-note">
        Last result: {row.lastResult}
      </p>
    </aside>
  )
}
