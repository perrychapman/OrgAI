import type {
  AgentInstance,
  AgentUsage,
  ConnectionId,
  CostSource,
  KnowledgeServedUsage,
  ModelUsageEntry,
  NoResultAgent,
  PriceSource,
  RoleUsage,
  RunKind,
  RunEfficiency,
  RunRecord,
  RunSummary,
  RunUsage,
  RunUsageRow,
  SkillUseCount,
  TokenUsage,
  TranscriptEntry,
  UsageCostCoverage,
  UsageOverview,
  UsageOverviewConnection,
  UsageOverviewModel,
  UsageOverviewRole,
  UsageOverviewRow,
  UsageOverviewTrendPoint,
  UsageProjectKind,
  UsageProjectRollup,
  UsageStats,
  UsageStatsQuery,
  UsageTrendPoint,
  UsageTrendProjectSlice
} from '@shared/types'
import { agentProducedNothing, cleanPlanStepGraph, cleanRunStaffing, emptyTokens, totalTokens } from '@shared/defaults'
import { agentLabel } from '@shared/view/agentTree'
import { isBuiltinConnectionId, RUN_KIND_LABELS, RUN_NO_RESULT_AGENTS_MAX, USAGE_CSV_COLUMNS, USAGE_OVERVIEW_CSV_COLUMNS, USAGE_OVERVIEW_MAX_PROJECT_IDS, USAGE_REMOVED_PROJECT_NAME, USAGE_STATS_DEFAULT_LIMIT, USAGE_STATS_MAX_LIMIT } from '@shared/types'

/**
 * Vendor-neutral usage metrics: the adapter-facing tally helpers (below, used by claude.ts, codex.ts and mock.ts),
 * plus run aggregation, legacy-record normalization and trend queries (RunManager, RunStore, runs:usageStats).
 * Never imports an SDK. Pricing lives in pricing.ts.
 */

// ---------- adapter-facing helpers (contract: stable signatures) ----------

/** A fresh, zeroed AgentUsage. */
export function emptyAgentUsage(): AgentUsage {
  return { tokens: emptyTokens(), models: [], costUsd: null, costSource: 'none', turns: 0, toolCalls: 0, retries: 0 }
}

/** a + b, field by field (a new object). */
export function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  // Persisted usage is untrusted file data: a NaN, negative or non-number field counts as 0.
  const f = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0)
  return { input: f(a.input) + f(b.input), output: f(a.output) + f(b.output), cacheRead: f(a.cacheRead) + f(b.cacheRead), cacheWrite: f(a.cacheWrite) + f(b.cacheWrite) }
}

/** The agent's usage, created (empty) when missing. */
export function usageOf(agent: AgentInstance): AgentUsage {
  if (!agent.usage) agent.usage = emptyAgentUsage()
  return agent.usage
}

/**
 * Replace one model's cumulative token counts (and the provider's cost for them, when it reported one > 0) on an
 * agent's usage, then recompute usage.tokens and the legacy AgentInstance.inputTokens / outputTokens. Adapters call it
 * with running totals per model (Claude: summed over distinct message ids; Codex: the thread's cumulative usage).
 * Cost fields are left for RunManager to price.
 */
export function setModelTokens(agent: AgentInstance, model: string, tokens: TokenUsage, providerCostUsd?: number): void {
  const usage = usageOf(agent)
  const name = model || 'unknown'
  let entry = usage.models.find((m) => m.model === name)
  if (!entry) {
    entry = { model: name, tokens: emptyTokens(), costUsd: null, priceSource: 'unknown' }
    usage.models.push(entry)
  }
  const n = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0)
  entry.tokens = { input: n(tokens.input), output: n(tokens.output), cacheRead: n(tokens.cacheRead), cacheWrite: n(tokens.cacheWrite) }
  if (providerCostUsd !== undefined && Number.isFinite(providerCostUsd) && providerCostUsd > 0) entry.providerCostUsd = providerCostUsd
  else delete entry.providerCostUsd
  usage.tokens = usage.models.reduce((acc, m) => addTokens(acc, m.tokens), emptyTokens())
  agent.inputTokens = usage.tokens.input + usage.tokens.cacheRead + usage.tokens.cacheWrite
  agent.outputTokens = usage.tokens.output
}

/** Count one model response (turn), tool call or API retry on an agent. */
export function countUsage(agent: AgentInstance, kind: 'turns' | 'toolCalls' | 'retries', n = 1): void {
  const usage = usageOf(agent)
  usage[kind] += n
}

// ---------- RunManager / RunStore side ----------

/** Extra run-level inputs RunManager tracks itself. */
export interface RunUsageInputs {
  /** The adapter's last run.cost (provider total, resume base already subtracted). */
  providerTotalUsd?: number
  /** RunPlan.autoContinues of this run. */
  nudges: number
  waitingMs: number
  limitHoldMs: number
  idleMs: number
  now: number
  /** Skill loads counted by RunManager (skill.used events). Missing or empty = RunUsage.skills stays unset. */
  skills?: readonly SkillUseCount[]
  /** Knowledge graph reads served (RunManager's tally). Missing or all zero = RunUsage.knowledge stays unset. */
  knowledge?: KnowledgeServedUsage
  /** The run's transcript, for RunEfficiency.reportStartMs (first file-writing tool use per report). Missing = that field stays unset. */
  transcript?: readonly TranscriptEntry[]
}

/**
 * A KnowledgeServedUsage from untrusted data (a persisted record): every field a finite whole number >= 0, else the
 * whole value is absent. All zero counts as absent too. Never throws.
 */
export function cleanKnowledgeUsage(x: unknown): KnowledgeServedUsage | undefined {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return undefined
  const o = x as Record<string, unknown>
  const out: Partial<KnowledgeServedUsage> = {}
  for (const k of ['recalls', 'autoContexts', 'itemsServed', 'charsServed'] as const) {
    const v = o[k]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined
    out[k] = Math.floor(v)
  }
  const u = out as KnowledgeServedUsage
  return u.recalls + u.autoContexts + u.itemsServed + u.charsServed > 0 ? u : undefined
}

/**
 * A RunEfficiency from untrusted data (a persisted record): every required field a finite number >= 0 (reports and
 * maxParallel whole, reports >= 1), else the whole value is absent. The optional readyIdleMs, afterLastReportMs and reportStartMs are each kept only as a finite
 * number >= 0 (else that field alone is dropped). Never throws.
 */
export function cleanRunEfficiency(x: unknown): RunEfficiency | undefined {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return undefined
  const o = x as Record<string, unknown>
  const out: Partial<RunEfficiency> = {}
  for (const k of ['reports', 'firstSpawnMs', 'reportSumMs', 'reportBusyMs', 'maxParallel', 'tailMs'] as const) {
    const v = o[k]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined
    out[k] = k === 'reports' || k === 'maxParallel' ? Math.floor(v) : v
  }
  const idle = o.readyIdleMs
  if (typeof idle === 'number' && Number.isFinite(idle) && idle >= 0) out.readyIdleMs = idle
  for (const k of ['afterLastReportMs', 'reportStartMs'] as const) {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v
  }
  const e = out as RunEfficiency
  return e.reports >= 1 ? e : undefined
}

/**
 * Timing of the root's direct reports from the agents' own timestamps (nothing is tracked for it). undefined when no
 * direct report started. A live report (no endedAt) counts to `now`; the run ends at summary.endedAt ?? now.
 */
export function computeRunEfficiency(
  summary: RunSummary,
  agents: readonly AgentInstance[],
  now: number,
  transcript?: readonly TranscriptEntry[]
): RunEfficiency | undefined {
  const root = agents.find((a) => a.parentId === null)
  if (!root) return undefined
  const num = (n: unknown, d: number): number => (typeof n === 'number' && Number.isFinite(n) ? n : d)
  const iv = agents
    .filter((a) => a.parentId === root.id && Number.isFinite(a.startedAt))
    .map((a) => ({ id: a.id, s: a.startedAt, e: Math.max(a.startedAt, num(a.endedAt, now)) }))
    .sort((a, b) => a.s - b.s || a.e - b.e)
  if (iv.length === 0) return undefined
  const runEnd = num(summary.endedAt, now)
  // Union of intervals and peak concurrency (an end at the same ms as a start frees the slot first).
  let busy = 0
  let curEnd = -Infinity
  let curStart = 0
  for (const x of iv) {
    if (x.s > curEnd) {
      if (curEnd > -Infinity) busy += curEnd - curStart
      curStart = x.s
      curEnd = x.e
    } else curEnd = Math.max(curEnd, x.e)
  }
  busy += curEnd - curStart
  const ev = iv.flatMap((x) => [{ t: x.s, d: 1 }, { t: x.e, d: -1 }]).sort((a, b) => a.t - b.t || a.d - b.d)
  let live = 0
  let maxParallel = 0
  for (const e of ev) {
    live += e.d
    maxParallel = Math.max(maxParallel, live)
  }
  // First wave: every report that started before any report ended (the earliest start is always in it).
  const firstEnd = Math.min(...iv.map((x) => x.e))
  const waveEnd = Math.max(...iv.filter((x, i) => i === 0 || x.s < firstEnd).map((x) => x.e))
  const ms = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)
  const lastEnd = Math.max(...iv.map((x) => x.e))
  const out: RunEfficiency = {
    reports: iv.length,
    firstSpawnMs: ms(iv[0]!.s - num(summary.startedAt, iv[0]!.s)),
    reportSumMs: ms(iv.reduce((n, x) => n + (x.e - x.s), 0)),
    reportBusyMs: ms(busy),
    maxParallel,
    tailMs: ms(runEnd - waveEnd),
    afterLastReportMs: ms(runEnd - lastEnd)
  }
  const start = medianReportStartMs(iv, transcript)
  if (start !== undefined) out.reportStartMs = start
  return out
}

/** Tools whose use means the agent is writing files (the normalized names: the Codex adapter maps fileChange to Edit or Write). */
export const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * Median over the reports that wrote a file of (their first write tool_use `at` minus their start), ms. A write before
 * the start (clock skew) counts as 0. undefined when no transcript or no report wrote.
 */
function medianReportStartMs(reports: readonly { id: string; s: number }[], transcript: readonly TranscriptEntry[] | undefined): number | undefined {
  if (!transcript || transcript.length === 0) return undefined
  const first = new Map<string, number>()
  for (const t of transcript) {
    if (t.block.kind !== 'tool_use' || !FILE_WRITE_TOOLS.has(t.block.name) || !Number.isFinite(t.at)) continue
    const cur = first.get(t.agentId)
    if (cur === undefined || t.at < cur) first.set(t.agentId, t.at)
  }
  const vals = reports.flatMap((r) => (first.has(r.id) ? [Math.max(0, first.get(r.id)! - r.s)] : [])).sort((a, b) => a - b)
  if (vals.length === 0) return undefined
  const mid = vals.length >> 1
  return vals.length % 2 ? vals[mid]! : (vals[mid - 1]! + vals[mid]!) / 2
}

/**
 * Time a condition holds, as one interval at a time: set(true) opens it, set(false) closes it. Setting the current
 * value again is a no-op, so "union of overlapping causes" is the caller's boolean (e.g. pendingCount > 0).
 */
export class IntervalTimer {
  private total = 0
  private openedAt: number | null = null

  get isOpen(): boolean {
    return this.openedAt !== null
  }

  set(active: boolean, now: number): void {
    if (active) {
      if (this.openedAt === null) this.openedAt = now
    } else if (this.openedAt !== null) {
      this.total += Math.max(0, now - this.openedAt)
      this.openedAt = null
    }
  }

  /** Milliseconds so far, counting an open interval up to `now`. */
  elapsed(now: number): number {
    return this.total + (this.openedAt !== null ? Math.max(0, now - this.openedAt) : 0)
  }
}

interface CostPart {
  costUsd: number | null
  costSource: CostSource
  costPartial?: true
}

interface CostResult {
  costUsd: number | null
  costSource: CostSource
  costPartial?: true
}

/** Roll costs of parts (agents, roles, runs) up. 'none' parts are ignored; an unpriced part makes the result partial. */
export function mergeCosts(parts: readonly CostPart[]): CostResult {
  let active = 0
  let priced = 0
  let sum = 0
  let allProvider = true
  let partial = false
  for (const p of parts) {
    if (p.costSource === 'none') continue
    active++
    if (p.costPartial) partial = true
    if (p.costUsd === null) continue
    if (!Number.isFinite(p.costUsd)) continue
    priced++
    sum += p.costUsd
    if (p.costSource !== 'provider') allProvider = false
  }
  if (active === 0) return { costUsd: 0, costSource: 'none' }
  if (priced === 0 || !Number.isFinite(sum)) return { costUsd: null, costSource: 'unknown' }
  const out: CostResult = { costUsd: sum, costSource: allProvider ? 'provider' : 'computed' }
  if (partial || priced < active) out.costPartial = true
  return out
}

const SOURCE_RANK: Record<PriceSource, number> = { override: 0, proxy: 1, builtin: 2, community: 3, provider: 4, unknown: 5 }

function mergeModelEntries(lists: readonly (readonly ModelUsageEntry[])[]): ModelUsageEntry[] {
  const byModel = new Map<string, ModelUsageEntry>()
  for (const list of lists) {
    for (const m of list) {
      const cur = byModel.get(m.model)
      if (!cur) {
        byModel.set(m.model, { ...m, tokens: { ...m.tokens } })
        continue
      }
      cur.tokens = addTokens(cur.tokens, m.tokens)
      if (m.providerCostUsd) cur.providerCostUsd = (cur.providerCostUsd ?? 0) + m.providerCostUsd
      if (m.costUsd !== null && Number.isFinite(m.costUsd)) {
        const next = (cur.costUsd ?? 0) + m.costUsd
        cur.costUsd = Number.isFinite(next) ? next : null
      }
      if (SOURCE_RANK[m.priceSource] < SOURCE_RANK[cur.priceSource]) cur.priceSource = m.priceSource
    }
  }
  return [...byModel.values()]
}

function stripHandle(name: string): string {
  return name.replace(/(?:\s+|-)\d+$/, '')
}

function agentWall(a: AgentInstance, now: number): number {
  return Math.max(0, (a.endedAt ?? now) - a.startedAt)
}

/** Aggregate a run's (already priced) agents into RunUsage. */
export function computeRunUsage(summary: RunSummary, agents: readonly AgentInstance[], inputs: RunUsageInputs): RunUsage {
  const now = inputs.now
  const usages = agents.map((a) => a.usage ?? emptyAgentUsage())
  const tokens = usages.reduce((acc, u) => addTokens(acc, u.tokens), emptyTokens())
  const models = mergeModelEntries(usages.map((u) => u.models))

  const roleMap = new Map<string, { role: RoleUsage; parts: CostPart[]; models: Set<string> }>()
  let noResultAgents = 0
  let noResultTokens = 0
  const noResultParts: AgentUsage[] = []
  const noResultList: NoResultAgent[] = []
  let legacy = false
  agents.forEach((a, i) => {
    const u = usages[i]!
    if (u.legacy) legacy = true
    const key = a.roleId ?? a.roleSlug
    let g = roleMap.get(key)
    if (!g) {
      g = {
        role: { roleId: a.roleId, roleSlug: a.roleSlug, roleName: stripHandle(a.name), agents: 0, tokens: emptyTokens(), costUsd: 0, costSource: 'none', turns: 0, toolCalls: 0, retries: 0, agentWallMs: 0, agentsWithoutResult: 0, noResultTokens: 0, models: [] },
        parts: [],
        models: new Set()
      }
      roleMap.set(key, g)
    }
    const r = g.role
    r.agents++
    r.tokens = addTokens(r.tokens, u.tokens)
    r.turns += u.turns
    r.toolCalls += u.toolCalls
    r.retries += u.retries
    r.agentWallMs += agentWall(a, now)
    g.parts.push(u)
    for (const m of u.models) g.models.add(m.model)
    if (agentProducedNothing(a)) {
      const t = totalTokens(u.tokens)
      r.agentsWithoutResult++
      r.noResultTokens += t
      noResultAgents++
      noResultTokens += t
      noResultParts.push(u)
      if (noResultList.length < RUN_NO_RESULT_AGENTS_MAX) {
        noResultList.push({ agentId: a.id, name: agentLabel(a), roleName: stripHandle(a.name), tokens: { ...u.tokens }, costUsd: knownCost(u) })
      }
    }
  })
  const roles: RoleUsage[] = [...roleMap.values()].map((g) => {
    const c = mergeCosts(g.parts)
    const r: RoleUsage = { ...g.role, costUsd: c.costUsd, costSource: c.costSource, models: [...g.models] }
    if (c.costPartial) r.costPartial = true
    return r
  })

  const cost = mergeCosts(usages)
  // Multi-provider runs: cost and agent count per connection, each agent priced by its own connection.
  const runConnection = summary.connection
  const multi = runConnection !== undefined && agents.some((a) => a.connection !== undefined && a.connection !== runConnection)
  const provider = inputs.providerTotalUsd
  // The adapter's total covers only the root's own session, never a bridged child's, so it cannot stand for a multi-provider run.
  const hasProvider = !multi && provider !== undefined && Number.isFinite(provider) && provider > 0
  // The provider's run total covers the whole run, so it wins when the agents' costs are provider-priced, and it
  // fills in when agent costs are missing altogether (no per-model cost reported). Computed costs keep their sum.
  const useProvider = hasProvider && (cost.costSource === 'provider' || cost.costSource === 'none' || cost.costSource === 'unknown')
  const usage: RunUsage = {
    tokens,
    costUsd: useProvider ? provider : cost.costUsd,
    costSource: useProvider ? 'provider' : cost.costSource,
    models,
    roles,
    wallMs: Math.max(0, (summary.endedAt ?? now) - summary.startedAt),
    turns: usages.reduce((n, u) => n + u.turns, 0),
    toolCalls: usages.reduce((n, u) => n + u.toolCalls, 0),
    retries: usages.reduce((n, u) => n + u.retries, 0),
    agents: agents.length,
    agentsWithoutResult: noResultAgents,
    noResultTokens,
    nudges: inputs.nudges,
    waitingMs: inputs.waitingMs,
    limitHoldMs: inputs.limitHoldMs,
    idleMs: inputs.idleMs,
    updatedAt: now
  }
  if (cost.costPartial && !useProvider) usage.costPartial = true
  if (noResultParts.length) {
    const nr = mergeCosts(noResultParts)
    usage.noResultCostUsd = nr.costUsd
    if (nr.costPartial) usage.noResultCostPartial = true
    usage.noResultAgents = noResultList
  }
  if (multi) {
    const groups = new Map<string, { parts: AgentUsage[]; agents: number }>()
    agents.forEach((a, i) => {
      const key = a.connection ?? runConnection!
      const g = groups.get(key) ?? { parts: [], agents: 0 }
      g.parts.push(usages[i]!)
      g.agents++
      groups.set(key, g)
    })
    // The contract types the map as a total Record over ConnectionId (anthropic, openai, proxy ids); only the used keys exist.
    usage.connections = Object.fromEntries(
      [...groups].map(([k, g]) => {
        const c = mergeCosts(g.parts)
        return [k, c.costPartial ? { costUsd: c.costUsd, agents: g.agents, costPartial: true as const } : { costUsd: c.costUsd, agents: g.agents }]
      })
    ) as RunUsage['connections']
  }
  if (hasProvider) usage.providerCostUsd = provider
  if (legacy) usage.legacy = true
  const skills = mergeSkillCounts([inputs.skills ?? []])
  if (skills.length) usage.skills = skills
  const knowledge = cleanKnowledgeUsage(inputs.knowledge)
  if (knowledge) usage.knowledge = knowledge
  const efficiency = computeRunEfficiency(summary, agents, now, inputs.transcript)
  if (efficiency) usage.efficiency = efficiency
  return usage
}

/** Merge skill counts by skillId (loads summed, roles unioned, latest name wins), most loaded first. */
export function mergeSkillCounts(lists: readonly (readonly SkillUseCount[])[]): SkillUseCount[] {
  const byId = new Map<string, SkillUseCount>()
  for (const list of lists) {
    for (const s of list) {
      const loads = Number.isFinite(s.loads) && s.loads > 0 ? s.loads : 0
      const have = byId.get(s.skillId)
      if (have) {
        have.loads += loads
        have.name = s.name
        for (const r of s.roles) if (!have.roles.includes(r)) have.roles.push(r)
      } else {
        byId.set(s.skillId, { skillId: s.skillId, name: s.name, loads, roles: [...new Set(s.roles)] })
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.loads - a.loads || a.name.localeCompare(b.name))
}

/** An AgentUsage built from an agent's older fields (inputTokens includes cache). `legacy` marks it approximate. */
export function usageFromLegacyAgent(a: AgentInstance, legacy: boolean): AgentUsage {
  const tokens: TokenUsage = { input: Math.max(0, a.inputTokens || 0), output: Math.max(0, a.outputTokens || 0), cacheRead: 0, cacheWrite: 0 }
  const total = totalTokens(tokens)
  const cost = Number.isFinite(a.costUsd) && a.costUsd > 0 ? a.costUsd : 0
  const entry: ModelUsageEntry = { model: a.model || 'unknown', tokens, costUsd: null, priceSource: 'unknown' }
  let costUsd: number | null
  let costSource: CostSource
  if (cost > 0) {
    entry.providerCostUsd = cost
    entry.costUsd = cost
    entry.priceSource = 'provider'
    costUsd = cost
    costSource = 'provider'
  } else if (total > 0) {
    costUsd = null
    costSource = 'unknown'
  } else {
    entry.costUsd = 0
    costUsd = 0
    costSource = 'none'
  }
  const usage: AgentUsage = { tokens: { ...tokens }, models: total > 0 || cost > 0 ? [entry] : [], costUsd, costSource, turns: 0, toolCalls: 0, retries: 0 }
  if (agentProducedNothing(a)) usage.producedNothing = true
  if (legacy) usage.legacy = true
  return usage
}

/** A RunUsage from a summary alone (no readable record): cost from totalCostUsd, no agent detail. */
export function legacySummaryUsage(summary: RunSummary, now: number): RunUsage {
  const cost = summary.totalCostUsd > 0 ? summary.totalCostUsd : 0
  const u: RunUsage = {
    tokens: emptyTokens(),
    costUsd: cost,
    costSource: cost > 0 ? 'provider' : 'none',
    models: [],
    roles: [],
    wallMs: Math.max(0, (summary.endedAt ?? summary.startedAt) - summary.startedAt),
    turns: 0,
    toolCalls: 0,
    retries: 0,
    agents: 0,
    agentsWithoutResult: 0,
    noResultTokens: 0,
    nudges: 0,
    waitingMs: 0,
    limitHoldMs: 0,
    idleMs: 0,
    legacy: true,
    updatedAt: now
  }
  if (cost > 0) u.providerCostUsd = cost
  return u
}

/**
 * The record's plan and staffing from an untrusted file (run staffing): the plan's step graph through
 * cleanPlanStepGraph (only when `plan.steps` is an array; nothing else of the plan is touched) and `staffing` through
 * cleanRunStaffing (a value that is not an object is removed). Returns the record itself when nothing changes. Pure.
 */
function cleanStoredGraph(record: RunRecord): RunRecord {
  let out = record
  const plan = record.plan
  if (plan && typeof plan === 'object' && Array.isArray(plan.steps)) {
    const steps = cleanPlanStepGraph(plan.steps)
    if (JSON.stringify(steps) !== JSON.stringify(plan.steps)) out = { ...out, plan: { ...plan, steps } }
  }
  if (record.staffing !== undefined) {
    const staffing = cleanRunStaffing(record.staffing)
    if (JSON.stringify(staffing) !== JSON.stringify(record.staffing)) {
      out = { ...out }
      if (staffing) out.staffing = staffing
      else delete out.staffing
    }
  }
  return out
}

/**
 * Fill AgentInstance.usage and RunSummary.usage on a record saved before usage tracking (legacy: true), and clean the
 * stored plan graph and staffing (cleanStoredGraph). Idempotent; returns the record itself when nothing changes.
 */
export function normalizeRunRecord(input: RunRecord, now: number = Date.now()): RunRecord {
  const record = cleanStoredGraph(input)
  let changed = record !== input
  const agents: Record<string, AgentInstance> = {}
  for (const [id, a] of Object.entries(record.agents ?? {})) {
    // Persisted JSON: an own "__proto__" key would set the new object's prototype instead of adding an agent.
    if (id === '__proto__' || id === 'constructor' || id === 'prototype') {
      changed = true
      continue
    }
    if (a.usage) {
      agents[id] = a
    } else {
      agents[id] = { ...a, usage: usageFromLegacyAgent(a, true) }
      changed = true
    }
  }
  let summary = record.summary
  if (!summary.usage) {
    const base = computeRunUsage(summary, Object.values(agents), { nudges: record.plan?.autoContinues ?? 0, waitingMs: 0, limitHoldMs: 0, idleMs: 0, now: summary.endedAt ?? now, transcript: record.transcript })
    const cost = summary.totalCostUsd > 0 ? summary.totalCostUsd : 0
    const isLegacy = base.legacy === true || Object.keys(agents).length === 0
    const usage: RunUsage = { ...base, updatedAt: now }
    if (isLegacy) usage.legacy = true
    if (isLegacy && cost > 0) {
      usage.providerCostUsd = cost
      if (usage.costSource === 'provider' || usage.costSource === 'none') {
        usage.costUsd = cost
        usage.costSource = 'provider'
      }
    }
    summary = { ...summary, usage }
    changed = true
  } else if (summary.usage.knowledge !== undefined || summary.usage.efficiency !== undefined) {
    // A stored knowledge tally or efficiency summary that is junk (old build, hand-edited file) reads as absent.
    const usage = { ...summary.usage }
    const clean = cleanKnowledgeUsage(usage.knowledge)
    const eff = cleanRunEfficiency(usage.efficiency)
    let dirty = false
    if (usage.knowledge !== undefined && JSON.stringify(clean) !== JSON.stringify(usage.knowledge)) {
      if (clean) usage.knowledge = clean
      else delete usage.knowledge
      dirty = true
    }
    if (usage.efficiency !== undefined && JSON.stringify(eff) !== JSON.stringify(usage.efficiency)) {
      if (eff) usage.efficiency = eff
      else delete usage.efficiency
      dirty = true
    }
    if (dirty) {
      summary = { ...summary, usage }
      changed = true
    }
  }
  return changed ? { ...record, summary, agents } : record
}

// ---------- usageStats ----------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Local-midnight start of the bucket containing `t`, and its YYYY-MM-DD label. Weeks start on Monday. */
export function bucketOf(t: number, bucket: 'day' | 'week'): { start: number; label: string } {
  const d = new Date(t)
  let y = d.getFullYear()
  let m = d.getMonth()
  let day = d.getDate()
  if (bucket === 'week') {
    const back = (d.getDay() + 6) % 7
    const s = new Date(y, m, day - back)
    y = s.getFullYear()
    m = s.getMonth()
    day = s.getDate()
  }
  return { start: new Date(y, m, day).getTime(), label: `${y}-${pad2(m + 1)}-${pad2(day)}` }
}

function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function emptyRunUsage(now: number): RunUsage {
  return { tokens: emptyTokens(), costUsd: 0, costSource: 'none', models: [], roles: [], wallMs: 0, turns: 0, toolCalls: 0, retries: 0, agents: 0, agentsWithoutResult: 0, noResultTokens: 0, nudges: 0, waitingMs: 0, limitHoldMs: 0, idleMs: 0, updatedAt: now }
}

type MergedRole = RoleUsage & { runs: number }

function mergeRoles(lists: readonly (readonly RoleUsage[])[]): MergedRole[] {
  const map = new Map<string, { r: MergedRole; parts: CostPart[]; models: Set<string> }>()
  for (const list of lists) {
    const seen = new Set<string>()
    for (const r of list) {
      const key = r.roleId ?? r.roleSlug
      let g = map.get(key)
      if (!g) {
        g = { r: { ...r, tokens: emptyTokens(), agents: 0, turns: 0, toolCalls: 0, retries: 0, agentWallMs: 0, agentsWithoutResult: 0, noResultTokens: 0, runs: 0, models: [] }, parts: [], models: new Set() }
        map.set(key, g)
      }
      g.r.agents += r.agents
      g.r.tokens = addTokens(g.r.tokens, r.tokens)
      g.r.turns += r.turns
      g.r.toolCalls += r.toolCalls
      g.r.retries += r.retries
      g.r.agentWallMs += r.agentWallMs
      g.r.agentsWithoutResult += r.agentsWithoutResult
      g.r.noResultTokens += r.noResultTokens
      g.parts.push(r)
      for (const m of r.models) g.models.add(m)
      if (!seen.has(key)) {
        seen.add(key)
        g.r.runs++
      }
    }
  }
  return [...map.values()].map((g) => {
    const c = mergeCosts(g.parts)
    const out: MergedRole = { ...g.r, costUsd: c.costUsd, costSource: c.costSource, models: [...g.models] }
    if (c.costPartial) out.costPartial = true
    else delete out.costPartial
    return out
  })
}

/** Sum run usages (models and roles merged, wallMs summed). */
export function sumRunUsage(list: readonly RunUsage[], now: number): RunUsage {
  if (list.length === 0) return emptyRunUsage(now)
  const cost = mergeCosts(list)
  const sum = (pick: (u: RunUsage) => number): number => list.reduce((n, u) => n + pick(u), 0)
  const total: RunUsage = {
    tokens: list.reduce((acc, u) => addTokens(acc, u.tokens), emptyTokens()),
    costUsd: cost.costUsd,
    costSource: cost.costSource,
    models: mergeModelEntries(list.map((u) => u.models)),
    roles: mergeRoles(list.map((u) => u.roles)),
    wallMs: sum((u) => u.wallMs),
    turns: sum((u) => u.turns),
    toolCalls: sum((u) => u.toolCalls),
    retries: sum((u) => u.retries),
    agents: sum((u) => u.agents),
    agentsWithoutResult: sum((u) => u.agentsWithoutResult),
    noResultTokens: sum((u) => u.noResultTokens),
    nudges: sum((u) => u.nudges),
    waitingMs: sum((u) => u.waitingMs),
    limitHoldMs: sum((u) => u.limitHoldMs),
    idleMs: sum((u) => u.idleMs),
    updatedAt: now
  }
  if (cost.costPartial) total.costPartial = true
  if (list.some((u) => u.legacy)) total.legacy = true
  const skills = mergeSkillCounts(list.map((u) => u.skills ?? []))
  if (skills.length) total.skills = skills
  const served = list.map((u) => cleanKnowledgeUsage(u.knowledge)).filter((k): k is KnowledgeServedUsage => k !== undefined)
  if (served.length) {
    total.knowledge = {
      recalls: served.reduce((n, k) => n + k.recalls, 0),
      autoContexts: served.reduce((n, k) => n + k.autoContexts, 0),
      itemsServed: served.reduce((n, k) => n + k.itemsServed, 0),
      charsServed: served.reduce((n, k) => n + k.charsServed, 0)
    }
  }
  const pc =sum((u) => u.providerCostUsd ?? 0)
  if (pc > 0 && Number.isFinite(pc)) total.providerCostUsd = pc
  return total
}

/** One RunUsageRow from a summary (a summary without usage reads as legacy). */
function usageRow(s: RunSummary, now: number): RunUsageRow {
  const row: RunUsageRow = { runId: s.id, kind: s.kind, status: s.status, prompt: oneLine(typeof s.prompt === 'string' ? s.prompt : '', 120), startedAt: s.startedAt, usage: s.usage ?? legacySummaryUsage(s, now) }
  if (s.title) row.title = s.title
  if (s.team === 'single') row.team = 'single'
  if (s.endedAt !== undefined) row.endedAt = s.endedAt
  if (s.resumedFrom) row.resumedFrom = s.resumedFrom
  return row
}

/** A known, finite cost or null. */
function knownCost(u: { costUsd: number | null }): number | null {
  return u.costUsd !== null && Number.isFinite(u.costUsd) ? u.costUsd : null
}

/** Sum of the known costs; null when none is known. */
function sumKnown(list: readonly { costUsd: number | null }[]): number | null {
  let any = false
  let n = 0
  for (const u of list) {
    const c = knownCost(u)
    if (c === null) continue
    any = true
    n += c
  }
  return any ? n : null
}

function unknownOrPartial(u: RunUsage): boolean {
  return u.costSource === 'unknown' || u.costPartial === true
}

/** One trend bucket over the runs' usages. */
function trendPoint(label: string, start: number, list: readonly RunUsage[]): UsageTrendPoint {
  const sum = (pick: (u: RunUsage) => number): number => list.reduce((n, u) => n + pick(u), 0)
  return {
    bucket: label,
    start,
    runs: list.length,
    tokens: list.reduce((acc, u) => addTokens(acc, u.tokens), emptyTokens()),
    costUsd: sumKnown(list),
    costUnknownRuns: list.filter(unknownOrPartial).length,
    turns: sum((u) => u.turns),
    toolCalls: sum((u) => u.toolCalls),
    nudges: sum((u) => u.nudges),
    retries: sum((u) => u.retries),
    wallMs: sum((u) => u.wallMs),
    waitingMs: sum((u) => u.waitingMs),
    noResultTokens: sum((u) => u.noResultTokens)
  }
}

/** runs:usageStats over persisted summaries (each with usage filled). A summary without usage reads as legacy. */
export function buildUsageStats(summaries: readonly RunSummary[], query: UsageStatsQuery, now: number): UsageStats {
  const kinds = query.kinds && query.kinds.length > 0 ? query.kinds : ['work' as const]
  const bucket = query.bucket === 'week' ? 'week' : 'day'
  const picked = summaries
    .filter((s) => s.projectId === query.projectId && kinds.includes(s.kind))
    .filter((s) => (query.since === undefined || s.startedAt >= query.since) && (query.until === undefined || s.startedAt < query.until))
    .sort((a, b) => b.startedAt - a.startedAt)

  // The newest runs win; roles, trend and totals cover only the returned rows.
  const limit = Math.min(USAGE_STATS_MAX_LIMIT, Math.max(1, Math.floor(Number.isFinite(query.limit) ? (query.limit as number) : USAGE_STATS_DEFAULT_LIMIT)))
  const truncated = picked.length > limit
  const runs = picked.slice(0, limit).map((s) => usageRow(s, now))

  const points = new Map<number, { label: string; runs: RunUsage[] }>()
  for (const r of runs) {
    const b = bucketOf(r.startedAt, bucket)
    let g = points.get(b.start)
    if (!g) {
      g = { label: b.label, runs: [] }
      points.set(b.start, g)
    }
    g.runs.push(r.usage)
  }
  const trend: UsageTrendPoint[] = [...points.entries()].sort((a, b) => a[0] - b[0]).map(([start, g]) => trendPoint(g.label, start, g.runs))

  const totals = sumRunUsage(runs.map((r) => r.usage), now)
  const stats: UsageStats = { projectId: query.projectId, runs, roles: totals.roles as UsageStats['roles'], trend, totals, generatedAt: now }
  if (truncated) stats.truncated = true
  return stats
}

// ---------- usageOverview (app-wide) ----------

/** Local-midnight start of the bucket containing `t` and its label; 'month' = the 1st of the local month (YYYY-MM-01). */
export function overviewBucketOf(t: number, bucket: 'day' | 'week' | 'month'): { start: number; label: string } {
  if (bucket !== 'month') return bucketOf(t, bucket)
  const d = new Date(t)
  const y = d.getFullYear()
  const m = d.getMonth()
  return { start: new Date(y, m, 1).getTime(), label: `${y}-${pad2(m + 1)}-01` }
}

const ALL_RUN_KINDS = Object.keys(RUN_KIND_LABELS) as RunKind[]
const OVERVIEW_ID = /^[A-Za-z0-9_-]{1,128}$/

/** UsageOverviewQuery after main's defaults and checks (also UsageOverview.query). */
export type SanitizedUsageOverviewQuery = UsageOverview['query']

/**
 * runs:usageOverview input from the renderer or a socket client, rebuilt: finite times, known kinds (default every
 * kind), known bucket (default 'day'), limit clamped to 1..USAGE_STATS_MAX_LIMIT (default USAGE_STATS_DEFAULT_LIMIT).
 * Throws "Invalid month" for a malformed range, "Invalid project ids" for a projectIds that is not an array of
 * [A-Za-z0-9_-]{1,128} strings or has more than USAGE_OVERVIEW_MAX_PROJECT_IDS entries. Unknown fields are dropped.
 * undefined / null = the empty query. Pure.
 */
export function sanitizeUsageOverviewQuery(raw: unknown): SanitizedUsageOverviewQuery {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) throw new Error('Invalid usage query')
  const q = (raw ?? {}) as Record<string, unknown>
  const kinds = Array.isArray(q.kinds) ? [...new Set(q.kinds.filter((k): k is RunKind => (ALL_RUN_KINDS as readonly unknown[]).includes(k)))] : []
  const out: SanitizedUsageOverviewQuery = {
    kinds: kinds.length ? kinds : [...ALL_RUN_KINDS],
    bucket: q.bucket === 'week' || q.bucket === 'month' ? q.bucket : 'day',
    limit: USAGE_STATS_DEFAULT_LIMIT
  }
  if (typeof q.since === 'number' && Number.isFinite(q.since)) out.since = q.since
  if (typeof q.until === 'number' && Number.isFinite(q.until)) out.until = q.until
  if (q.range !== undefined && q.range !== null) {
    const r = q.range
    const { since, until } = monthRange(r && typeof r === 'object' ? ((r as { month?: unknown }).month as string) : '')
    out.since = since
    out.until = until
  }
  if (q.projectIds !== undefined && q.projectIds !== null) {
    const ids = q.projectIds
    // Array.from turns holes of a sparse array (structured clone keeps them; every() skips them) into undefined.
    if (!Array.isArray(ids) || ids.length > USAGE_OVERVIEW_MAX_PROJECT_IDS || !Array.from(ids).every((id) => typeof id === 'string' && OVERVIEW_ID.test(id))) {
      throw new Error('Invalid project ids')
    }
    if (ids.length) out.projectIds = [...new Set(ids as string[])]
  }
  const limit = typeof q.limit === 'number' && Number.isFinite(q.limit) ? Math.floor(q.limit) : USAGE_STATS_DEFAULT_LIMIT
  out.limit = Math.min(USAGE_STATS_MAX_LIMIT, Math.max(1, limit))
  return out
}

/** What the overview shows for a project id; null = the project is gone (its runs read as USAGE_REMOVED_PROJECT_NAME). */
export interface UsageOverviewProjectInfo {
  name: string
  kind: UsageProjectKind
  client?: string
}

/** Name lookups the caller supplies (main: ProjectStore, the virtual display projects, connectionName). */
export interface UsageOverviewNames {
  project(id: string): UsageOverviewProjectInfo | null
  connection(id: ConnectionId): string
}

/** A whole count >= 0 from untrusted data (anything else is 0). */
function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
}

/** A duration or token count >= 0 from untrusted data (anything else is 0). */
function amount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

function cleanTokens(t: unknown): TokenUsage {
  const o = t && typeof t === 'object' ? (t as Record<string, unknown>) : {}
  return { input: amount(o.input), output: amount(o.output), cacheRead: amount(o.cacheRead), cacheWrite: amount(o.cacheWrite) }
}

const COST_SOURCES: readonly CostSource[] = ['provider', 'computed', 'unknown', 'none']

/**
 * A stored cost triple made consistent (review N1 / N2): a cost that is not a finite number >= 0 is null; null with
 * any source but a clean 'none' becomes 'unknown' (junk never reads as $0); 'none' with spent tokens or a cost > 0
 * becomes 'computed' (partial) or 'unknown'; a known cost under 'unknown' or a junk source becomes 'computed' and
 * partial (a lower bound, never exact).
 */
export function cleanCost(rawCost: unknown, rawSource: unknown, rawPartial: unknown, spentTokens: number): { costUsd: number | null; costSource: CostSource; costPartial?: true } {
  const cost = typeof rawCost === 'number' && Number.isFinite(rawCost) && rawCost >= 0 ? rawCost : null
  const valid = COST_SOURCES.includes(rawSource as CostSource)
  const source = rawSource as CostSource
  const partial = rawPartial === true
  if (valid && source === 'none') {
    if (spentTokens <= 0 && (cost === null || cost === 0)) return { costUsd: 0, costSource: 'none' }
    return cost !== null && cost > 0 ? { costUsd: cost, costSource: 'computed', costPartial: true } : { costUsd: null, costSource: 'unknown' }
  }
  // Only a valid 'none' says nothing was spent; junk never reads as $0.
  if (cost === null) return { costUsd: null, costSource: 'unknown' }
  if (!valid || source === 'unknown') return { costUsd: cost, costSource: 'computed', costPartial: true }
  return partial ? { costUsd: cost, costSource: source, costPartial: true } : { costUsd: cost, costSource: source }
}

/**
 * A stored RunUsage made safe for the overview: one malformed record must not break the app-wide view. Numbers become
 * finite and >= 0, tokens objects, models and roles arrays of well-formed entries, costs through cleanCost, skills,
 * knowledge and no-result agents filtered. `fallback` (legacy usage) when the value is not an object.
 */
function cleanStoredUsage(raw: unknown, fallback: () => RunUsage): RunUsage {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback()
  const u = raw as Partial<RunUsage> & Record<string, unknown>
  const tokens = cleanTokens(u.tokens)
  const runCost = cleanCost(u.costUsd, u.costSource, u.costPartial, totalTokens(tokens))
  const models: ModelUsageEntry[] = (Array.isArray(u.models) ? u.models : [])
    .filter((m): m is ModelUsageEntry => !!m && typeof m === 'object' && typeof (m as ModelUsageEntry).model === 'string')
    .map((m) => {
      const e: ModelUsageEntry = {
        model: m.model,
        tokens: cleanTokens(m.tokens),
        costUsd: typeof m.costUsd === 'number' && Number.isFinite(m.costUsd) && m.costUsd >= 0 ? m.costUsd : null,
        priceSource: Object.hasOwn(SOURCE_RANK, m.priceSource) ? m.priceSource : 'unknown'
      }
      if (amount(m.providerCostUsd) > 0) e.providerCostUsd = m.providerCostUsd
      return e
    })
  const roles: RoleUsage[] = (Array.isArray(u.roles) ? u.roles : [])
    .filter((r): r is RoleUsage => !!r && typeof r === 'object' && typeof (r as RoleUsage).roleSlug === 'string')
    .map((r) => {
      const roleTokens = cleanTokens(r.tokens)
      const c = cleanCost(r.costUsd, r.costSource, r.costPartial, totalTokens(roleTokens))
      const out: RoleUsage = {
        roleId: typeof r.roleId === 'string' ? r.roleId : null,
        roleSlug: r.roleSlug,
        roleName: typeof r.roleName === 'string' ? r.roleName : r.roleSlug,
        agents: count(r.agents),
        tokens: roleTokens,
        costUsd: c.costUsd,
        costSource: c.costSource,
        turns: count(r.turns),
        toolCalls: count(r.toolCalls),
        retries: count(r.retries),
        agentWallMs: amount(r.agentWallMs),
        agentsWithoutResult: count(r.agentsWithoutResult),
        noResultTokens: amount(r.noResultTokens),
        models: Array.isArray(r.models) ? r.models.filter((m): m is string => typeof m === 'string') : []
      }
      if (c.costPartial) out.costPartial = true
      return out
    })
  const out: RunUsage = {
    tokens,
    costUsd: runCost.costUsd,
    costSource: runCost.costSource,
    models,
    roles,
    wallMs: amount(u.wallMs),
    turns: count(u.turns),
    toolCalls: count(u.toolCalls),
    retries: count(u.retries),
    agents: count(u.agents),
    agentsWithoutResult: count(u.agentsWithoutResult),
    noResultTokens: amount(u.noResultTokens),
    nudges: count(u.nudges),
    waitingMs: amount(u.waitingMs),
    limitHoldMs: amount(u.limitHoldMs),
    idleMs: amount(u.idleMs),
    updatedAt: amount(u.updatedAt)
  }
  if (runCost.costPartial) out.costPartial = true
  if (out.agentsWithoutResult > 0 && 'noResultCostUsd' in u) {
    const nr = cleanCost(u.noResultCostUsd, u.noResultCostUsd === null ? 'unknown' : 'computed', u.noResultCostPartial, out.noResultTokens)
    out.noResultCostUsd = nr.costUsd
    if (nr.costPartial) out.noResultCostPartial = true
  }
  if (out.agentsWithoutResult > 0 && Array.isArray(u.noResultAgents)) {
    out.noResultAgents = u.noResultAgents
      .filter((a): a is NoResultAgent => !!a && typeof a === 'object' && typeof a.agentId === 'string' && typeof a.name === 'string')
      .slice(0, RUN_NO_RESULT_AGENTS_MAX)
      .map((a) => ({
        agentId: a.agentId,
        name: a.name,
        roleName: typeof a.roleName === 'string' ? a.roleName : a.name,
        tokens: cleanTokens(a.tokens),
        costUsd: typeof a.costUsd === 'number' && Number.isFinite(a.costUsd) && a.costUsd >= 0 ? a.costUsd : null
      }))
  }
  if (u.legacy === true) out.legacy = true
  if (amount(u.providerCostUsd) > 0) out.providerCostUsd = u.providerCostUsd as number
  if (Array.isArray(u.skills)) {
    const skills = u.skills.filter(
      (s): s is SkillUseCount => !!s && typeof s === 'object' && typeof s.skillId === 'string' && typeof s.name === 'string' && Array.isArray(s.roles) && s.roles.every((r) => typeof r === 'string')
    )
    if (skills.length) out.skills = mergeSkillCounts([skills])
  }
  const k = cleanKnowledgeUsage(u.knowledge)
  if (k) out.knowledge = k
  const eff = cleanRunEfficiency(u.efficiency)
  if (eff) out.efficiency = eff
  if (u.connections && typeof u.connections === 'object' && !Array.isArray(u.connections)) out.connections = u.connections
  return out
}

/** RunUsage.connections from untrusted file data: entries with a known-or-null finite cost and a whole agent count >= 0. */
function connectionParts(u: RunUsage): { id: ConnectionId; costUsd: number | null; agents: number; costPartial: boolean }[] | null {
  const c = u.connections
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null
  const out: { id: ConnectionId; costUsd: number | null; agents: number; costPartial: boolean }[] = []
  for (const [id, v] of Object.entries(c)) {
    if (!v || typeof v !== 'object' || !OVERVIEW_ID.test(id)) continue
    const cost = v.costUsd
    out.push({
      id,
      costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
      agents: count(v.agents),
      costPartial: v.costPartial === true
    })
  }
  return out.length ? out : null
}

/** Higher known cost first (unknown last), then the tie-breaker. */
function byCostDesc<T extends { costUsd: number | null }>(tie: (a: T, b: T) => number): (a: T, b: T) => number {
  return (a, b) => {
    const ca = knownCost(a) ?? -1
    const cb = knownCost(b) ?? -1
    return cb !== ca ? cb - ca : tie(a, b)
  }
}

interface ProjectAcc {
  info: UsageOverviewProjectInfo & { removed?: true }
  usages: RunUsage[]
  summaries: RunSummary[]
  connections: Set<ConnectionId>
}

/** A cost the UI can state: non-null and not partial. */
function costKnown(c: { costUsd: number | null; costPartial?: true }): boolean {
  return knownCost(c) !== null && c.costPartial !== true
}

/** UsageCostCoverage over cost-carrying items, one per run. */
function coverage(list: readonly { costUsd: number | null; costPartial?: true }[]): UsageCostCoverage {
  let known = 0
  for (const c of list) if (costKnown(c)) known++
  return { costKnownRuns: known, costUnknownRuns: list.length - known }
}

/**
 * runs:usageOverview over summaries of every project (each with usage filled; a summary without usage reads as
 * legacy). Rollups cover every matched run; only `runs` is cut at the limit. `liveIds` marks rows live. Pure.
 */
export function buildUsageOverview(
  summaries: readonly RunSummary[],
  query: SanitizedUsageOverviewQuery,
  names: UsageOverviewNames,
  now: number,
  liveIds: ReadonlySet<string> = new Set()
): UsageOverview {
  const kinds = new Set(query.kinds)
  const only = query.projectIds ? new Set(query.projectIds) : null
  const picked = summaries
    .filter((s) => Number.isFinite(s.startedAt) && kinds.has(s.kind) && (!only || only.has(s.projectId)))
    .filter((s) => (query.since === undefined || s.startedAt >= query.since) && (query.until === undefined || s.startedAt < query.until))
    .sort((a, b) => b.startedAt - a.startedAt)

  // Project info once per id.
  const infoCache = new Map<string, UsageOverviewProjectInfo & { removed?: true }>()
  const infoOf = (id: string): UsageOverviewProjectInfo & { removed?: true } => {
    let info = infoCache.get(id)
    if (!info) {
      let found: UsageOverviewProjectInfo | null = null
      try {
        found = names.project(id)
      } catch {
        found = null
      }
      info = found ? { name: found.name, kind: found.kind, ...(found.client ? { client: found.client } : {}) } : { name: USAGE_REMOVED_PROJECT_NAME, kind: 'code', removed: true }
      infoCache.set(id, info)
    }
    return info
  }
  const connName = (id: ConnectionId | null): string => {
    if (id === null) return 'Unknown connection'
    try {
      return names.connection(id)
    } catch {
      return 'Removed proxy'
    }
  }

  const usages: RunUsage[] = []
  const projects = new Map<string, ProjectAcc>()
  const models = new Map<string, { m: UsageOverviewModel; priced: boolean; unknown: boolean; projects: Set<string> }>()
  const conns = new Map<string, { connection: ConnectionId | null; runs: number; agents: number; parts: { costUsd: number | null; costSource: CostSource; costPartial?: true }[] }>()
  const points = new Map<number, { label: string; runs: RunUsage[]; byProject: Map<string, RunUsage[]> }>()
  // Per project + role: one cost item per run, for the role's coverage.
  const roleRuns = new Map<string, { costUsd: number | null; costPartial?: true }[]>()
  const roleKey = (projectId: string, r: RoleUsage): string => `${projectId}\u0000${r.roleId ?? r.roleSlug}`
  const rows: UsageOverviewRow[] = []

  for (const s of picked) {
    // Stored usage is file data: cleaned so one malformed record cannot break the app-wide view (review M2).
    const u = cleanStoredUsage(s.usage, () => legacySummaryUsage(s, now))
    usages.push(u)
    const info = infoOf(s.projectId)
    if (rows.length < query.limit) {
      const row: UsageOverviewRow = { ...usageRow(s, now), usage: u, projectId: s.projectId, projectName: info.name, projectKind: info.kind }
      if (info.client) row.client = info.client
      if (info.removed) row.projectRemoved = true
      if (s.connection) row.connection = s.connection
      if (liveIds.has(s.id)) {
        row.live = true
        delete row.endedAt
      }
      if (s.endedBy) row.endedBy = s.endedBy
      if (s.quick) row.quick = s.quick
      if (u.legacy) row.legacy = true
      rows.push(row)
    }
    const seenRoles = new Set<string>()
    for (const r of u.roles) {
      const key = roleKey(s.projectId, r)
      if (seenRoles.has(key)) continue
      seenRoles.add(key)
      const list = roleRuns.get(key)
      if (list) list.push(r)
      else roleRuns.set(key, [r])
    }

    let p = projects.get(s.projectId)
    if (!p) {
      p = { info, usages: [], summaries: [], connections: new Set() }
      projects.set(s.projectId, p)
    }
    p.usages.push(u)
    p.summaries.push(s)

    // Models: one count per run (RunUsage.models is per model already, but stay safe on duplicate entries).
    const seenModels = new Set<string>()
    for (const m of Array.isArray(u.models) ? u.models : []) {
      if (!m || typeof m.model !== 'string') continue
      let g = models.get(m.model)
      if (!g) {
        g = { m: { model: m.model, tokens: emptyTokens(), costUsd: null, priceSource: 'unknown', runs: 0, projects: 0, costKnownRuns: 0, costUnknownRuns: 0 }, priced: false, unknown: false, projects: new Set() }
        models.set(m.model, g)
      }
      g.m.tokens = addTokens(g.m.tokens, m.tokens ?? emptyTokens())
      const c = knownCost(m)
      if (c !== null) {
        g.priced = true
        g.m.costUsd = (g.m.costUsd ?? 0) + c
      } else if (totalTokens(m.tokens ?? emptyTokens()) > 0) g.unknown = true
      if (typeof m.providerCostUsd === 'number' && Number.isFinite(m.providerCostUsd) && m.providerCostUsd > 0) g.m.providerCostUsd = (g.m.providerCostUsd ?? 0) + m.providerCostUsd
      if (SOURCE_RANK[m.priceSource] < SOURCE_RANK[g.m.priceSource]) g.m.priceSource = m.priceSource
      if (!seenModels.has(m.model)) {
        seenModels.add(m.model)
        g.m.runs++
        // A run's share of a model is unknown when it spent tokens on it with no price.
        if (c === null && totalTokens(m.tokens ?? emptyTokens()) > 0) g.m.costUnknownRuns++
        else g.m.costKnownRuns++
      }
      g.projects.add(s.projectId)
    }

    // Connections: split multi-provider runs, else the whole run under its connection.
    const split = connectionParts(u)
    const addConn = (id: ConnectionId | null, agents: number, part: { costUsd: number | null; costSource: CostSource; costPartial?: true }): void => {
      const key = id ?? ''
      let g = conns.get(key)
      if (!g) {
        g = { connection: id, runs: 0, agents: 0, parts: [] }
        conns.set(key, g)
      }
      g.runs++
      g.agents += agents
      g.parts.push(part)
      if (id !== null) p.connections.add(id)
    }
    if (split) {
      // Records saved before RunUsage.connections carried costPartial (review N3): a partial or unknown run whose parts
      // say nothing marks every known part a lower bound, since which connection was short is not recorded.
      const legacyPartial = unknownOrPartial(u) && !split.some((p) => p.costPartial)
      for (const part of split) {
        const source: CostSource = part.costUsd === null ? 'unknown' : u.costSource === 'provider' ? 'provider' : 'computed'
        const partial = part.costUsd !== null && (part.costPartial || legacyPartial)
        addConn(part.id, part.agents, partial ? { costUsd: part.costUsd, costSource: source, costPartial: true } : { costUsd: part.costUsd, costSource: source })
      }
    } else {
      addConn(s.connection ?? null, u.agents, u)
    }
    if (split && s.connection) p.connections.add(s.connection)

    const b = overviewBucketOf(s.startedAt, query.bucket)
    let pt = points.get(b.start)
    if (!pt) {
      pt = { label: b.label, runs: [], byProject: new Map() }
      points.set(b.start, pt)
    }
    pt.runs.push(u)
    const list = pt.byProject.get(s.projectId)
    if (list) list.push(u)
    else pt.byProject.set(s.projectId, [u])
  }

  const sum = (list: readonly RunUsage[], pick: (u: RunUsage) => number): number => list.reduce((n, u) => n + (Number.isFinite(pick(u)) ? pick(u) : 0), 0)

  const projectRows: UsageProjectRollup[] = [...projects.entries()].map(([projectId, p]) => {
    const c = mergeCosts(p.usages)
    const runsByKind: UsageProjectRollup['runsByKind'] = {}
    for (const s of p.summaries) {
      const k = s.kind === 'work' && s.team === 'single' ? 'ask' : s.kind
      runsByKind[k] = (runsByKind[k] ?? 0) + 1
    }
    // Summaries are newest first.
    const starts = { first: p.summaries[p.summaries.length - 1].startedAt, last: p.summaries[0].startedAt }
    // Cost of agents without a result: a run with such agents but no noResultCostUsd (older record) counts as unknown.
    const nr = mergeCosts(
      p.usages
        .filter((u) => u.agentsWithoutResult > 0)
        .map((u) => (u.noResultCostUsd === undefined || u.noResultCostUsd === null ? { costUsd: null, costSource: 'unknown' as const } : { costUsd: u.noResultCostUsd, costSource: 'computed' as const, ...(u.noResultCostPartial ? { costPartial: true as const } : {}) }))
    )
    const out: UsageProjectRollup = {
      ...coverage(p.usages),
      projectId,
      projectName: p.info.name,
      projectKind: p.info.kind,
      runs: p.usages.length,
      runsByKind,
      firstStartedAt: starts.first,
      lastStartedAt: starts.last,
      tokens: p.usages.reduce((acc, u) => addTokens(acc, u.tokens), emptyTokens()),
      costUsd: c.costUsd,
      costSource: c.costSource,
      turns: sum(p.usages, (u) => u.turns),
      toolCalls: sum(p.usages, (u) => u.toolCalls),
      retries: sum(p.usages, (u) => u.retries),
      nudges: sum(p.usages, (u) => u.nudges),
      wallMs: sum(p.usages, (u) => u.wallMs),
      waitingMs: sum(p.usages, (u) => u.waitingMs),
      idleMs: sum(p.usages, (u) => u.idleMs),
      limitHoldMs: sum(p.usages, (u) => u.limitHoldMs),
      agents: sum(p.usages, (u) => u.agents),
      agentsWithoutResult: sum(p.usages, (u) => u.agentsWithoutResult),
      noResultTokens: sum(p.usages, (u) => u.noResultTokens),
      noResultCostUsd: nr.costUsd,
      connections: [...p.connections].sort()
    }
    if (p.info.client) out.client = p.info.client
    if (p.info.removed) out.projectRemoved = true
    if (c.costPartial) out.costPartial = true
    if (nr.costPartial) out.noResultCostPartial = true
    return out
  })
  projectRows.sort(byCostDesc((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens) || a.projectName.localeCompare(b.projectName)))

  const modelRows = [...models.values()]
    .map((g) => {
      const m: UsageOverviewModel = { ...g.m, costUsd: g.priced ? g.m.costUsd : null, projects: g.projects.size }
      if (g.priced && g.unknown) m.costPartial = true
      return m
    })
    .sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens) || a.model.localeCompare(b.model))

  const roleRows: UsageOverviewRole[] = []
  for (const [projectId, p] of projects) {
    for (const r of mergeRoles(p.usages.map((u) => u.roles))) {
      roleRows.push({ ...r, ...coverage(roleRuns.get(roleKey(projectId, r)) ?? []), projectId, projectName: p.info.name })
    }
  }
  roleRows.sort(byCostDesc((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens)))

  const connRows: UsageOverviewConnection[] = [...conns.values()].map((g) => {
    const c = mergeCosts(g.parts)
    const kind = g.connection === null ? null : isBuiltinConnectionId(g.connection) ? 'builtin' : 'proxy'
    const out: UsageOverviewConnection = { connection: g.connection, name: connName(g.connection), kind, runs: g.runs, agents: g.agents, costUsd: c.costUsd, costSource: c.costSource, ...coverage(g.parts) }
    if (c.costPartial) out.costPartial = true
    return out
  })
  connRows.sort(byCostDesc((a, b) => b.agents - a.agents))

  const trend: UsageOverviewTrendPoint[] = [...points.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, g]) => {
      const byProject: UsageTrendProjectSlice[] = [...g.byProject.entries()].map(([projectId, list]) => ({
        projectId,
        runs: list.length,
        tokens: list.reduce((acc, u) => addTokens(acc, u.tokens), emptyTokens()),
        costUsd: sumKnown(list),
        ...coverage(list),
        wallMs: list.reduce((n, u) => n + u.wallMs, 0),
        waitingMs: list.reduce((n, u) => n + u.waitingMs, 0)
      }))
      byProject.sort(byCostDesc((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens)))
      // costUnknownRuns from trendPoint and coverage agree (both: unknown or partial).
      return { ...trendPoint(g.label, start, g.runs), ...coverage(g.runs), byProject }
    })

  const overview: UsageOverview = {
    runs: rows,
    projects: projectRows,
    models: modelRows,
    roles: roleRows,
    connections: connRows,
    trend,
    totals: sumRunUsage(usages, now),
    ...coverage(usages),
    matchedRuns: picked.length,
    query: { ...query, kinds: [...query.kinds], ...(query.projectIds ? { projectIds: [...query.projectIds] } : {}) },
    generatedAt: now
  }
  if (picked.length > query.limit) overview.truncated = true
  if (rows.length) overview.oldestIncludedAt = rows[rows.length - 1]!.startedAt
  return overview
}

// ---------- month range and CSV export ----------

/**
 * A local calendar month as the [since, until) window UsageStatsQuery uses: local midnight of the 1st to local
 * midnight of the next month's 1st. 'YYYY-MM' only, months 01..12, years 2000..2999; anything else throws
 * "Invalid month". Pure.
 */
export function monthRange(month: string): { since: number; until: number } {
  const m = typeof month === 'string' ? /^(2\d{3})-(0[1-9]|1[0-2])$/.exec(month) : null
  if (!m) throw new Error('Invalid month')
  const year = Number(m[1])
  const index = Number(m[2]) - 1
  return { since: new Date(year, index, 1).getTime(), until: new Date(year, index + 1, 1).getTime() }
}

/**
 * One CSV cell: formula-injection guard for strings (a leading tab, CR or LF, or = + - @ and their full-width forms
 * after any leading whitespace gets a leading apostrophe), then RFC 4180 quoting.
 */
function csvCell(value: string | number): string {
  let s = String(value)
  if (typeof value === 'string' && (/^[\t\r\n]/.test(s) || /^[=+\-@＝＋－＠]/.test(s.trimStart()))) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** buildUsageCsv inputs from the caller: names for the project / client columns, and a UTC offset source for tests. */
export interface UsageCsvOptions {
  project?: string
  client?: string
  /** Offset east of UTC in minutes at the instant; default is the process time zone. A parameter so tests need no TZ. */
  offsetMinutes?: (t: number) => number
}

/**
 * runs:usageCsv body: USAGE_CSV_COLUMNS header, then one row per stats.runs entry (already newest first). project and
 * client come from `opts` (blank when missing); started / ended are local time with the UTC offset, started_utc is
 * ISO 8601 UTC (all blank while missing), title falls back to the prompt, roles is the role count, cost is
 * blank when unknown (never 0) and otherwise fixed-point with 6 decimals. RFC 4180 with CRLF line ends, no trailing
 * newline and a leading UTF-8 BOM so spreadsheets read it as UTF-8. When `stats.truncated` the file holds only the
 * returned rows (the newest ones); nothing marks that inside the file. Pure.
 */
export function buildUsageCsv(stats: UsageStats, opts: UsageCsvOptions = {}): string {
  return usageCsvText(stats.runs, () => ({ project: opts.project ?? '', client: opts.client ?? '' }), opts.offsetMinutes)
}

/**
 * runs:usageOverviewCsv body: USAGE_OVERVIEW_CSV_COLUMNS (USAGE_CSV_COLUMNS plus project_kind, connection, retries,
 * nudges, no_result_tokens, idle_ms) with the same quoting, time formats and BOM as buildUsageCsv, one row per
 * overview.runs entry (newest first) with that row's own projectName and client (blank when absent). Pure.
 */
export function buildUsageOverviewCsv(overview: Pick<UsageOverview, 'runs'>, opts: Pick<UsageCsvOptions, 'offsetMinutes'> = {}): string {
  return usageCsvText(overview.runs, (r) => ({ project: r.projectName, client: r.client ?? '' }), opts.offsetMinutes, {
    columns: USAGE_OVERVIEW_CSV_COLUMNS,
    cells: (r) => [r.projectKind, r.connection ?? '', r.usage.retries, r.usage.nudges, r.usage.noResultTokens, Math.round(r.usage.idleMs)]
  })
}

function usageCsvText<R extends RunUsageRow>(
  rows: readonly R[],
  names: (r: R) => { project: string; client: string },
  offsetMinutes?: (t: number) => number,
  extra?: { columns: readonly string[]; cells: (r: R) => (string | number)[] }
): string {
  const offsetOf = offsetMinutes ??((t: number) => -new Date(t).getTimezoneOffset())
  const valid = (t: number | undefined): t is number => typeof t === 'number' && Number.isFinite(t) && Math.abs(t) <= 8.64e15
  const utc = (t: number | undefined): string => (valid(t) ? new Date(t).toISOString() : '')
  const local = (t: number | undefined): string => {
    if (!valid(t)) return ''
    const off = offsetOf(t)
    const mins = Number.isFinite(off) ? Math.trunc(off) : 0
    const shifted = new Date(t + mins * 60000)
    if (Number.isNaN(shifted.getTime())) return ''
    const abs = Math.abs(mins)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${shifted.toISOString().slice(0, 19)}${mins < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  }
  const lines: string[] = [(extra ? extra.columns : USAGE_CSV_COLUMNS).join(',')]
  for (const r of rows) {
    const u = r.usage
    const n = names(r)
    const cells: (string | number)[] = [
      n.project,
      n.client,
      local(r.startedAt),
      utc(r.startedAt),
      local(r.endedAt),
      r.team === 'single' && r.kind === 'work' ? 'ask' : r.kind,
      r.status,
      r.title || r.prompt || '',
      u.roles.length,
      u.tokens.input,
      u.tokens.output,
      u.tokens.cacheRead,
      u.tokens.cacheWrite,
      u.costUsd === null || !Number.isFinite(u.costUsd) ? '' : u.costUsd.toFixed(6),
      u.costPartial ? 'true' : '',
      ...(extra ? extra.cells(r) : [])
    ]
    lines.push(cells.map(csvCell).join(','))
  }
  return '﻿' + lines.join('\r\n')
}
