import { useEffect } from 'react'
import { create } from 'zustand'
import type { TodoItem, TodoScope } from '@shared/types'
import { todoScopeKey } from '@shared/todos'
import { TODO_UNAVAILABLE_TEXT } from '@shared/view/todos'
import { cleanIpcError } from '../lib/ipcError'

/**
 * The renderer's copy of the to-do lists (docs/design/todos.md), one list per scope key. Separate from useAppStore.
 * `load(scope)` keeps only the newest answer per scope. `initTodos()` follows main's `todos:changed` push and reloads
 * the scope it names when that list was ever asked for. A missing API (an older main) is the same as a load error.
 */
interface TodosStore {
  byScope: Record<string, TodoItem[]>
  /** The last load failed: one plain sentence. The previous items (if any) stay in byScope. */
  errorByScope: Record<string, string>
  /** A load is in flight and nothing is known yet for the scope. */
  loadingByScope: Record<string, boolean>
  load(scope: TodoScope): Promise<void>
  /** Writes what main answered to an action into the list now (a load already in flight is dropped as older). */
  put(scope: TodoScope, item: TodoItem): void
  drop(scope: TodoScope, ids: readonly string[]): void
}

const seqByScope = new Map<string, number>()
const requested = new Set<string>()

export const useTodosStore = create<TodosStore>((set, get) => ({
  byScope: {},
  errorByScope: {},
  loadingByScope: {},
  put(scope, item) {
    const key = todoScopeKey(scope)
    const list = get().byScope[key]
    if (!list) return
    seqByScope.set(key, (seqByScope.get(key) ?? 0) + 1)
    set((s) => ({ byScope: { ...s.byScope, [key]: list.some((i) => i.id === item.id) ? list.map((i) => (i.id === item.id ? item : i)) : [...list, item] } }))
  },
  drop(scope, ids) {
    const key = todoScopeKey(scope)
    const list = get().byScope[key]
    if (!list) return
    seqByScope.set(key, (seqByScope.get(key) ?? 0) + 1)
    set((s) => ({ byScope: { ...s.byScope, [key]: list.filter((i) => !ids.includes(i.id)) } }))
  },
  async load(scope) {
    const key = todoScopeKey(scope)
    requested.add(key)
    const mine = (seqByScope.get(key) ?? 0) + 1
    seqByScope.set(key, mine)
    const api = typeof window !== 'undefined' ? window.orgai?.todos : undefined
    if (!api?.list) {
      set((s) => ({ errorByScope: { ...s.errorByScope, [key]: TODO_UNAVAILABLE_TEXT }, loadingByScope: { ...s.loadingByScope, [key]: false } }))
      return
    }
    if (get().byScope[key] === undefined) set((s) => ({ loadingByScope: { ...s.loadingByScope, [key]: true } }))
    try {
      const list = await api.list(scope)
      if (seqByScope.get(key) !== mine) return
      set((s) => {
        const { [key]: _e, ...errorByScope } = s.errorByScope
        return { byScope: { ...s.byScope, [key]: Array.isArray(list) ? list : [] }, errorByScope, loadingByScope: { ...s.loadingByScope, [key]: false } }
      })
    } catch (e) {
      if (seqByScope.get(key) !== mine) return
      set((s) => ({ errorByScope: { ...s.errorByScope, [key]: cleanIpcError(e, 'The to-dos could not be loaded.') }, loadingByScope: { ...s.loadingByScope, [key]: false } }))
    }
  }
}))

let started = false

/** Installs the todos:changed subscription once for the life of the window. Safe to call again. */
export function initTodos(): void {
  if (started) return
  started = true
  try {
    window.orgai?.onTodosChanged?.((event) => {
      const scope = event?.scope
      if (!scope) return
      if (requested.has(todoScopeKey(scope))) void useTodosStore.getState().load(scope)
    })
  } catch {
    // An older preload without the push: the view still refreshes after its own actions.
  }
}

/** Open items of one list, or null while unknown (not loaded yet, failed, no list). Loads the list the first time it is needed. */
export function useOpenTodoCount(scope: TodoScope | null): number | null {
  const key = scope ? todoScopeKey(scope) : ''
  const items = useTodosStore((s) => (scope ? s.byScope[key] : undefined))
  useEffect(() => {
    if (scope && !requested.has(key)) void useTodosStore.getState().load(scope)
    // The scope object is rebuilt each render; its key is the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  if (!items) return null
  return items.filter((i) => i.status !== 'done').length
}
