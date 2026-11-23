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

function period(runs: readonly RunSummary[], from: number, until: number): ProjectSpendPeriod {
  let spentUsd = 0
  let count = 0
  let unknownRuns = 0
  for (const r of runs) {
    if (r.startedAt < from || r.startedAt >= until) continue
    count++
    const c = knownRunCostUsd(r)
    if (c === null) unknownRuns++
    else spentUsd += c
  }
  return { spentUsd, runs: count, unknownRuns, from, until }
}

/**
 * UI overhaul (runInsights.projectSpend and the daily / monthly caps): a project's spend today and this month.
 * Pure. Runs of any kind count by start time; the caller passes the project's runs, live ones with their current cost.
 */
export function projectSpend(project: Pick<Project, 'id' | 'maxDailyUsd' | 'maxMonthlyUsd'>, runs: readonly RunSummary[], now: number): ProjectSpend {
  const b = periodBounds(now)
  const day = period(runs, b.dayFrom, b.dayUntil)
  const month = period(runs, b.monthFrom, b.monthUntil)
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
