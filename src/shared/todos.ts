// Pure helpers for the to-do lists (docs/design/todos.md). No dependency but the types and the hidden-character check.
import type { TodoItem, TodoScope } from './types'
import { TODO_DETAIL_MAX_CHARS, TODO_TITLE_MAX_CHARS } from './types'
import { hasHidden } from './view/hiddenChars'

const PROJECT_ID_MAX = 200

export function todoScopeKey(scope: TodoScope): string {
  return scope.kind === 'chat' ? 'chat' : `project:${scope.projectId}`
}

export function sameTodoScope(a: TodoScope, b: TodoScope): boolean {
  return todoScopeKey(a) === todoScopeKey(b)
}

/** Rebuilds a scope from untrusted input; null when it is not one. */
export function cleanTodoScope(value: unknown): TodoScope | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.kind === 'chat') return { kind: 'chat' }
  if (v.kind === 'project' && typeof v.projectId === 'string' && v.projectId.length > 0 && v.projectId.length <= PROJECT_ID_MAX) {
    return { kind: 'project', projectId: v.projectId }
  }
  return null
}

export type TodoTextResult = { ok: true; title?: string; detail?: string | null } | { ok: false; problem: string }

/**
 * Cleans the text fields of a save. Only the fields present in `input` are returned. A detail that is null or empty
 * after trimming clears the detail (null). Hidden characters and over-long text are refused, never cut.
 */
export function cleanTodoText(input: { title?: unknown; detail?: unknown }): TodoTextResult {
  const out: { ok: true; title?: string; detail?: string | null } = { ok: true }
  if (input.title !== undefined) {
    if (typeof input.title !== 'string') return { ok: false, problem: 'The title must be text.' }
    if (hasHidden(input.title)) return { ok: false, problem: 'The title has characters that cannot be shown. Use plain text on one line.' }
    const title = input.title.replace(/\s+/g, ' ').trim()
    if (title.length === 0) return { ok: false, problem: 'The title is empty. Give the item a short title.' }
    if (title.length > TODO_TITLE_MAX_CHARS) return { ok: false, problem: `The title is longer than ${TODO_TITLE_MAX_CHARS} characters. Shorten it and put the rest in the details.` }
    out.title = title
  }
  if (input.detail !== undefined) {
    if (input.detail === null) out.detail = null
    else {
      if (typeof input.detail !== 'string') return { ok: false, problem: 'The details must be text.' }
      if (hasHidden(input.detail)) return { ok: false, problem: 'The details have characters that cannot be shown. Remove them and try again.' }
      const detail = input.detail.trim()
      if (detail.length > TODO_DETAIL_MAX_CHARS) return { ok: false, problem: `The details are longer than ${TODO_DETAIL_MAX_CHARS} characters. Shorten them and try again.` }
      out.detail = detail.length === 0 ? null : detail
    }
  }
  return out
}

/** Open items first (newest created first), then done items (newest done first). Stable; does not mutate. */
export function sortTodos(items: readonly TodoItem[]): TodoItem[] {
  const open = items.filter((i) => i.status !== 'done').sort((a, b) => b.createdAt - a.createdAt)
  const done = items.filter((i) => i.status === 'done').sort((a, b) => (b.doneAt ?? b.updatedAt) - (a.doneAt ?? a.updatedAt))
  return [...open, ...done]
}

/** The draft a session started from an item is prefilled with. The user sends it; nothing sends it for them. */
export function todoStartPrompt(item: TodoItem): string {
  return item.detail ? `To-do: ${item.title}\n\n${item.detail}` : `To-do: ${item.title}`
}
