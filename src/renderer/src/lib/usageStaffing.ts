/**
 * Team timing, cost by tier and lead-alone vs reports for the Usage page (docs/design/orchestration-efficiency.md 4.7).
 * Pure: rows in, numbers out. Unknown cost is null and never $0.
 *
 * Staffing assignments (RunRecord.staffing) and per-agent usage do not reach the renderer: a UsageOverviewRow carries
 * only the run's RunUsage (per model, per role). Cost by tier therefore attributes each MODEL's cost to the tier that
 * model stands for on the run's connection, and everything else goes in one remainder.
 */
import type { UsageOverviewRow } from '@shared/types'
import { median } from './usageEfficiency'

// ---------- time to first spawn, overlap, tail ----------

export interface ReportTiming {
  runId: string
  firstSpawnMs: number
  /** reportSumMs / reportBusyMs; null when the busy time is not positive. 1 = reports ran one after another. */
  overlap: number | null
  /** tailMs / wallMs, 0..1; null when the wall time is not positive. */
  tailShare: number | null
  /** afterLastReportMs / wallMs, 0..1; null when unknown (older runs) or the wall time is not positive. */
  afterLastShare: number | null
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
    tailShare: finite(wall) && wall > 0 && finite(e.tailMs) ? Math.max(0, Math.min(1, e.tailMs / wall)) : null,
    afterLastShare: finite(wall) && wall > 0 && finite(e.afterLastReportMs) ? Math.max(0, Math.min(1, e.afterLastReportMs / wall)) : null
  }
}

export interface ReportTimingSummary {
  /** Runs that spawned at least one report. */
  runs: number
  firstSpawnMs: number | null
  overlap: number | null
  tailShare: number | null
  afterLastShare: number | null
}

/** Medians over the runs that spawned a report; a signal a run cannot give (zero busy time, no wall time) is left out of its median. */
export function reportTimingSummary(rows: readonly UsageOverviewRow[]): ReportTimingSummary {
  const t = rows.map(reportTiming).filter((x): x is ReportTiming => x !== null)
  const pick = (f: (x: ReportTiming) => number | null): number | null => median(t.map(f).filter((v): v is number => v !== null))
  return { runs: t.length, firstSpawnMs: pick((x) => x.firstSpawnMs), overlap: pick((x) => x.overlap), tailShare: pick((x) => x.tailShare), afterLastShare: pick((x) => x.afterLastShare) }
}

/** "1.8x". */
export function overlapText(ratio: number | null): string {
  return ratio === null || !Number.isFinite(ratio) ? '—' : `${ratio.toFixed(1)}x`
}

export const TIMING_DEFINITIONS = {
  firstSpawn: 'How long the lead worked before it handed anything to a report. Shorter means the team started sooner.',
  overlap: 'How many reports were working at the same moment, on average. 1.0x means they ran one after another; higher means they worked side by side.',
  tail: 'The share of the run that came after the first group of reports finished: the lead alone, or later reports, finishing up.',
  afterLast: 'The share of the run that came after the last report finished: the lead handing over and wrapping up.'
} as const

// Cost by tier, lead against reports and the tier resolver are shared with the CLI (src/shared/view/usageInsights.ts).
export { OTHER_TIER_LABEL, costByTier, leadComparison, makeTierOf, tierLabel } from '@shared/view/usageInsights'
export type { GroupStats, LeadComparison, TierConnection, TierKey, TierOf, TierPart } from '@shared/view/usageInsights'
