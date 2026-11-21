/**
 * Figure motion for the Dashboard and Usage redesign (docs/design/dashboard-usage-redesign/project/motion.md "Draw" and
 * "Live updates"). Pure; `useCountUp` drives it from one requestAnimationFrame loop.
 *
 * - On page arrival a known figure counts up from zero over `--dur-draw`.
 * - Later, a figure that changes tweens from the old value to the new over `--dur-slow`; a change under 1% snaps.
 * - Unknown (null) never counts up and is never tweened from: it shows at once, and so does the first known value after it.
 * - Reduced motion and Pause motion show the final value.
 */

import { TWEEN_MIN_CHANGE } from './tween'

export interface CountPlan {
  from: number
  to: number
  /** Which duration token drives it. */
  token: '--dur-draw' | '--dur-slow'
}

export function countPlan(prev: number | null, next: number | null, arriving: boolean): CountPlan | null {
  if (next === null || !Number.isFinite(next)) return null
  if (arriving) return next === 0 ? null : { from: 0, to: next, token: '--dur-draw' }
  if (prev === null || !Number.isFinite(prev) || prev === next) return null
  const base = Math.max(Math.abs(prev), Math.abs(next))
  if (base === 0 || Math.abs(next - prev) / base < TWEEN_MIN_CHANGE) return null
  return { from: prev, to: next, token: '--dur-slow' }
}
