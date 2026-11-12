import type { ReactElement } from 'react'
import { useId, useState } from 'react'
import { ChevronDown, ChevronRight, Pause, Pencil, Play, Trash2, Zap } from 'lucide-react'
import type { ScheduleRowView } from '@shared/view/schedules'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import ScheduleHistory from './ScheduleHistory'

/**
 * One schedule on the Schedules page: name, unread mark, state chip, target and timing, next run, last result, the
 * row actions and a History disclosure (opening it clears the unread count in main).
 */
export default function ScheduleRow({
  row,
  busy,
  historyKey,
  onRunNow,
  onToggle,
  onEdit,
  onDelete,
  onHistoryOpened,
  announce
}: {
  row: ScheduleRowView
  /** An action of this row is in flight. */
  busy: boolean
  /** Bumped when schedules:changed names this schedule. */
  historyKey: number
  onRunNow: () => void
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
  onHistoryOpened: () => void
  announce: (text: string) => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  const uid = useId()
  const headingId = `${uid}-name`
  const historyId = `${uid}-history`
  return (
    <li className="schedule-row" data-testid="schedule-row" data-schedule-id={row.id} data-state={row.chip.label} aria-labelledby={headingId}>
      <div className="schedule-row-head">
        <h2 className="schedule-row-name" id={headingId} tabIndex={-1} title={row.name}>
          {row.name}
        </h2>
        {row.unread > 0 && (
          <span className="schedule-unread" data-testid="schedule-unread" title={`${row.unread} new in the history`}>
            <span className="schedule-unread-dot" aria-hidden="true" />
            <span className="sr-only">{row.unread} new</span>
          </span>
        )}
        <Badge tone={row.chip.tone} testId="schedule-state" title={row.chip.reason}>
          {row.chip.label}
        </Badge>
        {row.fromAgent && <span className="schedule-row-origin">Added from a chat</span>}
      </div>
      {row.chip.reason && (
        <p className={`schedule-row-reason${row.chip.label === 'Needs attention' ? ' is-warning' : ''}`} data-testid="schedule-state-reason">
          {row.chip.reason}
        </p>
      )}
      <dl className="schedule-row-facts">
        <div>
          <dt>Runs as</dt>
          <dd data-testid="schedule-target">{row.target}</dd>
        </div>
        <div>
          <dt>When</dt>
          <dd data-testid="schedule-timing">{row.timing}</dd>
        </div>
        <div>
          <dt>Next run</dt>
          <dd data-testid="schedule-next" title={row.next.title || undefined}>
            {row.next.relative}
            {row.next.absolute && <span className="schedule-row-abs"> · {row.next.absolute}</span>}
          </dd>
        </div>
        <div>
          <dt>Last result</dt>
          <dd data-testid="schedule-last">{row.lastResult}</dd>
        </div>
      </dl>
      <div className="schedule-row-actions" role="group" aria-label={`Actions for ${row.name}`}>
        <Button size="sm" icon={Zap} disabled={busy} onClick={onRunNow} testId="schedule-run-now" ariaLabel={`Run ${row.name} now`}>
          Run now
        </Button>
        {row.toggle && (
          <Button size="sm" icon={row.toggle === 'Pause' ? Pause : Play} disabled={busy} onClick={onToggle} testId="schedule-toggle" ariaLabel={`${row.toggle} ${row.name}`}>
            {row.toggle}
          </Button>
        )}
        <Button size="sm" icon={Pencil} disabled={busy} onClick={onEdit} testId="schedule-edit" ariaLabel={`Edit ${row.name}`}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" icon={Trash2} disabled={busy} onClick={onDelete} testId="schedule-delete" ariaLabel={`Delete ${row.name}`}>
          Delete
        </Button>
        <button
          type="button"
          className="link-btn schedule-history-toggle"
          aria-expanded={open}
          aria-controls={historyId}
          data-testid="schedule-history-toggle"
          onClick={() => {
            const next = !open
            setOpen(next)
            if (next) onHistoryOpened()
          }}
        >
          <Icon icon={open ? ChevronDown : ChevronRight} size="xs" />
          History{row.unread > 0 ? ` (${row.unread} new)` : ''}
        </button>
      </div>
      <div id={historyId} className="schedule-row-history" hidden={!open}>
        {open && <ScheduleHistory scheduleId={row.id} scheduleName={row.name} reloadKey={historyKey} announce={announce} />}
      </div>
    </li>
  )
}
