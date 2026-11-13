/**
 * ScheduleService (docs/design/schedules.md 4): the schedule records, their history and the one place a schedule
 * starts a run. Validation (cleanScheduleInput, then validate.ts), save / remove / setEnabled / runNow / history / list,
 * fire(), the apply of an approved 'schedules' proposal and the run-end bookkeeping (outcome, cost, unread, consecutive
 * failures, auto-pause). It never talks to an adapter: a team target starts through RunManager.start and an ask target
 * through QuickRunService.start (the deps below, wired in host/bootstrap.ts), so every check of a user's own start
 * applies. History details and notifications are OrgAI-written sentences only.
 */
import { cleanScheduleInput, nextScheduleRun } from '@shared/schedule'
import { newId } from '@shared/defaults'
import {
  SCHEDULES_MAX,
  SCHEDULE_FAILURES_TO_PAUSE,
  SCHEDULE_MAX_CONCURRENT_RUNS,
  SCHEDULE_PROPOSAL_MAX_ITEMS,
  isVirtualProjectId
} from '@shared/types'
import type {
  Project,
  RunEvent,
  RunSummary,
  Schedule,
  ScheduleHistoryEntry,
  ScheduleProposalItem,
  ScheduleSkipReason,
  SchedulesChangedEvent,
  SchedulesProposalPayload
} from '@shared/types'
import type { ScheduleStore } from './store'
import {
  SCHEDULE_BYPASS_NOT_STARTED,
  effectiveScheduleMode,
  mergeScheduleInput,
  modeWithinTarget,
  scheduleFieldsProblem,
  targetBaseMode,
  type ScheduleCheckEnv,
  type ScheduleUserFields
} from './validate'
import type { RuntimeScheduleAccess } from '../runtime/types'

/** How a scheduled run is started (bootstrap wires RunManager.start / QuickRunService.start). */
export interface ScheduleStartInput {
  schedule: { id: string; name: string }
  prompt: string
  modelSelection?: Schedule['modelSelection']
  permissionMode?: Schedule['permissionMode']
  budgetUsd?: number
}

/** How a live run stands (RunManager.liveRunFacts); null = not live. */
export interface ScheduleRunFacts {
  status: RunSummary['status']
  limitHold: boolean
  pendingCards: number
  /**
   * The run still does work without the user (runActivity.ts state 'working' or 'ending'): an idle root whose reports
   * work, peer messages queued or flushing, a continuation nudge due (review H1).
   */
  working: boolean
}

export interface ScheduleServiceDeps {
  store: ScheduleStore
  now(): number
  /** A stored, non-virtual project. */
  project(projectId: string): Project | undefined
  /** validateQuickFolder as a sentence, or null. */
  folderProblem(folder: string): string | null
  startTeam(project: Project, input: ScheduleStartInput & { team?: 'single' }): Promise<RunSummary>
  startAsk(input: ScheduleStartInput & { folder?: string; allowEdits?: boolean }): Promise<RunSummary>
  liveRunFacts(runId: string): ScheduleRunFacts | null
  /** A paused run's auto-resume is still armed (RunManager.hasAutoResume): it will continue without the user. Missing = never. */
  autoResumePending?(runId: string): boolean
  /** End a run (RunManager.stop): used only for a start that returned after its timeout (review L9). Missing = not stopped. */
  stopRun?(runId: string): Promise<void>
  /** How long a start may take before the slot is recorded as failed (default SCHEDULE_START_TIMEOUT_MS). */
  startTimeoutMs?: number
  /** Re-check delay of an idle run that still works (default IDLE_RECHECK_MS). */
  idleRecheckMs?: number
  /**
   * Live RunManager runs that carry a schedule id (RunSummary.scheduleId), tracked or not: a start past its timeout or
   * an auto-resume between its timer and its tracking still counts (review recheck L-c). Missing = tracked runs only.
   */
  liveScheduleRuns?(): { runId: string; scheduleId: string }[]
  /** The stored or live summary of a run (cost and how it ended). */
  runSummary(runId: string): RunSummary | null
  /** AppSettings.schedulesPaused. */
  globallyPaused(): boolean
  /** Push schedules:changed. */
  changed(event: SchedulesChangedEvent): void
  /** An OS notification (notifications.ts; it honours AppSettings.notifications). Missing = none. */
  notify?(notice: { title: string; body: string; target?: { projectId: string; runId: string } }): void
  log?(message: string): void
}

/** A plain sentence for a start that threw: the real error goes to the log only (it may carry provider text). */
export const START_FAILED_DETAIL = 'The run could not start. Check the model, the connection and the folder, then try Run now.'
const ERROR_REASON = `Paused after ${SCHEDULE_FAILURES_TO_PAUSE} failed runs in a row. Check the history, then turn it back on.`
const PROJECT_MISSING_REASON = 'Its project no longer exists. Edit it to choose another project.'
/** A start that did not return in time (review L9): the slot is recorded as failed and the pass moves on. */
export const START_TIMED_OUT_DETAIL = 'The run took too long to start, so this run was counted as failed. Check the model and the connection, then try Run now.'
export const SCHEDULE_START_TIMEOUT_MS = 5 * 60_000
/** A proposal update built on a schedule that changed afterwards (review M4). */
export const SCHEDULE_CHANGED_SINCE_PROPOSED = 'The schedule changed since this was proposed; ask again.'

/**
 * Live and blocking a next run: working (also an idle root whose reports, peer flush or continuation nudge still run,
 * review H1), or waiting on the user (a card open, a usage-limit hold). An idle run with nothing left is done.
 */
export function runBlocks(facts: ScheduleRunFacts | null): boolean {
  if (!facts) return false
  if (facts.status === 'idle') return facts.pendingCards > 0 || facts.limitHold || facts.working
  return true
}

/** A name for main-written text: clamped, and its double quotes neutralised so it cannot close the quotes around it (review L5). */
const clampName = (s: string): string => (s.length > 80 ? `${s.slice(0, 79)}…` : s).replace(/"/g, "'")

/** The newest entry of a schedule as Schedule.lastEntry. */
function lastEntryOf(e: ScheduleHistoryEntry): NonNullable<Schedule['lastEntry']> {
  return {
    at: e.at,
    slotAt: e.slotAt,
    trigger: e.trigger,
    result: e.result,
    ...(e.reason ? { reason: e.reason } : {}),
    ...(e.outcome ? { outcome: e.outcome } : {}),
    ...(e.runId ? { runId: e.runId } : {})
  }
}

interface Tracked {
  scheduleId: string
  entryId: string
  /** The failure count already reflects this run: 'ok' reset it, 'fail' raised it. */
  counted?: 'ok' | 'fail'
  /** An idle with nothing left already recorded 'finished'; cleared by the next turn. */
  settled?: boolean
}

/** How often an idle scheduled run that still works is looked at again (review recheck H-new). */
export const IDLE_RECHECK_MS = 5_000

export class ScheduleService {
  /**
   * Runs this service started, by run id, until they end. An entry outlives the schedule's deletion (review L2): a
   * deleted schedule's live run still counts toward SCHEDULE_MAX_CONCURRENT_RUNS until it ends.
   */
  private readonly tracked = new Map<string, Tracked>()
  /** Starts in flight per schedule (review M2): counted by the overlap check and the global cap before the run exists. */
  private readonly starting = new Map<string, number>()
  /** Re-check timers of idle tracked runs that still work (settleIdle). */
  private readonly rechecks = new Map<string, ReturnType<typeof setTimeout>>()
  /** What an approved proposal saved, by the payload object (propose_schedule's outcome text). */
  private readonly appliedResults = new WeakMap<SchedulesProposalPayload, Schedule[]>()

  constructor(private readonly deps: ScheduleServiceDeps) {}

  /** The desktop shell's notifier (index.ts), set after boot. */
  setNotify(notify: ScheduleServiceDeps['notify']): void {
    this.deps.notify = notify
  }

  private env(): ScheduleCheckEnv {
    return { now: this.deps.now(), project: (id) => this.deps.project(id), folderProblem: (f) => this.deps.folderProblem(f) }
  }

  private emit(ids: string[], removed?: string[]): void {
    try {
      this.deps.changed({ scheduleIds: ids, ...(removed?.length ? { removed } : {}) })
    } catch (e) {
      this.deps.log?.(`schedules:changed failed: ${(e as Error).message}`)
    }
  }

  private notify(title: string, body: string, target?: { projectId: string; runId: string }): void {
    try {
      this.deps.notify?.({ title, body, ...(target ? { target } : {}) })
    } catch (e) {
      this.deps.log?.(`A schedule notification failed: ${(e as Error).message}`)
    }
  }

  // ---------- reads ----------

  list(): Schedule[] {
    return this.deps.store.list()
  }

  get(id: string): Schedule | undefined {
    return this.deps.store.get(id)
  }

  /** Newest first; clears the schedule's unread count (skipped silently while the store is read-only). */
  history(scheduleId: string): ScheduleHistoryEntry[] {
    const s = this.deps.store.get(scheduleId)
    if (!s) throw new Error('That schedule no longer exists.')
    if (s.unread > 0 && this.deps.store.readOnlyReason() === null) {
      this.deps.store.update((d) => {
        const t = d.schedules.find((x) => x.id === scheduleId)
        if (t) t.unread = 0
      })
      this.emit([scheduleId])
    }
    return this.deps.store.history(scheduleId)
  }

  /** RuntimeContext.schedules for list_schedules / propose_schedule. */
  access(): RuntimeScheduleAccess {
    return {
      list: () => this.list(),
      storedProject: (id) => (isVirtualProjectId(id) ? undefined : this.deps.project(id)),
      folderProblem: (f) => this.deps.folderProblem(f),
      now: () => this.deps.now(),
      applied: (payload) => this.appliedResults.get(payload)?.map((s) => ({ ...s }))
    }
  }

  // ---------- writes ----------

  /** Next run and state of an enabled / disabled schedule after a user or proposal change. */
  private placed(fields: ScheduleUserFields, lastSlotAt: number | undefined, now: number): Pick<Schedule, 'state' | 'nextRunAt'> {
    if (!fields.enabled) return { state: 'paused' }
    const next = nextScheduleRun(fields.timing, now, lastSlotAt)
    return next === null ? { state: 'paused' } : { state: 'active', nextRunAt: next }
  }

  /** The record of merged fields onto `existing` (or a new one). */
  private build(fields: ScheduleUserFields, existing: Schedule | undefined, createdBy: Schedule['createdBy'], now: number): Schedule {
    const placed = this.placed(fields, existing?.lastSlotAt, now)
    const out: Schedule = {
      id: existing?.id ?? newScheduleId(),
      ...fields,
      state: placed.state,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      createdBy: existing?.createdBy ?? createdBy,
      consecutiveFailures: fields.enabled ? 0 : (existing?.consecutiveFailures ?? 0),
      unread: existing?.unread ?? 0
    }
    if (placed.nextRunAt !== undefined) out.nextRunAt = placed.nextRunAt
    if (existing?.lastSlotAt !== undefined) out.lastSlotAt = existing.lastSlotAt
    if (existing?.lastEntry) out.lastEntry = { ...existing.lastEntry }
    // A schedule the user turned off keeps its error reason so the page can still say why it stopped.
    if (!fields.enabled && existing?.state === 'error' && existing.stateReason) {
      out.state = 'error'
      out.stateReason = existing.stateReason
    }
    return out
  }

  private writable(): void {
    const ro = this.deps.store.readOnlyReason()
    if (ro) throw new Error(ro)
  }

  /** schedules:save. Throws a plain sentence on any problem; nothing is written then. */
  save(raw: unknown): Schedule {
    this.writable()
    const cleaned = cleanScheduleInput(raw)
    if (!cleaned.ok) throw new Error(cleaned.problem)
    const input = cleaned.value
    const now = this.deps.now()
    const existing = input.id ? this.deps.store.get(input.id) : undefined
    if (input.id && !existing) throw new Error('That schedule no longer exists.')
    if (existing && input.expectedUpdatedAt !== undefined && existing.updatedAt !== input.expectedUpdatedAt) {
      throw new Error('This schedule changed since you opened it. Close the form and open it again.')
    }
    const fields = mergeScheduleInput(input, existing, now)
    const problem = scheduleFieldsProblem(fields, this.env())
    if (problem) throw new Error(problem)
    const saved = this.deps.store.update((d) => {
      if (!existing && d.schedules.length >= SCHEDULES_MAX) throw new Error(`You can have at most ${SCHEDULES_MAX} schedules. Delete one first.`)
      const next = this.build(fields, existing, 'user', now)
      const i = d.schedules.findIndex((s) => s.id === next.id)
      if (i >= 0) d.schedules[i] = next
      else d.schedules.push(next)
      return next
    })
    this.emit([saved.id])
    return this.deps.store.get(saved.id) ?? saved
  }

  /** schedules:remove: the schedule and its history go; its runs stay. */
  remove(id: string): void {
    this.writable()
    if (!this.deps.store.get(id)) throw new Error('That schedule no longer exists.')
    this.deps.store.update((d) => {
      d.schedules = d.schedules.filter((s) => s.id !== id)
      d.history = d.history.filter((h) => h.scheduleId !== id)
    })
    // Its live runs stay tracked (they still count toward the cap until they end; their bookkeeping finds no schedule).
    this.emit([], [id])
  }

  /** schedules:setEnabled. Enabling clears 'error' and the failure count; a schedule with no next run refuses. */
  setEnabled(id: string, enabled: boolean): Schedule {
    this.writable()
    const existing = this.deps.store.get(id)
    if (!existing) throw new Error('That schedule no longer exists.')
    const now = this.deps.now()
    const fields: ScheduleUserFields = { ...userFieldsOf(existing), enabled }
    if (enabled) {
      const problem = scheduleFieldsProblem(fields, this.env())
      if (problem) throw new Error(problem)
    }
    const saved = this.deps.store.update((d) => {
      const i = d.schedules.findIndex((s) => s.id === id)
      if (i < 0) throw new Error('That schedule no longer exists.')
      const next = this.build(fields, d.schedules[i], 'user', now)
      if (enabled) {
        next.consecutiveFailures = 0
        delete next.stateReason
      } else if (next.state !== 'error') delete next.stateReason
      d.schedules[i] = next
      return next
    })
    this.emit([id])
    return saved
  }

  // ---------- proposals ----------

  /**
   * An approved 'schedules' proposal: every item validated again (the tool's checks are not trusted), then all of them
   * written in one store update, or none. `origin.projectId` is the proposing work run's project (null = Chat): such a
   * run may only touch schedules of its own project. An agent's mode must stay within the target's own mode.
   */
  applyProposal(payload: SchedulesProposalPayload, origin: { projectId: string | null }): Schedule[] {
    this.writable()
    const items: ScheduleProposalItem[] = Array.isArray(payload?.items) ? payload.items : []
    if (!items.length || items.length > SCHEDULE_PROPOSAL_MAX_ITEMS) throw new Error('The proposal has no valid changes.')
    const now = this.deps.now()
    const env = this.env()
    const own = (s: { target: Schedule['target'] }): boolean => origin.projectId === null || (s.target.kind === 'team' && s.target.projectId === origin.projectId)
    type Planned = { action: ScheduleProposalItem['action']; id?: string; fields?: ScheduleUserFields }
    const planned: Planned[] = []
    for (const item of items) {
      const action = item?.action
      if (action === 'create' || action === 'update') {
        const cleaned = cleanScheduleInput(action === 'update' ? { ...item.schedule, id: item.scheduleId } : { ...item.schedule, id: undefined })
        if (!cleaned.ok) throw new Error(cleaned.problem)
        const existing = action === 'update' ? (item.scheduleId ? this.deps.store.get(item.scheduleId) : undefined) : undefined
        if (action === 'update' && !existing) throw new Error('A schedule in the proposal no longer exists.')
        if (existing && !own(existing)) throw new Error('A project run can only change its own project\'s schedules.')
        // The card showed the merged schedule as it was when proposed (review M4): a later change makes it stale.
        if (existing && action === 'update' && (cleaned.value.expectedUpdatedAt === undefined || cleaned.value.expectedUpdatedAt !== existing.updatedAt)) {
          throw new Error(SCHEDULE_CHANGED_SINCE_PROPOSED)
        }
        const fields = mergeScheduleInput(cleaned.value, existing, now)
        if (!own(fields)) throw new Error('A project run can only schedule runs of its own project.')
        const project = fields.target.kind === 'team' ? env.project(fields.target.projectId) : undefined
        if (fields.permissionMode && !modeWithinTarget(fields.permissionMode, fields.target, project)) {
          throw new Error(`The permission mode is wider than the target's own (${targetBaseMode(fields.target, project)}).`)
        }
        const problem = scheduleFieldsProblem(fields, env)
        if (problem) throw new Error(problem)
        planned.push({ action, ...(existing ? { id: existing.id } : {}), fields })
      } else if (action === 'remove' || action === 'pause' || action === 'resume') {
        const existing = item.scheduleId ? this.deps.store.get(item.scheduleId) : undefined
        if (!existing) throw new Error('A schedule in the proposal no longer exists.')
        if (!own(existing)) throw new Error('A project run can only change its own project\'s schedules.')
        const fields = { ...userFieldsOf(existing), enabled: action === 'resume' ? true : action === 'pause' ? false : existing.enabled }
        if (action === 'resume') {
          const problem = scheduleFieldsProblem(fields, env)
          if (problem) throw new Error(problem)
        }
        planned.push({ action, id: existing.id, fields })
      } else {
        throw new Error('The proposal has an unknown change.')
      }
    }
    const ids = planned.map((p) => p.id).filter((x): x is string => !!x)
    if (new Set(ids).size !== ids.length) throw new Error('The proposal changes one schedule twice.')
    const removed: string[] = []
    const result = this.deps.store.update((d) => {
      const out: Schedule[] = []
      const creates = planned.filter((p) => p.action === 'create').length
      const removes = planned.filter((p) => p.action === 'remove').length
      if (d.schedules.length - removes + creates > SCHEDULES_MAX) throw new Error(`You can have at most ${SCHEDULES_MAX} schedules.`)
      for (const p of planned) {
        const i = p.id ? d.schedules.findIndex((s) => s.id === p.id) : -1
        if (p.id && i < 0) throw new Error('A schedule in the proposal no longer exists.')
        if (p.action === 'remove') {
          out.push({ ...d.schedules[i], enabled: false })
          removed.push(p.id!)
          d.schedules.splice(i, 1)
          d.history = d.history.filter((h) => h.scheduleId !== p.id)
          continue
        }
        const existing = i >= 0 ? d.schedules[i] : undefined
        const next = this.build(p.fields!, existing, 'agent', now)
        if (p.action === 'resume') delete next.stateReason
        if (p.action === 'pause' && existing?.state !== 'error') delete next.stateReason
        if (i >= 0) d.schedules[i] = next
        else d.schedules.push(next)
        out.push(next)
      }
      return out
    })
    this.appliedResults.set(payload, result)
    this.emit(result.filter((s) => !removed.includes(s.id)).map((s) => s.id), removed)
    return result
  }

  // ---------- firing (scheduler.ts and runNow) ----------

  /** Does a tracked run block: live and working or waiting on the user, or paused with its auto-resume armed (review L1). */
  private trackedBlocks(runId: string): boolean {
    if (runBlocks(this.deps.liveRunFacts(runId))) return true
    try {
      return this.deps.autoResumePending?.(runId) === true
    } catch {
      return false
    }
  }

  /** Scheduled runs this service started that still block (trackedBlocks), plus starts in flight (review M2). */
  liveScheduledRuns(): number {
    let n = 0
    for (const runId of this.tracked.keys()) if (this.trackedBlocks(runId)) n++
    // A start in flight is usually already a live (untracked) run in RunManager: per schedule, count the larger of the
    // two so the same run is never counted twice.
    const untracked = new Map<string, number>()
    for (const r of this.untrackedLive()) if (runBlocks(this.deps.liveRunFacts(r.runId))) untracked.set(r.scheduleId, (untracked.get(r.scheduleId) ?? 0) + 1)
    for (const id of new Set([...this.starting.keys(), ...untracked.keys()])) n += Math.max(this.starting.get(id) ?? 0, untracked.get(id) ?? 0)
    return n
  }

  /** Live runs with a schedule id this service does not track (yet). */
  private untrackedLive(): { runId: string; scheduleId: string }[] {
    try {
      return (this.deps.liveScheduleRuns?.() ?? []).filter((r) => !this.tracked.has(r.runId))
    } catch {
      return []
    }
  }

  /** Enabled schedules with a next run (the quit gate's "scheduled runs are due"). */
  pendingCount(): number {
    // Nothing fires under the global pause (review L7): no pending schedule then.
    if (this.deps.globallyPaused()) return 0
    return this.deps.store.list().filter((s) => s.enabled && s.nextRunAt !== undefined).length
  }

  private previousBlocks(scheduleId: string): boolean {
    if ((this.starting.get(scheduleId) ?? 0) > 0) return true
    for (const [runId, t] of this.tracked) if (t.scheduleId === scheduleId && this.trackedBlocks(runId)) return true
    for (const r of this.untrackedLive()) if (r.scheduleId === scheduleId && runBlocks(this.deps.liveRunFacts(r.runId))) return true
    return false
  }

  /** Append a history entry (and lastEntry, unread) and optionally patch the schedule, in one write. */
  private record(scheduleId: string, entry: Omit<ScheduleHistoryEntry, 'id' | 'scheduleId'>, patch?: (s: Schedule) => void): ScheduleHistoryEntry {
    const full: ScheduleHistoryEntry = { id: newId('sh'), scheduleId, ...entry }
    this.deps.store.update((d) => {
      const s = d.schedules.find((x) => x.id === scheduleId)
      if (!s) return
      d.history.push(full)
      s.unread = (s.unread ?? 0) + 1
      s.lastEntry = lastEntryOf(full)
      patch?.(s)
    })
    this.emit([scheduleId])
    return full
  }

  /** One skipped entry (scheduler: app-closed, paused-globally). */
  recordSkip(scheduleId: string, slotAt: number, trigger: ScheduleHistoryEntry['trigger'], reason: ScheduleSkipReason): ScheduleHistoryEntry {
    return this.record(scheduleId, { slotAt, at: this.deps.now(), trigger, result: 'skipped', reason })
  }

  /**
   * The scheduler's mark, written BEFORE the run starts (a crash never refires the slot): lastSlotAt, the next run,
   * and 'done' when there is none (a once schedule) or the end date passed.
   */
  claimSlot(scheduleId: string, slotAt: number): Schedule | undefined {
    const now = this.deps.now()
    const out = this.deps.store.update((d) => {
      const s = d.schedules.find((x) => x.id === scheduleId)
      // A schedule deleted or paused since the pass read it is not claimed (review M1).
      if (!s || !s.enabled) return undefined
      s.lastSlotAt = Math.max(slotAt, s.lastSlotAt ?? 0)
      const next = nextScheduleRun(s.timing, now, s.lastSlotAt)
      if (next === null || (s.expiresAt !== undefined && next > s.expiresAt)) {
        markDone(s, s.timing.kind === 'once' ? 'The single run was handled.' : 'The end date passed.')
      } else s.nextRunAt = next
      s.updatedAt = now
      return { ...s }
    })
    if (out) this.emit([scheduleId])
    return out
  }

  /** A schedule whose end date passed before its next slot: 'done', nothing recorded. */
  expire(scheduleId: string): void {
    this.deps.store.update((d) => {
      const s = d.schedules.find((x) => x.id === scheduleId)
      if (s) {
        markDone(s, 'The end date passed.')
        s.updatedAt = this.deps.now()
      }
    })
    this.emit([scheduleId])
  }

  /**
   * Start one run of `schedule` for `slotAt`, or record why not: a team target whose project is gone (the schedule is
   * disabled at once), the previous run still live, the global cap, a start that throws (counts as a failure). Every
   * start goes through deps.startTeam / startAsk (RunManager.start / QuickRunService.start).
   */
  async fire(schedule: Schedule, slotAt: number, trigger: ScheduleHistoryEntry['trigger']): Promise<ScheduleHistoryEntry> {
    const now = (): number => this.deps.now()
    const target = schedule.target
    const project = target.kind === 'team' ? this.deps.project(target.projectId) : undefined
    if (target.kind === 'team' && (!project || isVirtualProjectId(target.projectId))) {
      const entry = this.record(schedule.id, { slotAt, at: now(), trigger, result: 'skipped', reason: 'project-missing' }, (s) => {
        s.enabled = false
        s.state = 'error'
        s.stateReason = PROJECT_MISSING_REASON
        delete s.nextRunAt
      })
      this.notify(`Schedule "${clampName(schedule.name)}" stopped`, PROJECT_MISSING_REASON)
      return entry
    }
    // No bypass, also not inherited from a project changed after the save (review M3): not started, counted as a failure.
    if (target.kind === 'team' && effectiveScheduleMode(schedule, project) === 'bypassPermissions') {
      return this.recordStartFailure(schedule, slotAt, trigger, SCHEDULE_BYPASS_NOT_STARTED)
    }
    if (this.previousBlocks(schedule.id)) return this.record(schedule.id, { slotAt, at: now(), trigger, result: 'skipped', reason: 'previous-running' })
    if (this.liveScheduledRuns() >= SCHEDULE_MAX_CONCURRENT_RUNS) return this.record(schedule.id, { slotAt, at: now(), trigger, result: 'skipped', reason: 'too-many-running' })
    const input: ScheduleStartInput = {
      schedule: { id: schedule.id, name: schedule.name },
      prompt: schedule.prompt,
      ...(schedule.modelSelection ? { modelSelection: { ...schedule.modelSelection } } : {}),
      ...(schedule.permissionMode ? { permissionMode: schedule.permissionMode } : {}),
      ...(schedule.budgetUsd !== undefined ? { budgetUsd: schedule.budgetUsd } : {})
    }
    // Counted before the await (review M2): a second Run now or a timer pass sees this start at once.
    this.starting.set(schedule.id, (this.starting.get(schedule.id) ?? 0) + 1)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      const left = (this.starting.get(schedule.id) ?? 1) - 1
      if (left > 0) this.starting.set(schedule.id, left)
      else this.starting.delete(schedule.id)
    }
    let timedOut = false
    /** A start that returned after the timeout and the failed entry the timeout wrote; whichever comes second acts. */
    const late: { run?: RunSummary; entryId?: string } = {}
    let timer: ReturnType<typeof setTimeout> | undefined
    let run: RunSummary
    try {
      let started: Promise<RunSummary>
      if (target.kind === 'team') started = this.deps.startTeam(project!, { ...input, ...(target.team === 'single' ? { team: 'single' as const } : {}) })
      else {
        // The folder is checked again at every fire (it may have moved or become unsafe).
        const folderProblem = target.folder !== undefined ? this.deps.folderProblem(target.folder) : null
        if (folderProblem) throw new Error(folderProblem)
        started = this.deps.startAsk({ ...input, ...(target.folder !== undefined ? { folder: target.folder } : {}), ...(target.allowEdits ? { allowEdits: true } : {}) })
      }
      // A start that never returns must not hang the pass (review L9). A run that arrives after the timeout is tracked
      // (it counts toward the overlap rule and the cap until it ends) and stopped: nobody is waiting for it any more.
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(new Error('timed out'))
        }, this.deps.startTimeoutMs ?? SCHEDULE_START_TIMEOUT_MS)
      })
      started.then(
        (arrived) => {
          if (!timedOut) return
          late.run = arrived
          if (late.entryId !== undefined) this.lateStart(schedule, arrived, late.entryId)
        },
        () => undefined
      )
      run = await Promise.race([started, timeout])
    } catch (e) {
      this.deps.log?.(`Schedule ${schedule.id}: the run did not start: ${(e as Error)?.message ?? String(e)}`)
      release()
      const entry = this.recordStartFailure(schedule, slotAt, trigger, timedOut ? START_TIMED_OUT_DETAIL : START_FAILED_DETAIL)
      if (timedOut) {
        late.entryId = entry.id
        if (late.run) this.lateStart(schedule, late.run, entry.id)
      }
      return entry
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      release()
    }
    const entry = this.record(schedule.id, { slotAt, at: now(), trigger, result: 'started', runId: run.id, projectId: run.projectId })
    this.tracked.set(run.id, { scheduleId: schedule.id, entryId: entry.id })
    return entry
  }

  /** A failed entry with a fixed sentence; counts toward the auto-pause. */
  private recordStartFailure(schedule: Schedule, slotAt: number, trigger: ScheduleHistoryEntry['trigger'], detail: string): ScheduleHistoryEntry {
    let paused = false
    const entry = this.record(schedule.id, { slotAt, at: this.deps.now(), trigger, result: 'failed', reason: 'start-refused', detail }, (s) => {
      paused = this.countFailure(s)
    })
    if (paused) this.notify(`Schedule "${clampName(schedule.name)}" paused`, ERROR_REASON)
    else this.notify(`Schedule "${clampName(schedule.name)}"`, detail)
    return entry
  }

  /** A run whose start returned after the timeout: tracked against the newest entry (already failed) and stopped. */
  private lateStart(schedule: Schedule, run: RunSummary, entryId: string): void {
    try {
      // counted 'fail': the timeout already raised the failure count; its end must not count again or reset it.
      this.tracked.set(run.id, { scheduleId: schedule.id, entryId, counted: 'fail' })
      this.deps.log?.(`Schedule ${schedule.id}: run ${run.id} started after the timeout; stopping it.`)
      void this.deps.stopRun?.(run.id).catch((e: unknown) => this.deps.log?.(`Schedule ${schedule.id}: could not stop run ${run.id}: ${(e as Error)?.message ?? String(e)}`))
    } catch (e) {
      this.deps.log?.(`Schedule ${schedule.id}: late start bookkeeping failed: ${(e as Error)?.message ?? String(e)}`)
    }
  }

  /** schedules:runNow: trigger 'manual', works while paused (the schedule's or the global pause); the overlap rules apply. */
  async runNow(id: string): Promise<ScheduleHistoryEntry> {
    this.writable()
    const s = this.deps.store.get(id)
    if (!s) throw new Error('That schedule no longer exists.')
    return this.fire(s, this.deps.now(), 'manual')
  }

  /** Raise the failure count; at the limit disable the schedule with state 'error'. True when it was paused now. */
  private countFailure(s: Schedule): boolean {
    s.consecutiveFailures = (s.consecutiveFailures ?? 0) + 1
    if (s.consecutiveFailures < SCHEDULE_FAILURES_TO_PAUSE || !s.enabled) return false
    s.enabled = false
    s.state = 'error'
    s.stateReason = ERROR_REASON
    delete s.nextRunAt
    return true
  }

  // ---------- run end ----------

  /** Every broadcast RunEvent (bootstrap's bus listener). Only runs this service started are looked at. */
  onRunEvent(event: RunEvent): void {
    let t = this.tracked.get(event.runId)
    if (!t) {
      // A usage-limit auto-resume of a tracked run (review L1): RunManager carries the schedule id on that continuation
      // only, so the successor is tracked in its predecessor's place (same entry, same failure bookkeeping).
      if (event.type !== 'run.status' || event.status !== 'starting' || this.tracked.size === 0) return
      const s = this.deps.runSummary(event.runId)
      const prev = s?.resumedFrom ? this.tracked.get(s.resumedFrom) : undefined
      if (!s || !prev) return
      this.clearRecheck(s.resumedFrom!)
      if (s.scheduleId && prev.scheduleId === s.scheduleId) {
        t = { ...prev, settled: false }
        this.tracked.delete(s.resumedFrom!)
        this.tracked.set(event.runId, t)
        return
      }
      // The user continued it themselves (no schedule id): the schedule's run ends here (review recheck L-f).
      try {
        this.setOutcome(s.resumedFrom!, prev, 'stopped')
      } catch (e) {
        this.deps.log?.(`Schedule ${prev.scheduleId}: run-end bookkeeping failed: ${(e as Error).message}`)
      }
      this.tracked.delete(s.resumedFrom!)
      return
    }
    try {
      if (event.type.endsWith('.request')) {
        this.setOutcome(event.runId, t, 'needs-you')
        return
      }
      if (event.type !== 'run.status') return
      if (event.status === 'idle') {
        // The turn ended and nothing waits on the user: done for the schedule (the session may still take a message).
        // Reports, a peer flush or a continuation nudge still at work (review H1): not done yet. The adapters report
        // idle before the continuation driver settles and that settling sends no event, so settleIdle re-checks on a
        // timer (and the scheduler sweeps every pass) until the run is done or turns busy again.
        this.settleIdle(event.runId)
        return
      }
      if (event.status === 'starting' || event.status === 'running') {
        // A new turn: an earlier idle 'finished' may be followed by more work; the next idle settles again.
        t.settled = false
        this.clearRecheck(event.runId)
        return
      }
      if (event.status === 'paused') {
        // Paused and waiting on the user (no auto-resume): that is what the history says until it moves on.
        if (event.autoResume === false) this.setOutcome(event.runId, t, 'needs-you')
        return
      }
      if (event.status === 'error') {
        this.clearRecheck(event.runId)
        this.setOutcome(event.runId, t, 'error')
        this.tracked.delete(event.runId)
        return
      }
      if (event.status === 'finished') {
        this.clearRecheck(event.runId)
        // A run paused at a usage limit hands over to its continuation: not an outcome of the schedule.
        if (event.pausedUntil) return
        const summary = this.deps.runSummary(event.runId)
        const endedBy = event.endedBy ?? summary?.endedBy
        // A budget end counts as a failure (a schedule that keeps hitting its cap pauses itself).
        const outcome = endedBy === 'budget' ? 'error' : endedBy === 'user' || endedBy === 'app' || endedBy === 'policy' ? 'stopped' : 'finished'
        this.setOutcome(event.runId, t, outcome)
        this.tracked.delete(event.runId)
      }
    } catch (e) {
      this.deps.log?.(`Schedule ${t.scheduleId}: run-end bookkeeping failed: ${(e as Error).message}`)
    }
  }

  /**
   * An idle tracked run: 'finished' once nothing blocks it any more (not working, no card, no hold); while it still
   * works, look again after IDLE_RECHECK_MS. A run that is no longer idle (a new turn, an end) stops the re-checks.
   */
  private settleIdle(runId: string): void {
    const t = this.tracked.get(runId)
    this.clearRecheck(runId)
    if (!t || t.settled) return
    const facts = this.deps.liveRunFacts(runId)
    if (!facts || facts.status !== 'idle') return
    if (!runBlocks(facts)) {
      t.settled = true
      this.setOutcome(runId, t, 'finished')
      return
    }
    // A card or a usage-limit hold waits on the user: their answer brings a new turn and a new idle.
    if (!facts.working) return
    const timer = setTimeout(() => {
      this.rechecks.delete(runId)
      try {
        this.settleIdle(runId)
      } catch (e) {
        this.deps.log?.(`Schedule ${t.scheduleId}: run-end bookkeeping failed: ${(e as Error).message}`)
      }
    }, this.deps.idleRecheckMs ?? IDLE_RECHECK_MS)
    ;(timer as { unref?: () => void }).unref?.()
    this.rechecks.set(runId, timer)
  }

  private clearRecheck(runId: string): void {
    const timer = this.rechecks.get(runId)
    if (timer !== undefined) clearTimeout(timer)
    this.rechecks.delete(runId)
  }

  /** The scheduler's backstop at every pass: settle tracked idle runs whose work ended without an event. */
  sweep(): void {
    for (const [runId, t] of [...this.tracked]) {
      if (t.settled) continue
      try {
        this.settleIdle(runId)
      } catch (e) {
        this.deps.log?.(`Schedule ${t.scheduleId}: run-end bookkeeping failed: ${(e as Error).message}`)
      }
    }
  }

  private setOutcome(runId: string, t: Tracked, outcome: NonNullable<ScheduleHistoryEntry['outcome']>): void {
    if (this.deps.store.readOnlyReason()) return
    const summary = this.deps.runSummary(runId)
    const cost = summary ? (summary.usage?.costUsd ?? summary.totalCostUsd) : undefined
    const costUsd = typeof cost === 'number' && Number.isFinite(cost) ? Math.max(0, cost) : null
    let paused = false
    let name = ''
    this.deps.store.update((d) => {
      const s = d.schedules.find((x) => x.id === t.scheduleId)
      const h = d.history.find((x) => x.id === t.entryId)
      if (!s || !h) return
      name = s.name
      // A run that ended keeps its final outcome; "needs you" never overwrites it.
      if (outcome === 'needs-you' && h.outcome !== undefined && h.outcome !== 'needs-you') return
      h.outcome = outcome
      h.costUsd = costUsd
      if (s.lastEntry && s.lastEntry.runId === h.runId) s.lastEntry = lastEntryOf(h)
      if (outcome === 'finished' && t.counted !== 'ok') {
        s.consecutiveFailures = 0
        t.counted = 'ok'
      } else if (outcome === 'error' && t.counted !== 'fail') {
        paused = this.countFailure(s)
        t.counted = 'fail'
      }
    })
    this.emit([t.scheduleId])
    if (paused) this.notify(`Schedule "${clampName(name)}" paused`, ERROR_REASON)
  }
}

function markDone(s: Schedule, reason: string): void {
  s.enabled = false
  s.state = 'done'
  s.stateReason = reason
  delete s.nextRunAt
}

function userFieldsOf(s: Schedule): ScheduleUserFields {
  return {
    name: s.name,
    prompt: s.prompt,
    target: s.target,
    timing: s.timing,
    enabled: s.enabled,
    missed: s.missed,
    ...(s.modelSelection ? { modelSelection: s.modelSelection } : {}),
    ...(s.permissionMode ? { permissionMode: s.permissionMode } : {}),
    ...(s.budgetUsd !== undefined ? { budgetUsd: s.budgetUsd } : {}),
    ...(s.expiresAt !== undefined ? { expiresAt: s.expiresAt } : {})
  }
}

function newScheduleId(): string {
  const bytes = new Uint8Array(8)
  globalThis.crypto.getRandomValues(bytes)
  return `sch_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}
