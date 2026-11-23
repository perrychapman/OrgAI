import type { Project, ProjectSpend, ProjectSpendPeriod, RunSummary } from '../../shared/types'
import { knownRunCostUsd } from './estimate'

/** The local calendar day and month containing `now`, epoch ms (until is the next local midnight / month start). */
export function periodBounds(now: number): { dayFrom: number; dayUntil: number; monthFrom: number; monthUntil: number } {
  const d = new Date(now)
  const y = d.getFullYear()
  const m = d.getMonth()
  const day = d.getDate()
  return {
    dayFrom: new Date(y, m, day).getTime(),
    dayUntil: new Date(y, m, day + 1).getTime(),
    monthFrom: new Date(y, m, 1).getTime(),
    monthUntil: new Date(y, m + 1, 1).getTime()
  }
}

/**
 * When the run stopped being active: its endedAt, `now` while it is still open, or (a finished / failed record that never
 * got an endedAt) its start, so an old record does not count toward every later period.
 */
function runEnd(r: RunSummary, now: number): number {
  if (typeof r.endedAt === 'number' && Number.isFinite(r.endedAt)) return Math.max(r.endedAt, r.startedAt)
  return r.status === 'finished' || r.status === 'error' ? r.startedAt : Math.max(now, r.startedAt)
}

function period(runs: readonly RunSummary[], from: number, until: number, now: number): ProjectSpendPeriod {
  let spentUsd = 0
  let count = 0
  let unknownRuns = 0
  for (const r of runs) {
    // A run counts in every period it overlaps, with its full known cost (the cost is not split by time, so a session that
    // runs across midnight counts toward both days: conservative for a spending limit).
    if (r.startedAt >= until || runEnd(r, now) < from) continue
    count++
    const c = knownRunCostUsd(r)
    if (c === null) unknownRuns++
    else spentUsd += c
  }
  return { spentUsd, runs: count, unknownRuns, from, until }
}

/**
 * UI overhaul (runInsights.projectSpend and the daily / monthly caps): a project's spend today and this month.
 * Pure. Runs of any kind count in each period they overlap (start to end, or to now while open), with their full known
 * cost, so a session begun before midnight still counts toward today's cap; the caller passes the project's runs, live ones with their current cost.
 */
export function projectSpend(project: Pick<Project, 'id' | 'maxDailyUsd' | 'maxMonthlyUsd'>, runs: readonly RunSummary[], now: number): ProjectSpend {
  const b = periodBounds(now)
  const day = period(runs, b.dayFrom, b.dayUntil, now)
  const month = period(runs, b.monthFrom, b.monthUntil, now)
  const elapsedDays = (now - b.monthFrom) / 86_400_000
  const nd = new Date(now)
  const daysInMonth = new Date(nd.getFullYear(), nd.getMonth() + 1, 0).getDate()
  const monthProjectionUsd = elapsedDays >= 3 && month.spentUsd > 0 ? (month.spentUsd / elapsedDays) * daysInMonth : null
  return {
    projectId: project.id,
    day,
    month,
    ...(project.maxDailyUsd !== undefined ? { maxDailyUsd: project.maxDailyUsd } : {}),
    ...(project.maxMonthlyUsd !== undefined ? { maxMonthlyUsd: project.maxMonthlyUsd } : {}),
    monthProjectionUsd,
    generatedAt: now
  }
}
