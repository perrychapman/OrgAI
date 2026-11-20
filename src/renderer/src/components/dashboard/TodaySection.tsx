import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { outcomeText } from '@shared/view/schedules'
import { useAppStore } from '../../store/useAppStore'
import { initTodos, useTodosStore } from '../../store/todosStore'
import { useSchedules } from '../schedules/useSchedules'
import { clockLabel } from '../../lib/dashboard'
import { openTodoRows, scheduledToday, scheduleTargetLabel } from '../../lib/todayModel'
import { startSessionFromTodo } from '../../lib/todoStart'
import { Button } from '../ui/Button'
import { useConfirm } from '../ui/ConfirmDialog'
import { DashSection, useDashboard } from './DashboardContext'
import { afterFirstPaint } from './projectQueue'
import { useNow } from './useDashboardData'

/** Today (docs/design/dashboard-overhaul.md 7.5): what is scheduled and which open to-dos could start a session. */

const LOAD_AT_ONCE = 3

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

  const shownSchedules = moreSchedules ? scheduleRows : scheduleRows.slice(0, caps.schedules)
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
      <DashSection id="today" testId="dash-today" empty={noGroups} sectionRef={rootRef} headExtra={<span className="dash-today-date">{date}</span>}>
        {!noSchedules && (
          <div className="dash-today-group" data-testid="dash-today-schedules">
            <h3 className="dash-today-h3">Scheduled</h3>
            {showPausedLine ? (
              <div className="dash-today-paused" data-testid="dash-today-paused">
                <p className="dash-today-paused-text">Schedules are paused. Nothing will start today.</p>
                <Button variant="ghost" size="sm" onClick={() => openSchedules()}>
                  Open schedules
                </Button>
              </div>
            ) : (
              <>
                <ul className="dash-rows dash-today-rows">
                  {shownSchedules.map((r) => {
                    const s = r.schedule
                    const target = scheduleTargetLabel(s.target, projects)
                    const outcome = r.state === 'ran' ? outcomeText({ result: 'started', outcome: s.lastEntry?.outcome, runId: s.lastEntry?.runId }) : ''
                    const runId = r.state === 'ran' ? s.lastEntry?.runId : undefined
                    const projectId = s.target.kind === 'team' ? s.target.projectId : undefined
                    const open = (): void => {
                      if (runId && projectId) void focusRun(projectId, runId)
                      else openSchedules({ scheduleId: s.id })
                    }
                    return (
                      <li key={`${s.id}:${r.state}`} className="dash-row" data-testid="dash-today-schedule" data-id={s.id} data-state={r.state}>
                        <button type="button" className="dash-row-main" data-row-main="" onClick={open}>
                          <span className="dash-row-text">
                            <span className="dash-row-line">
                              <span className="dash-today-time">{clockLabel(r.at)}</span>
                              <span className="dash-row-name" title={s.name}>
                                {s.name}
                              </span>
                            </span>
                            <span className="dash-row-cap">
                              <span className="dash-clip">
                                {r.state === 'upcoming' ? `Starts at ${clockLabel(r.at)} · ${target}` : outcome ? `${target} · ${outcome}` : target}
                              </span>
                            </span>
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
                {scheduleRows.length > caps.schedules && (
                  <Button variant="ghost" size="sm" className="dash-today-more" testId="dash-today-more-schedules" onClick={() => setMoreSchedules((v) => !v)}>
                    {moreSchedules ? 'Show fewer' : `Show ${scheduleRows.length - caps.schedules} more`}
                  </Button>
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
            <ul className="dash-rows dash-today-rows">
              {shownTodos.map((r) => (
                <li key={r.item.id} className="dash-row" data-testid="dash-today-todo" data-id={r.item.id} data-has-action="true">
                  <div className="dash-row-main dash-today-todo-main">
                    <span className="dash-row-text">
                      <span className="dash-row-line">
                        <span className="dash-row-name" title={r.item.title}>
                          {r.item.title}
                        </span>
                      </span>
                      <span className="dash-row-cap">
                        <span className="dash-clip">{r.agentAdded ? `${r.list} · Added by an assistant` : r.list}</span>
                      </span>
                    </span>
                  </div>
                  <div className="dash-row-side">
                    <Button variant="secondary" size="sm" testId="dash-today-start" ariaLabel={`Start session for ${r.item.title}`} onClick={() => void startSession(r)}>
                      Start session
                    </Button>
                  </div>
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
