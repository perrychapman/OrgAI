import type { PlanStep, RunKind, RunPlan } from '@shared/types'
import { DEFAULT_MAX_AUTO_CONTINUES } from '@shared/types'

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
  const key = (p: RunPlan): string => JSON.stringify([p.goal, p.steps.map((s) => [s.id, s.title, s.status, s.note ?? '', s.owner ?? ''])])
  if (key(previous) === key(next)) return null
  return `Plan updated: ${progress}.`
}

/** The instruction sent to the orchestrator when steps remain. The transcript shows continueSummary instead. */
export function continueNudgeText(plan: RunPlan): string {
  const remaining = remainingSteps(plan)
  const list = remaining.map((s) => `${s.id} ${s.title}${s.status === 'in_progress' ? ' (in progress)' : s.status === 'blocked' ? ' (blocked)' : ''}`).join('; ')
  return (
    `Harness: plan ${finishedCount(plan)} of ${plan.steps.length} done. Remaining: ${list}. ` +
    'Continue with the next step; mark steps with update_plan as you go. ' +
    "When all are done, run the project's verification (build/tests) and call complete_plan. " +
    'Stop only for a real decision: ask_user, or mark_blocked with the reason.'
  )
}

/** Every step is marked done or skipped but complete_plan was never called. */
export function finishNudgeText(plan: RunPlan): string {
  return (
    `Harness: plan ${finishedCount(plan)} of ${plan.steps.length} done but not completed. ` +
    "Run the project's verification (build/tests) and call complete_plan with a summary. " +
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
}

export interface NudgeDecision {
  kind: 'continue' | 'set-plan' | 'none'
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

/** What the harness should tell the orchestrator after a turn ended. Pure. */
export function nextNudge(input: NudgeInput): NudgeDecision {
  if (nudgeBlocked(input)) return { kind: 'none' }
  const { plan } = input
  if (!plan) return input.turnsWithoutPlan === 1 ? { kind: 'set-plan', text: SET_PLAN_NUDGE, summary: SET_PLAN_SUMMARY } : { kind: 'none' }
  if (plan.status !== 'active') return { kind: 'none' }
  if (plan.autoContinues >= Math.max(0, input.maxAutoContinues)) return { kind: 'none', limitReached: true }
  const text = remainingSteps(plan).length ? continueNudgeText(plan) : finishNudgeText(plan)
  return { kind: 'continue', text, summary: continueSummary(plan) }
}

/** What a ContinuationDriver needs from the adapter and the run manager. */
export interface ContinuationHost {
  kind: RunKind
  autoContinue?: boolean
  maxAutoContinues?: number
  delayMs?: number
  getPlan(): RunPlan | undefined
  updatePlan(plan: RunPlan): Promise<void>
  liveReports(): number
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
}

/**
 * Re-engages the orchestrator after a turn ends with plan steps left. The adapter calls `turnEnded`
 * at every successful turn end, `userMessage` when the user sends a message, `hold` on interrupt and
 * `dispose` when the session ends.
 */
export class ContinuationDriver {
  private timer: ReturnType<typeof setTimeout> | null = null
  private held = false
  private disposed = false
  private turnsWithoutPlan = 0
  private limitWarned = false

  constructor(private host: ContinuationHost) {}

  private get enabled(): boolean {
    return this.host.kind === 'work' && this.host.autoContinue !== false
  }

  /** A turn finished. Evaluate after the delay, re-checking every condition then. */
  turnEnded(): void {
    if (!this.enabled || this.disposed) return
    this.cancel()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.evaluate()
    }, this.host.delayMs ?? DEFAULT_CONTINUATION_DELAY_MS)
  }

  /** The user spoke: drop a pending evaluation and lift an interrupt's hold. */
  userMessage(): void {
    this.cancel()
    this.held = false
  }

  /** The user interrupted the turn: no automatic continues until they send a message. */
  hold(): void {
    this.cancel()
    this.held = true
  }

  dispose(): void {
    this.disposed = true
    this.cancel()
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Decide and act now. Returns the decision (for tests). */
  async evaluate(): Promise<NudgeDecision> {
    if (this.disposed) return { kind: 'none' }
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
      orchestratorBusy: this.host.orchestratorBusy()
    }
    if (!plan && !nudgeBlocked(input)) input.turnsWithoutPlan = ++this.turnsWithoutPlan
    const decision = nextNudge(input)
    if (decision.limitReached && !this.limitWarned) {
      this.limitWarned = true
      this.host.log('warn', `Automatic-continue limit reached (${input.maxAutoContinues}); the orchestrator waits for you.`)
      this.host.tellUser(limitReachedText(input.maxAutoContinues))
    }
    if (decision.kind === 'none' || !decision.text) return decision
    let activity = 'Planning the work…'
    let summary = decision.summary ?? decision.text
    if (decision.kind === 'continue' && plan) {
      const updated: RunPlan = { ...plan, autoContinues: plan.autoContinues + 1, updatedAt: Date.now() }
      await this.host.updatePlan(updated)
      const step = nextStep(updated)
      activity = step ? `Continuing: ${step.title}`.slice(0, 90) : 'Continuing: verification'
      summary = continueSummary(updated)
      this.host.log('info', `Automatic continue ${updated.autoContinues} of ${input.maxAutoContinues}: ${planProgressLabel(updated)} done.`)
    } else {
      this.host.log('info', 'The orchestrator ended a turn without a plan; asking it to set one.')
    }
    if (this.disposed) return decision
    this.host.nudge(decision.text, activity, summary)
    return decision
  }
}
