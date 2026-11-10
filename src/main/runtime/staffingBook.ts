// Run staffing bookkeeping (docs/design/orchestration-efficiency.md 4.3, decisions D1, D2, D9): the one place that knows,
// for a run, which plan step a spawn belongs to, what tier its parent resolved to, whether the spawn retries a step whose
// earlier attempt ended, and the row to record. Adapters (Claude spawn hook, Codex spawn_report, mock) keep one
// StaffingBook per run (per session), call `decide` at spawn time, apply `resolved` (only when `resolved.overrides`),
// then `started` (record the returned row with staffing.ts recordStaffing) or `cancel`, and `ended` when the agent
// finishes. The tier / effort rules themselves live in staffing.ts resolveStaffing; this module only feeds it.
//
// Pure in the sense the runtime modules use: synchronous, in memory, no I/O, no clock (callers pass `now`), no imports
// from adapters. Memory is bounded by the STAFFING_BOOK_* constants below.

import { compareEffort, compareTier } from '@shared/defaults'
import type { Effort, ModelTier, PlanStep, Project, Role, RunPlan, StaffingAssignment } from '@shared/types'
import { capNote, resolveStaffing, staffingAssignment, staffingLabel, staffRequestForSpawn, type ResolvedStaffing, type StaffingRequest } from './staffing'

/** Retries per plan step that escalate (spec 4.3: "at most twice"). Later retries run on the last attempt's values. */
export const STAFFING_ESCALATIONS_MAX = 2
/** Attempts remembered per plan step; beyond it the oldest ended attempts are forgotten (the newest is always kept). */
export const STAFFING_BOOK_STEP_ATTEMPTS_MAX = 10
/**
 * Plan steps remembered; beyond it steps with no decided or live attempt are forgotten, those not open in the plan
 * first, least recently touched first. A forgotten step that is still open counts as never attempted again.
 */
export const STAFFING_BOOK_STEPS_MAX = 100
/** Started agents remembered (for tierOf and ended); beyond it the oldest ended agents are forgotten. */
export const STAFFING_BOOK_AGENTS_MAX = 400
/** Decisions waiting for started / cancel; beyond it the oldest is cancelled (an adapter that lost track of a spawn). */
export const STAFFING_BOOK_PENDING_MAX = 100

export interface StaffingBookDeps {
  /** The run's project; only `staffing` is read (Project.staffing 'fixed' makes every role fixed). */
  project: Pick<Project, 'staffing'>
  /**
   * The root's tier now (the model it runs on; read live at each decision, since the user may switch the root's model
   * mid-run): the parentTier for spawns that carry no `parentAgentId`, and the tier 'inherit' resolves to for the plan
   * guard (resolveStaffing inheritTier). Absent or undefined = an 'inherit' report of the root cannot be sized and runs
   * as configured. A plain value is read as a root that never changes (Codex and mock pass one today).
   */
  rootTier?: ModelTier | (() => ModelTier | undefined)
  /** The connection's tier -> model id map (RunConnection.tierModels). Read live at each decision. */
  tierModels(): Partial<Record<ModelTier, string>>
  /** Efforts the adapter can send (defaults.ts effortOptionsFor(adapter)). Empty = the adapter never sends an effort. */
  adapterEfforts: readonly Effort[]
  /** The run's current plan (RuntimeContext.getPlan). Read live at each decision; undefined = no plan. */
  plan(): RunPlan | undefined
  /** The project profile's default for a role (spec 4.5, phase 4 supplies it; absent today). */
  profile?(roleId: string): StaffingRequest | undefined
}

/** What `decide` asks for a spawn. */
export interface StaffingDecideInput {
  /**
   * Identifies this spawn until its agent id is known: the Claude adapter passes the Agent call's tool_use_id; Codex and
   * mock may pass the agent id itself. Unique per spawn within the book. Deciding again under a key that is still
   * waiting for `started` / `cancel` cancels the earlier decision first.
   */
  key: string
  /** The role being spawned (a whole Role is fine). `slug` matches PlanStep.staff.role (trimmed, case-sensitive). */
  role: Pick<Role, 'id' | 'slug' | 'model' | 'tier' | 'effort' | 'staffing'>
  /**
   * The agent that spawns this one (AgentInstance.id) when it is a report; omit for a spawn by the root. Its tier is
   * tierOf(parentAgentId); an id the book does not know gives no parent tier (an 'inherit' role then runs as
   * configured), never the root's tier.
   */
  parentAgentId?: string
  /** Tier and / or effort stated on the spawn call itself (Codex spawn_report, the Claude Agent call); wins field by field. */
  onCall?: StaffingRequest
  /** The plan guard is engaged (usage near the weekly limit). Passed to resolveStaffing unchanged. */
  planGuard?: boolean
}

/** The outcome of `decide`. */
export interface SpawnDecision {
  /** What the spawn runs on. Apply its tier / model / effort only when `resolved.overrides` is true. */
  resolved: ResolvedStaffing
  /** The plan step the spawn is bound to; undefined when no open step names the role. */
  stepId?: string
  /** True when the spawn retries a step whose earlier attempts have all ended (escalated, or at the retry limit). */
  retry: boolean
  /** staffingLabel(resolved): the short text for the spawn's result and logs, e.g. "everyday / medium (chosen by the orchestrator)". */
  label: string
}

type AttemptState = 'decided' | 'live' | 'ended'

interface Attempt {
  key: string
  roleId: string
  stepId?: string
  state: AttemptState
  agentId?: string
  resolved: ResolvedStaffing
  /** The step's staff tier / effort when this attempt was decided (to see an orchestrator edit on a retry). */
  staffAt?: StaffingRequest
  /** This attempt was a retry that passed escalatedFrom (counts toward STAFFING_ESCALATIONS_MAX). */
  escalated: boolean
  seq: number
}

interface StepState {
  /** Identity of the step the attempts belong to: a step with the same id but another title or role is a new step. */
  title: string
  role: string
  attempts: Attempt[]
  escalations: number
  touched: number
}

const LIMIT_NOTE = `Retry limit reached (${STAFFING_ESCALATIONS_MAX} escalations on this step), so it runs on the last attempt's tier and effort`

const isOpen = (s: PlanStep): boolean => s.status === 'pending' || s.status === 'in_progress'
const roleOf = (s: PlanStep): string => (typeof s.staff?.role === 'string' ? s.staff.role.trim() : '')

/** Only the defined fields of a tier / effort pair; undefined when neither is set. */
function req(tier: ModelTier | undefined, effort: Effort | undefined): StaffingRequest | undefined {
  const out: StaffingRequest = {}
  if (tier) out.tier = tier
  if (effort) out.effort = effort
  return out.tier || out.effort ? out : undefined
}


/**
 * One run's staffing bookkeeping. Synchronous and in memory: two `decide` calls in the same tick see each other (the
 * first one's step counts as attempted for the second). Callers need no cleanup when a step is done, skipped, edited
 * to another role or dropped from the plan: the plan is read at every decision and closed or changed steps are ignored.
 */
export class StaffingBook {
  private readonly deps: StaffingBookDeps
  private readonly pending = new Map<string, Attempt>()
  private readonly agents = new Map<string, Attempt>()
  private readonly steps = new Map<string, StepState>()
  private seq = 0

  constructor(deps: StaffingBookDeps) {
    this.deps = deps
  }

  /**
   * At spawn time, before the agent exists: bind the spawn to a plan step and resolve its tier, model and effort. The
   * decision is remembered under `input.key` until `started` or `cancel`. Binding, in this order:
   * 1. A step never attempted: staffRequestForSpawn(plan, role.slug, <steps with any attempt>, onCall) (ready steps
   *    first, then any open step naming the role; `requested` = onCall over the step's staff). The step's first attempt.
   * 2. A retry: the first open (pending or in_progress) step naming the role whose attempts have all ended. The first
   *    STAFFING_ESCALATIONS_MAX retries pass `escalatedFrom` = the last attempt's resolved tier and effort, and a
   *    `requested` only from onCall and from step staff fields the orchestrator changed since the last attempt was
   *    decided (resolveStaffing raises nothing for a request equal to the previous attempt). Later retries resolve to
   *    the last attempt's values (onCall may only lower them) with a note that the limit is reached.
   * 3. Fan-out: the first open step naming the role with a decided or live attempt; the spawn shares it, `requested` =
   *    onCall over the step's staff, not a retry.
   * 4. No step: `requested` = onCall.
   * parentTier = tierOf(parentAgentId), or deps.rootTier() when no parentAgentId is given.
   */
  decide(input: StaffingDecideInput): SpawnDecision {
    if (this.pending.has(input.key)) this.cancel(input.key)
    const { role, onCall, planGuard } = input
    const plan = this.deps.plan()
    const planSteps = plan && Array.isArray(plan.steps) ? plan.steps : []
    this.forgetStale(planSteps)
    const slug = typeof role.slug === 'string' ? role.slug.trim() : ''
    const rootTier = typeof this.deps.rootTier === 'function' ? this.deps.rootTier() : this.deps.rootTier
    const parentTier = input.parentAgentId !== undefined ? this.tierOf(input.parentAgentId) : rootTier

    let stepId: string | undefined
    let step: PlanStep | undefined
    let requested: StaffingRequest | undefined
    let escalatedFrom: StaffingRequest | undefined
    let retry = false
    let atLimit = false

    // 1. A step never attempted.
    const first = staffRequestForSpawn(plan, slug, new Set(this.steps.keys()), onCall)
    requested = first.requested
    if (first.stepId) {
      stepId = first.stepId
      step = planSteps.find((s) => s.id === stepId)
    } else if (slug) {
      const named = planSteps.filter((s) => isOpen(s) && roleOf(s) === slug && this.steps.has(s.id))
      // 2. A retry: every attempt of the step has ended.
      const again = named.find((s) => this.steps.get(s.id)!.attempts.every((a) => a.state === 'ended'))
      if (again) {
        step = again
        stepId = again.id
        retry = true
        const state = this.steps.get(again.id)!
        const last = state.attempts[state.attempts.length - 1]
        const lastTier = last?.resolved.tier
        const lastEffort = last?.resolved.effort
        if (state.escalations < STAFFING_ESCALATIONS_MAX) {
          escalatedFrom = req(lastTier, lastEffort) ?? {}
          const staffNow = again.staff
          const edited = req(
            staffNow?.tier !== last?.staffAt?.tier ? staffNow?.tier : undefined,
            staffNow?.effort !== last?.staffAt?.effort ? staffNow?.effort : undefined
          )
          requested = req(onCall?.tier ?? edited?.tier, onCall?.effort ?? edited?.effort)
        } else {
          atLimit = true
          // The last attempt's values; a value on the call is taken only when it is not above them.
          const fixed = last?.resolved.mode === 'fixed'
          requested = fixed
            ? undefined
            : req(
                lastTier && onCall?.tier && compareTier(onCall.tier, lastTier) < 0 ? onCall.tier : lastTier,
                lastEffort && onCall?.effort && compareEffort(onCall.effort, lastEffort) < 0 ? onCall.effort : lastEffort
              )
        }
      } else {
        // 3. Fan-out: share a step that has a decided or live attempt.
        const shared = named.find((s) => this.steps.get(s.id)!.attempts.some((a) => a.state !== 'ended'))
        if (shared) {
          step = shared
          stepId = shared.id
          requested = req(onCall?.tier ?? shared.staff?.tier, onCall?.effort ?? shared.staff?.effort)
        }
      }
    }
    // 4. No step: `requested` stays onCall (from staffRequestForSpawn).

    let resolved = resolveStaffing({
      role,
      project: this.deps.project,
      parentTier,
      requested,
      profile: this.deps.profile?.(role.id),
      tierModels: this.deps.tierModels(),
      adapterEfforts: this.deps.adapterEfforts,
      planGuard,
      ...(rootTier ? { inheritTier: rootTier } : {}),
      escalatedFrom
    })
    // At the limit the last attempt's values are passed as a request, which the resolver reports as the orchestrator's
    // pick; they are the escalated values, so the source says that and the note says why nothing was raised.
    if (atLimit) {
      resolved = {
        ...resolved,
        source: resolved.source === 'orchestrator' ? 'escalated' : resolved.source,
        note: capNote(resolved.note ? `${LIMIT_NOTE}. ${resolved.note}` : `${LIMIT_NOTE}.`)
      }
    }

    const attempt: Attempt = {
      key: input.key,
      roleId: role.id,
      state: 'decided',
      resolved,
      escalated: escalatedFrom !== undefined,
      seq: ++this.seq
    }
    if (stepId) {
      attempt.stepId = stepId
      const staffAt = req(step?.staff?.tier, step?.staff?.effort)
      if (staffAt) attempt.staffAt = staffAt
      let state = this.steps.get(stepId)
      if (!state) {
        state = { title: step?.title ?? '', role: slug, attempts: [], escalations: 0, touched: attempt.seq }
        this.steps.set(stepId, state)
      }
      state.attempts.push(attempt)
      state.touched = attempt.seq
      if (attempt.escalated) state.escalations++
      this.trimStep(state)
      this.trimSteps(planSteps)
    }
    this.pending.set(input.key, attempt)
    this.trimPending()

    const out: SpawnDecision = { resolved, retry, label: staffingLabel(resolved) }
    if (stepId) out.stepId = stepId
    return out
  }

  /**
   * The agent decided under `key` started as `agentId`: the attempt becomes live, tierOf(agentId) answers from now on,
   * and the StaffingAssignment row (staffing.ts staffingAssignment, with roleId, agentId and stepId) is returned for
   * recordStaffing. Unknown key (never decided, already started or cancelled): undefined.
   */
  started(key: string, agentId: string, now: number): StaffingAssignment | undefined {
    const attempt = this.pending.get(key)
    if (!attempt) return undefined
    this.pending.delete(key)
    attempt.state = 'live'
    attempt.agentId = agentId
    this.agents.delete(agentId)
    this.agents.set(agentId, attempt)
    if (attempt.stepId) {
      const state = this.steps.get(attempt.stepId)
      if (state?.attempts.includes(attempt)) state.touched = ++this.seq
    }
    this.trimAgents()
    return staffingAssignment(attempt.resolved, { roleId: attempt.roleId, agentId, stepId: attempt.stepId }, now)
  }

  /**
   * The spawn decided under `key` was refused or never started: forget it completely. A cancelled first attempt leaves
   * its step unattempted; a cancelled retry does not count toward STAFFING_ESCALATIONS_MAX. Unknown key (never decided,
   * already started or cancelled): nothing happens.
   */
  cancel(key: string): void {
    const attempt = this.pending.get(key)
    if (!attempt) return
    this.pending.delete(key)
    this.dropFromStep(attempt)
  }

  /** The agent finished, with any outcome. Its step becomes a retry candidate once all its attempts have ended. Unknown id: nothing. */
  ended(agentId: string): void {
    const attempt = this.agents.get(agentId)
    if (!attempt || attempt.state === 'ended') return
    attempt.state = 'ended'
    const state = attempt.stepId ? this.steps.get(attempt.stepId) : undefined
    if (state?.attempts.includes(attempt)) this.trimStep(state)
    this.trimAgents()
  }

  /**
   * The tier a started agent resolved to (its ResolvedStaffing.tier): the parentTier for what it spawns. Undefined for
   * an id the book does not know (never started through it, or forgotten past STAFFING_BOOK_AGENTS_MAX after ending)
   * or a fixed agent whose tier is unknown.
   */
  tierOf(agentId: string): ModelTier | undefined {
    return this.agents.get(agentId)?.resolved.tier
  }

  // ---------- internals ----------

  /** Forget steps that left the plan or whose id now names another step (another title or role). */
  private forgetStale(planSteps: readonly PlanStep[]): void {
    if (!this.steps.size) return
    const byId = new Map(planSteps.map((s) => [s.id, s]))
    for (const [id, state] of this.steps) {
      const s = byId.get(id)
      if (!s || s.title !== state.title || roleOf(s) !== state.role) this.steps.delete(id)
    }
  }

  private dropFromStep(attempt: Attempt): void {
    if (!attempt.stepId) return
    const state = this.steps.get(attempt.stepId)
    if (!state) return
    const i = state.attempts.indexOf(attempt)
    if (i < 0) return
    state.attempts.splice(i, 1)
    if (attempt.escalated) state.escalations = Math.max(0, state.escalations - 1)
    if (!state.attempts.length) this.steps.delete(attempt.stepId)
  }

  /** Keep at most STAFFING_BOOK_STEP_ATTEMPTS_MAX attempts on a step, dropping the oldest ended (never the newest). */
  private trimStep(state: StepState): void {
    while (state.attempts.length > STAFFING_BOOK_STEP_ATTEMPTS_MAX) {
      const i = state.attempts.findIndex((a, idx) => a.state === 'ended' && idx < state.attempts.length - 1)
      if (i < 0) return
      state.attempts.splice(i, 1)
    }
  }

  /**
   * Keep at most STAFFING_BOOK_STEPS_MAX steps. Only steps with every attempt ended are dropped: first those that are
   * not open in the plan (done, skipped, blocked), then open ones; the least recently touched first.
   */
  private trimSteps(planSteps: readonly PlanStep[]): void {
    if (this.steps.size <= STAFFING_BOOK_STEPS_MAX) return
    const open = new Set(planSteps.filter(isOpen).map((s) => s.id))
    while (this.steps.size > STAFFING_BOOK_STEPS_MAX) {
      let oldest: [string, StepState] | undefined
      for (const entry of this.steps) {
        if (entry[1].attempts.some((a) => a.state !== 'ended')) continue
        if (
          !oldest ||
          (!open.has(entry[0]) && open.has(oldest[0])) ||
          (open.has(entry[0]) === open.has(oldest[0]) && entry[1].touched < oldest[1].touched)
        )
          oldest = entry
      }
      if (!oldest) return
      this.steps.delete(oldest[0])
    }
  }

  /** Keep at most STAFFING_BOOK_AGENTS_MAX agents, dropping the oldest ended (live agents are bounded by concurrency). */
  private trimAgents(): void {
    if (this.agents.size <= STAFFING_BOOK_AGENTS_MAX) return
    for (const [id, a] of this.agents) {
      if (this.agents.size <= STAFFING_BOOK_AGENTS_MAX) return
      if (a.state === 'ended') this.agents.delete(id)
    }
  }

  /** Keep at most STAFFING_BOOK_PENDING_MAX decisions waiting, cancelling the oldest. */
  private trimPending(): void {
    while (this.pending.size > STAFFING_BOOK_PENDING_MAX) {
      const oldest = this.pending.keys().next().value as string
      this.cancel(oldest)
    }
  }
}
