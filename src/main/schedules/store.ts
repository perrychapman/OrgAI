/**
 * The persistent store of Schedules (docs/design/schedules.md sections 3 and 4): `<dataDir>/schedules.json` holds the
 * schedules and their history (`{ version: 1, schedules, history }`). Electron-free.
 *
 * - One write path, `update(fn)`: fn edits a deep-copied draft; the store sanitizes it (junk dropped field by field, the
 *   history capped per schedule, orphan history dropped), copies the current good file to `schedules.json.bak`, then
 *   replaces the file durably (temp + fsync + rename, durableFs).
 * - A missing file is an empty, writable store. A file that exists but cannot be read as a schedule store (not readable,
 *   bad JSON, wrong top-level shape, version other than 1) is never overwritten: the store is READ-ONLY. If
 *   `schedules.json.bak` parses it is loaded so the user still sees their schedules, but the store stays read-only anyway,
 *   because the next write would replace the unreadable main file; the user must fix or remove it (which also decides which
 *   copy wins). `readOnlyReason()` says so in one plain sentence.
 * - Entries that fail validation are dropped on read (and on write), so junk never reaches the service or the disk.
 */
import { join } from 'node:path'
import { cleanScheduleInput } from '../../shared/schedule'
import { SCHEDULES_MAX, SCHEDULE_HISTORY_MAX } from '../../shared/types'
import type { Schedule, ScheduleHistoryEntry, ScheduleSkipReason } from '../../shared/types'
import { nodeVaultFs, writeFileDurable } from '../store/durableFs'
import type { VaultFs } from '../store/durableFs'

export interface ScheduleStoreData {
  schedules: Schedule[]
  history: ScheduleHistoryEntry[]
}

export interface ScheduleStoreOptions {
  /** Diagnostics (one line per event, never file contents). */
  log?: (message: string) => void
  /** The file system seam (tests inject faults); node:fs by default. */
  fs?: VaultFs
}

/** The file is not read past this size (a schedule store is a few hundred KB at most); bigger counts as unreadable. */
const MAX_FILE_BYTES = 32 * 1024 * 1024
const FILE_NAME = 'schedules.json'
const STATES = ['active', 'paused', 'error', 'done'] as const
const TRIGGERS = ['timer', 'catch-up', 'manual'] as const
const RESULTS = ['started', 'skipped', 'failed'] as const
const OUTCOMES = ['finished', 'error', 'stopped', 'needs-you'] as const
const REASONS: readonly ScheduleSkipReason[] = [
  'previous-running',
  'too-many-running',
  'app-closed',
  'paused-globally',
  'project-missing',
  'usage-limited',
  'start-refused'
]
const SCHEDULE_ID_RE = /^sch_[0-9a-f]{4,64}$/
const ENTRY_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const REF_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const TEXT_MAX = 300
// eslint-disable-next-line no-control-regex
const CONTROL_G = /[\u0000-\u001f\u007f]/g

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v)

function cleanText(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.replace(CONTROL_G, ' ').trim().slice(0, TEXT_MAX)
  return t.length > 0 ? t : undefined
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 1_000_000) : 0
}

/** The shared tail of an entry and a lastEntry: the optional fields that survive validation. */
function optionalEntryFields(r: Record<string, unknown>): Partial<ScheduleHistoryEntry> {
  const out: Partial<ScheduleHistoryEntry> = {}
  if (oneOf(REASONS, r.reason)) out.reason = r.reason
  if (oneOf(OUTCOMES, r.outcome)) out.outcome = r.outcome
  if (typeof r.runId === 'string' && REF_ID_RE.test(r.runId)) out.runId = r.runId
  return out
}

function cleanEntry(raw: unknown): ScheduleHistoryEntry | null {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || !ENTRY_ID_RE.test(raw.id)) return null
  if (typeof raw.scheduleId !== 'string' || !SCHEDULE_ID_RE.test(raw.scheduleId)) return null
  if (!isTime(raw.slotAt) || !isTime(raw.at)) return null
  if (!oneOf(TRIGGERS, raw.trigger) || !oneOf(RESULTS, raw.result)) return null
  const entry: ScheduleHistoryEntry = { id: raw.id, scheduleId: raw.scheduleId, slotAt: raw.slotAt, at: raw.at, trigger: raw.trigger, result: raw.result }
  Object.assign(entry, optionalEntryFields(raw))
  const detail = cleanText(raw.detail)
  if (detail !== undefined) entry.detail = detail
  if (typeof raw.projectId === 'string' && REF_ID_RE.test(raw.projectId)) entry.projectId = raw.projectId
  if (raw.costUsd === null) entry.costUsd = null
  else if (typeof raw.costUsd === 'number' && Number.isFinite(raw.costUsd) && raw.costUsd >= 0) entry.costUsd = raw.costUsd
  return entry
}

function cleanLastEntry(raw: unknown): Schedule['lastEntry'] | undefined {
  if (!isRecord(raw)) return undefined
  if (!isTime(raw.at) || !isTime(raw.slotAt) || !oneOf(TRIGGERS, raw.trigger) || !oneOf(RESULTS, raw.result)) return undefined
  const out: NonNullable<Schedule['lastEntry']> = { at: raw.at, slotAt: raw.slotAt, trigger: raw.trigger, result: raw.result }
  const opt = optionalEntryFields(raw)
  if (opt.reason !== undefined) out.reason = opt.reason
  if (opt.outcome !== undefined) out.outcome = opt.outcome
  if (opt.runId !== undefined) out.runId = opt.runId
  return out
}

function cleanSchedule(raw: unknown): Schedule | null {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || !SCHEDULE_ID_RE.test(raw.id)) return null
  if (typeof raw.enabled !== 'boolean') return null
  if (raw.missed !== undefined && raw.missed !== 'run-once' && raw.missed !== 'skip') return null
  // The user fields go through the same cleaner as a save (it also refuses bypassPermissions); main-owned ones are checked here.
  const cleaned = cleanScheduleInput({
    name: raw.name,
    prompt: raw.prompt,
    target: raw.target,
    timing: raw.timing,
    enabled: raw.enabled,
    missed: raw.missed,
    modelSelection: raw.modelSelection,
    permissionMode: raw.permissionMode,
    budgetUsd: raw.budgetUsd,
    expiresAt: raw.expiresAt
  })
  if (!cleaned.ok) return null
  const c = cleaned.value
  if (!oneOf(STATES, raw.state)) return null
  if (!isTime(raw.createdAt) || !isTime(raw.updatedAt)) return null
  if (raw.createdBy !== 'user' && raw.createdBy !== 'agent') return null
  const out: Schedule = {
    id: raw.id,
    name: c.name,
    prompt: c.prompt,
    target: c.target,
    timing: c.timing,
    enabled: raw.enabled,
    missed: c.missed ?? 'run-once',
    state: raw.state,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    createdBy: raw.createdBy,
    consecutiveFailures: count(raw.consecutiveFailures),
    unread: count(raw.unread)
  }
  if (c.modelSelection) out.modelSelection = c.modelSelection
  if (c.permissionMode) out.permissionMode = c.permissionMode
  if (typeof c.budgetUsd === 'number') out.budgetUsd = c.budgetUsd
  if (typeof c.expiresAt === 'number') out.expiresAt = c.expiresAt
  const reason = cleanText(raw.stateReason)
  if (reason !== undefined) out.stateReason = reason
  if (isTime(raw.nextRunAt)) out.nextRunAt = raw.nextRunAt
  if (isTime(raw.lastSlotAt)) out.lastSlotAt = raw.lastSlotAt
  const last = cleanLastEntry(raw.lastEntry)
  if (last) out.lastEntry = last
  return out
}

/** Newest first: by `at`, then `slotAt`. */
function newestFirst(a: ScheduleHistoryEntry, b: ScheduleHistoryEntry): number {
  return b.at - a.at || b.slotAt - a.slotAt
}

/**
 * Whatever was parsed or edited, as a clean store: junk entries and unknown keys dropped, duplicate ids dropped (the
 * first wins), at most SCHEDULES_MAX schedules (the oldest by createdAt), history only for kept schedules and at most
 * SCHEDULE_HISTORY_MAX entries each (the newest). Returns how many items were dropped for the log.
 */
function sanitize(rawSchedules: unknown, rawHistory: unknown): { data: ScheduleStoreData; dropped: number } {
  let dropped = 0
  const seen = new Set<string>()
  let schedules: Schedule[] = []
  for (const raw of Array.isArray(rawSchedules) ? rawSchedules : []) {
    const s = cleanSchedule(raw)
    if (!s || seen.has(s.id)) {
      dropped++
      continue
    }
    seen.add(s.id)
    schedules.push(s)
  }
  if (schedules.length > SCHEDULES_MAX) {
    dropped += schedules.length - SCHEDULES_MAX
    schedules = [...schedules].sort((a, b) => a.createdAt - b.createdAt).slice(0, SCHEDULES_MAX)
  }
  const kept = new Set(schedules.map((s) => s.id))
  const entryIds = new Set<string>()
  const candidates: ScheduleHistoryEntry[] = []
  for (const raw of Array.isArray(rawHistory) ? rawHistory : []) {
    const e = cleanEntry(raw)
    if (!e || !kept.has(e.scheduleId) || entryIds.has(e.id)) {
      dropped++
      continue
    }
    entryIds.add(e.id)
    candidates.push(e)
  }
  // Keep the newest SCHEDULE_HISTORY_MAX per schedule, in the order they were given.
  const drop = new Set<ScheduleHistoryEntry>()
  const byId = new Map<string, ScheduleHistoryEntry[]>()
  for (const e of candidates) {
    const list = byId.get(e.scheduleId)
    if (list) list.push(e)
    else byId.set(e.scheduleId, [e])
  }
  for (const list of byId.values()) {
    if (list.length <= SCHEDULE_HISTORY_MAX) continue
    const sorted = [...list].sort(newestFirst)
    for (const e of sorted.slice(SCHEDULE_HISTORY_MAX)) drop.add(e)
  }
  dropped += drop.size
  return { data: { schedules, history: candidates.filter((e) => !drop.has(e)) }, dropped }
}

type RootRead = { state: 'missing' } | { state: 'unreadable' } | { state: 'ok'; bytes: Buffer; data: ScheduleStoreData; dropped: number }

export class ScheduleStore {
  readonly file: string
  private readonly bakFile: string
  private readonly dataDir: string
  private readonly fs: VaultFs
  private readonly log: (message: string) => void
  private data: ScheduleStoreData = { schedules: [], history: [] }
  private readOnly: string | null = null

  constructor(dataDir: string, opts: ScheduleStoreOptions = {}) {
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

  list(): Schedule[] {
    return structuredClone(this.data.schedules).sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  get(id: string): Schedule | undefined {
    const s = this.data.schedules.find((x) => x.id === id)
    return s ? structuredClone(s) : undefined
  }

  history(scheduleId: string): ScheduleHistoryEntry[] {
    return structuredClone(this.data.history.filter((e) => e.scheduleId === scheduleId)).sort(newestFirst)
  }

  update<T>(fn: (draft: ScheduleStoreData) => T): T {
    if (this.readOnly) throw new Error(this.readOnly)
    const draft = structuredClone(this.data)
    const result = fn(draft)
    const { data } = sanitize(draft.schedules, draft.history)
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
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.schedules) || !Array.isArray(parsed.history)) return { state: 'unreadable' }
    const { data, dropped } = sanitize(parsed.schedules, parsed.history)
    return { state: 'ok', bytes, data, dropped }
  }

  private unreadableSentence(): string {
    return `OrgAI could not read ${this.file}. Schedules are read-only until the file is fixed or removed; nothing was overwritten.`
  }

  private load(): void {
    const main = this.readRoot(this.file)
    if (main.state === 'ok') {
      this.data = main.data
      if (main.dropped > 0) this.log(`schedules: dropped ${main.dropped} invalid item${main.dropped === 1 ? '' : 's'} while reading ${this.file}`)
      return
    }
    if (main.state === 'missing') return
    // Present but unreadable: never overwritten. The backup, when it parses, is shown read-only.
    this.readOnly = this.unreadableSentence()
    const bak = this.readRoot(this.bakFile)
    if (bak.state === 'ok') this.data = bak.data
    this.log(`schedules: ${this.file} is unreadable; read-only${bak.state === 'ok' ? ' (showing the last backup)' : ''}`)
  }

  /** Back up the current good file, then replace it. Re-checks the disk first: a file that went bad since the load is never replaced. */
  private persist(next: ScheduleStoreData): void {
    const current = this.readRoot(this.file)
    if (current.state === 'unreadable') {
      this.readOnly = this.unreadableSentence()
      this.log(`schedules: ${this.file} became unreadable; read-only`)
      throw new Error(this.readOnly)
    }
    this.fs.mkdirSync(this.dataDir, { recursive: true })
    if (current.state === 'ok') writeFileDurable(this.bakFile, current.bytes, { fs: this.fs })
    const text = `${JSON.stringify({ version: 1, schedules: next.schedules, history: next.history }, null, 2)}\n`
    writeFileDurable(this.file, text, { fs: this.fs })
  }
}
