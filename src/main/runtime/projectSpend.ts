import type { Project, ProjectSpend, RunSummary } from '../../shared/types'

/**
 * UI overhaul (runInsights.projectSpend and the daily / monthly caps): a project's spend today and this month.
 * Pure. CONTRACT STUB: implemented by a Runtime Engineer (see docs/design/ui-overhaul/impl-runtime.md).
 */
export function projectSpend(project: Pick<Project, 'id' | 'maxDailyUsd' | 'maxMonthlyUsd'>, runs: readonly RunSummary[], now: number): ProjectSpend {
  void runs
  const empty = { spentUsd: 0, runs: 0, unknownRuns: 0, from: now, until: now }
  return {
    projectId: project.id,
    day: { ...empty },
    month: { ...empty },
    ...(project.maxDailyUsd !== undefined ? { maxDailyUsd: project.maxDailyUsd } : {}),
    ...(project.maxMonthlyUsd !== undefined ? { maxMonthlyUsd: project.maxMonthlyUsd } : {}),
    monthProjectionUsd: null,
    generatedAt: now
  }
}
