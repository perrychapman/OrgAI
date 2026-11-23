import { describe, expect, it } from 'vitest'
import type { Schedule, ScheduleHistoryEntry } from '../../shared/types'
import { scheduleCosts } from './scheduleCost'

const NOW = new Date(2026, 10, 20, 12).getTime()

function sch(id: string, over: Partial<Schedule> = {}): Schedule {
  return { id, name: id, prompt: 'x', target: { kind: 'ask' }, timing: { kind: 'daily', time: '09:00' }, enabled: true, missed: 'run-once', state: 'active', ...over } as unknown as Schedule
}
function hist(scheduleId: string, costs: (number | null | undefined)[]): ScheduleHistoryEntry[] {
  return costs.map((c, i) => ({ id: `${scheduleId}${i}`, scheduleId, at: NOW - i * 1000, slotAt: NOW - i * 1000, ...(c === undefined ? {} : { costUsd: c }) }) as unknown as ScheduleHistoryEntry)
}

describe('scheduleCosts', () => {
  it('uses the median of the newest 7 costs and counts weekly slots', () => {
    // newest first: 7 recent costs (1,2,3,4,5,6,7), older 100 ignored
    const h = hist('a', [1, 2, 3, 4, 5, 6, 7, 100, 100])
    const r = scheduleCosts([sch('a')], () => h, NOW)
    expect(r.schedules[0]).toMatchObject({ perRunUsd: 4, sampleRuns: 7, runsPerWeek: 7, weeklyUsd: 28 })
    expect(r.weeklyTotalUsd).toBe(28)
    expect(r.unknownCount).toBe(0)
  })
  it('skips entries without a finite cost and gives null without any', () => {
    const r = scheduleCosts([sch('a')], () => hist('a', [undefined, null, Number.NaN, -1]), NOW)
    expect(r.schedules[0]).toMatchObject({ perRunUsd: null, sampleRuns: 0, runsPerWeek: 7, weeklyUsd: null })
    expect(r.weeklyTotalUsd).toBeNull()
    expect(r.unknownCount).toBe(1)
  })
  it('gives 0 runs for disabled, done and expired schedules', () => {
    const h = () => hist('x', [2])
    const r = scheduleCosts([sch('d', { enabled: false }), sch('n', { state: 'done' }), sch('e', { expiresAt: NOW - 1 })], h, NOW)
    expect(r.schedules.map((s) => s.runsPerWeek)).toEqual([0, 0, 0])
    expect(r.schedules.map((s) => s.weeklyUsd)).toEqual([0, 0, 0])
    expect(r.unknownCount).toBe(0)
  })
  it('counts interval slots in the 7 days and stops at expiry', () => {
    const h = () => hist('i', [1])
    const iv = sch('i', { timing: { kind: 'interval', everyMinutes: 60 * 24, anchor: NOW - 1000 } })
    expect(scheduleCosts([iv], h, NOW).schedules[0].runsPerWeek).toBe(7)
    const ex = sch('i', { timing: { kind: 'interval', everyMinutes: 60 * 24, anchor: NOW - 1000 }, expiresAt: NOW + 3.5 * 86_400_000 })
    expect(scheduleCosts([ex], h, NOW).schedules[0].runsPerWeek).toBe(3)
  })
  it('counts a once schedule in the week and not beyond it', () => {
    const h = () => hist('o', [1])
    expect(scheduleCosts([sch('o', { timing: { kind: 'once', at: NOW + 3600_000 } })], h, NOW).schedules[0].runsPerWeek).toBe(1)
    expect(scheduleCosts([sch('o', { timing: { kind: 'once', at: NOW + 8 * 86_400_000 } })], h, NOW).schedules[0].runsPerWeek).toBe(0)
  })
  it('gives null runs for a timing that cannot be evaluated', () => {
    const bad = sch('b', { timing: { kind: 'cron', expression: 'nope' } })
    const r = scheduleCosts([bad], () => hist('b', [1]), NOW)
    expect(r.schedules[0]).toMatchObject({ runsPerWeek: null, weeklyUsd: null })
    expect(r.unknownCount).toBe(1)
  })
})
