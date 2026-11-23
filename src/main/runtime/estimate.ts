import type { RunEstimate, RunEstimateQuery, RunSummary } from '../../shared/types'

/**
 * UI overhaul (runInsights.estimate): cost and time of a prospective run from this project's comparable recorded runs.
 * Pure. CONTRACT STUB: implemented by a Runtime Engineer (see docs/design/ui-overhaul/impl-runtime.md).
 */
export function estimateRun(runs: readonly RunSummary[], query: RunEstimateQuery, now: number): RunEstimate {
  void runs
  void query
  void now
  return { basis: 'none', sampleRuns: 0, costUsd: null, minutes: null, note: 'Not enough finished runs of this kind yet to estimate.' }
}
