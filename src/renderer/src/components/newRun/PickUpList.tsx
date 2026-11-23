import type { ReactElement } from 'react'
import { useMemo } from 'react'
import type { Project } from '@shared/types'
import { todoScopeKey } from '@shared/todos'
import { todoScopeFor } from '@shared/view/todos'
import { useAppStore, useProjectSummaries } from '../../store/useAppStore'
import { useTodosStore } from '../../store/todosStore'
import { startSessionFromTodo } from '../../lib/todoStart'
import { displayRunName } from '../../lib/orgChange'
import { promptLine } from '../../lib/runLabels'
import { relativeTime } from '../../lib/runChains'
import { useConfirm } from '../ui/ConfirmDialog'
import { pickUpRuns } from './newRunData'
import '../../styles/new-run.css'

const TODO_LIMIT = 2

/**
 * "Or pick up from": the project's earlier work runs (opens the run) and its open to-dos (fills this page's message box;
 * nothing is sent). Built only from records the renderer already holds; nothing shows when there are none.
 */
export function PickUpList({ project }: { project: Project }): ReactElement | null {
  const summaries = useProjectSummaries()
  const openRun = useAppStore((s) => s.openRun)
  const scope = todoScopeFor(project.id)
  const key = scope ? todoScopeKey(scope) : ''
  const todos = useTodosStore((s) => (key ? s.byScope[key] : undefined))
  const { confirm, dialog } = useConfirm()
  const runs = useMemo(() => pickUpRuns(summaries, 3), [summaries])
  const open = useMemo(() => (todos ?? []).filter((t) => t.status !== 'done').slice(0, TODO_LIMIT), [todos])
  if (runs.length === 0 && open.length === 0) return null
  return (
    <section className="nr-pickup" aria-labelledby="nr-pickup-title" data-testid="new-run-pickup">
      <h3 className="nr-pickup__title" id="nr-pickup-title">
        Or pick up from
      </h3>
      <ul className="nr-pickup__list">
        {runs.map((r) => (
          <li key={r.id}>
            <button type="button" className="nr-pickup__row" data-testid="new-run-pickup-run" title={promptLine(r.summary.prompt)} onClick={() => void openRun(r.id)}>
              <span className="nr-pickup__tag">Earlier</span>
              <span className="nr-pickup__text">{displayRunName(r.summary)}</span>
              <span className="nr-pickup__when">{relativeTime(r.at)}</span>
            </button>
          </li>
        ))}
        {open.map((t) => (
          <li key={t.id}>
            <button type="button" className="nr-pickup__row" data-testid="new-run-pickup-todo" title={t.title} onClick={() => void startSessionFromTodo(t, confirm)}>
              <span className="nr-pickup__tag">To-do</span>
              <span className="nr-pickup__text">{t.title}</span>
              <span className="nr-pickup__when">fills the message</span>
            </button>
          </li>
        ))}
      </ul>
      {dialog}
    </section>
  )
}
