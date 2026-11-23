import type { CSSProperties, ReactElement } from 'react'
import { useId, useState } from 'react'
import { ChevronDown, ChevronRight, Pause, Pencil, Play, Trash2, Zap } from 'lucide-react'
import type { ScheduleRowView } from '@shared/view/schedules'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Switch } from '../ui/Switch'
import { ContextMenu, useContextMenu, type MenuEntry } from '../ui/ContextMenu'
import ScheduleHistory from './ScheduleHistory'
import { showHidden } from '../../lib/hiddenChars'

/**
 * One schedule on the Schedules page: name, unread mark, state chip, target and timing, next run, last result, the
 * row actions and a History disclosure (opening it clears the unread count in main).
 */
export default function ScheduleRow({
  row,
  busy,
  historyKey,
  selected,
  colour,
  tone,
  onSelect,
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
  /** The detail panel shows this schedule. */
  selected: boolean
  /** A token colour (var(--chart-*)) shared with the week strip. */
  colour: string
  /** Last outcome dot: ok, bad or none. */
  tone: 'ok' | 'bad' | 'none'
  onSelect: () => void
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
  const menu = useContextMenu<string>()
  const fallbackFocus = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-testid=schedules-view] h1')
  // A right click returns focus to Run now, or to the card heading while the card is busy and that button is inert.
  const runNowOrHeading = (li: HTMLElement): HTMLElement | undefined => {
    const btn = li.querySelector<HTMLButtonElement>('[data-testid=schedule-run-now]')
    return (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true' ? btn : li.querySelector<HTMLElement>(`[id="${headingId}"]`)) ?? undefined
  }
  const why = busy ? 'Working on it' : undefined
  const isOff = row.toggle !== 'Pause'
  const nextText = row.next.relative === 'Not scheduled while paused' ? 'Turned off' : row.next.relative
  const menuItems = (): MenuEntry[] => [
    { id: 'run-now', label: 'Run now', icon: Zap, onSelect: onRunNow, disabled: busy, disabledReason: why, testId: 'schedule-menu-run-now' },
    ...(row.toggle ? [{ id: 'toggle', label: row.toggle, icon: row.toggle === 'Pause' ? Pause : Play, onSelect: onToggle, disabled: busy, disabledReason: why, testId: 'schedule-menu-toggle' }] : []),
    { id: 'edit', label: 'Edit', icon: Pencil, onSelect: onEdit, disabled: busy, disabledReason: why, testId: 'schedule-menu-edit' },
    'separator',
    { id: 'delete', label: 'Delete', icon: Trash2, onSelect: onDelete, destructive: true, disabled: busy, disabledReason: why, testId: 'schedule-menu-delete' }
  ]
  return (
    <li
      className={`schedule-row glass${selected ? ' is-selected' : ''}${isOff ? ' is-off' : ''}`}
      style={{ '--schedule-colour': colour } as CSSProperties}
      data-testid="schedule-row"
      data-schedule-id={row.id}
      data-state={row.chip.label}
      aria-labelledby={headingId}
      onContextMenu={(e) => menu.onContextMenu(e, row.id, { fallbackFocus, invoker: runNowOrHeading(e.currentTarget) })}
      onKeyDown={(e) => {
        const t = e.target
        // From the focused control inside the card; the menu itself handles its own keys.
        if (t instanceof HTMLElement && t !== e.currentTarget) menu.onKeyDown(e, row.id, { anchor: t, invoker: t, fallbackFocus })
      }}
    >
      <div className="schedule-row-main">
        <div className="schedule-row-head">
          <h2 className="schedule-row-name" id={headingId} tabIndex={-1} title={showHidden(row.name)}>
            <button type="button" className="schedule-row-pick" aria-pressed={selected} onClick={onSelect} data-testid="schedule-select" title="Show details">
              {showHidden(row.name)}
            </button>
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
        <p className="schedule-row-sub">
          <span data-testid="schedule-timing">{row.timing}</span>
          <span aria-hidden="true"> · </span>
          <span className="sr-only">, runs as </span>
          <span data-testid="schedule-target">{showHidden(row.target)}</span>
        </p>
      </div>
      <div className="schedule-row-side">
        <span className="schedule-row-next">
          <span className="schedule-row-key">Next run </span>
          <span data-testid="schedule-next" title={row.next.title || undefined}>
            {nextText}
            {row.next.absolute && <span className="schedule-row-abs"> · {row.next.absolute}</span>}
          </span>
        </span>
        <span className={`schedule-row-last tone-${tone}`}>
          <span className="schedule-row-dot" aria-hidden="true" />
          <span className="schedule-row-key">Last result </span>
          <span data-testid="schedule-last">{row.lastResult}</span>
        </span>
      </div>
      {row.toggle && (
        <Switch checked={row.toggle === 'Pause'} onChange={() => !busy && onToggle()} label={`${row.name}, ${row.toggle === 'Pause' ? 'on' : 'off'}`}testId="schedule-toggle" />
      )}
      {row.chip.reason && (
        <p className={`schedule-row-reason${row.chip.label === 'Needs attention' ? ' is-warning' : ''}`} data-testid="schedule-state-reason">
          {row.chip.reason}
        </p>
      )}
      <div className="schedule-row-actions" role="group" aria-label={`Actions for ${row.name}`}>
        <Button size="sm" icon={Zap} inert={busy} onClick={onRunNow} testId="schedule-run-now" ariaLabel={`Run ${row.name} now`}>
          Run now
        </Button>
        <Button size="sm" icon={Pencil} inert={busy} onClick={onEdit} testId="schedule-edit" ariaLabel={`Edit ${row.name}`}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" icon={Trash2} inert={busy} onClick={onDelete} testId="schedule-delete" ariaLabel={`Delete ${row.name}`}>
          Delete
        </Button>
        <button
          type="button"
          className="link-btn schedule-history-toggle"
          aria-expanded={open}
          aria-controls={historyId}
          data-testid="schedule-history-toggle"
          onClick={() => {
            setOpen(!open)
          }}
        >
          <Icon icon={open ? ChevronDown : ChevronRight} size="xs" />
          History{row.unread > 0 ? ` (${row.unread} new)` : ''}
        </button>
      </div>
      <div id={historyId} className="schedule-row-history" hidden={!open}>
        {open && <ScheduleHistory scheduleId={row.id} scheduleName={row.name} reloadKey={historyKey} announce={announce} onLoaded={onHistoryOpened} />}
      </div>
      <ContextMenu control={menu} label={`Actions for ${showHidden(row.name)}`} items={menuItems} testId="schedule-menu" />
    </li>
  )
}
