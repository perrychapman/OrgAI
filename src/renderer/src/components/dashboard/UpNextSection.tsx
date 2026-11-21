import type { CSSProperties, ReactElement } from 'react'
import { useMemo, useRef, useState } from 'react'
import { CalendarClock, CirclePause } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { clockLabel } from '../../lib/dashboard'
import { upNextName, upNextRows } from '../../lib/upNext'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { saveSchedulesPaused, useSchedules } from '../schedules/useSchedules'
import { DashSection, useDashboard } from './DashboardContext'
import { useNow } from './useDashboardData'

/**
 * Up next (section id `upnext`, docs/design/dashboard-usage-redesign components/UpNext): the next schedule firings, read
 * through the hook the Schedules page uses. The time sits in a fixed-width mono column so names align; the badge says how
 * far away the firing is and takes the accent tone within the hour. "Pause all" (the same setting the Schedules page
 * switches) is offered while schedules exist; while they are paused one line says so in place of the rows, with the way
 * back. Not drawn without schedules, or without a firing to show.
 */
export function UpNextSection(): ReactElement | null {
  const { caps, announce, arriving, still } = useDashboard()
  const projects = useAppStore((s) => s.projects)
  const openSchedules = useAppStore((s) => s.openSchedules)
  const sched = useSchedules()
  // Minute-fresh "In 40 min" badges; the figures are never announced.
  const now = useNow(30_000)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const moreRef = useRef<HTMLButtonElement | null>(null)

  const paused = sched.paused === true
  const total = sched.list?.length ?? 0
  const rows = useMemo(() => (sched.list && !paused ? upNextRows(sched.list, now, projects, clockLabel) : []), [sched.list, paused, now, projects])
  const empty = total === 0 || (!paused && rows.length === 0)
  const shown = more ? rows : rows.slice(0, caps.schedules)
  const hidden = rows.length - caps.schedules
  const draw = arriving && !still

  const setPaused = async (v: boolean): Promise<void> => {
    // The button stays focusable while saving (a disabled control drops keyboard focus); a second press waits.
    if (busy) return
    const before = sched.paused === true
    sched.setPausedLocal(v)
    setBusy(true)
    try {
      await saveSchedulesPaused(v)
      announce(v ? 'All schedules paused.' : 'Schedules resumed.')
    } catch {
      sched.setPausedLocal(before)
      announce(v ? 'Schedules could not be paused. Try again.' : 'Schedules could not be resumed. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const actions = (
    <span className="dash-head-actions">
      {!paused && (
        <Button variant="ghost" size="sm" testId="dash-upnext-pause" ariaLabel="Pause all schedules" onClick={() => void setPaused(true)}>
          Pause all
        </Button>
      )}
      <Button variant="ghost" size="sm" testId="dash-upnext-schedules" onClick={() => openSchedules()}>
        Schedules
      </Button>
    </span>
  )

  return (
    <DashSection id="upnext" testId="dash-upnext" icon={CalendarClock} empty={empty} count={paused ? undefined : rows.length} headExtra={actions}>
      {paused ? (
        <div className="dash-upnext-paused" data-testid="dash-upnext-paused">
          <span className="dash-upnext-paused-icon" aria-hidden="true">
            <Icon icon={CirclePause} size="md" />
          </span>
          <p className="dash-upnext-paused-text">Schedules are paused. Nothing will start until you resume them.</p>
          <Button variant="secondary" size="sm" testId="dash-upnext-resume" onClick={() => void setPaused(false)}>
            Resume schedules
          </Button>
        </div>
      ) : (
        <>
          <ul className="dash-rows dash-upnext-list" data-testid="dash-upnext-list">
            {shown.map((r, i) => (
              <li key={r.schedule.id} className={draw ? 'dash-upnext-row motion-enter' : 'dash-upnext-row'} style={{ '--i': i } as CSSProperties} data-testid="dash-upnext-row" data-id={r.schedule.id} data-soon={r.soon ? '' : undefined}>
                <button type="button" className="dash-upnext-main" data-testid="dash-upnext-open" data-row-main="" aria-label={upNextName(r)} title={`${r.schedule.name}. ${r.kind} on ${r.project}`} onClick={() => openSchedules({ scheduleId: r.schedule.id })}>
                  <span className="dash-upnext-when dash-num" aria-hidden="true">
                    <span className="dash-upnext-clock">{r.clock}</span>
                    <span className="dash-upnext-day">{r.day}</span>
                  </span>
                  <span className="dash-upnext-text" aria-hidden="true">
                    <span className="dash-upnext-name">{r.schedule.name}</span>
                    <span className="dash-upnext-sub">
                      <span className="dash-clip">{r.project}</span> · <span>{r.kind}</span>
                    </span>
                  </span>
                  <span className="dash-upnext-away" aria-hidden="true">
                    <Badge tone={r.soon ? 'accent' : 'neutral'}>{r.away}</Badge>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {hidden > 0 || more ? (
            <button
              ref={moreRef}
              type="button"
              className="btn ghost sm dash-upnext-more"
              data-testid="dash-upnext-more"
              aria-expanded={more}
              onClick={() => {
                const collapsing = more
                setMore(!more)
                if (collapsing) requestAnimationFrame(() => moreRef.current?.focus())
              }}
            >
              {more ? 'Show fewer' : `Show ${hidden} more`}
            </button>
          ) : null}
        </>
      )}
    </DashSection>
  )
}
