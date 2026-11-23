import type { ReactElement } from 'react'
import type { Schedule } from '@shared/types'
import type { ScheduleRowView } from '@shared/view/schedules'
import { detailFacts, type CostFigure } from '../../lib/schedulesBoard'
import RunBars from './RunBars'
import type { HistoryState } from './useScheduleInsights'
import { showHidden } from '../../lib/hiddenChars'

/**
 * The selected schedule beside the list: name, where it runs, the task text, the plain facts and the last result.
 * Read-only: every action (run now, edit, delete, pause) lives on the row, so each has one place and one test id.
 * Weekly cost and the last-runs bars come from main's real history (runInsights); unknown stays unknown.
 */
export default function ScheduleDetail({ schedule, row, cost, history }: { schedule: Schedule; row: ScheduleRowView; cost: CostFigure; history: HistoryState | undefined }): ReactElement {
  const next = row.next.relative === 'Not scheduled while paused' ? 'Turned off' : `${row.next.relative}${row.next.absolute ? ` · ${row.next.absolute}` : ''}`
  const facts = [...detailFacts(schedule, row.timing), { label: 'Next run', value: next }]
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
        <div className="schedule-detail-fact">
          <dt>Weekly cost</dt>
          <dd data-testid="schedule-detail-cost" data-known={cost.known} title={cost.basis}>
            {cost.text}
            <span className="sr-only">. {cost.basis}</span>
          </dd>
        </div>
      </dl>
      <div className="schedule-detail-runs">
        <h3 className="schedule-detail-sub-h">Last runs</h3>
        <RunBars state={history} testId="schedule-detail-runbars" />
      </div>
      <p className="schedule-detail-note" data-testid="schedule-detail-note">
        Last result: {row.lastResult}
      </p>
    </aside>
  )
}
