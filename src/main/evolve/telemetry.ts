import { EFFORTS, QUICK_PROJECT_ID } from '../../shared/types'
import type {
  EvolutionFinding,
  EvolutionFindingKind,
  EvolutionMetrics,
  ModelTier,
  Project,
  RunRecord,
  RunSummary,
  SkillFinding,
  StaffingGoal,
  StaffingMode,
  TeamEvolutionDiagnosis
} from '../../shared/types'
import type { GraphStepLike } from '../../shared/planGraph'
import {
  DIGEST_TRANSCRIPT_LIMIT,
  asDigest,
  digestHash,
  digestKey,
  ownerKey,
  pendingOverlaps,
  planLevels,
  safeLine,
  safeName,
  type ErrorCategory,
  type RunDigest,
  type Shape
} from '../store/runDigest'
import { PROMPT_BUDGET_PER_ROLE, compressPrompt, effectiveConcurrency, isGuardRole, stepEffort, stepTier } from './plan'

export { classifyError, safeLine, spawnShape } from '../store/runDigest'

/**
 * The zero-token analyzer: reads finished work runs and produces a waste score, fitness metrics and typed findings.
 * Pure (no I/O, no clock, no randomness), one pass over the runs. Run text is data: nothing a run wrote reaches a
 * finding except as a count, a sanitized tool name or a sanitized path prefix.
 *
 * It works from run DIGESTS (src/main/store/runDigest.ts: per-agent aggregates, staffing assignments, failed receipts,
 * plan shape, merge conflicts, tool friction and status polling, made once per run and cached by RunStore.getDigest).
 * A RunRecord passed in is digested first (tests, the bench), so both give the same diagnosis.
 */

export const TRANSCRIPT_SCAN_LIMIT = DIGEST_TRANSCRIPT_LIMIT
/** Evidence needed before a finding fires. */
export const MIN_ROLE_AGENTS = 3
export const OVER_FIRST_PASS = 0.9
export const UNDER_ESCALATION_RATE = 0.35
export const MAX_FINDINGS = 12
const FINDING_SUMMARY_MAX = 240
/** unused_role: a role spawned in none of the last this-many measured runs (needs that many runs in the window). */
export const UNUSED_ROLE_RUNS = 10
/** spawner_step_work: runs in which a planned step for a role the chart lacks was done with no report. */
export const SELF_STEP_MIN_RUNS = 3

/**
 * Findings that explain but never justify a change on their own: shown in the diagnosis, kept out of the waste score
 * that gates a plan (so a healthy chart can sit under MIN_WASTE_DEFAULT). A tier_overprovisioned finding that carries an
 * `exploration` (thin evidence) is advisory too: the synthesizer only notes it.
 */
export const ADVISORY_FINDING_KINDS: ReadonlySet<EvolutionFindingKind> = new Set<EvolutionFindingKind>(['skill_crystallization', 'ceremonial_layer', 'spawner_step_work', 'unused_role'])

export function isAdvisoryFinding(f: Pick<EvolutionFinding, 'kind' | 'exploration'>): boolean {
  return ADVISORY_FINDING_KINDS.has(f.kind) || f.exploration !== undefined
}

/** A run as the analyzer takes it: a stored record or its digest. */
export type RunLike = RunRecord | RunDigest

/** The summary fields the run predicates read (a RunRecord, a RunSummary wrapper and a RunDigest all have them). */
export type SummaryOf = { summary: Pick<RunSummary, 'id' | 'kind' | 'quick' | 'projectId' | 'team' | 'status' | 'endedBy' | 'execOutcome' | 'pausedUntil' | 'startedAt' | 'endedAt'> }

export interface DiagnoseInput {
  project: Project
  /** Run records or digests, any order; the newest `runs` work runs are used. */
  runs: readonly RunLike[]
  staffingProfile?: { mode: StaffingMode; goal: StaffingGoal }
  skillFindings?: SkillFinding[]
  goal?: StaffingGoal
  now?: number
  /** Most runs read (default 10). */
  maxRuns?: number
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))
const r4 = (n: number): number => Math.round(n * 10000) / 10000

export function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** True when a work run belongs to this project's team (not setup, quick/Chat, or single-assistant). */
export function isTeamWorkRun(r: SummaryOf): boolean {
  const s = r.summary
  return s.kind === 'work' && !s.quick && s.projectId !== QUICK_PROJECT_ID && s.team !== 'single'
}

/** True when an exec run ended without completing (e.g. stalled, budget-exceeded, incomplete-plan, interrupted, failed). */
export function isFailedExecOutcome(outcome: RunRecord['summary']['execOutcome']): boolean {
  return outcome !== undefined && outcome !== 'completed' && outcome !== 'completed-unplanned'
}

/**
 * True when a team work run was cut short (execOutcome 'interrupted') by neither the user nor the app. A user's Ctrl-C /
 * SIGTERM / End session (execOutcome 'interrupted', endedBy 'user') and quitting OrgAI mid-work (endedBy 'app') say
 * nothing about the team, so they are never an interrupted trial run: they stay out of the trial window (the trial
 * stays pending) like every other user or app end (isMeasuredRun). A real timeout is the stall watchdog, which ends the
 * run 'stalled' with endedBy 'policy': that is a measured run and a failed exec outcome (isFailedExecOutcome), so it
 * already counts against a trial. An 'interrupted' outcome with any other endedBy (host-attributed) counts as one too.
 */
export function isInterruptedTrialRun(r: SummaryOf): boolean {
  const s = r.summary
  if (!isTeamWorkRun(r)) return false
  if (s.status !== 'finished' && s.status !== 'error') return false
  if (s.endedBy === 'user' || s.endedBy === 'app') return false
  return s.execOutcome === 'interrupted'
}

/** Runs eligible to count in an active trial window (measured runs plus interrupted/timed-out trial runs). */
export function isTrialRun(r: SummaryOf): boolean {
  return isMeasuredRun(r) || isInterruptedTrialRun(r)
}

/**
 * Finished work runs the engine measures: kind 'work', not a Chat (quick) or single-assistant run, ended finished or
 * error (or paused on a usage limit), and not cut short by the user or by quitting (that says nothing about the team).
 */
export function isMeasuredRun(r: SummaryOf): boolean {
  const s = r.summary
  if (s.endedBy === 'user' || s.endedBy === 'app') return false
  return isTeamWorkRun(r) && (s.status === 'finished' || s.status === 'error' || (s.status === 'paused' && s.pausedUntil !== undefined))
}

/** The newest `max` measured runs, newest first. */
export function measuredRuns<T extends SummaryOf>(runs: readonly T[], max = 10): T[] {
  return runs
    .filter(isMeasuredRun)
    .sort((a, b) => b.summary.startedAt - a.summary.startedAt)
    .slice(0, clamp(Math.floor(max), 1, 50))
}

// ---- plan graph shape -----------------------------------------------------------------------------------------------

/** Widest set of steps that can run together (longest-path levels, path overlaps as extra waits). 1 without a graph. */
export function planWidth(steps: readonly GraphStepLike[], opts?: { countIds?: ReadonlySet<string> }): { width: number; depth: number } {
  return planLevels(steps, steps.length < 2 ? [] : pendingOverlaps(steps), opts?.countIds)
}

/**
 * How much of the plan's width the run used: the root's reports' peak parallelism over the widest set of delegated
 * steps. `rootKeys`: digestHash of the lowercased names of the root role (a step staffed by the root is not
 * delegated); empty = the run's own root agents' slugs and names. Null without a plan of two steps or two reports.
 */
function dagRatio(d: RunDigest, rootKeys?: ReadonlySet<string>): { ratio: number; width: number; shape: Shape } | null {
  const plan = d.plan
  if (!plan || plan.steps.length < 2) return null
  const hasStaff = plan.steps.some((s) => s.role !== undefined)
  let width: number
  if (hasStaff) {
    const roots = rootKeys?.size ? rootKeys : new Set(d.rootNameKeys)
    const delegated = new Set(plan.steps.filter((s) => s.role !== undefined && !roots.has(s.role)).map((s) => s.id))
    width = planLevels(plan.steps, plan.overlaps, delegated).width
  } else {
    width = planLevels(plan.steps, plan.overlaps).width
  }
  const shape = d.shape
  if (width < 2 || shape.reports < 2) return null
  return { ratio: clamp(shape.maxParallel / width, 0, 1), width, shape }
}

// ---- metrics ----------------------------------------------------------------------------------------------------------

/** Fitness of a set of measured runs. Pure. */
export function measure(runs: readonly RunLike[], _limit = 8, opts?: { includeInterrupted?: boolean }): EvolutionMetrics {
  return measureDigests(runs.filter(opts?.includeInterrupted ? isTrialRun : isMeasuredRun).map(asDigest))
}

/** measure() over runs already filtered and digested. */
function measureDigests(work: readonly RunDigest[]): EvolutionMetrics {
  let reports = 0
  let passed = 0
  let conflicted = 0
  let errored = 0
  const ratios: number[] = []
  for (const r of work) {
    // A run paused on a usage limit or ended incomplete/interrupted never finished its work: it counts as not first pass.
    const paused = r.summary.status === 'paused'
    const incomplete = paused || isFailedExecOutcome(r.summary.execOutcome) || isInterruptedTrialRun(r)
    if (r.summary.status === 'error' || incomplete) errored++
    const rep = r.agents
    reports += incomplete ? Math.max(1, rep.length) : rep.length
    if (!incomplete) for (const a of rep) if (a.firstPass) passed++
    if (rep.some((a) => a.conflict)) conflicted++
    const d = dagRatio(r)
    if (d) ratios.push(d.ratio)
  }
  const n = work.length
  return {
    runs: n,
    // No reports at all: the run itself is the unit (an errored run is a failed first pass).
    firstPassRate: n === 0 ? 0 : r4(reports > 0 ? passed / reports : (n - errored) / n),
    conflictRate: n === 0 ? 0 : r4(conflicted / n),
    errorRunRate: n === 0 ? 0 : r4(errored / n),
    medianCostUsd: median(work.map((r) => r.costUsd).filter((x) => x > 0)),
    medianWallMs: median(work.map((r) => r.wallMs).filter((x) => x > 0)),
    medianInputTokens: median(work.map((r) => r.inputTokens).filter((x) => x > 0)),
    dagConcurrencyRatio: ratios.length ? r4(ratios.reduce((a, b) => a + b, 0) / ratios.length) : 1
  }
}

// ---- per-role aggregation ---------------------------------------------------------------------------------------------

interface RoleAgg {
  /** digestKey of the role slug. */
  slug: string
  agents: number
  firstPass: number
  errors: number
  assignments: number
  escalated: number
  failedReceipts: number
  tiers: Map<ModelTier, number>
  turns: number
  outTokens: number
  inTokens: number
  costUsd: number
  wallMs: number
  runs: Set<string>
  // spawners
  spawnerAgents: number
  fanOut: number
  lowFan: number
  lowFanRuns: Set<string>
}

const newAgg = (slug: string): RoleAgg => ({ slug, agents: 0, firstPass: 0, errors: 0, assignments: 0, escalated: 0, failedReceipts: 0, tiers: new Map(), turns: 0, outTokens: 0, inTokens: 0, costUsd: 0, wallMs: 0, runs: new Set(), spawnerAgents: 0, fanOut: 0, lowFan: 0, lowFanRuns: new Set() })

const tierDown = (t: ModelTier | undefined): boolean => t === 'deep' || t === 'everyday'

// ---- diagnose ---------------------------------------------------------------------------------------------------------

/** Waste score from finding severities: saturating, monotone in every severity and in the number of findings. */
export function wasteScoreOf(severities: readonly number[]): number {
  let keep = 1
  for (const s of severities) keep *= 1 - clamp(Number.isFinite(s) ? s : 0, 0, 100) / 100
  return clamp(Math.round(100 * (1 - keep)), 0, 100)
}

export function diagnose(input: DiagnoseInput): TeamEvolutionDiagnosis {
  const { project } = input
  const goal: StaffingGoal = input.goal ?? input.staffingProfile?.goal ?? 'balanced'
  const staffingFixed = input.staffingProfile?.mode === 'fixed' || project.staffing === 'fixed'
  const limit = effectiveConcurrency(project)
  // Only the runs measured are digested (a record passed in is digested here once).
  const runs = measuredRuns<RunLike>(input.runs, input.maxRuns ?? 10).map(asDigest)
  const metrics = measureDigests(runs)
  const base: TeamEvolutionDiagnosis = {
    projectId: project.id,
    runIds: runs.map((r) => r.summary.id),
    wasteScore: 0,
    metrics,
    findings: [],
    goal,
    analyzedAt: input.now ?? 0
  }
  if (!runs.length) return base

  // Digests hold slugs and role ids as digestKey; the project's are compared the same way.
  const roleBySlug = new Map(project.roles.map((r) => [digestKey(r.slug), r]))
  const roleById = new Map(project.roles.map((r) => [digestKey(r.id), r]))
  const rootRole = project.roles.find((r) => r.reportsTo === null) ?? project.roles[0]
  const rootKeys = new Set(
    [rootRole?.slug, rootRole?.name].filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => digestHash(s.trim().toLowerCase()))
  )
  const aggs = new Map<string, RoleAgg>()
  const agg = (slug: string): RoleAgg => {
    let a = aggs.get(slug)
    if (!a) aggs.set(slug, (a = newAgg(slug)))
    return a
  }
  let totalCost = 0
  const conflictRuns: { leads: string[]; overlap: string[] }[] = []
  const frictionCount = new Map<string, Map<ErrorCategory, number>>()
  const frictionTools = new Map<string, Set<string>>()
  const frictionRepeat = new Map<string, Map<string, number>>()
  const pollAgg = new Map<string, { totalPolls: number; pollRuns: Set<string>; costUsd: number; inTokens: number }>()
  const serial: { ratio: number; width: number; shape: Shape }[] = []
  let serialRuns = 0
  // Roles the chart has, as plan owners are compared (ownerKey of slug, name and id).
  const chartOwnerKeys = new Set(project.roles.flatMap((r) => [r.slug, r.name, r.id].map(ownerKey)).filter(Boolean))
  const selfStepRuns = new Set<string>()
  let selfSteps = 0
  const selfOwners = new Set<string>()
  // Roles seen running (digestKey of role ids and slugs) for unused_role.
  const seenRoleIds = new Set<string>()
  const seenSlugs = new Set<string>()

  for (const r of runs) {
    totalCost += r.costUsd
    // A done plan step owned by a role the chart lacks, with no report bound to it: a spawner did the work itself.
    for (const s of r.plan?.steps ?? []) {
      if (!s.unstaffed || !s.owner || chartOwnerKeys.has(s.owner)) continue
      selfSteps++
      selfStepRuns.add(r.summary.id)
      selfOwners.add(s.owner)
    }
    for (const x of r.assignments) seenRoleIds.add(x.roleId)
    for (const a of r.agents) {
      seenSlugs.add(a.slug)
      if (a.roleId) seenRoleIds.add(a.roleId)
    }
    for (const a of r.agents) {
      const g = agg(a.slug)
      g.runs.add(r.summary.id)
      g.agents++
      if (a.firstPass) g.firstPass++
      if (a.error) g.errors++
      g.turns += a.turns
      g.outTokens += a.outTokens
      g.inTokens += a.inTokens
      g.costUsd += a.costUsd
      g.wallMs += a.wallMs
      const role = a.roleId ? roleById.get(a.roleId) : roleBySlug.get(a.slug)
      if (role?.canSpawn) {
        g.spawnerAgents++
        g.fanOut += a.kids
        if (a.kids <= 1) {
          g.lowFan++
          g.lowFanRuns.add(r.summary.id)
        }
      }
    }
    for (const x of r.assignments) {
      const role = roleById.get(x.roleId)
      const slug = role ? digestKey(role.slug) : x.agentSlug
      if (!slug) continue
      const g = agg(slug)
      g.assignments++
      if (x.escalated) g.escalated++
      if (x.tier) g.tiers.set(x.tier as ModelTier, (g.tiers.get(x.tier as ModelTier) ?? 0) + 1)
    }
    for (const roleId of r.failedReceiptRoleIds) {
      const role = roleById.get(roleId)
      if (role) agg(digestKey(role.slug)).failedReceipts++
    }

    // serial bottleneck
    const d = dagRatio(r, rootKeys)
    if (d && d.ratio < 0.6) {
      serialRuns++
      serial.push(d)
    }

    // merge conflicts and overlapping file prefixes
    if (r.conflict) conflictRuns.push(r.conflict)

    // tool friction
    for (const f of r.friction) {
      const m = frictionCount.get(f.slug) ?? new Map<ErrorCategory, number>()
      for (const [cat, k] of f.cats) m.set(cat, (m.get(cat) ?? 0) + k)
      frictionCount.set(f.slug, m)
      for (const name of f.missingTools) frictionTools.set(f.slug, (frictionTools.get(f.slug) ?? new Set()).add(name))
      if (f.repeats.length) {
        const rm = frictionRepeat.get(f.slug) ?? new Map<string, number>()
        for (const [key, k] of f.repeats) rm.set(key, (rm.get(key) ?? 0) + k)
        frictionRepeat.set(f.slug, rm)
      }
    }
    // status polling
    for (const p of r.polls) {
      let a = pollAgg.get(p.slug)
      if (!a) pollAgg.set(p.slug, (a = { totalPolls: 0, pollRuns: new Set(), costUsd: 0, inTokens: 0 }))
      a.totalPolls += p.polls
      a.pollRuns.add(r.summary.id)
      a.costUsd += p.costUsd
      a.inTokens += p.inTokens
    }
  }

  const n = runs.length
  const findings: EvolutionFinding[] = []
  const perRunCost = (g: RoleAgg): number => g.costUsd / n

  // 1. tier calibration
  for (const g of aggs.values()) {
    const role = roleBySlug.get(g.slug)
    if (!role || g.agents < 1) continue
    const rate = g.agents ? g.firstPass / g.agents : 0
    const escRate = g.assignments ? g.escalated / g.assignments : 0
    const failRate = g.agents ? Math.max(g.failedReceipts, g.errors) / g.agents : 0
    const roleTier = role.tier
    const share = totalCost > 0 ? clamp(g.costUsd / totalCost, 0, 1) : 0
    if (g.agents >= MIN_ROLE_AGENTS && (escRate >= UNDER_ESCALATION_RATE || failRate >= UNDER_ESCALATION_RATE)) {
      findings.push({
        kind: 'tier_underprovisioned',
        roleSlug: role.slug,
        severity: clamp(15 + Math.round(60 * Math.max(escRate, failRate)), 0, 50),
        summary: safeLine(`${role.name} escalated or failed ${Math.round(100 * Math.max(escRate, failRate))}% of its assignments; it needs a stronger floor.`, FINDING_SUMMARY_MAX),
        evidence: [`${g.agents} agents over ${g.runs.size} runs`, `escalated ${g.escalated}/${g.assignments} assignments`, `failed receipts ${g.failedReceipts}, errors ${g.errors}`],
        data: { agents: g.agents, escalated: g.escalated, assignments: g.assignments }
      })
      continue
    }
    // A spawner's (lead's, coordinator's) short work is coordination, not easy work: its length never justifies a cut.
    if (role.canSpawn) continue
    const simple = g.turns / g.agents <= 6 && g.outTokens / g.agents <= 4000
    const runtimeTier = roleTier ?? ([...g.tiers].sort((a, b) => b[1] - a[1])[0]?.[0] as ModelTier | undefined)
    // A deep or everyday role can step a tier (everyday/low is the floor); a fast role can only step its effort, and
    // only from above medium (the synthesizer's effort rule).
    const highEffort = !!role.effort && EFFORTS.indexOf(role.effort) > EFFORTS.indexOf('medium')
    const fastEffort = runtimeTier === 'fast' && highEffort
    const cheaper = (tierDown(runtimeTier) && !(runtimeTier === 'everyday' && role.effort === 'low')) || fastEffort
    if (rate >= OVER_FIRST_PASS && g.escalated === 0 && g.failedReceipts === 0 && g.errors === 0 && simple && cheaper && !(totalCost > 0 && g.costUsd === 0)) {
      const saveUsd = perRunCost(g) * (role.effort && role.effort !== 'low' && role.effort !== 'medium' ? 0.2 : 0.5)
      const thin = g.agents < 6 || g.runs.size < 3
      findings.push({
        kind: 'tier_overprovisioned',
        roleSlug: role.slug,
        severity: thin ? clamp(4 + Math.round(10 * share), 0, 14) : clamp(10 + Math.round(30 * share), 0, 40),
        summary: safeLine(`${role.name} passed ${Math.round(rate * 100)}% first time with short, simple work; a cheaper ${role.effort && role.effort !== 'low' && role.effort !== 'medium' ? 'effort' : 'tier'} should do.`, FINDING_SUMMARY_MAX),
        evidence: [`${g.agents} agents over ${g.runs.size} runs`, `first pass ${g.firstPass}/${g.agents}, escalations 0`, `avg ${(g.turns / g.agents).toFixed(1)} turns, ${Math.round(g.outTokens / g.agents)} output tokens`, ...(staffingFixed ? ['staffing is fixed: the role runs as configured'] : [])],
        estSavingsUsd: r4(saveUsd),
        estSavingsTokens: Math.round((g.outTokens / n) * 0.15),
        estSavingsMs: Math.round((g.wallMs / n) * 0.15),
        ...(thin ? { exploration: { everyK: 4, ...(fastEffort && role.effort && stepEffort(role.effort, -1) ? { effort: stepEffort(role.effort, -1) } : runtimeTier && stepTier(runtimeTier, -1) ? { tier: stepTier(runtimeTier, -1) } : {}) } } : {}),
        data: { agents: g.agents, runs: g.runs.size, tier: runtimeTier ?? '' }
      })
    }
  }

  // 2. serial bottleneck
  if (serial.length) {
    const throttled = serial.filter((s) => s.shape.maxParallel >= limit && s.width > limit)
    const peak = Math.max(...serial.map((s) => s.width))
    const saveMs = serial.reduce((a, s) => a + Math.max(0, s.shape.busyMs - s.shape.sumMs / s.width), 0) / n
    const ratio = metrics.dagConcurrencyRatio
    const lim = throttled.length >= serial.length / 2
    findings.push({
      kind: 'serial_bottleneck',
      severity: clamp(10 + Math.round(40 * (1 - ratio)), 0, 50),
      summary: safeLine(lim ? `Independent steps waited behind the concurrency limit of ${limit} in ${serial.length} of ${n} runs.` : `Independent steps were spawned one after another in ${serial.length} of ${n} runs.`, FINDING_SUMMARY_MAX),
      evidence: [`${serialRuns} of ${n} runs below 60% of the plan's width`, `widest ready set ${peak}, limit ${limit}`, `concurrency ratio ${ratio}`],
      estSavingsMs: Math.round(saveMs),
      data: { runs: serial.length, peakReady: peak, limit, limitThrottled: lim ? 1 : 0 }
    })
  }

  // 3. merge conflict hotspot
  if (conflictRuns.length && (conflictRuns.some((c) => c.overlap.length) || conflictRuns.length >= 2)) {
    const leads = new Map<string, number>()
    for (const c of conflictRuns) for (const slug of c.leads) leads.set(slug, (leads.get(slug) ?? 0) + 1)
    const lead = [...leads].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0]
    const leadRole = lead ? roleBySlug.get(lead) : undefined
    const prefixes = [...new Set(conflictRuns.flatMap((c) => c.overlap))].slice(0, 6)
    const rate = conflictRuns.length / n
    findings.push({
      kind: 'merge_conflict_hotspot',
      ...(leadRole ? { roleSlug: leadRole.slug } : {}),
      severity: clamp(12 + Math.round(60 * rate), 0, 50),
      summary: safeLine(`Parallel reports conflicted on merge in ${conflictRuns.length} of ${n} runs; their file scopes overlap.`, FINDING_SUMMARY_MAX),
      evidence: [`${conflictRuns.length} runs with a conflicting merge`, ...prefixes.map((p) => `overlap ${p}/`)].slice(0, 6),
      estSavingsMs: Math.round((rate * metrics.medianWallMs) * 0.2),
      data: { runs: conflictRuns.length, prefixes: prefixes.join(','), ...(lead ? { leadSlug: safeName(leadRole?.slug ?? lead, 60) } : {}) }
    })
  }

  // 4. tool friction
  const friction = [...frictionCount].map(([slug, m]) => {
    const real = [...m].filter(([c]) => c !== 'other')
    const repeats = Math.max(0, ...(frictionRepeat.get(slug)?.values() ?? [0]))
    const worst = real.sort((a, b) => b[1] - a[1])[0]
    return { slug, worst, repeats, total: real.reduce((a, [, k]) => a + k, 0) }
  }).filter((f) => f.worst && (f.worst[1] >= 3 || f.repeats >= 3)).sort((a, b) => b.total - a.total).slice(0, 3)
  for (const f of friction) {
    const cat = f.worst![0]
    const tools = [...(frictionTools.get(f.slug) ?? [])].slice(0, 6)
    const role = roleBySlug.get(f.slug)
    findings.push({
      kind: 'tool_friction',
      ...(role ? { roleSlug: role.slug } : {}),
      severity: clamp(5 + f.total * 2, 0, 30),
      summary: safeLine(`${role?.name ?? safeName(f.slug)} hit ${f.total} repeated tool errors (${cat.replace('_', ' ')}).`, FINDING_SUMMARY_MAX),
      evidence: [`${cat.replace('_', ' ')}: ${f.worst![1]} errors`, `most repeated identical error: ${f.repeats}x`, ...(tools.length ? [`unavailable tools: ${tools.join(', ')}`] : [])],
      estSavingsTokens: Math.round((f.total * 600) / n),
      data: { category: cat, errors: f.total, missingTools: tools.join(',') }
    })
  }

  // 5. skills and prompts
  const never: string[] = []
  const overlap: string[] = []
  for (const f of input.skillFindings ?? []) {
    if (f.kind === 'neverLoaded') never.push(...f.skillIds)
    else if (f.kind === 'overlap') overlap.push(...f.skillIds)
    else if (f.kind === 'repeatedToolSequence' || f.kind === 'repeatedCorrection') {
      const count = f.evidence?.runIds?.length ?? f.evidence?.count ?? 0
      const seq = (f.evidence?.sequence ?? []).map((s) => safeName(s)).filter(Boolean).slice(0, 6)
      findings.push({
        kind: 'skill_crystallization',
        severity: clamp(4 + count * 2, 0, 16),
        summary: safeLine(f.kind === 'repeatedToolSequence' ? `The same ${seq.length || 'multi'}-step tool routine repeats in ${count} runs; a project skill could hold it.` : `The same user correction came up in ${count} runs; a project skill could carry it.`, FINDING_SUMMARY_MAX),
        evidence: [`${count} runs`, ...(seq.length ? [`sequence ${seq.join(' > ')}`] : [])],
        estSavingsTokens: Math.round(count * 300 / Math.max(1, n)),
        data: { source: f.kind, runs: count, sequence: seq.join('>') }
      })
    }
  }
  if (never.length || overlap.length) {
    findings.push({
      kind: 'prompt_deflation',
      severity: clamp(4 + never.length * 3 + overlap.length, 0, 20),
      summary: safeLine(`${never.length} granted skill(s) were never loaded${overlap.length ? ` and ${overlap.length} overlap` : ''}; their grants only add prompt weight.`, FINDING_SUMMARY_MAX),
      evidence: [`never loaded: ${never.length}`, `overlapping: ${overlap.length}`],
      estSavingsTokens: never.length * 120,
      data: { neverLoaded: [...new Set(never)].slice(0, 20).map((s) => safeName(s, 128)).join(','), overlapping: [...new Set(overlap)].slice(0, 20).map((s) => safeName(s, 128)).join(',') }
    })
  }
  for (const role of project.roles) {
    const chars = role.prompt?.length ?? 0
    if (chars <= PROMPT_BUDGET_PER_ROLE) continue
    const spawns = Math.max(1, (aggs.get(digestKey(role.slug))?.agents ?? n) / n)
    const protectedRole = role.reportsTo === null || isGuardRole(role, project.roles)
    const removableChars = protectedRole ? 0 : chars - compressPrompt(role.prompt ?? '').prompt.length
    const summary =
      removableChars > 0
        ? `${role.name}'s prompt is ${chars} characters (over ${PROMPT_BUDGET_PER_ROLE}); ${removableChars} characters of exact duplicate lines can be trimmed automatically.`
        : `${role.name}'s prompt is ${chars} characters (over ${PROMPT_BUDGET_PER_ROLE}); no exact duplicate lines to auto-trim (shorten manually if desired).`
    findings.push({
      kind: 'prompt_deflation',
      roleSlug: role.slug,
      severity: clamp(3 + Math.round((chars - PROMPT_BUDGET_PER_ROLE) / 100), 0, 20),
      summary: safeLine(summary, FINDING_SUMMARY_MAX),
      evidence: [`${chars} characters`, `about ${Math.round(spawns * 10) / 10} spawns per run`],
      estSavingsTokens: Math.round(((chars - PROMPT_BUDGET_PER_ROLE) / 4) * spawns * 0.2),
      data: { chars, removableChars }
    })
  }

  // 6. ceremonial layer
  for (const g of aggs.values()) {
    if (g.lowFanRuns.size < 3 || g.spawnerAgents < 3 || g.lowFan / g.spawnerAgents < 0.8) continue
    const role = roleBySlug.get(g.slug)
    const avgIn = g.inTokens / g.agents
    if (!role || avgIn < 20_000) continue
    findings.push({
      kind: 'ceremonial_layer',
      roleSlug: role.slug,
      severity: clamp(6 + Math.round(avgIn / 5000), 0, 26),
      summary: safeLine(`${role.name} spawns at most one report in ${g.lowFanRuns.size} runs while reading ${Math.round(avgIn / 1000)}k input tokens per agent; route to its report directly.`, FINDING_SUMMARY_MAX),
      evidence: [`fan-out <= 1 in ${g.lowFan}/${g.spawnerAgents} agents`, `${g.lowFanRuns.size} runs`, `avg ${Math.round(avgIn)} input tokens`],
      estSavingsTokens: Math.round((avgIn * g.lowFan) / n),
      data: { runs: g.lowFanRuns.size, avgInputTokens: Math.round(avgIn) }
    })
  }

  // 7. orchestrator polling
  for (const [slug, p] of pollAgg) {
    const role = roleBySlug.get(slug)
    if (!role) continue
    const runCount = p.pollRuns.size
    const avgPolls = p.totalPolls / runCount
    const wasteFrac = clamp(avgPolls / (avgPolls + 4), 0.25, 0.75)
    const estUsd = r4((p.costUsd / n) * wasteFrac)
    const estTok = Math.round((p.inTokens / n) * wasteFrac)
    const severity = clamp(10 + Math.round(avgPolls * 2), 10, 45)
    findings.push({
      kind: 'orchestrator_polling',
      roleSlug: role.slug,
      severity,
      summary: safeLine(`${role.name} polled ListAgents ${avgPolls.toFixed(1)}x/run across ${runCount} of ${n} run${n === 1 ? '' : 's'} while waiting on reports; let it end its turn and wait for report delivery.`, FINDING_SUMMARY_MAX),
      evidence: [
        `ListAgents called ${p.totalPolls}x across ${runCount} run${runCount === 1 ? '' : 's'} (avg ${avgPolls.toFixed(1)}/run)`,
        ...(p.costUsd > 0 ? [`spawner cost $${(p.costUsd / runCount).toFixed(4)}/run`] : []),
        ...(p.inTokens > 0 ? [`avg ${Math.round(p.inTokens / runCount / 1000)}k input tokens/run`] : [])
      ],
      ...(estUsd > 0 ? { estSavingsUsd: estUsd } : {}),
      ...(estTok > 0 ? { estSavingsTokens: estTok } : {}),
      data: { runs: runCount, totalPolls: p.totalPolls, avgPolls: Math.round(avgPolls * 10) / 10 }
    })
  }

  // 8. a spawner doing step work itself (advisory): plan steps owned by a role the chart lacks, done with no report.
  //    Built from counts and the root's slug only; the owners themselves are hashes in the digest and never shown.
  if (selfStepRuns.size >= SELF_STEP_MIN_RUNS) {
    const rootSlug = safeName(rootRole?.slug ?? '', 60) || 'the root'
    findings.push({
      kind: 'spawner_step_work',
      severity: clamp(4 + selfSteps, 0, 20),
      summary: safeLine(`${selfSteps} planned steps in ${selfStepRuns.size} of ${n} runs named an owner the chart has no role for and ran with no report; ${rootSlug} or a lead did them itself. A specialist role may be missing (change the chart by hand).`, FINDING_SUMMARY_MAX),
      evidence: [`${selfSteps} steps done with no report`, `${selfStepRuns.size} of ${n} runs`, `${selfOwners.size} owner name(s) not in the chart`],
      data: { runs: selfStepRuns.size, steps: selfSteps, owners: selfOwners.size }
    })
  }

  // 9. a role never spawned (advisory): only with a full window of UNUSED_ROLE_RUNS measured runs; the root always runs.
  if (n >= UNUSED_ROLE_RUNS) {
    for (const role of project.roles) {
      if (role === rootRole || role.reportsTo === null) continue
      if (seenRoleIds.has(digestKey(role.id)) || seenSlugs.has(digestKey(role.slug))) continue
      const slug = safeName(role.slug, 60) || 'a role'
      findings.push({
        kind: 'unused_role',
        roleSlug: role.slug,
        severity: 5,
        summary: safeLine(`Role ${slug} was not spawned in any of the last ${n} measured runs; it may be redundant (review the chart by hand).`, FINDING_SUMMARY_MAX),
        evidence: [`0 agents in ${n} runs`, `prompt ${role.prompt?.length ?? 0} characters`],
        data: { runs: n }
      })
    }
  }

  // Advisory findings never crowd an actionable one out of the cap, and never count toward the waste score.
  const order = (a: EvolutionFinding, b: EvolutionFinding): number => b.severity - a.severity || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : (a.roleSlug ?? '') < (b.roleSlug ?? '') ? -1 : 1)
  const actionable = findings.filter((f) => !isAdvisoryFinding(f)).sort(order)
  const advisory = findings.filter(isAdvisoryFinding).sort(order)
  const kept = [...actionable, ...advisory]
    .slice(0, MAX_FINDINGS)
    .sort(order)
    .map((f) => ({ ...f, evidence: f.evidence.slice(0, 6).map((e) => safeLine(e)) }))
  return { ...base, findings: kept, wasteScore: wasteScoreOf(kept.filter((f) => !isAdvisoryFinding(f)).map((f) => f.severity)) }
}
