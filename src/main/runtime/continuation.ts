import type { PlanStep, Project, ProjectKind, Role, RunKind, RunPlan, RunSummary } from '@shared/types'
import { DEFAULT_MAX_AUTO_CONTINUES } from '@shared/types'
import { effectiveSubagentLimits } from '@shared/defaults'
import { pathOverlaps, readySteps, type PathOverlap } from '@shared/planGraph'

/**
 * Unattended execution, vendor-neutral. The orchestrator keeps a plan with the harness's plan tools
 * (set_plan, update_plan, complete_plan, mark_blocked); whenever one of its turns ends with steps left,
 * the harness reminds it of what remains so the run carries on to completion without the user.
 *
 * `nextNudge` is the pure decision. `ContinuationDriver` is the timer and bookkeeping around it that
 * every adapter uses: the adapter reports turn ends, user messages and interrupts, and delivers the
 * nudge through its own "message the orchestrator" path.
 */

/** Bare names of the plan tools. Adapters may namespace them (Claude: mcp__orgai__<name>). */
export const PLAN_TOOLS = {
  set: 'set_plan',
  update: 'update_plan',
  complete: 'complete_plan',
  blocked: 'mark_blocked'
} as const

/** Wait this long after a turn ends before nudging, so a report that just landed can wake the orchestrator first. */
export const DEFAULT_CONTINUATION_DELAY_MS = 1500

/**
 * How long turnEnded waits before evaluating. A host that does not report `lastReportEndedAt` (`known` false) always
 * waits the full `delayMs`, as does one with live reports or a report end time in the future (clock went backwards).
 * Otherwise only what is left of the window after the newest report ended: 0 when none ever ended or it ended at
 * least `delayMs` ago. Never negative, never more than `delayMs`.
 */
export function continuationWaitMs(input: { delayMs: number; liveReports: number; lastReportEndedAt?: number; now: number; known: boolean }): number {
  const { delayMs, liveReports, lastReportEndedAt, now, known } = input
  if (!known || liveReports > 0) return delayMs
  if (lastReportEndedAt === undefined) return 0
  const elapsed = now - lastReportEndedAt
  if (elapsed < 0) return delayMs
  return Math.min(delayMs, Math.max(0, delayMs - elapsed))
}

export const SET_PLAN_NUDGE = 'Harness: before continuing, call set_plan with the goal and the concrete steps, then start on step 1.'
/** What the user reads in the transcript for SET_PLAN_NUDGE (the full text is the entry's `detail`). */
export const SET_PLAN_SUMMARY = 'Continuing: asked the orchestrator to write a plan before it works.'

/** Steps still to do: anything not done or skipped. */
export function remainingSteps(plan: RunPlan): PlanStep[] {
  return plan.steps.filter((s) => s.status !== 'done' && s.status !== 'skipped')
}

/** Steps counted as finished for "X of Y done": done and skipped. */
export function finishedCount(plan: RunPlan): number {
  return plan.steps.length - remainingSteps(plan).length
}

export { pathOverlaps, readySteps }
export type { PathOverlap }

/** Ready steps that name a report (`staff.role` set) other than the caller's own role (`ownRoles`: its slug and name). */
export function readyReports(plan: RunPlan, ownRoles: readonly string[] = []): PlanStep[] {
  const own = ownRoles.map((r) => r.trim().toLowerCase()).filter(Boolean)
  return readySteps(plan).filter((s) => {
    const role = s.staff?.role.trim().toLowerCase()
    return !!role && !own.includes(role)
  })
}

export interface AgentSlots {
  free: number
  limit: number
}

/** Free agent slots: the project's concurrency limit (effectiveSubagentLimits) minus the reports running now. */
export function agentSlots(ctx: { project: Project; roles: Role[] }, liveReports: number): AgentSlots {
  const limit = effectiveSubagentLimits({ ...ctx.project, roles: ctx.roles }).concurrency
  return { free: Math.max(0, limit - Math.max(0, liveReports)), limit }
}

/** The orchestrator's own role as plan steps may name it: slug and name (the root role). */
export function rootRoleNames(roles: readonly Role[]): string[] {
  const root = roles.find((r) => r.reportsTo === null) ?? roles[0]
  return root ? [root.slug, root.name] : []
}

/**
 * What can start now, for a plan tool result (`nudge` false) or the idle nudge (true). '' when nothing is ready.
 * One step with a free slot is just named; several give the free slots and how to start them.
 */
export function readyLine(ready: readonly PlanStep[], slots: AgentSlots, nudge = false): string {
  if (!ready.length) return ''
  const list = ready.map((s) => `${s.id} (${s.staff?.role ?? 'lead'})`).join(', ')
  const head = `Ready now: ${list}.`
  const count = `${slots.free} of ${slots.limit} agent slots are free`
  if (slots.free <= 0) return `${head} ${count}; start ${ready.length === 1 ? 'it' : 'them'} when a report ends.`
  const fit = ready.length > slots.free
  const how = 'in one message: calls in one message run together.'
  if (nudge) {
    const names = fit ? `the first ${slots.free}` : ready.length === 1 ? 'it' : 'them'
    return `${head} ${count}${fit ? `, so only ${slots.free} fit now` : ''}. Start ${names} in one message (calls in one message run together), or call update_plan if they should wait.`
  }
  if (fit) return `${head} ${count}, so only ${slots.free} fit now. Start those ${how}`
  if (ready.length === 1) return head
  return `${head} ${count}. Start them ${how}`
}

/** The signature of a ready set: sorted step ids. */
export function readySignature(ready: readonly PlanStep[]): string {
  return ready.map((s) => s.id).sort().join(',')
}

/** The step being worked on now, or the next one to start. */
export function nextStep(plan: RunPlan): PlanStep | undefined {
  return plan.steps.find((s) => s.status === 'in_progress') ?? plan.steps.find((s) => s.status === 'pending') ?? remainingSteps(plan)[0]
}

/** One-line progress, e.g. "3/7 steps". */
export function planProgressLabel(plan: RunPlan): string {
  return `${finishedCount(plan)}/${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}`
}

/** Root-node activity for the step in progress, if any. */
export function stepActivity(plan: RunPlan | undefined): string | undefined {
  const step = plan?.status === 'active' ? plan.steps.find((s) => s.status === 'in_progress') : undefined
  return step ? step.title.slice(0, 90) : undefined
}

/**
 * A log line for a plan change, or null when only bookkeeping moved (the automatic-continue count,
 * the timestamp), which the continuation driver logs itself.
 */
export function describePlanChange(previous: RunPlan | undefined, next: RunPlan): string | null {
  const progress = `${finishedCount(next)} of ${next.steps.length} steps done`
  if (!previous) return `Plan set: ${next.goal.slice(0, 120)} (${next.steps.length} step${next.steps.length === 1 ? '' : 's'}).`
  if (previous.status !== next.status) {
    if (next.status === 'done') return `Plan complete: ${progress}.`
    if (next.status === 'blocked') return `Plan blocked: ${next.blockedReason ?? 'no reason given'}`
    return `Plan active again: ${progress}.`
  }
  const key = (p: RunPlan): string => JSON.stringify([p.goal, p.steps.map((s) => [s.id, s.title, s.status, s.note ?? '', s.owner ?? '', s.after ?? [], s.paths ?? [], s.staff ?? null])])
  if (key(previous) === key(next)) return null
  return `Plan updated: ${progress}.`
}

/** The instruction sent to the orchestrator when steps remain. The transcript shows continueSummary instead. */
export function continueNudgeText(plan: RunPlan, kind: ProjectKind = 'code'): string {
  const remaining = remainingSteps(plan)
  const list = remaining.map((s) => `${s.id} ${s.title}${s.status === 'in_progress' ? ' (in progress)' : s.status === 'blocked' ? ' (blocked)' : ''}`).join('; ')
  return (
    `Harness: plan ${finishedCount(plan)} of ${plan.steps.length} done. Remaining: ${list}. ` +
    'Continue with the next step; mark steps with update_plan as you go. ' +
    (kind === 'engagement'
      ? 'When all are done, review the deliverables against the brief and call complete_plan. '
      : "When all are done, run the project's verification (build/tests) and call complete_plan. ") +
    'Stop only for a real decision: ask_user, or mark_blocked with the reason.'
  )
}

/** Every step is marked done or skipped but complete_plan was never called. */
export function finishNudgeText(plan: RunPlan, kind: ProjectKind = 'code'): string {
  return (
    `Harness: plan ${finishedCount(plan)} of ${plan.steps.length} done but not completed. ` +
    (kind === 'engagement'
      ? 'Review the deliverables against the brief and call complete_plan with a summary. '
      : "Run the project's verification (build/tests) and call complete_plan with a summary. ") +
    'Stop only for a real decision: ask_user, or mark_blocked with the reason.'
  )
}

/** One human line for a continue nudge, e.g. 'Continuing: 2 of 5 steps done, next "Write tests".' */
export function continueSummary(plan: RunPlan): string {
  const done = `${finishedCount(plan)} of ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'} done`
  const step = remainingSteps(plan).length ? nextStep(plan) : undefined
  if (!step) return `Continuing: ${done}, asked the orchestrator to verify and complete the plan.`
  const title = step.title.length > 80 ? `${step.title.slice(0, 79)}…` : step.title
  return `Continuing: ${done}, next "${title}".`
}

export function limitReachedText(max: number): string {
  return `Automatic continues paused: this run reached its limit of ${max}. Reply to keep going, or raise "Max automatic continues per run" in project settings.`
}

/**
 * Whether the plan-nudge path applies to a run at all: work runs only, and never a Chat with the single assistant
 * (a quick run with team 'single' is a conversation, not a planned task). A Chat with the default team keeps nudges.
 * RunManager folds this into RuntimeContext.autoContinue, so every adapter's ContinuationDriver stays off for such a
 * run; interrupt holds, idle handling and auto-resume do not depend on it. Pure.
 */
export function planNudgesApply(run: Pick<RunSummary, 'kind' | 'quick' | 'team'>): boolean {
  return run.kind === 'work' && run.quick?.team !== 'single' && run.team !== 'single'
}

export interface NudgeInput {
  plan: RunPlan | undefined
  kind: RunKind
  autoContinue: boolean
  maxAutoContinues: number
  /** Reports still running; their reports wake the orchestrator by themselves. */
  liveReports: number
  /** Permission, proposal, question and merge-review cards waiting for the user. */
  pendingInteractions: number
  rateLimited: boolean
  /** The session is ending, the user interrupted the turn, or a usage cap stopped the run. */
  stopping: boolean
  /** Completed turns without a plan, counting this one, at which a nudge was otherwise allowed. */
  turnsWithoutPlan: number
  /** The orchestrator is in a turn again (a report or message woke it during the delay). */
  orchestratorBusy?: boolean
  /** The run's project kind; wording of the nudges only. Missing = 'code'. */
  projectKind?: ProjectKind
  /** Agent slots free now and the project's limit. Missing = the `ready` nudge never fires. */
  slots?: AgentSlots
  /** The orchestrator's own role (slug and name): ready steps naming it are its own work, not reports. */
  ownRoles?: readonly string[]
  /** readySignature of the last ready set a `ready` nudge was sent for. */
  lastReadySignature?: string
}

export interface NudgeDecision {
  kind: 'continue' | 'set-plan' | 'ready' | 'none'
  /** Set with a `ready` nudge: the signature of the ready set it names. */
  readySignature?: string
  /** The full instruction for the orchestrator. */
  text?: string
  /** One human line for the transcript (set with `text`). */
  summary?: string
  /** 'none' because the automatic-continue limit was reached; the harness tells the user. */
  limitReached?: boolean
}

/** Why nothing may be sent right now, or null when a nudge is allowed. Plan state is not considered. */
export function nudgeBlocked(input: NudgeInput): string | null {
  if (input.kind !== 'work') return 'not a work run'
  if (!input.autoContinue) return 'automatic continue is off'
  if (input.stopping) return 'stopping'
  if (input.rateLimited) return 'rate limited'
  if (input.liveReports > 0) return 'reports are running'
  if (input.pendingInteractions > 0) return 'waiting for the user'
  if (input.orchestratorBusy) return 'the orchestrator is busy'
  return null
}

/**
 * The `ready` nudge (decision D7), the one that may fire while reports run: ready steps that name a report, a free slot
 * and a ready set not yet nudged for. Counts against maxAutoContinues like a continue nudge.
 */
function readyNudge(input: NudgeInput): NudgeDecision {
  const { plan, slots } = input
  if (!plan || plan.status !== 'active' || !slots || slots.free < 1) return { kind: 'none' }
  const ready = readyReports(plan, input.ownRoles)
  if (!ready.length) return { kind: 'none' }
  const signature = readySignature(ready)
  if (signature === input.lastReadySignature) return { kind: 'none' }
  if (plan.autoContinues >= Math.max(0, input.maxAutoContinues)) return { kind: 'none', limitReached: true }
  return {
    kind: 'ready',
    readySignature: signature,
    text: `Harness: ${readyLine(ready, slots, true)}`,
    summary: `Continuing: ${ready.map((s) => s.id).join(', ')} ready, asked the orchestrator to start ${ready.length === 1 ? 'it' : 'them'}.`
  }
}

/** What the harness should tell the orchestrator after a turn ended. Pure. */
export function nextNudge(input: NudgeInput): NudgeDecision {
  const blocked = nudgeBlocked(input)
  if (blocked === 'reports are running') {
    // Everything else that blocks a nudge still blocks the ready nudge.
    return nudgeBlocked({ ...input, liveReports: 0 }) ? { kind: 'none' } : readyNudge(input)
  }
  if (blocked) return { kind: 'none' }
  const { plan } = input
  if (!plan) return input.turnsWithoutPlan === 1 ? { kind: 'set-plan', text: SET_PLAN_NUDGE, summary: SET_PLAN_SUMMARY } : { kind: 'none' }
  if (plan.status !== 'active') return { kind: 'none' }
  if (plan.autoContinues >= Math.max(0, input.maxAutoContinues)) return { kind: 'none', limitReached: true }
  const text = remainingSteps(plan).length ? continueNudgeText(plan, input.projectKind) : finishNudgeText(plan, input.projectKind)
  return { kind: 'continue', text, summary: continueSummary(plan) }
}

/** What decides whether a peer run's message (message_run) may wake the run now. */
export interface PeerDeliveryInput {
  /** The user interrupted the run and has not sent a message since. */
  held: boolean
  /** The provider reported a usage-limit rejection; the run is about to pause. */
  rateLimited: boolean
  /** Permission, proposal, question, merge-review, install and rule cards waiting for the user. */
  pendingInteractions: number
}

/**
 * Why a peer message must wait instead of waking the run, or null when it may be delivered now. Same rule as the
 * automatic continue: nothing but the user resumes a run the user stopped or a run waiting on the user. Pure.
 */
export function peerDeliveryBlocked(input: PeerDeliveryInput): 'held' | 'rate limited' | 'waiting for the user' | null {
  if (input.held) return 'held'
  if (input.rateLimited) return 'rate limited'
  if (input.pendingInteractions > 0) return 'waiting for the user'
  return null
}

/**
 * What a ContinuationDriver needs from the adapter and the run manager. `autoContinue` and `maxAutoContinues` are read
 * at every check (adapters pass getters over ctx), so RunManager's setLive re-clamp reaches a live driver.
 */
export interface ContinuationHost {
  kind: RunKind
  readonly autoContinue?: boolean
  readonly maxAutoContinues?: number
  delayMs?: number
  /** The run's project kind (projectKindOf(ctx.project)); only changes the nudge wording. Missing = 'code'. */
  projectKind?: ProjectKind
  getPlan(): RunPlan | undefined
  updatePlan(plan: RunPlan): Promise<void>
  liveReports(): number
  /**
   * Agent slots free now and the project's concurrency limit. Optional: without it the `ready` nudge never fires.
   */
  slots?(): AgentSlots
  /** The orchestrator's own role (slug and name), so ready steps naming it are not counted as reports. */
  ownRoles?(): string[]
  /**
   * Epoch ms at which the newest report (any subagent or report thread of this session, any depth) finished, or
   * undefined when none has. Optional: a host without it keeps the full delay after every turn end.
   */
  lastReportEndedAt?(): number | undefined
  pendingInteractions(): number
  rateLimited(): boolean
  stopping(): boolean
  orchestratorBusy(): boolean
  /**
   * Deliver `text` to the orchestrator as a harness message and show `activity` on the root node. The
   * transcript entry is `{ kind: 'system', text: summary, detail: text }` with `source: 'harness'`.
   */
  nudge(text: string, activity: string, summary: string): void
  log(level: 'info' | 'warn' | 'error', message: string): void
  /** A system line in the orchestrator's transcript, for the user (`source: 'harness'`). */
  tellUser(text: string): void
  /**
   * Headless exec settlement (cli-spec 6.2(2)): a root turn generation became settled (evaluated without a nudge,
   * skipped, or the driver is off). Adapters forward it as ctx.noteActivity('continuation'). Optional.
   */
  onSettled?(turnGen: number): void
}

/**
 * Re-engages the orchestrator after a turn ends with plan steps left. The adapter calls `turnEnded(gen)`
 * at every successful root turn end, `skipTurn(gen)` at a failed or interrupted one, `userMessage` when
 * the user sends a message, `hold` on interrupt and `dispose` when the session ends.
 *
 * Turn generations (cli-spec 6.2(2)): each root turn end carries the adapter's monotonic `turnGen`. A
 * generation is settled once it was evaluated without sending a nudge (or skipped, or the driver is off)
 * and nothing is pending; `isSettledForTurn(gen)` is what RunManager's exec settlement reads. A turn that
 * got a nudge is never settled: the follow-up turn the nudge starts gets the next generation.
 */
export class ContinuationDriver {
  private timer: ReturnType<typeof setTimeout> | null = null
  private held = false
  private disposed = false
  private turnsWithoutPlan = 0
  private limitWarned = false
  private evaluating = false
  /** The newest root turn generation reported (turnEnded / skipTurn). */
  private currentTurnGen = 0
  /** The newest generation evaluated without a nudge (or skipped); -1 = none yet, or unsettled by a user message. */
  private lastEvaluatedTurnGen = -1
  private setPlanNudgeSent = false
  /** Signature of the last ready set a `ready` nudge was sent for. */
  private lastReadySignature: string | undefined

  constructor(private host: ContinuationHost) {}

  /** Read at every check: the host's autoContinue may change while the run is live (setLive re-clamp). */
  private get enabled(): boolean {
    return this.host.kind === 'work' && this.host.autoContinue !== false
  }

  /** The turn-1 set-plan nudge was sent in this session. */
  get nudgeTurn1Sent(): boolean {
    return this.setPlanNudgeSent
  }

  /** The generation of the newest root turn end the driver heard of. */
  get turnGen(): number {
    return this.currentTurnGen
  }

  /** No timer, no evaluation in flight, and `gen` was evaluated without a nudge (or skipped, or the driver is off). */
  isSettledForTurn(gen: number): boolean {
    return !this.timer && !this.evaluating && this.lastEvaluatedTurnGen === gen
  }

  private markSettled(gen: number): void {
    this.lastEvaluatedTurnGen = gen
    try {
      this.host.onSettled?.(gen)
    } catch {
      /* a listener never breaks the driver */
    }
  }

  /**
   * A turn finished (`turnGen`: the adapter's root turn counter; missing = the previous one plus 1). Evaluate after
   * the delay, re-checking every condition then. A disabled or disposed driver settles the generation at once.
   */
  turnEnded(turnGen?: number): void {
    this.currentTurnGen = turnGen ?? this.currentTurnGen + 1
    this.cancel()
    if (!this.enabled || this.disposed) {
      this.markSettled(this.currentTurnGen)
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.evaluate()
    }, this.waitMs())
  }

  private waitMs(): number {
    const delayMs = this.host.delayMs ?? DEFAULT_CONTINUATION_DELAY_MS
    const known = typeof this.host.lastReportEndedAt === 'function'
    if (!known) return delayMs
    return continuationWaitMs({ delayMs, liveReports: this.host.liveReports(), lastReportEndedAt: this.host.lastReportEndedAt?.(), now: Date.now(), known })
  }

  /** A failed or interrupted root turn: no nudge for it, and its generation counts as evaluated at once. */
  skipTurn(turnGen: number): void {
    this.currentTurnGen = turnGen
    this.cancel()
    this.markSettled(turnGen)
  }

  /** The user spoke: drop a pending evaluation and lift an interrupt's hold. Unsettled until the next turn end. */
  userMessage(): void {
    this.cancel()
    this.held = false
    this.lastEvaluatedTurnGen = -1
  }

  /** The user interrupted the turn: no automatic continues until they send a message. */
  hold(): void {
    const pending = !!this.timer
    this.cancel()
    this.held = true
    // A held run never nudges: a turn end still waiting for its evaluation is settled now.
    if (pending) this.markSettled(this.currentTurnGen)
  }

  /** True from an interrupt (`hold`) until the user's next message (`userMessage`). */
  isHeld(): boolean {
    return this.held
  }

  dispose(): void {
    this.disposed = true
    const pending = !!this.timer
    this.cancel()
    if (pending) this.markSettled(this.currentTurnGen)
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /**
   * Decide and act now. Returns the decision (for tests). Unless a nudge was sent, the generation current when the
   * evaluation started is settled when it finishes (decision 'none', limit reached, blocked, held or disposed).
   */
  async evaluate(): Promise<NudgeDecision> {
    const gen = this.currentTurnGen
    this.evaluating = true
    let sent = false
    try {
      const result = await this.decide()
      sent = result.sent
      return result.decision
    } finally {
      this.evaluating = false
      if (!sent) this.markSettled(gen)
    }
  }

  private async decide(): Promise<{ decision: NudgeDecision; sent: boolean }> {
    if (this.disposed) return { decision: { kind: 'none' }, sent: false }
    const plan = this.host.getPlan()
    const input: NudgeInput = {
      plan,
      kind: this.host.kind,
      autoContinue: this.host.autoContinue !== false,
      maxAutoContinues: this.host.maxAutoContinues ?? DEFAULT_MAX_AUTO_CONTINUES,
      liveReports: this.host.liveReports(),
      pendingInteractions: this.host.pendingInteractions(),
      rateLimited: this.host.rateLimited(),
      stopping: this.held || this.host.stopping(),
      turnsWithoutPlan: this.turnsWithoutPlan,
      orchestratorBusy: this.host.orchestratorBusy(),
      ...(this.host.slots ? { slots: this.host.slots() } : {}),
      ...(this.host.ownRoles ? { ownRoles: this.host.ownRoles() } : {}),
      ...(this.lastReadySignature !== undefined ? { lastReadySignature: this.lastReadySignature } : {}),
      ...(this.host.projectKind ? { projectKind: this.host.projectKind } : {})
    }
    if (!plan && !nudgeBlocked(input)) input.turnsWithoutPlan = ++this.turnsWithoutPlan
    const decision = nextNudge(input)
    if (decision.limitReached && !this.limitWarned) {
      this.limitWarned = true
      this.host.log('warn', `Automatic-continue limit reached (${input.maxAutoContinues}); the orchestrator waits for you.`)
      this.host.tellUser(limitReachedText(input.maxAutoContinues))
    }
    if (decision.kind === 'none' || !decision.text) return { decision, sent: false }
    let activity = 'Planning the work…'
    let summary = decision.summary ?? decision.text
    if (decision.kind === 'continue' && plan) {
      const updated: RunPlan = { ...plan, autoContinues: plan.autoContinues + 1, updatedAt: Date.now() }
      await this.host.updatePlan(updated)
      const step = nextStep(updated)
      activity = step ? `Continuing: ${step.title}`.slice(0, 90) : this.host.projectKind === 'engagement' ? 'Continuing: review' : 'Continuing: verification'
      summary = continueSummary(updated)
      this.host.log('info', `Automatic continue ${updated.autoContinues} of ${input.maxAutoContinues}: ${planProgressLabel(updated)} done.`)
    } else if (decision.kind === 'ready' && plan) {
      const updated: RunPlan = { ...plan, autoContinues: plan.autoContinues + 1, updatedAt: Date.now() }
      await this.host.updatePlan(updated)
      this.lastReadySignature = decision.readySignature
      activity = `Starting ready steps: ${decision.readySignature}`.slice(0, 90)
      this.host.log('info', `Automatic continue ${updated.autoContinues} of ${input.maxAutoContinues}: ready steps ${decision.readySignature}.`)
    } else {
      this.host.log('info', 'The orchestrator ended a turn without a plan; asking it to set one.')
    }
    if (this.disposed) return { decision, sent: false }
    this.host.nudge(decision.text, activity, summary)
    if (decision.kind === 'set-plan') this.setPlanNudgeSent = true
    return { decision, sent: true }
  }
}
