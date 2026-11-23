import { RUN_ESTIMATE_MAX_SAMPLES, RUN_ESTIMATE_MIN_SAMPLES, RUN_ESTIMATE_WINDOW_DAYS } from '../../shared/types'
import type { EstimateRange, RunEstimate, RunEstimateQuery, RunSummary } from '../../shared/types'

/**
 * The one rule for "this run's cost is known": the run's usage carries a finite cost from a real source ('provider' or
 * 'computed'). Unknown / unpriced runs, runs without usage and a bare totalCostUsd of 0 are unknown (null), never 0.
 * Used by the estimate, the project spend and the schedule costs.
 */
export function knownRunCostUsd(run: Pick<RunSummary, 'usage'>): number | null {
  const u = run.usage
  if (!u) return null
  if (u.costSource !== 'provider' && u.costSource !== 'computed') return null
  return typeof u.costUsd === 'number' && Number.isFinite(u.costUsd) && u.costUsd >= 0 ? u.costUsd : null
}

/** Percentile (0..1) of an ascending list by linear interpolation. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * p
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/** 25th / 50th / 75th percentile with 5 or more values, else min / median / max. */
export function rangeOf(values: readonly number[]): EstimateRange {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length >= 5) return { low: percentile(sorted, 0.25), median: percentile(sorted, 0.5), high: percentile(sorted, 0.75) }
  return { low: sorted[0], median: percentile(sorted, 0.5), high: sorted[sorted.length - 1] }
}

const DAY_MS = 86_400_000

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size !== sb.size) return false
  for (const x of sa) if (!sb.has(x)) return false
  return true
}

/**
 * UI overhaul (runInsights.estimate): cost and time of a prospective run from this project's comparable recorded runs.
 * Pure. Comparable = finished work runs of the project (not Chat), started the same way (team or single), inside the
 * window, with a known cost and an end time. Minutes are wall-clock time from start to end.
 */
export function estimateRun(runs: readonly RunSummary[], query: RunEstimateQuery, now: number): RunEstimate {
  const single = query.team === 'single'
  const since = now - RUN_ESTIMATE_WINDOW_DAYS * DAY_MS
  let comparable = runs
    .filter(
      (r) =>
        r.kind === 'work' &&
        r.status === 'finished' &&
        !r.quick &&
        (r.team === 'single') === single &&
        r.startedAt >= since &&
        typeof r.endedAt === 'number' &&
        r.endedAt >= r.startedAt &&
        knownRunCostUsd(r) !== null
    )
    .sort((a, b) => b.startedAt - a.startedAt)
  let note: string | null = null
  const exclude = query.excludeRoleIds
  if (exclude && exclude.length > 0) {
    const same = comparable.filter((r) => sameSet(r.excludedRoleIds ?? [], exclude))
    if (same.length >= RUN_ESTIMATE_MIN_SAMPLES) {
      comparable = same
      note = 'with the same roles left out'
    } else note = 'including runs with other roles left out, as too few match yours'
  }
  comparable = comparable.slice(0, RUN_ESTIMATE_MAX_SAMPLES)
  if (comparable.length < RUN_ESTIMATE_MIN_SAMPLES) {
    return {
      basis: 'none',
      sampleRuns: comparable.length,
      costUsd: null,
      minutes: null,
      note: 'Not enough finished runs of this kind with a known cost to estimate yet.'
    }
  }
  const costs = comparable.map((r) => knownRunCostUsd(r) as number)
  const minutes = comparable.map((r) => ((r.endedAt as number) - r.startedAt) / 60_000)
  const n = comparable.length
  const text = `From your last ${n} similar run${n === 1 ? '' : 's'}${note ? `, ${note}` : ''}. Time is wall-clock time.`
  return { basis: 'history', sampleRuns: n, costUsd: rangeOf(costs), minutes: rangeOf(minutes), note: text }
}
