/**
 * Pure presentation logic of the Usage page shared by the renderer and the CLI (`orgai usage show --overview`): cost
 * and time words, "runs worth a look", cost by tier and lead-alone against runs with reports. Rows in, plain strings
 * and numbers out. Unknown cost is null and never $0.
 */
import type { ModelTier, TokenUsage, UsageOverviewRow } from '../types'
import { MODEL_TIERS } from '../types'
import { totalTokens } from '../defaults'
import { costView, type CostInput } from './cost'

export type WastefulSort = 'no-result' | 'cost' | 'cache' | 'retries' | 'nudges' | 'idle'
export type UsageKind = 'work' | 'setup' | 'ask' | 'chat' | 'assistants'

/** The page kind of a row. Chat wins over Ask: a Chat is a single-agent conversation by default. */
export function usageKindOf(row: Pick<UsageOverviewRow, 'kind' | 'team' | 'quick' | 'projectId'>): UsageKind {
  if (row.kind === 'setup') return 'setup'
  if (row.kind === 'mcp-assist' || row.kind === 'skill-assist') return 'assistants'
  if (row.quick || row.projectId === 'quick') return 'chat'
  return row.team === 'single' ? 'ask' : 'work'
}

const CACHE_MIN_INPUT_TOKENS = 20_000
const cacheReportedBy = (t: TokenUsage): boolean => t.cacheRead + t.cacheWrite > 0
const promptTokens = (t: TokenUsage): number => t.input + t.cacheRead + t.cacheWrite
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

export const isLegacyRow = (r: Pick<UsageOverviewRow, 'legacy' | 'usage'>): boolean => !!(r.legacy || r.usage.legacy)

/** Known cost of a row: priced, complete, and something was spent. Partial and unknown are left out. */
export function knownCost(r: UsageOverviewRow): number | null {
  const u = r.usage
  if (u.costUsd === null || u.costPartial || u.costSource === 'unknown') return null
  return totalTokens(u.tokens) > 0 ? u.costUsd : null
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/** A page-precision cost string (the same words as <Cost precision="page" />). */
export function pageCost(usd: number | null, partial = false): string {
  if (usd === null) return 'unknown'
  return costView({ costUsd: usd, costSource: 'computed', sourceMixed: true, ...(partial ? { costPartial: true as const } : {}) } as CostInput, { precision: 'page' }).text
}

/** 0-1 as "41%"; a real but tiny share reads "<1%", never 0%. */
export function percentText(fraction: number): string {
  if (!Number.isFinite(fraction)) return '—'
  const p = fraction * 100
  if (p > 0 && p < 1) return '<1%'
  return `${Math.round(p)}%`
}

/** "45 s", "12 min", "1 h 20 min". */
export function minutesText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString()} ${n === 1 ? one : many}`

// ---------- runs worth a look (6.6) ----------

/** The sort in force: "cost with no result" needs noResultCostUsd on some row, else Most expensive (6.6). */
export function effectiveWastefulSort(sort: WastefulSort, rows: readonly UsageOverviewRow[]): WastefulSort {
  if (sort !== 'no-result') return sort
  return rows.some((r) => r.usage.noResultCostUsd !== undefined) ? sort : 'cost'
}

export interface WastefulEntry {
  row: UsageOverviewRow
  /** The run's cost is not known (it sorts after the known ones, by tokens). */
  unknownCost: boolean
  /** The run has agents that returned nothing. */
  noResult: boolean
  /** The plain sentence for the active sort. */
  why: string
}

const WHY_NAMES_MAX = 1

/** "implementer-2 spent 820 tokens and produced no result" / "implementer-2 and 1 other spent 1,640 tokens ...". */
export function noResultSentence(row: Pick<UsageOverviewRow, 'usage'>): string {
  const u = row.usage
  const n = u.agentsWithoutResult
  const tokens = `${u.noResultTokens.toLocaleString()} ${u.noResultTokens === 1 ? 'token' : 'tokens'}`
  const names = (u.noResultAgents ?? []).map((a) => a.name)
  if (n <= 0) return 'No agent finished without a result.'
  if (names.length === 0) return `${plural(n, 'agent')} produced no result and spent ${tokens}.`
  const first = names.slice(0, WHY_NAMES_MAX).join(', ')
  const others = n - Math.min(names.length, WHY_NAMES_MAX)
  const who = others > 0 ? `${first} and ${others} other${others === 1 ? '' : 's'}` : first
  return `${who} spent ${tokens} and produced no result`
}

interface Scored {
  row: UsageOverviewRow
  /** Higher sorts first. null = unknown cost (sorts after, by `tie`). */
  score: number | null
  tie: number
  unknownCost: boolean
  why: string
}

function noResultScore(r: UsageOverviewRow): Scored | null {
  const u = r.usage
  const failed = r.status === 'error'
  const noResult = u.agentsWithoutResult > 0
  if (!failed && !noResult) return null
  // A failed run counts its whole cost; its no-result agents are inside it, so they are not added again.
  let usd: number | null
  let tie: number
  if (failed) {
    usd = u.costUsd === null || u.costSource === 'unknown' ? null : u.costUsd
    tie = totalTokens(u.tokens)
  } else {
    usd = u.noResultCostUsd === undefined || u.noResultCostUsd === null ? null : u.noResultCostUsd
    tie = u.noResultTokens
  }
  if (usd !== null && usd <= 0 && tie <= 0) return null
  const why = noResult ? `${noResultSentence(r)}${failed ? '; the run failed' : ''}` : 'The run failed'
  return { row: r, score: usd, tie, unknownCost: usd === null, why }
}

/** Cells carry short phrases without a closing full stop ("Retried 2 times"). */
function phrase(s: string): string {
  return s.replace(/\.+$/, '')
}

/**
 * The runs worth a look, best first, for a sort. Rows with unknown cost sort after known ones by tokens. The sort must
 * already be effective (`effectiveWastefulSort`).
 */
export function wastefulRuns(rows: readonly UsageOverviewRow[], sort: WastefulSort): WastefulEntry[] {
  const scored: Scored[] = []
  for (const r of rows) {
    const u = r.usage
    let s: Scored | null = null
    const tokens = totalTokens(u.tokens)
    switch (sort) {
      case 'no-result':
        s = noResultScore(r)
        break
      case 'cost': {
        if (tokens <= 0) break
        const known = u.costUsd !== null && u.costSource !== 'unknown'
        s = { row: r, score: known ? u.costUsd : null, tie: tokens, unknownCost: !known, why: known ? `Estimated ${pageCost(u.costUsd, !!u.costPartial)}.` : `Cost unknown; ${tokens.toLocaleString()} tokens.` }
        break
      }
      case 'cache': {
        if (isLegacyRow(r) || promptTokens(u.tokens) < CACHE_MIN_INPUT_TOKENS || !cacheReportedBy(u.tokens)) break
        const rate = u.tokens.cacheRead / promptTokens(u.tokens)
        s = { row: r, score: 1 - rate, tie: promptTokens(u.tokens), unknownCost: false, why: `Cache hit ${percentText(rate)}.` }
        break
      }
      case 'retries':
        if (u.retries > 0) s = { row: r, score: u.retries, tie: u.turns, unknownCost: false, why: u.retries === 1 ? 'Retried once.' : `Retried ${u.retries} times.` }
        break
      case 'nudges':
        if (u.nudges > 0) s = { row: r, score: u.nudges, tie: u.turns, unknownCost: false, why: u.nudges === 1 ? 'Auto-continued once.' : `Auto-continued ${u.nudges} times.` }
        break
      case 'idle': {
        if (isLegacyRow(r) || u.wallMs <= 0 || u.idleMs <= 0) break
        const share = u.idleMs / u.wallMs
        const waited = u.waitingMs >= 60_000 ? `; waited on you ${minutesText(u.waitingMs)}` : ''
        s = { row: r, score: share, tie: u.idleMs, unknownCost: false, why: `Idle ${minutesText(u.idleMs)}, ${percentText(share)} of its time${waited}` }
        break
      }
    }
    if (s) scored.push(s)
  }
  scored.sort((a, b) => {
    if ((a.score === null) !== (b.score === null)) return a.score === null ? 1 : -1
    if (a.score !== null && b.score !== null && a.score !== b.score) return b.score - a.score
    return b.tie - a.tie || b.row.startedAt - a.row.startedAt
  })
  return scored.map((s) => ({ row: s.row, unknownCost: s.unknownCost, noResult: s.row.usage.agentsWithoutResult > 0, why: phrase(s.why) }))
}


// ---------- cost by tier ----------

export type TierKey = ModelTier | 'other'

export interface TierPart {
  key: TierKey
  /** Plain label: "Top", "Deep", "Everyday", "Fast" or the remainder. */
  label: string
  costUsd: number
  /** Share of the total, 0..1. */
  share: number
}

export const OTHER_TIER_LABEL = 'Not tied to a tier'
const TIER_LABELS: Record<ModelTier, string> = { top: 'Top', deep: 'Deep', everyday: 'Everyday', fast: 'Fast' }
export const tierLabel = (k: TierKey): string => (k === 'other' ? OTHER_TIER_LABEL : TIER_LABELS[k])

/** Which tier a model stands for on a connection, or undefined. */
export type TierOf = (model: string, connection: string | undefined) => ModelTier | undefined

/**
 * The period's cost split by tier. Each priced model entry of each run goes to `tierOf(model, run connection)`; what is
 * left of `total` (models with no tier, unpriced entries, a provider total that differs from the model sum) is the
 * remainder, so the parts always add up to `total`. When the model parts exceed `total` (never expected) they are scaled
 * down to it. `model` narrows to one model's entries (the page's Model chip). null when `total` is unknown or zero.
 */
export function costByTier(rows: readonly UsageOverviewRow[], total: number | null, tierOf: TierOf, model: string | null = null): TierPart[] | null {
  if (total === null || !(total > 0)) return null
  const sums = new Map<ModelTier, number>()
  for (const r of rows) {
    for (const m of r.usage.models) {
      if (model && m.model !== model) continue
      if (m.costUsd === null || m.priceSource === 'unknown' || !(m.costUsd > 0)) continue
      const t = tierOf(m.model, r.connection)
      if (t) sums.set(t, (sums.get(t) ?? 0) + m.costUsd)
    }
  }
  let attributed = 0
  for (const v of sums.values()) attributed += v
  const scale = attributed > total ? total / attributed : 1
  const parts: TierPart[] = []
  let used = 0
  for (const t of MODEL_TIERS) {
    const v = (sums.get(t) ?? 0) * scale
    if (v <= 0) continue
    used += v
    parts.push({ key: t, label: tierLabel(t), costUsd: v, share: v / total })
  }
  const rest = Math.max(0, total - used)
  // Anything under a hundredth of a cent of rounding noise is not a remainder.
  if (rest > total * 1e-9 && rest > 1e-6) parts.push({ key: 'other', label: OTHER_TIER_LABEL, costUsd: rest, share: rest / total })
  return parts
}

// ---------- lead alone vs with reports ----------

export interface GroupStats {
  runs: number
  /** Median wall time, ms; null without runs. */
  medianWallMs: number | null
  /** Median cost over the runs with a known cost; null without any. */
  medianCostUsd: number | null
  costKnownRuns: number
}

export interface LeadComparison {
  alone: GroupStats
  withReports: GroupStats
}

function stats(rows: readonly UsageOverviewRow[]): GroupStats {
  const costs = rows.map(knownCost).filter((c): c is number => c !== null)
  return {
    runs: rows.length,
    medianWallMs: median(rows.map((r) => r.usage.wallMs).filter((w) => finite(w) && w >= 0)),
    medianCostUsd: median(costs),
    costKnownRuns: costs.length
  }
}

/**
 * Team work runs only. "With reports": the run spawned at least one direct report. "Lead alone": no efficiency record and
 * the run has one agent. A run with several agents but no efficiency record predates the field, so it is in neither group.
 */
export function leadComparison(rows: readonly UsageOverviewRow[]): LeadComparison {
  const alone: UsageOverviewRow[] = []
  const withReports: UsageOverviewRow[] = []
  for (const r of rows) {
    if (isLegacyRow(r) || usageKindOf(r) !== 'work') continue
    if (r.usage.efficiency && r.usage.efficiency.reports > 0) withReports.push(r)
    else if (!r.usage.efficiency && r.usage.agents <= 1) alone.push(r)
  }
  return { alone: stats(alone), withReports: stats(withReports) }
}

// ---------- tier of a model ----------

/** What the resolver needs of a connection: its tier mapping. */
export interface TierConnection {
  id: string
  tierModels: Partial<Record<ModelTier, string>>
}

/**
 * Resolver for costByTier: a model that is a connection's mapped tier model is that tier; otherwise a Claude alias or
 * full Claude id names its own tier (tierForModel); anything else has none.
 */
export function makeTierOf(connections: readonly TierConnection[], fallback: (model: string) => ModelTier | undefined): TierOf {
  const byId = new Map(connections.map((c) => [c.id, c.tierModels]))
  return (model, connection) => {
    const maps = connection !== undefined && byId.has(connection) ? [byId.get(connection)!] : []
    for (const map of maps) for (const t of MODEL_TIERS) if (map[t]?.trim() === model) return t
    return fallback(model)
  }
}
