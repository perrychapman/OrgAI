import { useEffect, useState } from 'react'
import type { EstimateRange, RunEstimate as RuntimeEstimate } from '@shared/types'
import { formatUsdCompact } from '@shared/view/cost'

/**
 * The cost and time estimate for a run about to start, from the runtime (`runInsights.estimate`): the middle of
 * comparable recorded runs with the low and high of their spread. With no basis, an error or a missing answer the page
 * says "Unknown" (plus the sentence main wrote when there is one); a number is never made up.
 */
export type RunEstimateMode = 'team' | 'ask'

export type RunEstimate =
  | { state: 'loading' }
  | { state: 'unknown'; note: string }
  | { state: 'ready'; cost: EstimateRange | null; minutes: EstimateRange | null; sampleRuns: number; note: string }

/** What the tiles say when the runtime gave no sentence (an error, or no bridge). */
export const ESTIMATE_UNKNOWN_TEXT = 'Unknown until this project has finished runs'

/** Wait this long after the last change (a role checked, the mode switched) before asking again. */
export const ESTIMATE_DEBOUNCE_MS = 250

/** The view of a runtime answer. Pure. */
export function estimateFromRuntime(r: RuntimeEstimate): RunEstimate {
  const cost = r.basis === 'history' ? r.costUsd : null
  const minutes = r.basis === 'history' ? r.minutes : null
  if (r.basis !== 'history' || (!cost && !minutes)) return { state: 'unknown', note: r.note || ESTIMATE_UNKNOWN_TEXT }
  return { state: 'ready', cost, minutes, sampleRuns: r.sampleRuns, note: r.note }
}

/**
 * `excludeRoleIds` are the roles the user turned off (team mode only; their subtrees go with them). Answers for an older
 * question are dropped, so a slow reply never overwrites a newer one.
 */
export function useRunEstimate(projectId: string, mode: RunEstimateMode, excludeRoleIds: readonly string[]): RunEstimate {
  const [estimate, setEstimate] = useState<RunEstimate>({ state: 'loading' })
  const exclusions = mode === 'team' ? [...excludeRoleIds].sort().join('\n') : ''
  useEffect(() => {
    let current = true
    const timer = window.setTimeout(() => {
      const ids = exclusions === '' ? [] : exclusions.split('\n')
      const ask = window.orgai.runInsights?.estimate
      if (!ask) {
        setEstimate({ state: 'unknown', note: ESTIMATE_UNKNOWN_TEXT })
        return
      }
      ask({ projectId, ...(mode === 'ask' ? { team: 'single' as const } : {}), ...(ids.length > 0 ? { excludeRoleIds: ids } : {}) }).then(
        (r) => {
          if (current) setEstimate(estimateFromRuntime(r))
        },
        () => {
          if (current) setEstimate({ state: 'unknown', note: ESTIMATE_UNKNOWN_TEXT })
        }
      )
    }, ESTIMATE_DEBOUNCE_MS)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [projectId, mode, exclusions])
  return estimate
}

const usd = (n: number): string => formatUsdCompact(n)

/** "$0.40 to $1.20", or "about $0.40" when the range is a point. Unknown is never a number. */
export function costText(e: RunEstimate): string {
  if (e.state === 'loading') return '…'
  if (e.state !== 'ready' || !e.cost) return 'Unknown'
  const lo = usd(e.cost.low)
  const hi = usd(e.cost.high)
  return lo === hi ? `about ${usd(e.cost.median)}` : `${lo} to ${hi}`
}

/** "12 min", "1 h 5 min": whole minutes, at least one. */
function duration(min: number): string {
  const m = Math.max(1, Math.round(min))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`
}

/** "about 12 min" for a narrow spread, "8 to 20 min" for a wide one. */
export function timeText(e: RunEstimate): string {
  if (e.state === 'loading') return '…'
  if (e.state !== 'ready' || !e.minutes) return 'Unknown'
  const lo = duration(e.minutes.low)
  const hi = duration(e.minutes.high)
  if (lo === hi) return `about ${lo}`
  const m = e.minutes
  // A spread within a quarter of the middle reads as one figure around it.
  if (m.median > 0 && (m.high - m.low) / m.median <= 0.25) return `about ${duration(m.median)}`
  return lo.endsWith(' min') && hi.endsWith(' min') && !lo.includes(' h') && !hi.includes(' h') ? `${lo.slice(0, -4)} to ${hi}` : `${lo} to ${hi}`
}

/** The sentence under the figures: where they come from, or why there are none. */
export function estimateNote(e: RunEstimate): string | null {
  if (e.state === 'unknown') return e.note
  if (e.state === 'ready') return e.note || null
  return null
}
