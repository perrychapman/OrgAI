import type { ReactElement } from 'react'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Bot, CalendarDays, CirclePause } from 'lucide-react'
import type { TodoItem } from '@shared/types'
import { outcomeText } from '@shared/view/schedules'
import { useAppStore } from '../../store/useAppStore'
import { initTodos, useTodosStore } from '../../store/todosStore'
import { useSchedules } from '../schedules/useSchedules'
import { clockLabel } from '../../lib/dashboard'
import { openTodoRows, scheduledToday, scheduleTargetLabel } from '../../lib/todayModel'
import { startSessionFromTodo } from '../../lib/todoStart'
import { projectHue } from '../../lib/projectIdentity'
import { outcomeTone, pickRailRows, railDomain, railItemName, railTicks, railX, RAIL_PAD_PX, layoutRail } from '../../lib/scheduleRail'
import { Button } from '../ui/Button'
import { useConfirm } from '../ui/ConfirmDialog'
import { Icon } from '../ui/Icon'
import { DashSection, useDashboard } from './DashboardContext'
import { ProjectBadge } from './ProjectBadge'
import { afterFirstPaint } from './projectQueue'
import { useNow } from './useDashboardData'

/** Today (docs/design/dashboard-overhaul.md 7.5): what is scheduled and which open to-dos could start a session. */

const LOAD_AT_ONCE = 3

/** A dot's tooltip is anchored to its own edge this close to the rail's ends, so it never leaves the card. */
const TIP_EDGE_PX = 140

/** A to-do's project id for its badge; Chat has none (the neutral badge). */
const todoProjectId = (item: TodoItem): string => (item.scope.kind === 'project' ? item.scope.projectId : '')

/** The width of an element, kept current by a ResizeObserver (0 until it is mounted and measured). */
function useElementWidth(el: HTMLElement | null): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    if (!el) return undefined
    const measure = (): void => setWidth(el.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return width
}

/** Loads the Chat list and each project's list, three at a time, after first paint. A failed list stays unknown. */
function useTodayTodos(projectIds: readonly string[]): void {
  const key = projectIds.join('\u0000')
  useEffect(() => {
    initTodos()
    const scopes = [{ kind: 'chat' as const }, ...projectIds.map((projectId) => ({ kind: 'project' as const, projectId }))]
    let live = true
    let next = 0
    const worker = async (): Promise<void> => {
      while (live && next < scopes.length) {
        const scope = scopes[next++]
        try {
          await useTodosStore.getState().load(scope)
        } catch {
          // Skipped silently.
        }
      }
    }
    const cancel = afterFirstPaint(() => {
      for (let i = 0; i < LOAD_AT_ONCE; i++) void worker()
    })
    return () => {
      live = false
      cancel()
    }
    // projectIds is rebuilt each render; its joined key is the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}

export function TodaySection(): ReactElement | null {
  const { caps } = useDashboard()
  const now = useNow()
  const projects = useAppStore((s) => s.projects)
  const openSchedules = useAppStore((s) => s.openSchedules)
  const focusRun = useAppStore((s) => s.focusRun)
  const byScope = useTodosStore((s) => s.byScope)
  const sched = useSchedules()
  const { confirm, dialog } = useConfirm()
  const [moreSchedules, setMoreSchedules] = useState(false)
  const [moreTodos, setMoreTodos] = useState(false)
  const moreRef = useRef<HTMLButtonElement | null>(null)
  const rootRef = useRef<HTMLElement | null>(null)

  const projectIds = useMemo(() => projects.map((p) => p.id), [projects])
  useTodayTodos(projectIds)

  const paused = sched.paused === true
  const scheduleRows = useMemo(() => (sched.list && !paused ? scheduledToday(sched.list, now) : []), [sched.list, paused, now])
  const showPausedLine = paused && sched.list !== null
  const todoRows = useMemo(() => openTodoRows(byScope, projects), [byScope, projects])

  const noSchedules = scheduleRows.length === 0 && !showPausedLine
  const noGroups = noSchedules && todoRows.length === 0

  // With a cap, the next upcoming schedule is always drawn (pickRailRows), then the rest by time.
  const shownSchedules = useMemo(() => (moreSchedules ? scheduleRows : pickRailRows(scheduleRows, caps.schedules)), [moreSchedules, scheduleRows, caps.schedules])
  const nextRow = shownSchedules.find((r) => r.state === 'upcoming')
  const [railEl, setRailEl] = useState<HTMLDivElement | null>(null)
  const railWidth = useElementWidth(railEl)
  const domain = useMemo(() => (shownSchedules.length > 0 ? railDomain(shownSchedules.map((r) => r.at), now) : null), [shownSchedules, now])
  const placed = useMemo(
    () => (domain && railWidth > 0 ? layoutRail(shownSchedules.map((r) => ({ key: `${r.schedule.id}:${r.state}`, at: r.at, labelChars: clockLabel(r.at).length })), domain, railWidth) : []),
    [shownSchedules, domain, railWidth]
  )
  const ticks = useMemo(() => (domain ? railTicks(domain) : []), [domain])
  const nowX = domain && railWidth > 0 ? railX(now, domain, railWidth) : 0
  const shownTodos = moreTodos ? todoRows : todoRows.slice(0, caps.todos)
  const hiddenTodos = todoRows.length - caps.todos
  const date = useMemo(() => new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(now), [now])

  const startSession = async (row: (typeof todoRows)[number]): Promise<void> => {
    const ok = await startSessionFromTodo(row.item, confirm)
    if (!ok) {
      // A declined confirm leaves focus where it was: put it back on this row's button.
      requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(`[data-testid="dash-today-todo"][data-id="${CSS.escape(row.item.id)}"] [data-testid="dash-today-start"]`)?.focus())
    }
  }

  return (
    <>
      <DashSection id="upnext" testId="dash-today" icon={CalendarDays} empty={noGroups} sectionRef={rootRef} headExtra={<span className="dash-today-date">{date}</span>}>
        {!noSchedules && (
          <div className="dash-today-group" data-testid="dash-today-schedules">
            <h3 className="dash-today-h3">
              Scheduled
              {nextRow && (
                <span className="dash-today-next" aria-hidden="true">
                  <span className="dash-today-next-time">{clockLabel(nextRow.at)}</span> {nextRow.schedule.name}
                </span>
              )}
            </h3>
            {showPausedLine ? (
              <div className="dash-today-paused" data-testid="dash-today-paused">
                <span className="dash-today-paused-icon" aria-hidden="true">
                  <Icon icon={CirclePause} size="md" />
                </span>
                <p className="dash-today-paused-text">Schedules are paused. Nothing will start today.</p>
                <Button variant="ghost" size="sm" onClick={() => openSchedules()}>
                  Open schedules
                </Button>
              </div>
            ) : (
              <>
                <div className="dash-rail" role="group" aria-label="Scheduled today" ref={setRailEl} data-lanes={placed.some((p) => p.lane === 1) ? '2' : '1'}>
                  {railWidth > 0 && domain && (
                    <>
                      <span className="dash-rail-line" aria-hidden="true" />
                      <span className="dash-rail-elapsed" aria-hidden="true" style={{ width: Math.max(0, nowX - RAIL_PAD_PX) }} />
                      {ticks.map((t) => (
                        <span key={t} className="dash-rail-tick" aria-hidden="true" style={{ left: railX(t, domain, railWidth) }} />
                      ))}
                      <span className="dash-rail-now" aria-hidden="true" style={{ left: nowX }}>
                        <span className="dash-rail-now-label">Now</span>
                      </span>
                      {shownSchedules.map((r) => {
                        const s = r.schedule
                        const key = `${s.id}:${r.state}`
                        const spot = placed.find((p) => p.key === key)
                        if (!spot) return null
                        const target = scheduleTargetLabel(s.target, projects)
                        const outcome = r.state === 'ran' ? outcomeText({ result: 'started', outcome: s.lastEntry?.outcome, runId: s.lastEntry?.runId }) : ''
                        const runId = r.state === 'ran' ? s.lastEntry?.runId : undefined
                        const projectId = s.target.kind === 'team' ? s.target.projectId : undefined
                        const opens = runId && projectId ? 'run' : 'schedule'
                        const time = clockLabel(r.at)
                        const open = (): void => {
                          if (runId && projectId) void focusRun(projectId, runId)
                          else openSchedules({ scheduleId: s.id })
                        }
                        const isNext = r === nextRow
                        const align = spot.x < TIP_EDGE_PX ? 'start' : spot.x > railWidth - TIP_EDGE_PX ? 'end' : 'center'
                        return (
                          <Fragment key={key}>
                            <button
                              type="button"
                              className="dash-rail-dot"
                              data-testid="dash-today-schedule"
                              data-id={s.id}
                              data-state={r.state}
                              data-next={isNext ? 'true' : undefined}
                              data-tone={r.state === 'ran' ? outcomeTone(s.lastEntry?.outcome) : undefined}
                              data-align={align}
                              style={{ left: spot.x }}
                              aria-label={railItemName({ time, name: s.name, target, outcome: outcome || undefined, opens })}
                              onClick={open}
                            >
                              <span className="dash-rail-mark" aria-hidden="true" />
                              <span className="dash-rail-tip" aria-hidden="true">
                                <span className="dash-rail-tip-time">{time}</span> {s.name} · {target}
                                {outcome ? ` · ${outcome}` : ''}
                              </span>
                            </button>
                            {spot.lane !== null && (
                              <span className="dash-rail-time" data-lane={spot.lane} data-next={isNext ? 'true' : undefined} aria-hidden="true" style={{ left: spot.x }}>
                                {time}
                                {spot.extra > 0 ? ` +${spot.extra}` : ''}
                              </span>
                            )}
                          </Fragment>
                        )
                      })}
                    </>
                  )}
                </div>
                {scheduleRows.length > caps.schedules && (
                  // The shared Button has no aria-expanded; this is its markup (as the to-do "Show more" below).
                  <button
                    type="button"
                    className="btn ghost sm dash-today-more"
                    data-testid="dash-today-more-schedules"
                    aria-expanded={moreSchedules}
                    onClick={() => setMoreSchedules((v) => !v)}
                  >
                    {moreSchedules ? 'Show fewer' : `Show ${scheduleRows.length - caps.schedules} more`}
                  </button>
                )}
              </>
            )}
          </div>
        )}
        {todoRows.length > 0 && (
          <div className="dash-today-group" data-testid="dash-today-todos">
            <h3 className="dash-today-h3">
              To-dos <span className="dash-count">{todoRows.length}</span>
            </h3>
            <ul className="dash-today-todos">
              {shownTodos.map((r) => (
                <li key={r.item.id} className="dash-todo" data-testid="dash-today-todo" data-id={r.item.id} data-hue={projectHue(todoProjectId(r.item))}>
                  <ProjectBadge projectId={todoProjectId(r.item)} name={r.list} size="sm" />
                  <span className="dash-todo-text">
                    <span className="dash-row-name dash-todo-title" title={r.item.title}>
                      {r.item.title}
                    </span>
                    {/* The list and who added it are not drawn as a line: the badge says it, this is for screen readers. */}
                    <span className="sr-only">{r.agentAdded ? `${r.list} · Added by an assistant` : r.list}</span>
                  </span>
                  {r.agentAdded && (
                    <span className="dash-todo-agent" title="Added by an assistant" aria-hidden="true">
                      <Icon icon={Bot} size="sm" />
                    </span>
                  )}
                  <Button variant="secondary" size="sm" testId="dash-today-start" ariaLabel={`Start session for ${r.item.title}`} onClick={() => void startSession(r)}>
                    Start session
                  </Button>
                </li>
              ))}
            </ul>
            {hiddenTodos > 0 || moreTodos ? (
              <button
                ref={moreRef}
                type="button"
                className="btn ghost sm dash-today-more"
                data-testid="dash-today-more"
                aria-expanded={moreTodos}
                onClick={() => {
                  const collapsing = moreTodos
                  setMoreTodos(!moreTodos)
                  if (collapsing) requestAnimationFrame(() => moreRef.current?.focus())
                }}
              >
                {moreTodos ? 'Show fewer' : `Show ${hiddenTodos} more`}
              </button>
            ) : null}
          </div>
        )}
      </DashSection>
      {dialog}
    </>
  )
}
