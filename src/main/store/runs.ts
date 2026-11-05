import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MAX_AUTO_CONTINUES_LIMIT } from '@shared/defaults'
import { DEFAULT_HEADLESS_DECISION_POLICY, EXEC_OUTCOMES, QUICK_PROJECT_ID, isPermissionMode } from '@shared/types'
import type {
  ExecOutcome,
  HeadlessDecisionPolicy,
  ImageAttachment,
  ImageMediaType,
  RunEndedBy,
  RunOverrides,
  RunRecord,
  RunSummary,
  RunUsage,
  TranscriptEntry
} from '@shared/types'

const MAX_TRANSCRIPT_ENTRIES = 5000
const MAX_LOG_LINES = 400

const IMAGE_EXT: Record<ImageMediaType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
/** The only image refs ever written or read: a content hash plus a known extension, so a ref cannot leave the run's directory. */
const IMAGE_REF = /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/

const ENDED_BY: readonly RunEndedBy[] = ['user', 'app', 'policy', 'budget']
const EXEC_CHAIN_ID_MAX = 100

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
const isNonNegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

const POLICY_CHOICES: { [K in keyof HeadlessDecisionPolicy]-?: readonly unknown[] | 'count' } = {
  permission: ['deny', 'fail', 'wait'],
  rules: ['deny', 'fail', 'wait'],
  mcpInstall: ['deny', 'fail', 'wait'],
  question: ['fail', 'conservative', 'wait'],
  proposal: ['decline', 'fail', 'wait'],
  merge: ['hold', 'fail', 'wait'],
  maxAutoDenials: 'count',
  waitTimeoutMs: 'count',
  humanGraceMs: 'count'
}

/**
 * HeadlessDecisionPolicy from an untrusted file: each field kept only when it is in its allowed set (numbers finite,
 * >= 0; maxAutoDenials an integer). A missing or bad choice field gets DEFAULT_HEADLESS_DECISION_POLICY's value; a
 * policy with no valid field at all is dropped.
 */
function cleanDecisionPolicy(v: unknown): HeadlessDecisionPolicy | undefined {
  if (!isPlainObject(v)) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, allowed] of Object.entries(POLICY_CHOICES)) {
    const value = v[key]
    if (value === undefined) continue
    if (allowed === 'count') {
      if (isNonNegative(value) && (key !== 'maxAutoDenials' || Number.isInteger(value))) out[key] = value
    } else if (allowed.includes(value)) out[key] = value
  }
  if (!Object.keys(out).length) return undefined
  // A missing or bad choice falls back to the conservative default, so the result is a whole policy.
  const choices = ['permission', 'rules', 'mcpInstall', 'question', 'proposal', 'merge'] as const
  for (const k of choices) out[k] ??= DEFAULT_HEADLESS_DECISION_POLICY[k]
  return out as unknown as HeadlessDecisionPolicy
}

/**
 * RunOverrides from an untrusted file, rebuilt from known keys of the right types; unknown keys and bad values are
 * dropped. Undefined when nothing is left.
 */
export function cleanRunOverrides(v: unknown): RunOverrides | undefined {
  if (!isPlainObject(v)) return undefined
  const out: RunOverrides = {}
  if (isPermissionMode(v.permissionMode)) out.permissionMode = v.permissionMode
  for (const key of ['autoContinue', 'allowUnpricedBudget', 'allowUnmerged', 'allowPeerMessages', 'execMode', 'waitForReset'] as const) {
    if (typeof v[key] === 'boolean') out[key] = v[key] as boolean
  }
  const mac = v.maxAutoContinues
  if (typeof mac === 'number' && Number.isInteger(mac) && mac >= 0 && mac <= MAX_AUTO_CONTINUES_LIMIT) out.maxAutoContinues = mac
  if (isNonNegative(v.maxBudgetUsd)) out.maxBudgetUsd = v.maxBudgetUsd
  if (isNonNegative(v.execStallTimeoutMs)) out.execStallTimeoutMs = v.execStallTimeoutMs
  if (typeof v.execChainId === 'string' && v.execChainId.length > 0 && v.execChainId.length <= EXEC_CHAIN_ID_MAX) out.execChainId = v.execChainId
  const policy = cleanDecisionPolicy(v.decisionPolicy)
  if (policy) out.decisionPolicy = policy
  return Object.keys(out).length ? out : undefined
}

/**
 * Boot normalization of one stored summary (pure: returns a copy, never mutates `input`). Used by the RunStore
 * constructor and, later, by a read-only store reader in memory.
 *
 * Anything still marked live from a previous app session is actually dead. Paused runs lose their auto-resume
 * (timers die with the process) but keep pausedUntil, so the Runs tab can offer Continue. endedWithApp / endedBy
 * 'app' tell the UI the session was cut by the app quitting, not closed by the run itself. endedBy, endedWithApp,
 * endedWhile, execOutcome and overrides come from an untrusted file and are normalized here.
 */
export function normalizeCrashedRunSummary(input: RunSummary, now: number = Date.now()): RunSummary {
  const r: RunSummary = { ...input }
  if (r.endedBy !== undefined && !ENDED_BY.includes(r.endedBy)) delete r.endedBy
  // endedWithApp is exactly true or absent. A record saved before endedBy existed has endedWithApp alone: the
  // app cut it, so it gets endedBy 'app' (the renderer trusts endedWithApp). Next to any other endedBy it is dropped.
  if (r.endedWithApp !== undefined && (r.endedWithApp as unknown) !== true) delete r.endedWithApp
  if (r.endedWithApp && r.endedBy === undefined) r.endedBy = 'app'
  if (r.endedBy !== 'app') delete r.endedWithApp
  // endedWhile (also untrusted) only means something next to endedBy 'app'.
  if (r.endedWhile !== undefined && ((r.endedWhile !== 'working' && r.endedWhile !== 'waiting') || r.endedBy !== 'app')) {
    delete r.endedWhile
  }
  if (r.execOutcome !== undefined && !EXEC_OUTCOMES.includes(r.execOutcome as ExecOutcome)) delete r.execOutcome
  if (r.overrides !== undefined) {
    const overrides = cleanRunOverrides(r.overrides)
    if (overrides) r.overrides = overrides
    else delete r.overrides
  }
  if (r.status !== 'finished' && r.status !== 'error') {
    // What it was doing, from the status as saved: idle is the user's turn, paused gets none.
    const was = r.status
    r.status = 'finished'
    r.endedAt = r.endedAt ?? now
    // End session was under way (stop() saves endedBy 'user' with 'stopping'): it stays the user's end. A host
    // finalized exec run ('policy' / 'budget') keeps its endedBy too.
    r.endedBy ??= 'app'
    if (r.endedBy === 'app') {
      r.endedWithApp = true
      if (r.endedWhile === undefined) {
        if (was === 'idle') r.endedWhile = 'waiting'
        else if (was === 'starting' || was === 'running' || was === 'stopping') r.endedWhile = 'working'
      }
      if (was === 'paused') delete r.endedWhile
    }
  }
  if (r.autoResume) delete r.autoResume
  if (!r.kind) r.kind = 'work'
  return r
}

/**
 * The summaries of a parsed `runs.json` (pure; RunStore's constructor and the CLI's read-only reader). Only plain
 * objects with a string id are runs; a null or junk entry is dropped. Not normalized (see normalizeCrashedRunSummary).
 */
export function parseRunIndex(parsed: unknown): RunSummary[] {
  const runs = (parsed as { runs?: unknown } | null)?.runs
  return Array.isArray(runs)
    ? (runs as unknown[]).filter((r): r is RunSummary => !!r && typeof r === 'object' && !Array.isArray(r) && typeof (r as { id?: unknown }).id === 'string')
    : []
}

/** The file name RunStore uses for a run's record under `<dataDir>/runs/` (characters outside [A-Za-z0-9_-] become '_'). */
export function runRecordFileName(runId: string): string {
  return `${runId.replace(/[^a-z0-9_-]/gi, '_')}.json`
}

/**
 * Persists run summaries in one index file, and one record file per run with the
 * agents, transcript and logs, so a past run can be redrawn after a restart.
 *
 * Layout under `dataDir`: `runs.json` (index), `runs/<runId>.json` (record) and
 * `runs/<runId>/images/<sha256>.<ext>` (content-addressed bytes of images sent with user messages).
 * Records on disk carry `ImageAttachment.ref` with `data: ''`; getRecord rehydrates `data` and drops `ref`.
 */
export class RunStore {
  private file: string
  private recordsDir: string
  private runs: RunSummary[] = []
  /** Images already written, by object identity, so periodic flushes of a live record skip hashing. */
  private storedImages = new WeakMap<ImageAttachment, string>()
  /**
   * Called with the summaries a prune or removeProject just deleted (after the index write), so a quick run's
   * scratch dir can be removed once no record points to it. Errors are swallowed: deletion never fails on a hook.
   */
  onRunsRemoved?: (removed: RunSummary[]) => void

  constructor(dataDir: string) {
    this.file = join(dataDir, 'runs.json')
    this.recordsDir = join(dataDir, 'runs')
    try {
      if (existsSync(this.file)) {
        this.runs = parseRunIndex(JSON.parse(readFileSync(this.file, 'utf8')))
      }
    } catch {
      this.runs = []
    }
    // Anything still marked live from a previous app session is actually dead (see normalizeCrashedRunSummary).
    this.runs = this.runs.map((r) => normalizeCrashedRunSummary(r))
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, runs: this.runs.slice(-500) }, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  upsert(run: RunSummary): void {
    const idx = this.runs.findIndex((r) => r.id === run.id)
    if (idx === -1) this.runs.push({ ...run })
    else this.runs[idx] = { ...run }
    this.persist()
  }

  /**
   * Attach computed usage to several summaries in one index write (runUsage normalization of runs saved before
   * usage tracking). Existing usage is kept; unknown ids are ignored. totalCostUsd is left as it was saved.
   */
  setUsage(updates: readonly { id: string; usage: RunUsage }[]): void {
    let changed = false
    for (const u of updates) {
      const run = this.runs.find((r) => r.id === u.id)
      if (!run || run.usage) continue
      run.usage = u.usage
      changed = true
    }
    if (changed) this.persist()
  }

  list(projectId: string): RunSummary[] {
    return this.runs.filter((r) => r.projectId === projectId).sort((a, b) => b.startedAt - a.startedAt)
  }

  get(runId: string): RunSummary | null {
    const run = this.runs.find((r) => r.id === runId)
    return run ? { ...run } : null
  }

  allProjectIds(): string[] {
    return this.runs.map((r) => r.projectId)
  }

  private safeId(runId: string): string {
    return runId.replace(/[^a-z0-9_-]/gi, '_')
  }

  private recordPath(runId: string): string {
    return join(this.recordsDir, runRecordFileName(runId))
  }

  /** Per-run directory beside the record file; holds `images/`. */
  private runDir(runId: string): string {
    return join(this.recordsDir, this.safeId(runId))
  }

  /** Write an image once (content-addressed) and return its ref; null if it could not be written. */
  private storeImage(runId: string, img: ImageAttachment): string | null {
    const known = this.storedImages.get(img)
    if (known) return known
    const ext = IMAGE_EXT[img.mediaType]
    if (!ext) return null
    try {
      const bytes = Buffer.from(img.data, 'base64')
      const ref = `${createHash('sha256').update(bytes).digest('hex')}.${ext}`
      const dir = join(this.runDir(runId), 'images')
      const file = join(dir, ref)
      if (!existsSync(file)) {
        mkdirSync(dir, { recursive: true })
        const tmp = `${file}.tmp`
        writeFileSync(tmp, bytes)
        renameSync(tmp, file)
      }
      this.storedImages.set(img, ref)
      return ref
    } catch (e) {
      console.warn(`Failed to store an image of run ${runId}; keeping it inline:`, e)
      return null
    }
  }

  /** Copy of the transcript with user images moved to the image store. Never mutates the input. */
  private externalizeImages(runId: string, transcript: TranscriptEntry[]): TranscriptEntry[] {
    return transcript.map((entry) => {
      const block = entry.block
      if (block.kind !== 'user' || !block.images?.length) return entry
      const images = block.images.map((img) => {
        if (!img.data) return img // already a ref (or nothing to store)
        const ref = this.storeImage(runId, img)
        return ref ? { ...img, data: '', ref } : img
      })
      return { ...entry, block: { ...block, images } }
    })
  }

  /** Copy of the transcript with image data read back from the image store and refs removed. */
  private rehydrateImages(runId: string, transcript: TranscriptEntry[]): TranscriptEntry[] {
    if (!Array.isArray(transcript)) return transcript
    return transcript.map((entry) => {
      const block = entry?.block
      if (!block || block.kind !== 'user' || !Array.isArray(block.images) || !block.images.some((i) => i.ref !== undefined)) return entry
      const images = block.images.map((img) => {
        if (img.ref === undefined) return img
        const { ref, ...rest } = img
        let data = ''
        if (typeof ref === 'string' && IMAGE_REF.test(ref)) {
          try {
            data = readFileSync(join(this.runDir(runId), 'images', ref)).toString('base64')
          } catch {
            /* missing or unreadable: warned below */
          }
        }
        if (!data) console.warn(`Image ${String(ref)} of run ${runId} is missing from the image store`)
        return { ...rest, data }
      })
      return { ...entry, block: { ...block, images } }
    })
  }

  saveRecord(record: RunRecord): void {
    mkdirSync(this.recordsDir, { recursive: true })
    const trimmed: RunRecord = {
      ...record,
      transcript: this.externalizeImages(record.summary.id, record.transcript.slice(-MAX_TRANSCRIPT_ENTRIES)),
      logs: record.logs.slice(-MAX_LOG_LINES)
    }
    const file = this.recordPath(record.summary.id)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(trimmed), 'utf8')
    renameSync(tmp, file)
  }

  getRecord(runId: string): RunRecord | null {
    const file = this.recordPath(runId)
    if (!existsSync(file)) return null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as RunRecord
      const record: RunRecord = { ...parsed, transcript: this.rehydrateImages(runId, parsed.transcript) }
      // The index is the source of truth for status; a crash can leave a record marked live.
      const summary = this.runs.find((r) => r.id === runId)
      return summary ? { ...record, summary } : record
    } catch {
      return null
    }
  }

  /** Delete a run's record file and its directory (image store). */
  removeRecord(runId: string): void {
    const file = this.recordPath(runId)
    if (existsSync(file)) unlinkSync(file)
    rmSync(this.runDir(runId), { recursive: true, force: true })
  }

  /** Forget every run of a project, index entries and record files alike. */
  removeProject(projectId: string): number {
    const gone = this.runs.filter((r) => r.projectId === projectId)
    if (!gone.length) return 0
    this.runs = this.runs.filter((r) => r.projectId !== projectId)
    this.persist()
    for (const r of gone) this.removeRecord(r.id)
    this.notifyRemoved(gone)
    return gone.length
  }

  /** Keep only the newest `keepFor(projectId)` finished runs per project; delete the rest with their records. */
  prune(keepFor: (projectId: string) => number): number {
    const byProject = new Map<string, RunSummary[]>()
    for (const r of this.runs) byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r])
    const drop = new Set<string>()
    for (const [projectId, runs] of byProject) {
      const keep = Math.max(1, keepFor(projectId))
      const sorted = [...runs].sort((a, b) => b.startedAt - a.startedAt)
      for (const r of sorted.slice(keep)) if (r.status === 'finished' || r.status === 'error') drop.add(r.id)
    }
    if (!drop.size) return 0
    const removed = this.runs.filter((r) => drop.has(r.id))
    this.runs = this.runs.filter((r) => !drop.has(r.id))
    this.persist()
    for (const id of drop) this.removeRecord(id)
    this.notifyRemoved(removed)
    return drop.size
  }

  private notifyRemoved(removed: RunSummary[]): void {
    try {
      this.onRunsRemoved?.(removed.map((r) => ({ ...r })))
    } catch (e) {
      console.warn('onRunsRemoved failed:', e)
    }
  }

  /**
   * Move runs to another project (a promoted quick run). Only the index entry changes (getRecord reads its summary
   * from the index). Unknown ids are skipped. Returns the moved summaries (new projectId) in the order given.
   */
  moveToProject(runIds: readonly string[], projectId: string): RunSummary[] {
    const moved: RunSummary[] = []
    for (const id of runIds) {
      const run = this.runs.find((r) => r.id === id)
      if (!run) continue
      run.projectId = projectId
      // Out of the Chat: from now on it is a project run (continuing it uses the project's own roles).
      if (projectId !== QUICK_PROJECT_ID) delete run.quick
      moved.push({ ...run })
    }
    if (moved.length) this.persist()
    return moved
  }

  /** Every stored summary (copies), for the scratch-dir sweep. */
  all(): RunSummary[] {
    return this.runs.map((r) => ({ ...r }))
  }

  /** Delete record files and run directories (image stores) whose run is no longer in the index. */
  sweepOrphans(): number {
    if (!existsSync(this.recordsDir)) return 0
    const known = new Set(this.runs.map((r) => this.recordPath(r.id)))
    const knownDirs = new Set(this.runs.map((r) => this.runDir(r.id)))
    let removed = 0
    for (const name of readdirSync(this.recordsDir)) {
      const file = join(this.recordsDir, name)
      if (!name.endsWith('.json')) {
        try {
          if (statSync(file).isDirectory() && !knownDirs.has(file)) {
            rmSync(file, { recursive: true, force: true })
            removed++
          }
        } catch {
          /* locked or already gone */
        }
        continue
      }
      if (!known.has(file)) {
        try {
          unlinkSync(file)
          removed++
        } catch {
          /* locked or already gone */
        }
      }
    }
    return removed
  }
}
