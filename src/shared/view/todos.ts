// Pure view model of the to-do lists (docs/design/todos.md). No renderer imports: the rows the Todos view draws.
import type { TodoItem, TodoScope } from '../types'
import { QUICK_PROJECT_ID, isVirtualProjectId } from '../types'
import { sortTodos, todoStartPrompt } from '../todos'
import { clampLabel } from './clampLabel'

export const TODO_EMPTY_TEXT = "Say 'put that on my to-do list' in a conversation, or add one here."
export const TODO_UNAVAILABLE_TEXT = 'To-dos are not available in this version.'

/** The list a project id owns: Chat has one, the other assistants none, a stored project its own. */
export function todoScopeFor(projectId: string): TodoScope | null {
  if (projectId === QUICK_PROJECT_ID) return { kind: 'chat' }
  if (isVirtualProjectId(projectId)) return null
  return projectId ? { kind: 'project', projectId } : null
}

/** "1 open to-do" / "3 open to-dos". */
export function todosCountLabel(n: number): string {
  return `${n} open to-do${n === 1 ? '' : 's'}`
}

export interface TodoRowView {
  id: string
  item: TodoItem
  /** As stored, rendered whole as plain text. */
  title: string
  detail: string | undefined
  /** The checkbox's name: the title, shortened for speech. */
  checkLabel: string
  /** "Added by assistant" / "Added by <role>" for an item an agent created; undefined for the user's own. */
  sourceText: string | undefined
  /** The conversation it came from, only while that run still exists. */
  sourceRunId: string | undefined
  /** Runs started from this item, newest first, with whether each still exists. */
  startedRuns: { id: string; exists: boolean }[]
  canStart: boolean
  startPrompt: string
}

export interface TodoListView {
  open: TodoRowView[]
  done: TodoRowView[]
  openCount: number
  doneCount: number
}

function rowOf(item: TodoItem, known: { runExists(id: string): boolean }): TodoRowView {
  const agent = item.createdBy === 'agent'
  const role = item.source?.roleName ? clampLabel(item.source.roleName, 40) : ''
  const runId = item.source?.runId
  return {
    id: item.id,
    item,
    title: item.title,
    detail: item.detail ? item.detail : undefined,
    checkLabel: clampLabel(item.title, 80),
    sourceText: agent ? (role ? `Added by ${role}` : 'Added by assistant') : undefined,
    sourceRunId: agent && runId && known.runExists(runId) ? runId : undefined,
    startedRuns: (item.startedRunIds ?? []).map((id) => ({ id, exists: known.runExists(id) })),
    canStart: item.status !== 'done',
    startPrompt: todoStartPrompt(item)
  }
}

/** Open items (newest first) and done items (newest done first), as the view draws them. */
export function todoListView(items: readonly TodoItem[], known: { runExists(id: string): boolean }): TodoListView {
  const open: TodoRowView[] = []
  const done: TodoRowView[] = []
  for (const item of sortTodos(items)) (item.status === 'done' ? done : open).push(rowOf(item, known))
  return { open, done, openCount: open.length, doneCount: done.length }
}
