import type { AgentInstance, AgentUsage, CostSource, ModelUsageEntry, PriceSource, RoleUsage, RunRecord, RunSummary, RunUsage, SkillUseCount, TokenUsage, UsageStats, UsageStatsQuery, UsageTrendPoint } from '@shared/types'
import { agentProducedNothing, emptyTokens, totalTokens } from '@shared/defaults'
import { USAGE_CSV_COLUMNS, USAGE_STATS_DEFAULT_LIMIT, USAGE_STATS_MAX_LIMIT } from '@shared/types'

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
    }
  })
  const roles: RoleUsage[] = [...roleMap.values()].map((g) => {
    const c = mergeCosts(g.parts)
    const r: RoleUsage = { ...g.role, costUsd: c.costUsd, costSource: c.costSource, models: [...g.models] }
    if (c.costPartial) r.costPartial = true
    return r
  })

  const cost = mergeCosts(usages)
  const provider = inputs.providerTotalUsd
  const hasProvider = provider !== undefined && Number.isFinite(provider) && provider > 0
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
  if (hasProvider) usage.providerCostUsd = provider
  if (legacy) usage.legacy = true
  const skills = mergeSkillCounts([inputs.skills ?? []])
  if (skills.length) usage.skills = skills
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

/** Fill AgentInstance.usage and RunSummary.usage on a record saved before usage tracking (legacy: true). Idempotent. */
export function normalizeRunRecord(record: RunRecord, now: number = Date.now()): RunRecord {
  let changed = false
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
    const base = computeRunUsage(summary, Object.values(agents), { nudges: record.plan?.autoContinues ?? 0, waitingMs: 0, limitHoldMs: 0, idleMs: 0, now: summary.endedAt ?? now })
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
  const pc = sum((u) => u.providerCostUsd ?? 0)
  if (pc > 0 && Number.isFinite(pc)) total.providerCostUsd = pc
  return total
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
  const runs = picked.slice(0, limit).map((s) => {
    const row: UsageStats['runs'][number] = { runId: s.id, kind: s.kind, status: s.status, prompt: oneLine(s.prompt, 120), startedAt: s.startedAt, usage: s.usage ?? legacySummaryUsage(s, now) }
    if (s.title) row.title = s.title
    if (s.team === 'single') row.team = 'single'
    if (s.endedAt !== undefined) row.endedAt = s.endedAt
    if (s.resumedFrom) row.resumedFrom = s.resumedFrom
    return row
  })

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
  const trend: UsageTrendPoint[] = [...points.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, g]) => {
      const known = g.runs.filter((u) => u.costUsd !== null)
      const sum = (pick: (u: RunUsage) => number): number => g.runs.reduce((n, u) => n + pick(u), 0)
      return {
        bucket: g.label,
        start,
        runs: g.runs.length,
        tokens: g.runs.reduce((acc, u) => addTokens(acc, u.tokens), emptyTokens()),
        costUsd: known.length > 0 ? known.reduce((n, u) => n + (Number.isFinite(u.costUsd) ? (u.costUsd ?? 0) : 0), 0) : null,
        costUnknownRuns: g.runs.filter((u) => u.costSource === 'unknown' || u.costPartial).length,
        turns: sum((u) => u.turns),
        toolCalls: sum((u) => u.toolCalls),
        nudges: sum((u) => u.nudges),
        retries: sum((u) => u.retries),
        wallMs: sum((u) => u.wallMs),
        waitingMs: sum((u) => u.waitingMs),
        noResultTokens: sum((u) => u.noResultTokens)
      }
    })

  const totals = sumRunUsage(runs.map((r) => r.usage), now)
  const stats: UsageStats = { projectId: query.projectId, runs, roles: totals.roles as UsageStats['roles'], trend, totals, generatedAt: now }
  if (truncated) stats.truncated = true
  return stats
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
  const offsetOf = opts.offsetMinutes ?? ((t: number) => -new Date(t).getTimezoneOffset())
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
  const lines: string[] = [USAGE_CSV_COLUMNS.join(',')]
  for (const r of stats.runs) {
    const u = r.usage
    const cells: (string | number)[] = [
      opts.project ?? '',
      opts.client ?? '',
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
      u.costPartial ? 'true' : ''
    ]
    lines.push(cells.map(csvCell).join(','))
  }
  return '﻿' + lines.join('\r\n')
}
