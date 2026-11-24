import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, ListChecks } from 'lucide-react'
import type { TodoItem } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { initTodos, useTodosStore } from '../../store/todosStore'
import { openTodoRows } from '../../lib/todayModel'
import { startSessionFromTodo } from '../../lib/todoStart'
import { projectHue } from '../../lib/projectIdentity'
import { Button } from '../ui/Button'
import { useConfirm } from '../ui/ConfirmDialog'
import { Icon } from '../ui/Icon'
import { DashSection, useDashboard } from './DashboardContext'
import { focusLaterUnlessMoved } from '../../lib/laterFocus'
import { ProjectBadge } from './ProjectBadge'
import { afterFirstPaint } from './projectQueue'

/**
 * To-dos (section id `todos`, docs/design/dashboard-usage-redesign dashboard.md; the to-do half of the old Today): the
 * open to-dos of Chat and every project, newest update first, each with Start session. An unboxed list, hairlines
 * between rows. Not drawn without an open to-do. Reads only lists that were loaded, loading them three at a time after
 * first paint; a list that fails to load stays unknown.
 */

const LOAD_AT_ONCE = 3

/** A to-do's project id for its badge; Chat has none (the neutral badge). */
const todoProjectId = (item: TodoItem): string => (item.scope.kind === 'project' ? item.scope.projectId : '')

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

export function TodosSection(): ReactElement | null {
  const { caps } = useDashboard()
  const projects = useAppStore((s) => s.projects)
  const byScope = useTodosStore((s) => s.byScope)
  const { confirm, dialog } = useConfirm()
  const [more, setMore] = useState(false)
  const moreRef = useRef<HTMLButtonElement | null>(null)
  const rootRef = useRef<HTMLElement | null>(null)

  const projectIds = useMemo(() => projects.map((p) => p.id), [projects])
  useTodayTodos(projectIds)

  const todoRows = useMemo(() => openTodoRows(byScope, projects), [byScope, projects])
  const shown = more ? todoRows : todoRows.slice(0, caps.todos)
  const hidden = todoRows.length - caps.todos

  const startSession = async (row: (typeof todoRows)[number]): Promise<void> => {
    const ok = await startSessionFromTodo(row.item, confirm)
    if (!ok) {
      // A declined confirm leaves focus where it was: put it back on this row's button.
      focusLaterUnlessMoved(() => rootRef.current?.querySelector<HTMLElement>(`[data-testid="dash-today-todo"][data-id="${CSS.escape(row.item.id)}"] [data-testid="dash-today-start"]`))
    }
  }

  return (
    <>
      <DashSection id="todos" testId="dash-todos" icon={ListChecks} empty={todoRows.length === 0} count={todoRows.length} sectionRef={rootRef}>
        <ul className="dash-today-todos" data-testid="dash-today-todos">
          {shown.map((r) => (
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
        {hidden > 0 || more ? (
          <button
            ref={moreRef}
            type="button"
            className="btn ghost sm dash-today-more"
            data-testid="dash-today-more"
            aria-expanded={more}
            onClick={() => {
              const collapsing = more
              setMore(!more)
              if (collapsing) focusLaterUnlessMoved(() => moreRef.current)
            }}
          >
            {more ? 'Show fewer' : `Show ${hidden} more`}
          </button>
        ) : null}
      </DashSection>
      {dialog}
    </>
  )
}
