import { compileScheduleTiming } from '../../shared/schedule'
import { SCHEDULE_COST_SAMPLES } from '../../shared/types'
import type { Schedule, ScheduleCost, ScheduleCostReport, ScheduleHistoryEntry } from '../../shared/types'

const WEEK_MS = 7 * 86_400_000
/** Upper bound of the slot walk (the shortest interval allowed gives far fewer slots per week). */
const MAX_SLOTS = 20_000

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Due slots in [now, now + 7 days); 0 when not running; null when the timing cannot be evaluated. */
function slotsInWeek(s: Schedule, now: number): number | null {
  if (!s.enabled || s.state === 'done') return 0
  if (typeof s.expiresAt === 'number' && s.expiresAt <= now) return 0
  const next = compileScheduleTiming(s.timing)
  if (next === null) return null
  const end = now + WEEK_MS
  const stop = typeof s.expiresAt === 'number' ? Math.min(end, s.expiresAt) : end
  let count = 0
  let after = now - 1
  for (let i = 0; i < MAX_SLOTS; i++) {
    const n = next(after)
    if (n === null || n >= stop) return count
    count++
    after = n
  }
  return null
}

/**
 * UI overhaul (runInsights.scheduleCosts): per-schedule and weekly cost from schedule run history. Pure.
 * Per-run cost is the median of the newest SCHEDULE_COST_SAMPLES entries that have a recorded cost.
 */
export function scheduleCosts(schedules: readonly Schedule[], historyOf: (scheduleId: string) => readonly ScheduleHistoryEntry[], now: number): ScheduleCostReport {
  let total = 0
  let anyKnown = false
  let unknownCount = 0
  const out: ScheduleCost[] = schedules.map((s) => {
    const costs = [...historyOf(s.id)]
      .sort((a, b) => b.at - a.at)
      .filter((e) => typeof e.costUsd === 'number' && Number.isFinite(e.costUsd) && e.costUsd >= 0)
      .slice(0, SCHEDULE_COST_SAMPLES)
      .map((e) => e.costUsd as number)
    const perRunUsd = costs.length > 0 ? median(costs) : null
    const runsPerWeek = slotsInWeek(s, now)
    const weeklyUsd = perRunUsd !== null && runsPerWeek !== null ? perRunUsd * runsPerWeek : null
    if (s.enabled) {
      if (weeklyUsd === null) unknownCount++
      else {
        total += weeklyUsd
        anyKnown = true
      }
    }
    return { scheduleId: s.id, perRunUsd, sampleRuns: costs.length, runsPerWeek, weeklyUsd }
  })
  return { schedules: out, weeklyTotalUsd: anyKnown ? total : null, unknownCount, generatedAt: now }
}
