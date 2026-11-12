import type { ReactElement } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { CalendarClock, CalendarPlus, Minus, Pause, Pencil, Play, TriangleAlert } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Schedule, ScheduleProposalItem, SchedulesProposalPayload } from '@shared/types'
import { SCHEDULE_APPROVAL_NOTE, SCHEDULE_UNATTENDED_NOTE } from '@shared/view/schedules'
import { clampLabel } from '../../lib/clampLabel'
import { showHidden } from '../../lib/hiddenChars'
import { anyUnattended, scheduleItemView, type ExistingSchedules, type ScheduleItemView } from '../../lib/scheduleProposal'
import { useAppStore } from '../../store/useAppStore'
import { Badge, type BadgeTone } from '../ui/Badge'
import { Icon } from '../ui/Icon'
import { ClampText } from './ClampText'

const BADGE: Record<ScheduleProposalItem['action'], { tone: BadgeTone; icon: LucideIcon }> = {
  create: { tone: 'success', icon: CalendarPlus },
  update: { tone: 'warning', icon: Pencil },
  remove: { tone: 'danger', icon: Minus },
  pause: { tone: 'info', icon: Pause },
  resume: { tone: 'info', icon: Play }
}

/**
 * The stored schedules, read once while a schedules card is open. undefined while loading and when the read failed
 * (the card then names items by the summary main wrote).
 */
export function useExistingSchedules(active: boolean): ExistingSchedules {
  const [list, setList] = useState<Schedule[] | undefined>(undefined)
  useEffect(() => {
    if (!active) return
    let live = true
    window.orgai.schedules
      .list()
      .then((l) => {
        if (live) setList(l)
      })
      .catch(() => {
        if (live) setList(undefined)
      })
    return () => {
      live = false
    }
  }, [active])
  return list
}

function ScheduleItem({ view }: { view: ScheduleItemView }): ReactElement {
  const badge = BADGE[view.action]
  const name = view.name ? clampLabel(showHidden(view.name), 80) : ''
  return (
    <li className="sched-prop-item" data-testid="proposal-schedule-item" data-action={view.action} data-schedule={name}>
      <div className="sched-prop-head">
        <Badge tone={badge.tone} icon={badge.icon}>
          {view.actionText}
        </Badge>
        {name && <span className="sched-prop-name">{name}</span>}
        {view.hidden && (
          <Badge tone="danger" icon={TriangleAlert} testId="proposal-schedule-hidden">
            Contains hidden characters
          </Badge>
        )}
      </div>
      {view.summary && <p className="sched-prop-summary">{view.summary}</p>}
      {view.rows.length > 0 && (
        <dl className="sched-prop-fields">
          {view.rows.map((row) => (
            <div key={row.key} className="sched-prop-field" data-field={row.key}>
              <dt>{row.label}</dt>
              {row.key === 'prompt' ? (
                <dd>
                  <ClampText text={String(row.value)} label={name || 'the schedule'} />
                </dd>
              ) : row.key === 'next' ? (
                <dd data-testid="proposal-schedule-next">{Array.isArray(row.value) && row.value.length > 0 ? row.value.join(', ') : 'No upcoming runs'}</dd>
              ) : (
                <dd>{showHidden(String(row.value))}</dd>
              )}
            </div>
          ))}
        </dl>
      )}
    </li>
  )
}

/** The body of a schedules proposal: one block per change, then the two plain sentences about unattended runs. */
export function SchedulesProposalBody({ payload, existing }: { payload: SchedulesProposalPayload; existing?: ExistingSchedules }): ReactElement {
  const projectList = useAppStore((s) => s.projects)
  const projects = useMemo(() => projectList.map((p) => ({ id: p.id, name: showHidden(p.name) })), [projectList])
  const views = useMemo(() => payload.items.map((item) => scheduleItemView(item, existing, projects)), [payload.items, existing, projects])
  return (
    <div className="sched-prop" data-testid="proposal-schedules">
      {payload.rationale.trim() && <p className="proposal-rationale">{showHidden(payload.rationale)}</p>}
      <ul className="sched-prop-list" aria-label="Schedule changes in this proposal">
        {views.map((v, i) => (
          <ScheduleItem key={`${v.action}-${v.name ?? ''}-${i}`} view={v} />
        ))}
      </ul>
      {anyUnattended(payload.items) && (
        <p className="sched-prop-note" data-testid="proposal-schedule-note">
          <Icon icon={CalendarClock} size="xs" />
          <span>
            {SCHEDULE_UNATTENDED_NOTE} {SCHEDULE_APPROVAL_NOTE}
          </span>
        </p>
      )}
    </div>
  )
}
