/**
 * Team timing, cost by tier and lead-alone vs reports for the Usage page (docs/design/orchestration-efficiency.md 4.7).
 * Pure: rows in, numbers out. Unknown cost is null and never $0.
 *
 * Staffing assignments (RunRecord.staffing) and per-agent usage do not reach the renderer: a UsageOverviewRow carries
 * only the run's RunUsage (per model, per role). Cost by tier therefore attributes each MODEL's cost to the tier that
 * model stands for on the run's connection, and everything else goes in one remainder.
 */
import type { ModelTier, UsageOverviewRow } from '@shared/types'
import { MODEL_TIERS } from '@shared/types'
import { isLegacyRow, knownCost, median } from './usageEfficiency'
import { usageKindOf } from './usageOverview'

// ---------- time to first spawn, overlap, tail ----------

export interface ReportTiming {
  runId: string
  firstSpawnMs: number
  /** reportSumMs / reportBusyMs; null when the busy time is not positive. 1 = reports ran one after another. */
  overlap: number | null
  /** tailMs / wallMs, 0..1; null when the wall time is not positive. */
  tailShare: number | null
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/** One run's timing, or null when it spawned no report (no efficiency record, or `reports` is 0). */
export function reportTiming(row: Pick<UsageOverviewRow, 'runId' | 'usage'>): ReportTiming | null {
  const e = row.usage.efficiency
  if (!e || !(e.reports > 0)) return null
  const wall = row.usage.wallMs
  return {
    runId: row.runId,
    firstSpawnMs: finite(e.firstSpawnMs) ? Math.max(0, e.firstSpawnMs) : 0,
    overlap: finite(e.reportBusyMs) && e.reportBusyMs > 0 && finite(e.reportSumMs) ? Math.max(1, e.reportSumMs / e.reportBusyMs) : null,
    tailShare: finite(wall) && wall > 0 && finite(e.tailMs) ? Math.max(0, Math.min(1, e.tailMs / wall)) : null
  }
}

export interface ReportTimingSummary {
  /** Runs that spawned at least one report. */
  runs: number
  firstSpawnMs: number | null
  overlap: number | null
  tailShare: number | null
}

/** Medians over the runs that spawned a report; a signal a run cannot give (zero busy time, no wall time) is left out of its median. */
export function reportTimingSummary(rows: readonly UsageOverviewRow[]): ReportTimingSummary {
  const t = rows.map(reportTiming).filter((x): x is ReportTiming => x !== null)
  const pick = (f: (x: ReportTiming) => number | null): number | null => median(t.map(f).filter((v): v is number => v !== null))
  return { runs: t.length, firstSpawnMs: pick((x) => x.firstSpawnMs), overlap: pick((x) => x.overlap), tailShare: pick((x) => x.tailShare) }
}

/** "1.8x". */
export function overlapText(ratio: number | null): string {
  return ratio === null || !Number.isFinite(ratio) ? '—' : `${ratio.toFixed(1)}x`
}

export const TIMING_DEFINITIONS = {
  firstSpawn: 'How long the lead worked before it handed anything to a report. Shorter means the team started sooner.',
  overlap: 'How many reports were working at the same moment, on average. 1.0x means they ran one after another; higher means they worked side by side.',
  tail: 'The share of the run that came after the first group of reports finished: the lead alone, or later reports, finishing up.'
} as const

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
