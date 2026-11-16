import { agentProducedNothing } from '../../shared/defaults'
import { pathOverlaps, type GraphStepLike } from '../../shared/planGraph'
import { QUICK_PROJECT_ID } from '../../shared/types'
import type {
  AgentInstance,
  EvolutionFinding,
  EvolutionMetrics,
  ModelTier,
  Project,
  RunRecord,
  SkillFinding,
  StaffingGoal,
  StaffingMode,
  TeamEvolutionDiagnosis
} from '../../shared/types'
import { redactEvidence } from '../skills/suggest'
import { PROMPT_BUDGET_PER_ROLE, effectiveConcurrency, stepTier } from './plan'

/**
 * The zero-token analyzer: reads finished work runs as stored and produces a waste score, fitness metrics and typed
 * findings. Pure (no I/O, no clock, no randomness), one pass over the runs, bounded transcript scanning. Run text is
 * data: nothing a run wrote reaches a finding except as a count, a sanitized tool name or a sanitized path prefix.
 *
 * What it reads from RunRecord (real fields): summary.{kind, quick, projectId, team, status, error, startedAt, endedAt,
 * usage.{costUsd, wallMs, idleMs, waitingMs, limitHoldMs, tokens}}, agents[].{id, parentId, roleId, roleSlug, state,
 * result, startedAt, endedAt, usage.{turns, costUsd, tokens}, delegation.verdict, worktree.{status, changedFiles}},
 * staffing.assignments[].{agentId, roleId, tier, source}, delegation.receipts[].{roleId, verdict}, plan.steps[]
 * ({after, paths}, via planGraph.pathOverlaps), transcript[].{agentId, block tool_use / tool_result}.
 */

export const TRANSCRIPT_SCAN_LIMIT = 5000
/** Evidence needed before a finding fires. */
export const MIN_ROLE_AGENTS = 3
export const OVER_FIRST_PASS = 0.9
export const UNDER_ESCALATION_RATE = 0.35
export const MAX_FINDINGS = 12
const FINDING_SUMMARY_MAX = 240
const EVIDENCE_LINE_MAX = 120

export interface DiagnoseInput {
  project: Project
  /** Run records, any order; the newest `runs` work runs are used. */
  runs: RunRecord[]
  staffingProfile?: { mode: StaffingMode; goal: StaffingGoal }
  skillFindings?: SkillFinding[]
  goal?: StaffingGoal
  now?: number
  /** Most runs read (default 10). */
  maxRuns?: number
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))
const r4 = (n: number): number => Math.round(n * 10000) / 10000
const finite = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0)

export function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** One safe line of evidence: control characters, angle brackets and secrets removed, bounded. */
export function safeLine(s: string, max = EVIDENCE_LINE_MAX): string {
  const t = redactEvidence(String(s))
    .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁯﻿]/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

const safeName = (s: unknown, max = 40): string => String(s ?? '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, max)

/**
 * Finished work runs the engine measures: kind 'work', not a Chat (quick) or single-assistant run, ended finished or
 * error (or paused on a usage limit), and not cut short by the user or by quitting (that says nothing about the team).
 */
export function isMeasuredRun(r: Pick<RunRecord, 'summary'>): boolean {
  const s = r.summary
  if (s.endedBy === 'user' || s.endedBy === 'app') return false
  return s.kind === 'work' && !s.quick && s.projectId !== QUICK_PROJECT_ID && s.team !== 'single' && (s.status === 'finished' || s.status === 'error' || (s.status === 'paused' && s.pausedUntil !== undefined))
}

/** The newest `max` measured runs, newest first. */
export function measuredRuns(runs: RunRecord[], max = 10): RunRecord[] {
  return runs
    .filter(isMeasuredRun)
    .sort((a, b) => b.summary.startedAt - a.summary.startedAt)
    .slice(0, clamp(Math.floor(max), 1, 50))
}

const isRoot = (a: AgentInstance): boolean => a.id === 'root' || a.parentId === null
const reportsOf = (r: RunRecord): AgentInstance[] => Object.values(r.agents ?? {}).filter((a) => !isRoot(a))

const runCost = (r: RunRecord): number => finite(r.summary.usage?.costUsd ?? r.summary.totalCostUsd)
const runWallMs = (r: RunRecord): number => {
  const u = r.summary.usage
  const raw = u ? finite(u.wallMs) - finite(u.idleMs) - finite(u.waitingMs) - finite(u.limitHoldMs) : finite((r.summary.endedAt ?? r.summary.startedAt) - r.summary.startedAt)
  return Math.max(0, raw)
}
const runInputTokens = (r: RunRecord): number => {
  const t = r.summary.usage?.tokens
  return t ? finite(t.input) + finite(t.cacheRead) + finite(t.cacheWrite) : 0
}

// ---- plan graph shape -----------------------------------------------------------------------------------------------

/** Widest set of steps that can run together (longest-path levels, path overlaps as extra waits). 1 without a graph. */
export function planWidth(steps: readonly GraphStepLike[]): { width: number; depth: number } {
  if (steps.length < 2) return { width: steps.length ? 1 : 0, depth: steps.length }
  const pending = steps.map((s) => ({ ...s, status: 'pending' as const }))
  const deps = new Map<string, Set<string>>(pending.map((s) => [s.id, new Set((s.after ?? []).filter((x) => x !== s.id))]))
  for (const o of pathOverlaps({ steps: pending })) deps.get(o.second)?.add(o.first)
  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const depthOf = (id: string): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 1 // a cycle: the steps in it never separate, count it as one level
    visiting.add(id)
    let d = 1
    for (const dep of deps.get(id) ?? []) if (deps.has(dep)) d = Math.max(d, 1 + depthOf(dep))
    visiting.delete(id)
    depth.set(id, d)
    return d
  }
  const levels = new Map<number, number>()
  let deepest = 1
  for (const s of pending) {
    const d = depthOf(s.id)
    deepest = Math.max(deepest, d)
    levels.set(d, (levels.get(d) ?? 0) + 1)
  }
  return { width: Math.max(...levels.values()), depth: deepest }
}

interface Shape {
  reports: number
  maxParallel: number
  busyMs: number
  sumMs: number
}

/** Timing of the root's direct reports from the agents' own timestamps. */
export function spawnShape(r: RunRecord): Shape {
  const agents = Object.values(r.agents ?? {})
  const rootIds = new Set(agents.filter(isRoot).map((a) => a.id))
  const end = r.summary.endedAt ?? 0
  const iv = agents
    .filter((a) => a.parentId !== null && rootIds.has(a.parentId))
    .map((a) => [a.startedAt, Math.max(a.startedAt, a.endedAt ?? end)] as const)
    .sort((a, b) => a[0] - b[0])
  let busy = 0
  let sum = 0
  let curEnd = -Infinity
  let curStart = 0
  const edges: [number, number][] = []
  for (const [s, e] of iv) {
    sum += e - s
    edges.push([s, 1], [e, -1])
    if (s > curEnd) {
      if (curEnd > -Infinity) busy += curEnd - curStart
      curStart = s
      curEnd = e
    } else curEnd = Math.max(curEnd, e)
  }
  if (curEnd > -Infinity) busy += curEnd - curStart
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let live = 0
  let max = 0
  for (const [, d] of edges) {
    live += d
    max = Math.max(max, live)
  }
  return { reports: iv.length, maxParallel: max, busyMs: busy, sumMs: sum }
}

function dagRatio(r: RunRecord): { ratio: number; width: number; shape: Shape } | null {
  const steps = r.plan?.steps
  if (!steps || steps.length < 2) return null
  const { width } = planWidth(steps)
  const shape = spawnShape(r)
  if (width < 2 || shape.reports < 2) return null
  return { ratio: clamp(shape.maxParallel / width, 0, 1), width, shape }
}

// ---- metrics ----------------------------------------------------------------------------------------------------------

function firstPassOf(a: AgentInstance, run: RunRecord, escalatedAgents: Set<string>): boolean {
  return a.state === 'done' && !agentProducedNothing(a) && a.delegation?.verdict !== 'failed' && !escalatedAgents.has(a.id) && a.worktree?.status !== 'conflict'
}

const escalatedAgentIds = (r: RunRecord): Set<string> => new Set((r.staffing?.assignments ?? []).filter((x) => x.source === 'escalated' && x.agentId).map((x) => x.agentId as string))

/** Fitness of a set of measured runs. Pure. */
export function measure(runs: RunRecord[], _limit = 8): EvolutionMetrics {
  const work = runs.filter(isMeasuredRun)
  let reports = 0
  let passed = 0
  let conflicted = 0
  let errored = 0
  const ratios: number[] = []
  for (const r of work) {
    // A run paused on a usage limit (status 'paused' with pausedUntil) never finished its work: it counts as not first pass.
    const paused = r.summary.status === 'paused'
    if (r.summary.status === 'error' || paused) errored++
    const esc = escalatedAgentIds(r)
    const rep = reportsOf(r)
    reports += paused ? Math.max(1, rep.length) : rep.length
    if (!paused) for (const a of rep) if (firstPassOf(a, r, esc)) passed++
    if (rep.some((a) => a.worktree?.status === 'conflict')) conflicted++
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
    medianCostUsd: median(work.map(runCost).filter((x) => x > 0)),
    medianWallMs: median(work.map(runWallMs).filter((x) => x > 0)),
    medianInputTokens: median(work.map(runInputTokens).filter((x) => x > 0)),
    dagConcurrencyRatio: ratios.length ? r4(ratios.reduce((a, b) => a + b, 0) / ratios.length) : 1
  }
}

// ---- per-role aggregation ---------------------------------------------------------------------------------------------

interface RoleAgg {
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

type Category = 'missing_tool' | 'bad_flag' | 'missing_path' | 'other'
const MISSING_TOOL = /no such tool|unknown tool|tool\b.{0,60}\b(?:is )?not (?:available|allowed|found|permitted)|isn'?t available|not in (?:the )?(?:allowed )?tools/i
const BAD_FLAG = /unknown (?:option|flag|argument)|unrecognized (?:option|argument|arguments)|invalid (?:option|flag)|illegal option|unexpected argument|usage:/i
const MISSING_PATH = /ENOENT|no such file or directory|does not exist|cannot find (?:the )?(?:path|file)|file not found|not a directory/i

export function classifyError(text: string): Category {
  const t = text.slice(0, 600)
  if (MISSING_TOOL.test(t)) return 'missing_tool'
  if (BAD_FLAG.test(t)) return 'bad_flag'
  if (MISSING_PATH.test(t)) return 'missing_path'
  return 'other'
}

const dirPrefix = (file: string): string => {
  const parts = file.replace(/\\/g, '/').split('/').filter((x) => x && x !== '.')
  const dirs = parts.length > 1 ? parts.slice(0, -1) : parts
  return safeLine(dirs.slice(0, 2).join('/').replace(/[^A-Za-z0-9._/-]/g, ''), 40)
}

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
  const runs = measuredRuns(input.runs, input.maxRuns ?? 10)
  const base: TeamEvolutionDiagnosis = {
    projectId: project.id,
    runIds: runs.map((r) => r.summary.id),
    wasteScore: 0,
    metrics: measure(runs, limit),
    findings: [],
    goal,
    analyzedAt: input.now ?? 0
  }
  if (!runs.length) return base

  const roleBySlug = new Map(project.roles.map((r) => [r.slug, r]))
  const roleById = new Map(project.roles.map((r) => [r.id, r]))
  const aggs = new Map<string, RoleAgg>()
  const agg = (slug: string): RoleAgg => {
    let a = aggs.get(slug)
    if (!a) aggs.set(slug, (a = newAgg(slug)))
    return a
  }
  let totalCost = 0
  const conflictRuns: { agents: AgentInstance[]; overlap: string[]; run: RunRecord }[] = []
  const frictionCount = new Map<string, Map<Category, number>>()
  const frictionTools = new Map<string, Set<string>>()
  const frictionRepeat = new Map<string, Map<string, number>>()
  const serial: { ratio: number; width: number; shape: Shape }[] = []
  let serialRuns = 0

  for (const r of runs) {
    totalCost += runCost(r)
    const esc = escalatedAgentIds(r)
    const agents = Object.values(r.agents ?? {})
    const byId = new Map(agents.map((a) => [a.id, a]))
    const childCount = new Map<string, number>()
    for (const a of agents) if (a.parentId) childCount.set(a.parentId, (childCount.get(a.parentId) ?? 0) + 1)
    for (const a of agents) {
      if (isRoot(a)) continue
      const g = agg(a.roleSlug)
      g.runs.add(r.summary.id)
      g.agents++
      if (firstPassOf(a, r, esc)) g.firstPass++
      if (a.state === 'error') g.errors++
      g.turns += finite(a.usage?.turns)
      g.outTokens += finite(a.usage?.tokens.output ?? a.outputTokens)
      g.inTokens += finite(a.usage?.tokens.input) + finite(a.usage?.tokens.cacheRead) + finite(a.usage?.tokens.cacheWrite) || finite(a.inputTokens)
      g.costUsd += finite(a.usage?.costUsd ?? a.costUsd)
      g.wallMs += Math.max(0, finite((a.endedAt ?? r.summary.endedAt ?? a.startedAt) - a.startedAt))
      const role = a.roleId ? roleById.get(a.roleId) : roleBySlug.get(a.roleSlug)
      if (role?.canSpawn) {
        const kids = childCount.get(a.id) ?? 0
        g.spawnerAgents++
        g.fanOut += kids
        if (kids <= 1) {
          g.lowFan++
          g.lowFanRuns.add(r.summary.id)
        }
      }
    }
    for (const x of r.staffing?.assignments ?? []) {
      const slug = roleById.get(x.roleId)?.slug ?? (x.agentId ? byId.get(x.agentId)?.roleSlug : undefined)
      if (!slug) continue
      const g = agg(slug)
      g.assignments++
      if (x.source === 'escalated') g.escalated++
      if (x.tier) g.tiers.set(x.tier, (g.tiers.get(x.tier) ?? 0) + 1)
    }
    for (const rc of r.delegation?.receipts ?? []) {
      if (rc.verdict !== 'failed') continue
      const slug = roleById.get(rc.roleId)?.slug
      if (slug) agg(slug).failedReceipts++
    }

    // serial bottleneck
    const d = dagRatio(r)
    if (d && d.ratio < 0.6) {
      serialRuns++
      serial.push(d)
    }

    // merge conflicts and overlapping file prefixes
    const conflicted = agents.filter((a) => a.worktree?.status === 'conflict')
    if (conflicted.length) {
      const owners = new Map<string, Set<string>>()
      for (const a of agents) for (const f of a.worktree?.changedFiles?.slice(0, 200) ?? []) {
        const p = dirPrefix(f)
        if (!p) continue
        const s = owners.get(p) ?? new Set()
        s.add(a.id)
        owners.set(p, s)
      }
      const overlap = [...owners].filter(([, s]) => s.size >= 2).map(([p]) => p).sort()
      conflictRuns.push({ agents: conflicted.map((a) => byId.get(a.parentId ?? '') ?? a), overlap, run: r })
    }

    // tool friction
    const uses = new Map<string, string>()
    const t = r.transcript ?? []
    for (let i = 0; i < t.length && i < TRANSCRIPT_SCAN_LIMIT; i++) {
      const b = t[i].block
      if (b.kind === 'tool_use') uses.set(b.id, String(b.name))
      else if (b.kind === 'tool_result' && b.isError) {
        const slug = byId.get(t[i].agentId)?.roleSlug ?? 'unknown'
        const cat = classifyError(b.content)
        const m = frictionCount.get(slug) ?? new Map<Category, number>()
        m.set(cat, (m.get(cat) ?? 0) + 1)
        frictionCount.set(slug, m)
        if (cat === 'missing_tool') {
          const name = safeName(uses.get(b.toolUseId))
          if (name) frictionTools.set(slug, (frictionTools.get(slug) ?? new Set()).add(name))
        }
        if (cat !== 'other') {
          const key = `${cat}:${(uses.get(b.toolUseId) ?? '').slice(0, 20)}:${b.content.slice(0, 80).toLowerCase().replace(/[0-9]+/g, '#').replace(/\s+/g, ' ')}`
          const rm = frictionRepeat.get(slug) ?? new Map<string, number>()
          rm.set(key, (rm.get(key) ?? 0) + 1)
          frictionRepeat.set(slug, rm)
        }
      }
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
        roleSlug: g.slug,
        severity: clamp(15 + Math.round(60 * Math.max(escRate, failRate)), 0, 50),
        summary: safeLine(`${role.name} escalated or failed ${Math.round(100 * Math.max(escRate, failRate))}% of its assignments; it needs a stronger floor.`, FINDING_SUMMARY_MAX),
        evidence: [`${g.agents} agents over ${g.runs.size} runs`, `escalated ${g.escalated}/${g.assignments} assignments`, `failed receipts ${g.failedReceipts}, errors ${g.errors}`],
        data: { agents: g.agents, escalated: g.escalated, assignments: g.assignments }
      })
      continue
    }
    const simple = g.turns / g.agents <= 6 && g.outTokens / g.agents <= 4000
    const runtimeTier = roleTier ?? ([...g.tiers].sort((a, b) => b[1] - a[1])[0]?.[0] as ModelTier | undefined)
    if (rate >= OVER_FIRST_PASS && g.escalated === 0 && g.failedReceipts === 0 && g.errors === 0 && simple && tierDown(runtimeTier) && !(runtimeTier === 'everyday' && role.effort === 'low')) {
      const saveUsd = perRunCost(g) * (role.effort && role.effort !== 'low' && role.effort !== 'medium' ? 0.2 : 0.5)
      const thin = g.agents < 6 || g.runs.size < 3
      findings.push({
        kind: 'tier_overprovisioned',
        roleSlug: g.slug,
        severity: thin ? clamp(4 + Math.round(10 * share), 0, 14) : clamp(10 + Math.round(30 * share), 0, 40),
        summary: safeLine(`${role.name} passed ${Math.round(rate * 100)}% first time with short, simple work; a cheaper ${role.effort && role.effort !== 'low' && role.effort !== 'medium' ? 'effort' : 'tier'} should do.`, FINDING_SUMMARY_MAX),
        evidence: [`${g.agents} agents over ${g.runs.size} runs`, `first pass ${g.firstPass}/${g.agents}, escalations 0`, `avg ${(g.turns / g.agents).toFixed(1)} turns, ${Math.round(g.outTokens / g.agents)} output tokens`, ...(staffingFixed ? ['staffing is fixed: the role runs as configured'] : [])],
        estSavingsUsd: r4(saveUsd),
        estSavingsTokens: Math.round((g.outTokens / n) * 0.15),
        estSavingsMs: Math.round((g.wallMs / n) * 0.15),
        ...(thin ? { exploration: { everyK: 4, ...(runtimeTier && stepTier(runtimeTier, -1) ? { tier: stepTier(runtimeTier, -1) } : {}) } } : {}),
        data: { agents: g.agents, tier: runtimeTier ?? '' }
      })
    }
  }

  // 2. serial bottleneck
  if (serial.length) {
    const throttled = serial.filter((s) => s.shape.maxParallel >= limit && s.width > limit)
    const peak = Math.max(...serial.map((s) => s.width))
    const saveMs = serial.reduce((a, s) => a + Math.max(0, s.shape.busyMs - s.shape.sumMs / s.width), 0) / n
    const ratio = measure(runs, limit).dagConcurrencyRatio
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
    for (const c of conflictRuns) for (const a of c.agents) leads.set(a.roleSlug, (leads.get(a.roleSlug) ?? 0) + 1)
    const lead = [...leads].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0]
    const prefixes = [...new Set(conflictRuns.flatMap((c) => c.overlap))].slice(0, 6)
    const rate = conflictRuns.length / n
    findings.push({
      kind: 'merge_conflict_hotspot',
      ...(lead && roleBySlug.has(lead) ? { roleSlug: lead } : {}),
      severity: clamp(12 + Math.round(60 * rate), 0, 50),
      summary: safeLine(`Parallel reports conflicted on merge in ${conflictRuns.length} of ${n} runs; their file scopes overlap.`, FINDING_SUMMARY_MAX),
      evidence: [`${conflictRuns.length} runs with a conflicting merge`, ...prefixes.map((p) => `overlap ${p}/`)].slice(0, 6),
      estSavingsMs: Math.round((rate * measure(runs, limit).medianWallMs) * 0.2),
      data: { runs: conflictRuns.length, prefixes: prefixes.join(','), ...(lead ? { leadSlug: safeName(lead, 60) } : {}) }
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
      ...(role ? { roleSlug: f.slug } : {}),
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
    const spawns = Math.max(1, (aggs.get(role.slug)?.agents ?? n) / n)
    findings.push({
      kind: 'prompt_deflation',
      roleSlug: role.slug,
      severity: clamp(3 + Math.round((chars - PROMPT_BUDGET_PER_ROLE) / 100), 0, 20),
      summary: safeLine(`${role.name}'s prompt is ${chars} characters (over ${PROMPT_BUDGET_PER_ROLE}); duplicated and filler lines cost tokens on every spawn.`, FINDING_SUMMARY_MAX),
      evidence: [`${chars} characters`, `about ${Math.round(spawns * 10) / 10} spawns per run`],
      estSavingsTokens: Math.round(((chars - PROMPT_BUDGET_PER_ROLE) / 4) * spawns * 0.2),
      data: { chars }
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
      roleSlug: g.slug,
      severity: clamp(6 + Math.round(avgIn / 5000), 0, 26),
      summary: safeLine(`${role.name} spawns at most one report in ${g.lowFanRuns.size} runs while reading ${Math.round(avgIn / 1000)}k input tokens per agent; route to its report directly.`, FINDING_SUMMARY_MAX),
      evidence: [`fan-out <= 1 in ${g.lowFan}/${g.spawnerAgents} agents`, `${g.lowFanRuns.size} runs`, `avg ${Math.round(avgIn)} input tokens`],
      estSavingsTokens: Math.round((avgIn * g.lowFan) / n),
      data: { runs: g.lowFanRuns.size, avgInputTokens: Math.round(avgIn) }
    })
  }

  findings.sort((a, b) => b.severity - a.severity || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : (a.roleSlug ?? '') < (b.roleSlug ?? '') ? -1 : 1))
  const kept = findings.slice(0, MAX_FINDINGS).map((f) => ({ ...f, evidence: f.evidence.slice(0, 6).map((e) => safeLine(e)) }))
  return { ...base, findings: kept, wasteScore: wasteScoreOf(kept.map((f) => f.severity)) }
}
