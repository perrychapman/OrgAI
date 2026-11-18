import type { FormEvent, ReactElement } from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import type { Project, TodoScope } from '@shared/types'
import { cleanTodoText } from '@shared/todos'
import { clampLabel } from '@shared/view/clampLabel'
import { TODO_EMPTY_TEXT, TODO_UNAVAILABLE_TEXT, todoListView, todoScopeFor, type TodoRowView } from '@shared/view/todos'
import { useAppStore } from '../store/useAppStore'
import { useTodosStore } from '../store/todosStore'
import { Banner } from '../components/ui/Banner'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { Input } from '../components/ui/Input'
import { useConfirm } from '../components/ui/ConfirmDialog'
import TodoRow, { type TodoRunLink } from '../components/todos/TodoRow'
import type { TodoEdits } from '../components/todos/TodoEditForm'
import { cleanIpcError } from '../lib/ipcError'
import { displayRunName } from '../lib/orgChange'
import { startSessionFromTodo } from '../lib/todoStart'
import '../styles/todos.css'

type FocusTarget = { kind: 'check' | 'edit'; id: string } | { kind: 'add' }

/** The runs of one list that still exist, by id: `<projectId>|<name>`, or '' when the run is gone. Re-renders only on a change. */
function useRunInfo(historyProjectId: string, ids: readonly string[]): Map<string, { projectId: string; name: string }> {
  const flat = useAppStore(
    useShallow((s) =>
      ids.map((id) => {
        const summary = s.runs[id]?.summary ?? (s.historyByProject[historyProjectId] ?? []).find((h) => h.id === id)
        return summary ? `${summary.projectId || historyProjectId}|${displayRunName(summary)}` : ''
      })
    )
  )
  return useMemo(() => {
    const map = new Map<string, { projectId: string; name: string }>()
    ids.forEach((id, i) => {
      const entry = flat[i]
      if (!entry) return
      const cut = entry.indexOf('|')
      map.set(id, { projectId: entry.slice(0, cut), name: entry.slice(cut + 1) })
    })
    return map
  }, [ids, flat])
}

const todosApi = (): NonNullable<Window['orgai']['todos']> => {
  const api = window.orgai?.todos
  if (!api?.save) throw new Error(TODO_UNAVAILABLE_TEXT)
  return api
}

/**
 * The To-dos tab of a project and of Chat (docs/design/todos.md). The list lives in main; this view reads it through
 * todosStore, writes through todos:save / remove / clearDone, and follows todos:changed. Every text an agent wrote is a
 * plain text node. A missing API or a failed load is the error banner and turns the writes off. One polite live region
 * speaks the results; a refusal shows next to the control it came from and keeps what the user typed.
 */
export default function TodosView({ project }: { project: Project }): ReactElement {
  const scope = useMemo(() => todoScopeFor(project.id), [project.id]) as TodoScope
  const key = scope.kind === 'chat' ? 'chat' : `project:${scope.projectId}`
  const items = useTodosStore((s) => s.byScope[key])
  const loadError = useTodosStore((s) => s.errorByScope[key])
  const loading = useTodosStore((s) => !!s.loadingByScope[key])
  const [addText, setAddText] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [actionError, setActionError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [live, setLive] = useState('')
  const [tick, setTick] = useState(0)
  const { confirm, dialog: confirmDialog } = useConfirm()
  const rootRef = useRef<HTMLDivElement>(null)
  const focusRef = useRef<FocusTarget | null>(null)
  const busyIds = useRef(new Set<string>())
  const addId = useId()
  const addErrorId = useId()
  const doneListId = useId()

  useEffect(() => {
    void useTodosStore.getState().load(scope)
    // The source and started runs come from the project's history; make sure it is in.
    void useAppStore.getState().loadHistory().catch(() => undefined)
  }, [scope])

  const say = useCallback((text: string) => {
    // Clear first so the same sentence twice is still announced.
    setLive('')
    requestAnimationFrame(() => setLive(text))
  }, [])

  const askFocus = useCallback((target: FocusTarget) => {
    focusRef.current = target
    setTick((n) => n + 1)
  }, [])

  // Focus lands after the render that moved or removed the row, never before it.
  useEffect(() => {
    const target = focusRef.current
    if (!target) return
    focusRef.current = null
    let el: HTMLElement | null = null
    if (target.kind !== 'add') {
      const testId = target.kind === 'check' ? 'todo-check' : 'todo-edit'
      el = rootRef.current?.querySelector<HTMLElement>(`[data-todo-id="${CSS.escape(target.id)}"] [data-testid="${testId}"]`) ?? null
    }
    ;(el ?? document.getElementById(addId))?.focus()
  }, [tick, items, editingId, addId])

  const list = items ?? []
  const ids = useMemo(() => {
    const out = new Set<string>()
    for (const i of list) {
      if (i.source?.runId) out.add(i.source.runId)
      for (const r of i.startedRunIds ?? []) out.add(r)
    }
    return [...out]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])
  const runInfo = useRunInfo(scope.kind === 'chat' ? 'quick' : scope.projectId, ids)
  const view = useMemo(() => todoListView(list, { runExists: (id) => runInfo.has(id) }), [list, runInfo])
  const total = view.openCount + view.doneCount

  const writable = items !== undefined && !!window.orgai?.todos?.save
  const unavailable = loadError ?? (!window.orgai?.todos ? TODO_UNAVAILABLE_TEXT : undefined)

  // An open edit whose item was removed elsewhere closes, with a sentence.
  useEffect(() => {
    if (!editingId || !items || items.some((i) => i.id === editingId)) return
    setEditingId(null)
    setNote('This to-do was removed elsewhere.')
    say('This to-do was removed elsewhere.')
    askFocus({ kind: 'add' })
  }, [items, editingId, say, askFocus])

  const setRowError = (id: string, message: string | null): void =>
    setRowErrors((cur) => {
      if (message === null) {
        if (!(id in cur)) return cur
        const { [id]: _gone, ...rest } = cur
        return rest
      }
      return { ...cur, [id]: message }
    })

  const linkOf = (id: string, label: string): TodoRunLink | undefined => {
    const info = runInfo.get(id)
    return info ? { id, projectId: info.projectId, label, name: clampLabel(info.name, 60) } : undefined
  }
  const runLinksOf = (row: TodoRowView): TodoRunLink[] => {
    const all = row.startedRuns
    // Oldest first gets "Session 1": the list is newest first.
    return all
      .map((r, i) => (r.exists ? linkOf(r.id, `Session ${all.length - i}`) : undefined))
      .filter((l): l is TodoRunLink => !!l)
      .reverse()
  }

  const add = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (adding || !writable) return
    const cleaned = cleanTodoText({ title: addText })
    if (!cleaned.ok) {
      setAddError(cleaned.problem)
      say(cleaned.problem)
      return
    }
    setAdding(true)
    setAddError(null)
    setNote(null)
    try {
      const saved = await todosApi().save({ scope, title: cleaned.title })
      useTodosStore.getState().put(scope, saved)
      setAddText('')
      say(`Added “${clampLabel(saved.title, 80)}”.`)
    } catch (err) {
      const message = cleanIpcError(err, 'The to-do could not be added.')
      setAddError(message)
      say(message)
    } finally {
      setAdding(false)
    }
  }

  const toggle = async (row: TodoRowView, done: boolean): Promise<void> => {
    if (busyIds.current.has(row.id)) return
    busyIds.current.add(row.id)
    setRowError(row.id, null)
    setNote(null)
    setActionError(null)
    // Where focus goes when this row leaves the open list: the next open row, else the previous, else the add field.
    const at = view.open.findIndex((r) => r.id === row.id)
    const neighbour = view.open[at + 1] ?? view.open[at - 1]
    try {
      const saved = await todosApi().save({ id: row.id, scope, status: done ? 'done' : 'open', expectedUpdatedAt: row.item.updatedAt })
      useTodosStore.getState().put(scope, saved)
      say(done ? `Marked “${row.checkLabel}” done.` : `Reopened “${row.checkLabel}”.`)
      if (!done) askFocus({ kind: 'check', id: row.id })
      else if (at >= 0) askFocus(neighbour ? { kind: 'check', id: neighbour.id } : { kind: 'add' })
    } catch (err) {
      const message = cleanIpcError(err, 'The to-do could not be changed.')
      setRowError(row.id, message)
      say(message)
      void useTodosStore.getState().load(scope)
    } finally {
      busyIds.current.delete(row.id)
    }
  }

  const saveEdit = async (row: TodoRowView, edits: TodoEdits, expectedUpdatedAt: number): Promise<string | null> => {
    try {
      const saved = await todosApi().save({ id: row.id, scope, ...edits, expectedUpdatedAt })
      useTodosStore.getState().put(scope, saved)
      setEditingId(null)
      setNote(null)
      say(`Saved “${clampLabel(saved.title, 80)}”.`)
      askFocus({ kind: 'edit', id: row.id })
      return null
    } catch (err) {
      const message = cleanIpcError(err, 'The to-do could not be saved.')
      say(message)
      return message
    }
  }

  const remove = async (row: TodoRowView): Promise<void> => {
    const ok = await confirm({
      title: 'Delete this to-do?',
      body: `“${row.checkLabel}” is removed from the list. This cannot be undone.`,
      confirmLabel: 'Delete to-do',
      danger: true,
      confirmTestId: 'todo-delete-confirm'
    })
    if (!ok) return
    const group = row.item.status === 'done' ? view.done : view.open
    const at = group.findIndex((r) => r.id === row.id)
    const neighbour = group[at + 1] ?? group[at - 1]
    setRowError(row.id, null)
    try {
      await todosApi().remove({ scope, id: row.id })
      useTodosStore.getState().drop(scope, [row.id])
      setNote(null)
      say(`Deleted “${row.checkLabel}”.`)
      askFocus(neighbour ? { kind: 'check', id: neighbour.id } : { kind: 'add' })
    } catch (err) {
      const message = cleanIpcError(err, 'The to-do could not be deleted.')
      setRowError(row.id, message)
      say(message)
      void useTodosStore.getState().load(scope)
    }
  }

  const clearDone = async (): Promise<void> => {
    const n = view.doneCount
    const ok = await confirm({
      title: 'Clear done to-dos?',
      body: `Remove ${n} done to-do${n === 1 ? '' : 's'} from this list? This cannot be undone.`,
      confirmLabel: 'Clear done',
      danger: true,
      confirmTestId: 'todo-clear-done-confirm'
    })
    if (!ok) return
    setActionError(null)
    try {
      const removed = await todosApi().clearDone(scope)
      await useTodosStore.getState().load(scope)
      setNote(null)
      say(`Removed ${removed} done to-do${removed === 1 ? '' : 's'}.`)
      askFocus({ kind: 'add' })
    } catch (err) {
      const message = cleanIpcError(err, 'The done to-dos could not be cleared.')
      setActionError(message)
      say(message)
    }
  }

  const start = async (row: TodoRowView): Promise<void> => {
    setRowError(row.id, null)
    setActionError(null)
    try {
      await startSessionFromTodo(row.item, confirm)
    } catch (err) {
      const message = cleanIpcError(err, 'The session could not be prepared.')
      setRowError(row.id, message)
      say(message)
    }
  }

  const rowProps = (row: TodoRowView): Parameters<typeof TodoRow>[0] => ({
    row,
    writable,
    editing: editingId === row.id,
    error: rowErrors[row.id],
    sourceLink: row.sourceRunId ? linkOf(row.sourceRunId, 'Open conversation') : undefined,
    runLinks: runLinksOf(row),
    onToggle: (r, done) => void toggle(r, done),
    onEdit: (r) => {
      setNote(null)
      setRowError(r.id, null)
      setEditingId(r.id)
    },
    onDelete: (r) => void remove(r),
    onStart: (r) => void start(r),
    onOpenRun: (link) => void useAppStore.getState().focusRun(link.projectId, link.id),
    onSave: saveEdit,
    onCancelEdit: (r) => {
      setEditingId(null)
      askFocus({ kind: 'edit', id: r.id })
    }
  })

  return (
    <div className="todos-view" data-testid="todos-view" aria-busy={loading && !items}>
      <div className="todos-scroll">
        <div className="todos-page" ref={rootRef}>
          <header className="todos-head">
            <h2 className="todos-title">To-dos</h2>
            <p className="todos-scope muted">{scope.kind === 'chat' ? 'For Chat' : 'For this project'}</p>
          </header>

          {unavailable && (
            <Banner
              tone="danger"
              testId="todos-error"
              actions={
                <Button size="sm" onClick={() => void useTodosStore.getState().load(scope)}>
                  Try again
                </Button>
              }
            >
              {unavailable}
            </Banner>
          )}
          {actionError && (
            <p className="field-error" data-testid="todos-action-error">
              {actionError}
            </p>
          )}

          <form className="todos-add" onSubmit={(e) => void add(e)} noValidate>
            <label className="todos-add-label" htmlFor={addId}>
              Add a to-do
            </label>
            <div className="todos-add-row">
              <Input
                id={addId}
                data-testid="todo-add-input"
                value={addText}
                onChange={(v) => {
                  setAddText(v)
                  if (addError) setAddError(null)
                }}
                invalid={!!addError}
                aria-describedby={addError ? addErrorId : undefined}
                disabled={!!unavailable && !items}
                autoComplete="off"
                spellCheck
              />
              <Button type="submit" variant="primary" icon={Plus} inert={(!!unavailable && !items) || adding} testId="todo-add">
                Add
              </Button>
            </div>
            {addError && (
              <p className="field-error" id={addErrorId} data-testid="todo-add-error">
                {addError}
              </p>
            )}
          </form>

          {note && <p className="todos-note muted">{note}</p>}

          {!items && !unavailable ? (
            <p className="muted" data-testid="todos-loading">
              Loading to-dos…
            </p>
          ) : items && total === 0 ? (
            <p className="todos-empty muted" data-testid="todos-empty">
              {TODO_EMPTY_TEXT}
            </p>
          ) : items ? (
            <>
              {view.openCount > 0 ? (
                <ul className="todos-list" aria-label="Open to-dos" data-testid="todo-list-open">
                  {view.open.map((row) => (
                    <TodoRow key={row.id} {...rowProps(row)} />
                  ))}
                </ul>
              ) : (
                <p className="muted">Nothing open.</p>
              )}
              {view.doneCount > 0 && (
                <section className="todos-done" aria-label="Done">
                  <div className="todos-done-head">
                    <button
                      type="button"
                      className="todo-done-toggle"
                      data-testid="todo-done-toggle"
                      aria-expanded={showDone}
                      aria-controls={showDone ? doneListId : undefined}
                      onClick={() => setShowDone((v) => !v)}
                    >
                      <Icon icon={showDone ? ChevronDown : ChevronRight} size="sm" />
                      Done ({view.doneCount})
                    </button>
                    <Button size="sm" variant="ghost" inert={!writable} onClick={() => void clearDone()} testId="todo-clear-done">
                      Clear done
                    </Button>
                  </div>
                  {showDone && (
                    <ul className="todos-list" id={doneListId} aria-label="Done to-dos" data-testid="todo-list-done">
                      {view.done.map((row) => (
                        <TodoRow key={row.id} {...rowProps(row)} />
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </>
          ) : null}
        </div>
      </div>
      {confirmDialog}
      <p className="sr-only" role="status" aria-live="polite" data-testid="todos-status">
        {live}
      </p>
    </div>
  )
}
