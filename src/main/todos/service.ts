/**
 * The to-do service (docs/design/todos.md): every rule about who may change what lives here, on top of the TodoStore.
 * Electron-free. User calls (IPC) take `unknown` arguments and rebuild them; agent calls take a scope main chose and a
 * caller main filled. Every refusal is an Error with one plain sentence (the tool prints it after "REFUSED: ", the UI
 * shows it as is). The id, timestamps, createdBy, editedBy, statusBy, source and startedRunIds are never read from input.
 */
import { randomBytes } from 'node:crypto'
import { cleanTodoScope, cleanTodoText, sameTodoScope, sortTodos, todoScopeKey } from '../../shared/todos'
import { TODOS_MAX_PER_SCOPE, TODO_RUN_WRITES_MAX, TODO_STARTED_RUNS_MAX } from '../../shared/types'
import type { TodoItem, TodoScope, TodoStatus, TodosChangedEvent } from '../../shared/types'
import type { TodoStore } from './store'

export interface TodoCaller {
  runId: string
  agentId?: string
  roleName?: string
}

export interface TodoServiceDeps {
  store: TodoStore
  now(): number
  /** A stored, non-virtual project with this id exists. */
  projectExists(projectId: string): boolean
  /** The list a run belongs to (chat for a Chat run, its project otherwise); null when there is no such run. */
  runScope(runId: string): TodoScope | null
  changed?(event: TodosChangedEvent): void
  log?(message: string): void
  /** id generator for tests; default 'todo_' + 16 hex chars. */
  newId?(): string
}

export type TodoWriteResult = { item: TodoItem; changed: boolean }

const ID_RE = /^todo_[0-9a-f]{8,64}$/
const REF_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const ROLE_MAX = 120

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export class TodoService {
  private readonly runWrites = new Map<string, number>()

  constructor(private readonly deps: TodoServiceDeps) {}

  readOnlyReason(): string | null {
    return this.deps.store.readOnlyReason()
  }

  // ---------- user ----------

  list(scope: unknown): TodoItem[] {
    return sortTodos(this.deps.store.list(this.userScope(scope)))
  }

  save(input: unknown): TodoItem {
    if (!isRecord(input)) throw new Error('That is not a to-do.')
    const scope = this.userScope(input.scope)
    const status = input.status === undefined ? undefined : this.cleanStatus(input.status)
    const text = this.cleanText({ title: input.title, detail: input.detail })
    if (input.id === undefined) return this.create(scope, text, status ?? 'open', 'user')
    const id = this.cleanId(input.id)
    const prev = this.deps.store.get(scope, id)
    if (!prev) throw new Error('No such to-do.')
    // Present but not a number: refused, so a malformed field never skips the stale-edit check (review L1).
    if (input.expectedUpdatedAt !== undefined && (typeof input.expectedUpdatedAt !== 'number' || !Number.isFinite(input.expectedUpdatedAt))) throw new Error('That is not a to-do.')
    if (typeof input.expectedUpdatedAt === 'number' && input.expectedUpdatedAt !== prev.updatedAt) {
      throw new Error('This to-do changed since you opened it. Reload it and try again.')
    }
    return this.apply(scope, prev, text, status, 'user').item
  }

  remove(input: unknown): void {
    if (!isRecord(input)) throw new Error('That is not a to-do.')
    const scope = this.userScope(input.scope)
    const id = this.cleanId(input.id)
    if (!this.deps.store.get(scope, id)) throw new Error('No such to-do.')
    this.deps.store.update((d) => {
      const key = todoScopeKey(scope)
      d.lists[key] = (d.lists[key] ?? []).filter((i) => i.id !== id)
    })
    this.push({ scope, ids: [], removed: [id] })
  }

  clearDone(scope: unknown): number {
    const s = this.userScope(scope)
    const removed = this.deps.store.list(s).filter((i) => i.status === 'done').map((i) => i.id)
    if (removed.length === 0) return 0
    this.deps.store.update((d) => {
      const key = todoScopeKey(s)
      d.lists[key] = (d.lists[key] ?? []).filter((i) => i.status !== 'done')
    })
    this.push({ scope: s, ids: [], removed })
    return removed.length
  }

  linkRun(input: unknown): TodoItem {
    if (!isRecord(input)) throw new Error('That is not a to-do.')
    const scope = this.userScope(input.scope)
    const id = this.cleanId(input.id)
    if (typeof input.runId !== 'string' || !REF_RE.test(input.runId)) throw new Error('No such run.')
    const runId = input.runId
    const runScope = this.deps.runScope(runId)
    if (!runScope) throw new Error('No such run.')
    if (!sameTodoScope(runScope, scope)) throw new Error('That run does not belong to this list.')
    if (!this.deps.store.get(scope, id)) throw new Error('No such to-do.')
    const next = this.deps.store.update((d) => {
      const item = (d.lists[todoScopeKey(scope)] ?? []).find((i) => i.id === id)
      if (!item) throw new Error('No such to-do.')
      item.startedRunIds = [runId, ...(item.startedRunIds ?? []).filter((r) => r !== runId)].slice(0, TODO_STARTED_RUNS_MAX)
      return structuredClone(item)
    })
    this.push({ scope, ids: [id] })
    return next
  }

  /** The project was deleted: drop its whole list. No project-exists check. */
  removeScope(scope: TodoScope): number {
    const removed = this.deps.store.list(scope).map((i) => i.id)
    if (removed.length === 0) return 0
    this.deps.store.update((d) => {
      delete d.lists[todoScopeKey(scope)]
    })
    this.push({ scope, ids: [], removed })
    return removed.length
  }

  // ---------- agent ----------

  agentList(scope: TodoScope): TodoItem[] {
    this.checkScope(scope)
    return sortTodos(this.deps.store.list(scope))
  }

  agentAdd(scope: TodoScope, text: { title: unknown; detail?: unknown }, caller: TodoCaller): TodoWriteResult {
    this.checkScope(scope)
    const cleaned = this.cleanText({ title: text.title, detail: text.detail })
    if (cleaned.title === undefined) throw new Error('Give the item a short title.')
    const key = cleaned.title.toLowerCase()
    const dup = this.deps.store.list(scope).find((i) => i.status === 'open' && i.title.toLowerCase() === key)
    if (dup) return { item: dup, changed: false }
    this.checkWriteLimit(caller)
    const item = this.create(scope, cleaned, 'open', 'agent', this.sourceOf(caller))
    this.countWrite(caller)
    return { item, changed: true }
  }

  agentSetStatus(scope: TodoScope, id: unknown, status: 'open' | 'done', caller: TodoCaller): TodoWriteResult {
    this.checkScope(scope)
    const clean = this.cleanStatus(status)
    const prev = this.deps.store.get(scope, this.cleanId(id))
    if (!prev) throw new Error('No such to-do.')
    if (prev.status === clean) return { item: prev, changed: false }
    this.checkWriteLimit(caller)
    const result = this.apply(scope, prev, {}, clean, 'agent')
    this.countWrite(caller)
    return result
  }

  agentUpdate(scope: TodoScope, id: unknown, text: { title?: unknown; detail?: unknown }, caller: TodoCaller): TodoWriteResult {
    this.checkScope(scope)
    const prev = this.deps.store.get(scope, this.cleanId(id))
    if (!prev) throw new Error('No such to-do.')
    if (text.title === undefined && text.detail === undefined) throw new Error('Give a new title or detail.')
    const cleaned = this.cleanText(text)
    if (prev.createdBy === 'user' || prev.editedBy === 'user') throw new Error('Only the user can change that item; add a new one instead.')
    if (!this.textChanges(prev, cleaned)) return { item: prev, changed: false }
    this.checkWriteLimit(caller)
    const result = this.apply(scope, prev, cleaned, undefined, 'agent')
    this.countWrite(caller)
    return result
  }

  // ---------- internals ----------

  private userScope(value: unknown): TodoScope {
    const scope = cleanTodoScope(value)
    if (!scope) throw new Error('That is not a to-do list.')
    this.checkScope(scope)
    return scope
  }

  private checkScope(scope: TodoScope): void {
    if (scope.kind === 'project' && !this.deps.projectExists(scope.projectId)) throw new Error('That project no longer exists.')
  }

  private cleanId(value: unknown): string {
    if (typeof value !== 'string' || !ID_RE.test(value)) throw new Error('No such to-do.')
    return value
  }

  private cleanStatus(value: unknown): TodoStatus {
    if (value !== 'open' && value !== 'done') throw new Error('The status must be open or done.')
    return value
  }

  private cleanText(input: { title?: unknown; detail?: unknown }): { title?: string; detail?: string | null } {
    const r = cleanTodoText(input)
    if (!r.ok) throw new Error(r.problem)
    return { ...(r.title !== undefined ? { title: r.title } : {}), ...(r.detail !== undefined ? { detail: r.detail } : {}) }
  }

  private textChanges(prev: TodoItem, text: { title?: string; detail?: string | null }): boolean {
    if (text.title !== undefined && text.title !== prev.title) return true
    if (text.detail !== undefined && (text.detail ?? undefined) !== prev.detail) return true
    return false
  }

  private sourceOf(caller: TodoCaller): TodoItem['source'] {
    const source: NonNullable<TodoItem['source']> = { runId: caller.runId }
    if (caller.agentId !== undefined) source.agentId = caller.agentId
    // The store drops a role name with hidden characters; drop it here too so the returned item equals the stored one (review L4).
    if (caller.roleName !== undefined) {
      const role = caller.roleName.slice(0, ROLE_MAX)
      if (role.trim() && cleanTodoText({ title: role }).ok) source.roleName = role
    }
    return source
  }

  private nextUpdatedAt(prev?: number): number {
    const now = this.deps.now()
    return prev === undefined ? now : Math.max(now, prev + 1)
  }

  private create(
    scope: TodoScope,
    text: { title?: string; detail?: string | null },
    status: TodoStatus,
    by: 'user' | 'agent',
    source?: TodoItem['source']
  ): TodoItem {
    if (text.title === undefined) throw new Error('Give the item a short title.')
    const title = text.title
    if (this.deps.store.list(scope).length >= TODOS_MAX_PER_SCOPE) {
      throw new Error(`This list holds ${TODOS_MAX_PER_SCOPE} items, the most it can. Remove some or clear done items first.`)
    }
    const at = this.nextUpdatedAt()
    const item: TodoItem = {
      id: this.deps.newId ? this.deps.newId() : `todo_${randomBytes(8).toString('hex')}`,
      scope,
      title,
      status,
      createdAt: at,
      updatedAt: at,
      createdBy: by,
      editedBy: by,
      statusBy: by
    }
    if (typeof text.detail === 'string') item.detail = text.detail
    if (status === 'done') item.doneAt = at
    if (source) item.source = source
    const stored = this.deps.store.update((d) => {
      const key = todoScopeKey(scope)
      d.lists[key] = [...(d.lists[key] ?? []), item]
      return item
    })
    this.push({ scope, ids: [stored.id] })
    // What the store kept after its sanitizer, not the draft (review L4).
    return this.deps.store.get(scope, stored.id) ?? structuredClone(stored)
  }

  /** Applies text and status changes to a stored item. No change at all returns it untouched (changed false). */
  private apply(
    scope: TodoScope,
    prev: TodoItem,
    text: { title?: string; detail?: string | null },
    status: TodoStatus | undefined,
    by: 'user' | 'agent'
  ): TodoWriteResult {
    const textChanged = this.textChanges(prev, text)
    const statusChanged = status !== undefined && status !== prev.status
    if (!textChanged && !statusChanged) return { item: prev, changed: false }
    const at = this.nextUpdatedAt(prev.updatedAt)
    const next = this.deps.store.update((d) => {
      const item = (d.lists[todoScopeKey(scope)] ?? []).find((i) => i.id === prev.id)
      if (!item) throw new Error('No such to-do.')
      if (textChanged) {
        if (text.title !== undefined) item.title = text.title
        if (text.detail !== undefined) {
          if (text.detail === null) delete item.detail
          else item.detail = text.detail
        }
        item.editedBy = by
      }
      if (statusChanged && status !== undefined) {
        item.status = status
        item.statusBy = by
        if (status === 'done') item.doneAt = at
        else delete item.doneAt
      }
      item.updatedAt = at
      return structuredClone(item)
    })
    this.push({ scope, ids: [prev.id] })
    return { item: this.deps.store.get(scope, prev.id) ?? next, changed: true }
  }

  private checkWriteLimit(caller: TodoCaller): void {
    if ((this.runWrites.get(caller.runId) ?? 0) >= TODO_RUN_WRITES_MAX) {
      throw new Error(`The to-do write limit for this run (${TODO_RUN_WRITES_MAX}) is reached; nothing was saved.`)
    }
  }

  private countWrite(caller: TodoCaller): void {
    this.runWrites.set(caller.runId, (this.runWrites.get(caller.runId) ?? 0) + 1)
  }

  private push(event: TodosChangedEvent): void {
    try {
      this.deps.changed?.(event)
    } catch (e) {
      this.deps.log?.(`todos: change push failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
