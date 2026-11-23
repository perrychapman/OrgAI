import type { ProjectSpendPeriod } from '@shared/types'
import { formatUsdCompact } from '../../lib/cost'

/**
 * Words for the Spending limits rows. Money uses the app's compact rule (formatUsdCompact: two decimals, "<$0.01" above
 * zero and below a cent), so "$0.05581" never shows. Unknown cost is said, never counted as $0 (spendGuard.ts counts only
 * runs with a known price; the rest are named).
 */

/** "Spent so far: $1.20." for a period; runs without a known price are said, never counted as $0. */
export function spentText(p: ProjectSpendPeriod | undefined, failed: boolean): string {
  if (failed) return 'Spent so far is not available.'
  if (!p) return 'Measuring spent so far…'
  const n = p.unknownRuns
  const unknown = n > 0 ? ` ${n} ${n === 1 ? 'run has' : 'runs have'} no known price and ${n === 1 ? 'is' : 'are'} not counted.` : ''
  if (p.spentUsd <= 0 && n > 0) return `Spent so far: unknown.${unknown}`
  return `Spent so far: ${n > 0 ? 'at least ' : ''}${formatUsdCompact(p.spentUsd)}.${unknown}`
}

/**
 * What is true right now when the spend has already reached the cap (main refuses new runs and pauses or stops live ones
 * on the next check; saving a lower cap changes nothing else). Empty when under the cap or unknown.
 */
export function reachedText(p: ProjectSpendPeriod | undefined, cap: number | undefined, word: 'day' | 'month', mode: 'pause' | 'stop'): string {
  if (!p || cap === undefined || !(cap > 0) || p.spentUsd < cap) return ''
  return `Already reached: new runs will not start until the ${word} ends or you raise it, and a live run will ${mode === 'stop' ? 'stop' : 'pause'}.`
}
