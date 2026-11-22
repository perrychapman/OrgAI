import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { renameSyncRetry } from '../host/fsRetry'
import { RunBusyError, type SessionRecord } from '../host/sessions'
import { storeSyncFor, type StoreSync } from './shared/storeSync'
import { mapTranscriptImages } from '../runtime/transcriptMedia'
import { sanitizeImages } from '../runtime/attachments'
import { MAX_AUTO_CONTINUES_LIMIT } from '@shared/defaults'
import { DEFAULT_HEADLESS_DECISION_POLICY, EXEC_OUTCOMES, OUTPUT_COLOR_RE, QUICK_PROJECT_ID, isEffort, isPermissionMode, isStaffingGoal, isVirtualProjectId } from '@shared/types'
import type {
  ExecOutcome,
  HeadlessDecisionPolicy,
  ImageAttachment,
  ImageMediaType,
  RunEndedBy,
  RunOverrides,
  RunRecord,
  RunRosterRole,
  RunSummary,
  RunUsage,
  TranscriptEntry
} from '@shared/types'

/** How often a read re-checks that the sessions hosting other runs are still running (ms). */
const OWNER_RECHECK_MS = 1000

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
  if (v.strictDelegation === true) out.strictDelegation = true
  if (isStaffingGoal(v.goal)) out.goal = v.goal
  const mac = v.maxAutoContinues
  if (typeof mac === 'number' && Number.isInteger(mac) && mac >= 0 && mac <= MAX_AUTO_CONTINUES_LIMIT) out.maxAutoContinues = mac
  if (isNonNegative(v.maxBudgetUsd)) out.maxBudgetUsd = v.maxBudgetUsd
  // A stall timeout must be > 0 (as runOverridesArgs requires): 0 would re-arm the watchdog every tick (review Low).
  if (isNonNegative(v.execStallTimeoutMs) && v.execStallTimeoutMs > 0) out.execStallTimeoutMs = v.execStallTimeoutMs
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
 *
 * `opts.live` (several orgai sessions on one data folder): the run is hosted by a session that is still running, so it
 * really is live. Its fields are cleaned the same way, but its status, its session grant and its auto-resume stay.
 */
export function normalizeCrashedRunSummary(input: RunSummary, now: number = Date.now(), opts: { live?: boolean } = {}): RunSummary {
  const r: RunSummary = { ...input }
  if (typeof r.conversationBudgetUsd !== 'number' || !Number.isFinite(r.conversationBudgetUsd) || r.conversationBudgetUsd <= 0) delete r.conversationBudgetUsd
  if (r.modelAdapter !== 'claude' && r.modelAdapter !== 'codex' && r.modelAdapter !== 'mock') delete r.modelAdapter
  // Schedules (untrusted file): a schedule id and a one-line name of at most 80 characters, both or neither.
  // eslint-disable-next-line no-control-regex
  if (typeof r.scheduleId !== 'string' || !/^sch_[0-9a-f]{4,64}$/.test(r.scheduleId) || typeof r.scheduleName !== 'string' || r.scheduleName.length > 80 || /[\u0000-\u001f\u007f]/.test(r.scheduleName)) {
    delete r.scheduleId
    delete r.scheduleName
  }
  if (r.endedBy !== undefined && !ENDED_BY.includes(r.endedBy)) delete r.endedBy
  // endedWithApp is exactly true or absent. A record saved before endedBy existed has endedWithApp alone: the
  // app cut it, so it gets endedBy 'app' (the renderer trusts endedWithApp). Next to any other endedBy it is dropped.
  if (r.endedWithApp !== undefined && (r.endedWithApp as unknown) !== true) delete r.endedWithApp
  if (r.endedWithApp && r.endedBy === undefined) r.endedBy = 'app'
  if (r.endedBy !== 'app') delete r.endedWithApp
  // endedWhile (also untrusted) only means something next to endedBy 'app'.
  if (r.endedWhile !== undefined && ((r.endedWhile !== 'working' && r.endedWhile !== 'waiting' && r.endedWhile !== 'idle') || r.endedBy !== 'app')) {
    delete r.endedWhile
  }
  if (r.execOutcome !== undefined && !EXEC_OUTCOMES.includes(r.execOutcome as ExecOutcome)) delete r.execOutcome
  // Per-run choices (untrusted file): a known effort and mode only; the "chosen" flag is exactly true and needs a mode.
  if (r.rootEffort !== undefined && !isEffort(r.rootEffort)) delete r.rootEffort
  if (r.permissionMode !== undefined && !isPermissionMode(r.permissionMode)) delete r.permissionMode
  if (r.permissionModeChosen !== undefined && ((r.permissionModeChosen as unknown) !== true || r.permissionMode === undefined)) delete r.permissionModeChosen
  // A session's "accept edits" grant ended with the session: never on a loaded run (unless its session still runs).
  if (!opts.live) delete r.sessionPermissionMode
  if (r.overrides !== undefined) {
    const overrides = cleanRunOverrides(r.overrides)
    if (overrides) r.overrides = overrides
    else delete r.overrides
  }
  if (!opts.live && r.status !== 'finished' && r.status !== 'error') {
    // What it was doing, from the status as saved: idle (open cards unknown) is 'idle', not 'waiting'; paused gets none.
    const was = r.status
    r.status = 'finished'
    r.endedAt = r.endedAt ?? now
    // End session was under way (stop() saves endedBy 'user' with 'stopping'): it stays the user's end. A host
    // finalized exec run ('policy' / 'budget') keeps its endedBy too.
    r.endedBy ??= 'app'
    if (r.endedBy === 'app') {
      r.endedWithApp = true
      if (r.endedWhile === undefined) {
        if (was === 'idle') r.endedWhile = 'idle'
        else if (was === 'starting' || was === 'running' || was === 'stopping') r.endedWhile = 'working'
      }
      if (was === 'paused') delete r.endedWhile
    }
  }
  if (r.autoResume && !opts.live) delete r.autoResume
  if (!r.kind) r.kind = 'work'
  return r
}

/** Not ended: a run its host still has in memory (starting, running, idle, stopping) or holds paused. */
/** A run that is working right now, not waiting for its user: its reports may be writing in their worktrees. */
export function isWorkingRunStatus(status: RunSummary['status']): boolean {
  return status === 'starting' || status === 'running' || status === 'stopping'
}

/** Worktree states in which a report (or the harness, or the user at a merge card) is still at work on the branch. */
const WORKTREE_AT_WORK: ReadonlySet<string> = new Set(['active', 'waiting-children', 'merging', 'review'])

/**
 * Whether any agent of a run has a worktree that is still at work (`agents` as in a RunRecord). A run can be idle
 * while that is so: its orchestrator ended its turn and waits for reports that work in the background, or a finished
 * report's branch waits at a merge review card.
 */
export function hasWorktreeAtWork(agents: unknown): boolean {
  if (agents === null || typeof agents !== 'object') return false
  for (const a of Object.values(agents as Record<string, unknown>)) {
    const status = (a as { worktree?: { status?: unknown } } | null)?.worktree?.status
    if (typeof status === 'string' && WORKTREE_AT_WORK.has(status)) return true
  }
  return false
}

export function isOpenRunStatus(status: RunSummary['status']): boolean {
  return status !== 'finished' && status !== 'error'
}

/**
 * `owners` of a parsed `runs.json`: which orgai session hosts each run that is not ended (run id -> session id).
 * Written only when several sessions may share the data folder; an older orgai and the desktop app ignore and drop it.
 * Anything that is not a plain map of strings reads as empty.
 */
export function parseRunOwners(parsed: unknown): Record<string, string> {
  const raw = (parsed as { owners?: unknown } | null)?.owners
  const out: Record<string, string> = Object.create(null) as Record<string, string>
  if (!isPlainObject(raw)) return out
  for (const [runId, sessionId] of Object.entries(raw)) {
    if (typeof sessionId === 'string' && /^[0-9a-f]{12}$/.test(sessionId)) out[runId] = sessionId
  }
  return out
}

/**
 * The summaries of a parsed index as a process should see them (pure). A run that is not ended and whose owner session
 * `isLive` says is running keeps its status; every other one is normalized as crashed. Without `isLive` (one process per
 * data folder) every run is normalized, as before.
 */
export function loadRunIndex(parsed: unknown, isLive?: (sessionId: string) => boolean, now: number = Date.now()): { runs: RunSummary[]; owners: Record<string, string> } {
  const owners = isLive ? parseRunOwners(parsed) : (Object.create(null) as Record<string, string>)
  const kept: Record<string, string> = Object.create(null) as Record<string, string>
  const runs = parseRunIndex(parsed).map((r) => {
    const owner = owners[r.id]
    const live = !!isLive && owner !== undefined && isOpenRunStatus(r.status) && isLive(owner)
    if (live) kept[r.id] = owner
    return normalizeCrashedRunSummary(r, now, { live })
  })
  return { runs, owners: kept }
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
/** Most entries a stored RunRecord.roster keeps on read, and the longest id / slug / name kept. */
export const RUN_ROSTER_MAX = 200
const ROSTER_TEXT_MAX = { id: 200, slug: 100, name: 200 } as const

/**
 * RunRecord.roster as read from disk (review L1): an array of at most RUN_ROSTER_MAX entries, each rebuilt from
 * { id, slug, name, color, reportsTo: string | null, added?: true, removed?: true }. An entry without a non-empty
 * string id or a string slug / name is dropped; over-long text is cut; a colour that is not #rrggbb becomes '' (the
 * renderer then falls back to its neutral colour); a reportsTo that is not a string reads as null. undefined when
 * nothing valid remains. Pure.
 */
export function cleanRunRoster(raw: unknown): RunRosterRole[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: RunRosterRole[] = []
  for (const e of raw) {
    if (out.length >= RUN_ROSTER_MAX) break
    if (!isPlainObject(e)) continue
    if (typeof e.id !== 'string' || !e.id || typeof e.slug !== 'string' || typeof e.name !== 'string') continue
    const entry: RunRosterRole = {
      id: e.id.slice(0, ROSTER_TEXT_MAX.id),
      slug: e.slug.slice(0, ROSTER_TEXT_MAX.slug),
      name: e.name.slice(0, ROSTER_TEXT_MAX.name),
      color: typeof e.color === 'string' && OUTPUT_COLOR_RE.test(e.color) ? e.color.toLowerCase() : '',
      reportsTo: typeof e.reportsTo === 'string' ? e.reportsTo.slice(0, ROSTER_TEXT_MAX.id) : null
    }
    if (e.added === true) entry.added = true
    if (e.removed === true) entry.removed = true
    out.push(entry)
  }
  return out.length ? out : undefined
}

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
/** How long RunStore keeps its list of the other sessions (who they are, not whether they run: that is the lock). */
const PEERS_FOR_MS = 250

export class RunStore {
  private file: string
  private recordsDir: string
  private runs: RunSummary[] = []
  /**
   * Shared data folder only: the session hosting each run that is not ended (run id -> session id), as `runs.json`
   * says and trimmed to sessions that are running. Empty with one process per data folder.
   */
  private owners: Record<string, string> = Object.create(null) as Record<string, string>
  /** When the owners were last checked for a session that died (see fresh()). */
  private ownersCheckedAt = 0
  private sync: StoreSync
  /** Images already written, by object identity, so periodic flushes of a live record skip hashing. */
  private storedImages = new WeakMap<ImageAttachment, string>()
  /**
   * Called with the summaries a prune or removeProject just deleted (after the index write), so a quick run's
   * scratch dir can be removed once no record points to it. Errors are swallowed: deletion never fails on a hook.
   */
  onRunsRemoved?: (removed: RunSummary[]) => void

  /** `opts.sync` overrides the data folder's own sync (tests that put two sessions in one process). */
  constructor(dataDir: string, opts: { sync?: StoreSync } = {}) {
    this.file = join(dataDir, 'runs.json')
    this.recordsDir = join(dataDir, 'runs')
    this.sync = opts.sync ?? storeSyncFor(dataDir)
    this.sync.load(this.file, () => this.loadIndex(true))
  }

  /**
   * Read the index from disk. Anything still marked live from a session that is gone is actually dead (see
   * normalizeCrashedRunSummary); on a shared data folder a run another running session hosts keeps its status.
   * A first read that fails starts empty, as before. A later re-read that fails keeps what is in memory: the file is
   * only ever replaced whole, so that is damage from outside, and writing an empty index over it would lose every run.
   */
  private loadIndex(first: boolean): void {
    let parsed: unknown
    try {
      parsed = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : null
    } catch (e) {
      if (!first) {
        console.warn(`runs.json could not be read again (${e instanceof Error ? e.name : 'Error'}); keeping the runs in memory.`)
        return
      }
      parsed = null
    }
    const loaded = loadRunIndex(parsed, this.sync.shared ? (id) => this.sync.isSessionLive(id) : undefined)
    this.runs = loaded.runs
    this.owners = loaded.owners
  }

  /**
   * Before a read: pick up what another session wrote, and notice a session that died while hosting a run (its runs
   * are then crashed runs, whether or not the file changed). Nothing to do with one process per data folder.
   */
  private fresh(): void {
    if (!this.sync.shared) return
    if (this.sync.refresh(this.file, () => this.loadIndex(false))) return
    const now = Date.now()
    if (now - this.ownersCheckedAt < OWNER_RECHECK_MS) return
    this.ownersCheckedAt = now
    for (const owner of new Set(Object.values(this.owners))) {
      if (owner !== this.sync.sessionId && !this.sync.isSessionLive(owner)) {
        this.loadIndex(false)
        return
      }
    }
  }

  /** A change to the index: under the write lock, on the newest content (shared), or directly (one process). */
  private change<T>(fn: () => T): T {
    return this.sync.write(this.file, () => this.loadIndex(false), fn)
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    const owners = this.sync.shared && Object.keys(this.owners).length ? { owners: this.owners } : {}
    writeFileSync(tmp, JSON.stringify({ version: 1, runs: this.runs.slice(-500), ...owners }, null, 2), 'utf8')
    renameSyncRetry(tmp, this.file)
  }

  /**
   * The session id of another running orgai that hosts this run (it is not ended there), or null. Always null with one
   * process per data folder. Such a run can be read here but never changed: its host writes it.
   */
  hostedElsewhere(runId: string): string | null {
    if (!this.sync.shared) return null
    this.fresh()
    return this.elsewhere(runId)
  }

  /**
   * Throws RunBusyError when another running orgai session hosts this run (naming that session). A no-op with one
   * process per data folder. For callers about to act on a stored run (continue it, resume it, change it).
   */
  assertHostedHere(runId: string): void {
    if (!this.sync.shared) return
    this.fresh()
    this.refuseElsewhere(runId)
  }

  /**
   * The other running sessions that host a work run of `projectId` with report branches at work right now (their ids,
   * no duplicates): what a session asks before it touches the project's report branches, and what tells a new run
   * that those branches may be another run's work in progress. A run counts while it is starting, running or
   * stopping, and also while it is idle with a report still working in the background or a branch waiting at a merge
   * card (read from its record, which its host saves about every 1.5 s). A run that only waits for its user has no
   * report at work, and a setup or assistant run makes no branches.
   */
  workingElsewhereIn(projectId: string): string[] {
    if (!this.sync.shared) return []
    this.fresh()
    const out = new Set<string>()
    for (const r of this.runs) {
      if (r.projectId !== projectId || !isOpenRunStatus(r.status) || (r.kind !== undefined && r.kind !== 'work')) continue
      const owner = this.elsewhere(r.id)
      if (!owner || out.has(owner)) continue
      if (isWorkingRunStatus(r.status) || this.recordHasWorktreeAtWork(r.id)) out.add(owner)
    }
    return [...out]
  }

  /** {@link hasWorktreeAtWork} for a run's saved record. A record that cannot be read counts as at work: nothing of it is touched. */
  private recordHasWorktreeAtWork(runId: string): boolean {
    const file = this.recordPath(runId)
    if (!existsSync(file)) return false
    try {
      return hasWorktreeAtWork((JSON.parse(readFileSync(file, 'utf8')) as { agents?: unknown }).agents)
    } catch {
      return true
    }
  }

  /** {@link hostedElsewhere} on the index as loaded (no refresh; used inside a change). */
  private elsewhere(runId: string): string | null {
    const owner = this.owners[runId]
    if (owner === undefined || owner === this.sync.sessionId) return null
    return this.sync.isSessionLive(owner) ? owner : null
  }

  private refuseElsewhere(runId: string): void {
    const owner = this.elsewhere(runId)
    if (!owner) return
    throw new RunBusyError(runId, this.sync.session?.others().find((s) => s.hostInstanceId === owner))
  }

  upsert(run: RunSummary): void {
    this.change(() => {
      if (this.sync.shared) {
        // Another running session hosts this run: only it may write the run.
        this.refuseElsewhere(run.id)
        const open = isOpenRunStatus(run.status)
        // A run that is not ended belongs to a project this session holds (a Chat run has no project to hold).
        if (open && !isVirtualProjectId(run.projectId)) this.sync.requireProject(run.projectId)
        if (open) this.owners[run.id] = this.sync.sessionId
        else delete this.owners[run.id]
      }
      // liveElsewhere is what a read adds for the caller, never part of the stored summary.
      const { liveElsewhere: _seen, ...stored } = run
      const idx = this.runs.findIndex((r) => r.id === run.id)
      if (idx === -1) this.runs.push(stored)
      else this.runs[idx] = stored
      this.persist()
    })
  }

  /**
   * Attach computed usage to several summaries in one index write (runUsage normalization of runs saved before
   * usage tracking). Existing usage is kept; unknown ids are ignored. totalCostUsd is left as it was saved.
   */
  setUsage(updates: readonly { id: string; usage: RunUsage }[]): void {
    if (!updates.length) return
    this.change(() => {
      let changed = false
      // One index for the batch: the app-wide usage overview may normalize every legacy run at once.
      const byId = new Map(this.runs.map((r) => [r.id, r]))
      for (const u of updates) {
        const run = byId.get(u.id)
        // A run another session hosts gets its usage from that session.
        if (!run || run.usage || this.elsewhere(u.id)) continue
        run.usage = u.usage
        changed = true
      }
      if (changed) this.persist()
    })
  }

  list(projectId: string): RunSummary[] {
    this.fresh()
    return this.runs
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((r) => this.asSeenHere(r))
  }

  /**
   * A stored summary as this session hands it out: one that another running session hosts says so
   * (RunSummary.liveElsewhere, never written back). `copy`: always a new object.
   */
  private asSeenHere(run: RunSummary, copy = false): RunSummary {
    const owner = this.sync.shared ? this.elsewhere(run.id) : null
    if (!owner) return copy ? { ...run } : run
    let s = this.peers().find((o) => o.hostInstanceId === owner)
    if (!s) {
      // A session that started since the list was read: read it again rather than answer without its pid and folder.
      this.peersAt = 0
      s = this.peers().find((o) => o.hostInstanceId === owner)
    }
    return { ...run, liveElsewhere: { pid: s?.pid ?? 0, cwd: s?.cwd ?? '', command: s?.command ?? '' } }
  }

  /** The other running sessions, read at most once per PEERS_FOR_MS: a list of many runs asks for each of them. */
  private peersAt = 0
  private peersSeen: SessionRecord[] = []
  private peers(): SessionRecord[] {
    const now = Date.now()
    if (now - this.peersAt >= PEERS_FOR_MS || now < this.peersAt) {
      this.peersSeen = this.sync.session?.others() ?? []
      this.peersAt = now
    }
    return this.peersSeen
  }

  get(runId: string): RunSummary | null {
    this.fresh()
    const run = this.runs.find((r) => r.id === runId)
    return run ? this.asSeenHere(run, true) : null
  }

  allProjectIds(): string[] {
    this.fresh()
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
        renameSyncRetry(tmp, file)
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
      const mapped = mapTranscriptImages(block, (img) => {
        if (!img.data) return img // already a ref (or nothing to store)
        const ref = this.storeImage(runId, img)
        return ref ? { ...img, data: '', ref } : img
      })
      return mapped === block ? entry : { ...entry, block: mapped }
    })
  }

  /** Copy of the transcript with image data read back from the image store and refs removed. */
  private rehydrateImages(runId: string, transcript: TranscriptEntry[]): TranscriptEntry[] {
    if (!Array.isArray(transcript)) return transcript
    return transcript.map((entry) => {
      const block = entry?.block
      if (!block) return entry
      let hydratedBytes = 0
      let hydratedCount = 0
      const mapped = mapTranscriptImages(block, (img) => {
        if (img.ref === undefined) return img
        const { ref, ...rest } = img
        let data = ''
        if (typeof ref === 'string' && IMAGE_REF.test(ref)) {
          try {
            const file = join(this.runDir(runId), 'images', ref)
            const rel = relative(realpathSync(this.recordsDir), realpathSync(file))
            const stat = lstatSync(file)
            if (stat.isFile() && !stat.isSymbolicLink() && !isAbsolute(rel) && !rel.startsWith('..') && stat.size <= 10 * 1024 * 1024 && hydratedCount < 8 && hydratedBytes + stat.size <= 10 * 1024 * 1024) {
              const read = readFileSync(file).toString('base64')
              const validated = sanitizeImages([{ ...rest, data: read }])[0]
              if (validated && validated.mediaType === rest.mediaType) {
                data = validated.data
                hydratedBytes += stat.size
                hydratedCount++
              }
            }
          } catch {
            /* missing or unreadable: warned below */
          }
        }
        if (!data) console.warn(`Image ${String(ref)} of run ${runId} is missing from the image store`)
        return { ...rest, data }
      })
      return mapped === block ? entry : { ...entry, block: mapped }
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
    renameSyncRetry(tmp, file)
  }

  getRecord(runId: string): RunRecord | null {
    const file = this.recordPath(runId)
    if (!existsSync(file)) return null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as RunRecord
      const record: RunRecord = { ...parsed, transcript: this.rehydrateImages(runId, parsed.transcript) }
      // A mid-run roster (run.roster) is rebuilt field by field; nothing valid left drops the field (review L1).
      if (record.roster !== undefined) {
        const roster = cleanRunRoster(record.roster)
        if (roster) record.roster = roster
        else delete record.roster
      }
      // The index is the source of truth for status; a crash can leave a record marked live.
      this.fresh()
      const summary = this.runs.find((r) => r.id === runId)
      return summary ? { ...record, summary: this.asSeenHere(summary, true) } : record
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
    const gone = this.change(() => {
      // A run another running session hosts stays: that session writes it and would lose its record.
      const drop = this.runs.filter((r) => r.projectId === projectId && !this.elsewhere(r.id))
      if (!drop.length) return drop
      const ids = new Set(drop.map((r) => r.id))
      this.runs = this.runs.filter((r) => !ids.has(r.id))
      for (const id of ids) delete this.owners[id]
      this.persist()
      return drop
    })
    if (!gone.length) return 0
    for (const r of gone) this.removeRecord(r.id)
    this.notifyRemoved(gone)
    return gone.length
  }

  /** Keep only the newest `keepFor(projectId)` finished runs per project; delete the rest with their records. */
  prune(keepFor: (projectId: string) => number): number {
    const removed = this.change(() => {
      const byProject = new Map<string, RunSummary[]>()
      for (const r of this.runs) {
        const list = byProject.get(r.projectId)
        if (list) list.push(r)
        else byProject.set(r.projectId, [r])
      }
      const drop = new Set<string>()
      for (const [projectId, runs] of byProject) {
        const keep = Math.max(1, keepFor(projectId))
        if (runs.length <= keep) continue
        const sorted = [...runs].sort((a, b) => b.startedAt - a.startedAt)
        for (const r of sorted.slice(keep)) if (r.status === 'finished' || r.status === 'error') drop.add(r.id)
      }
      if (!drop.size) return []
      const gone = this.runs.filter((r) => drop.has(r.id))
      this.runs = this.runs.filter((r) => !drop.has(r.id))
      this.persist()
      return gone
    })
    if (!removed.length) return 0
    for (const r of removed) this.removeRecord(r.id)
    this.notifyRemoved(removed)
    return removed.length
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
    return this.change(() => {
      // Checked before anything moves: a run another running session hosts cannot change project under it.
      for (const id of runIds) this.refuseElsewhere(id)
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
    })
  }

  /** Every stored summary (copies), for the scratch-dir sweep. */
  all(): RunSummary[] {
    this.fresh()
    return this.runs.map((r) => this.asSeenHere(r, true))
  }

  /** Delete record files and run directories (image stores) whose run is no longer in the index. */
  sweepOrphans(): number {
    if (!existsSync(this.recordsDir)) return 0
    // On a shared data folder only a session that is alone sweeps (bootstrap.ts): a record file is written before its
    // run reaches the index, so another session's new run would look like an orphan here.
    this.fresh()
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
