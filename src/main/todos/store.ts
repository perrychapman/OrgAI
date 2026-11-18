/**
 * The persistent store of to-do lists (docs/design/todos.md): `<dataDir>/todos.json` holds
 * `{ version: 1, lists: Record<scopeKey, TodoItem[]> }`. Electron-free. Same durability rules as the schedules store:
 *
 * - One write path, `update(fn)`: fn edits a deep-copied draft; the store sanitizes it, copies the current good file to
 *   `todos.json.bak`, then replaces the file durably (temp + fsync + rename).
 * - A missing file is an empty, writable store. A file that exists but cannot be read (not readable, bad JSON, wrong
 *   shape, version other than 1, over the size cap) is never overwritten: the store is READ-ONLY. The backup, when it
 *   parses, is shown read-only. `readOnlyReason()` says so in one plain sentence.
 * - Entries that fail validation are dropped on read and on write.
 */
import { join } from 'node:path'
import { cleanTodoScope, cleanTodoText, todoScopeKey } from '../../shared/todos'
import { TODOS_MAX_PER_SCOPE, TODO_STARTED_RUNS_MAX } from '../../shared/types'
import type { TodoItem } from '../../shared/types'
import { nodeVaultFs, writeFileDurable } from '../store/durableFs'
import type { VaultFs } from '../store/durableFs'

export interface TodoStoreData {
  lists: Record<string, TodoItem[]>
}

export interface TodoStoreOptions {
  /** Diagnostics (one line per event, never file contents). */
  log?: (message: string) => void
  /** The file system seam (tests inject faults); node:fs by default. */
  fs?: VaultFs
}

const MAX_FILE_BYTES = 32 * 1024 * 1024
const FILE_NAME = 'todos.json'
const ID_RE = /^todo_[0-9a-f]{8,64}$/
const REF_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const ROLE_MAX = 120

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15
const isActor = (v: unknown): v is 'user' | 'agent' => v === 'user' || v === 'agent'

function cleanSource(raw: unknown): TodoItem['source'] | undefined {
  if (!isRecord(raw) || typeof raw.runId !== 'string' || !REF_RE.test(raw.runId)) return undefined
  const out: NonNullable<TodoItem['source']> = { runId: raw.runId }
  if (typeof raw.agentId === 'string' && REF_RE.test(raw.agentId)) out.agentId = raw.agentId
  if (typeof raw.roleName === 'string') {
    // Reuse the title check for hidden characters; keep the cleaned, cut value.
    const r = cleanTodoText({ title: raw.roleName.slice(0, ROLE_MAX) })
    if (r.ok && r.title) out.roleName = r.title
  }
  return out
}

function cleanItem(raw: unknown, key: string): TodoItem | null {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null
  const scope = cleanTodoScope(raw.scope)
  if (!scope || todoScopeKey(scope) !== key) return null
  const text = cleanTodoText({ title: raw.title, detail: raw.detail === undefined ? undefined : raw.detail })
  if (!text.ok || text.title === undefined) return null
  if (raw.status !== 'open' && raw.status !== 'done') return null
  if (!isTime(raw.createdAt) || !isTime(raw.updatedAt)) return null
  if (!isActor(raw.createdBy) || !isActor(raw.editedBy) || !isActor(raw.statusBy)) return null
  const item: TodoItem = {
    id: raw.id,
    scope,
    title: text.title,
    status: raw.status,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    createdBy: raw.createdBy,
    editedBy: raw.editedBy,
    statusBy: raw.statusBy
  }
  if (typeof text.detail === 'string') item.detail = text.detail
  if (raw.status === 'done' && isTime(raw.doneAt)) item.doneAt = raw.doneAt
  const source = cleanSource(raw.source)
  if (source) item.source = source
  if (Array.isArray(raw.startedRunIds)) {
    const ids = [...new Set(raw.startedRunIds.filter((x): x is string => typeof x === 'string' && REF_RE.test(x)))].slice(0, TODO_STARTED_RUNS_MAX)
    if (ids.length > 0) item.startedRunIds = ids
  }
  return item
}

function sanitize(rawLists: unknown): { data: TodoStoreData; dropped: number } {
  let dropped = 0
  const lists: Record<string, TodoItem[]> = {}
  const seen = new Set<string>()
  if (isRecord(rawLists)) {
    for (const key of Object.keys(rawLists)) {
      const rawList = rawLists[key]
      if (!Array.isArray(rawList)) {
        dropped++
        continue
      }
      let items: TodoItem[] = []
      for (const raw of rawList) {
        const item = cleanItem(raw, key)
        if (!item || seen.has(item.id)) {
          dropped++
          continue
        }
        seen.add(item.id)
        items.push(item)
      }
      if (items.length > TODOS_MAX_PER_SCOPE) {
        dropped += items.length - TODOS_MAX_PER_SCOPE
        const keep = new Set([...items].sort((a, b) => b.createdAt - a.createdAt).slice(0, TODOS_MAX_PER_SCOPE))
        items = items.filter((i) => keep.has(i))
      }
      if (items.length > 0) lists[key] = items
    }
  }
  return { data: { lists }, dropped }
}

type RootRead = { state: 'missing' } | { state: 'unreadable' } | { state: 'ok'; bytes: Buffer; data: TodoStoreData; dropped: number }

export class TodoStore {
  readonly file: string
  private readonly bakFile: string
  private readonly dataDir: string
  private readonly fs: VaultFs
  private readonly log: (message: string) => void
  private data: TodoStoreData = { lists: {} }
  private readOnly: string | null = null

  constructor(dataDir: string, opts: TodoStoreOptions = {}) {
    this.dataDir = dataDir
    this.file = join(dataDir, FILE_NAME)
    this.bakFile = `${this.file}.bak`
    this.fs = opts.fs ?? nodeVaultFs
    this.log = opts.log ?? (() => {})
    this.load()
  }

  /** null when writes are allowed; else one plain sentence naming the file. */
  readOnlyReason(): string | null {
    return this.readOnly
  }

  list(scope: TodoItem['scope']): TodoItem[] {
    return structuredClone(this.data.lists[todoScopeKey(scope)] ?? [])
  }

  get(scope: TodoItem['scope'], id: string): TodoItem | undefined {
    const item = (this.data.lists[todoScopeKey(scope)] ?? []).find((x) => x.id === id)
    return item ? structuredClone(item) : undefined
  }

  update<T>(fn: (draft: TodoStoreData) => T): T {
    if (this.readOnly) throw new Error(this.readOnly)
    const draft = structuredClone(this.data)
    const result = fn(draft)
    const { data, dropped } = sanitize(draft.lists)
    if (dropped > 0) this.log(`todos: dropped ${dropped} invalid item${dropped === 1 ? '' : 's'} while writing`)
    this.persist(data)
    this.data = data
    return result
  }

  // ---------- internals ----------

  private readRoot(path: string): RootRead {
    let bytes: Buffer
    try {
      bytes = this.fs.readFileSync(path)
    } catch (e) {
      return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable' }
    }
    if (bytes.length > MAX_FILE_BYTES) return { state: 'unreadable' }
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.toString('utf8'))
    } catch {
      return { state: 'unreadable' }
    }
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.lists)) return { state: 'unreadable' }
    const { data, dropped } = sanitize(parsed.lists)
    return { state: 'ok', bytes, data, dropped }
  }

  private unreadableSentence(): string {
    return `OrgAI could not read ${this.file}. To-do lists are read-only until the file is fixed or removed; nothing was overwritten.`
  }

  private load(): void {
    const main = this.readRoot(this.file)
    if (main.state === 'ok') {
      this.data = main.data
      if (main.dropped > 0) this.log(`todos: dropped ${main.dropped} invalid item${main.dropped === 1 ? '' : 's'} while reading ${this.file}`)
      return
    }
    if (main.state === 'missing') return
    this.readOnly = this.unreadableSentence()
    const bak = this.readRoot(this.bakFile)
    if (bak.state === 'ok') this.data = bak.data
    this.log(`todos: ${this.file} is unreadable; read-only${bak.state === 'ok' ? ' (showing the last backup)' : ''}`)
  }

  /** Back up the current good file, then replace it. Re-checks the disk first: a file that went bad since the load is never replaced. */
  private persist(next: TodoStoreData): void {
    const current = this.readRoot(this.file)
    if (current.state === 'unreadable') {
      this.readOnly = this.unreadableSentence()
      this.log(`todos: ${this.file} became unreadable; read-only`)
      throw new Error(this.readOnly)
    }
    this.fs.mkdirSync(this.dataDir, { recursive: true })
    if (current.state === 'ok') writeFileDurable(this.bakFile, current.bytes, { fs: this.fs })
    const text = `${JSON.stringify({ version: 1, lists: next.lists }, null, 2)}\n`
    writeFileDurable(this.file, text, { fs: this.fs })
  }
}
