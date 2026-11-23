/**
 * The cost and time estimate for a run about to start. The runtime contract (ov-runtime) is not wired yet, so this hook
 * answers `unknown` for every project: the page shows that honestly and no number is ever invented. When the runtime
 * API lands, only this file changes: return `ready` with the range it gives.
 */
export type RunEstimateMode = 'team' | 'ask'

export type RunEstimate =
  | { state: 'unknown' }
  | { state: 'ready'; cost: { lowUsd: number; highUsd: number }; minutes: { low: number; high: number } }

export function useRunEstimate(_projectId: string, _mode: RunEstimateMode): RunEstimate {
  return { state: 'unknown' }
}

/** What the estimate tiles say while no estimate exists. */
export const ESTIMATE_UNKNOWN_TEXT = 'Unknown until this project has finished runs'

const usd = (n: number): string => (n < 1 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`)

export function costText(e: RunEstimate): string {
  return e.state === 'ready' ? `${usd(e.cost.lowUsd)} to ${usd(e.cost.highUsd)}` : 'Unknown'
}

export function timeText(e: RunEstimate): string {
  return e.state === 'ready' ? `${e.minutes.low} to ${e.minutes.high} min` : 'Unknown'
}
