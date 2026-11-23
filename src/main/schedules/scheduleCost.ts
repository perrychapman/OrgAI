import type { Schedule, ScheduleCostReport, ScheduleHistoryEntry } from '../../shared/types'

/**
 * UI overhaul (runInsights.scheduleCosts): per-schedule and weekly cost from schedule run history. Pure.
 * CONTRACT STUB: implemented by a Runtime Engineer (see docs/design/ui-overhaul/impl-runtime.md).
 */
export function scheduleCosts(schedules: readonly Schedule[], historyOf: (scheduleId: string) => readonly ScheduleHistoryEntry[], now: number): ScheduleCostReport {
  void historyOf
  return {
    schedules: schedules.map((s) => ({ scheduleId: s.id, perRunUsd: null, sampleRuns: 0, runsPerWeek: null, weeklyUsd: null })),
    weeklyTotalUsd: null,
    unknownCount: schedules.filter((s) => s.enabled).length,
    generatedAt: now
  }
}
