import { describe, expect, it } from 'vitest'
// The zone must be set before any Date is used. Node re-reads process.env.TZ on assignment (checked on win32 and in the
// vitest worker by the "zone is applied" test below, which the DST tests are skipped without).
process.env.TZ = 'America/New_York'

import {
  SCHEDULE_BUDGET_MAX_USD,
  SCHEDULE_NAME_MAX_CHARS,
  SCHEDULE_PERMISSION_MODES,
  SCHEDULE_PROMPT_MAX_CHARS
} from './types'
import type { PermissionMode, ScheduleTiming } from './types'
import {
  cleanScheduleInput,
  compileScheduleTiming,
  describeScheduleTiming,
  nextScheduleRun,
  parseCron,
  scheduleTimingProblem,
  upcomingScheduleRuns
} from './schedule'

const L = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()
const cron = (expression: string): ScheduleTiming => ({ kind: 'cron', expression })
const zoneApplied = new Date(2026, 2, 8, 2, 30).getHours() === 3

describe('zone', () => {
  it('is applied (the DST tests need it)', () => {
    expect(zoneApplied).toBe(true)
  })
})

describe('parseCron', () => {
  it('parses lists, ranges, steps and stars', () => {
    const r = parseCron('0,30 9-17/2 1,15 */3 1-5')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.cron.minutes).toEqual([0, 30])
    expect(r.cron.hours).toEqual([9, 11, 13, 15, 17])
    expect(r.cron.daysOfMonth).toEqual([1, 15])
    expect(r.cron.months).toEqual([1, 4, 7, 10])
    expect(r.cron.daysOfWeek).toEqual([1, 2, 3, 4, 5])
    expect(r.cron.domAny).toBe(false)
    expect(r.cron.dowAny).toBe(false)
  })

  it('folds day of week 7 into Sunday and flags star fields', () => {
    const r = parseCron('0 0 * * 5-7')
    expect(r.ok && r.cron.daysOfWeek).toEqual([0, 5, 6])
    expect(r.ok && r.cron.domAny).toBe(true)
  })

  it('refuses malformed expressions with a sentence', () => {
    for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '5-1 * * * *', '*/0 * * * *', '5/2 * * * *', 'a * * * *', '* * * JAN *', '1,,2 * * * *', '1-2-3 * * * *', '*/2/3 * * * *']) {
      const r = parseCron(bad)
      expect(r.ok, bad).toBe(false)
      if (!r.ok) expect(r.problem.length).toBeGreaterThan(5)
    }
  })

  it('refuses an overlong expression', () => {
    expect(parseCron('0 '.repeat(100) + '0').ok).toBe(false)
  })
})

describe('scheduleTimingProblem', () => {
  it('accepts normal timings', () => {
    expect(scheduleTimingProblem({ kind: 'daily', time: '00:00' })).toBeNull()
    expect(scheduleTimingProblem({ kind: 'daily', time: '09:30', days: [1, 2, 3, 4, 5] })).toBeNull()
    expect(scheduleTimingProblem({ kind: 'interval', everyMinutes: 15 })).toBeNull()
    expect(scheduleTimingProblem({ kind: 'interval', everyMinutes: 43_200, anchor: 1_700_000_000_000 })).toBeNull()
    expect(scheduleTimingProblem({ kind: 'once', at: 1_800_000_000_000 })).toBeNull()
    expect(scheduleTimingProblem(cron('0 0 * * 1'))).toBeNull()
    expect(scheduleTimingProblem(cron('*/15 * * * *'))).toBeNull()
    expect(scheduleTimingProblem(cron('0 0 29 2 *'))).toBeNull()
  })

  it('refuses cron expressions that fire closer than 15 minutes apart', () => {
    expect(scheduleTimingProblem(cron('* * * * *'))).toMatch(/15 minutes/)
    expect(scheduleTimingProblem(cron('*/5 * * * *'))).toMatch(/5 minutes apart/)
    expect(scheduleTimingProblem(cron('0,10 * * * *'))).toMatch(/10 minutes apart/)
    expect(scheduleTimingProblem(cron('0-14 3 * * *'))).not.toBeNull()
    expect(scheduleTimingProblem(cron('0 0,0 * * *'))).toBeNull()
  })

  it('counts the gap across midnight and across days', () => {
    // 23:55 and 00:05 the next day are 10 minutes apart.
    expect(scheduleTimingProblem(cron('55,5 23,0 * * *'))).not.toBeNull()
    expect(scheduleTimingProblem(cron('55 23 * * *'))).toBeNull()
    // Last day of January and first of February, 23:55 and 00:05.
    expect(scheduleTimingProblem(cron('5 0 1 2 *'))).toBeNull()
  })

  it('refuses expressions that never match a date', () => {
    expect(scheduleTimingProblem(cron('0 0 31 2 *'))).toMatch(/never/)
    expect(scheduleTimingProblem(cron('0 0 30 2 *'))).toMatch(/never/)
    expect(scheduleTimingProblem(cron('0 0 31 4 *'))).toMatch(/never/)
  })

  it('checks the other kinds', () => {
    expect(scheduleTimingProblem({ kind: 'interval', everyMinutes: 14 })).toMatch(/15 minutes/)
    expect(scheduleTimingProblem({ kind: 'interval', everyMinutes: 43_201 })).toMatch(/30 days/)
    expect(scheduleTimingProblem({ kind: 'interval', everyMinutes: 30.5 })).not.toBeNull()
    expect(scheduleTimingProblem({ kind: 'interval', everyMinutes: 60, anchor: -1 })).not.toBeNull()
    expect(scheduleTimingProblem({ kind: 'daily', time: '24:00' })).not.toBeNull()
    expect(scheduleTimingProblem({ kind: 'daily', time: '9:30' })).not.toBeNull()
    expect(scheduleTimingProblem({ kind: 'daily', time: '09:30', days: [7] })).not.toBeNull()
    expect(scheduleTimingProblem({ kind: 'daily', time: '09:30', days: [1, 1] })).not.toBeNull()
    expect(scheduleTimingProblem({ kind: 'once', at: Number.NaN })).not.toBeNull()
    expect(scheduleTimingProblem({ kind: 'once', at: 0 })).not.toBeNull()
    expect(scheduleTimingProblem({ kind: 'bogus' } as unknown as ScheduleTiming)).not.toBeNull()
  })
})

describe('nextScheduleRun', () => {
  it('daily: the next slot is strictly after, and rolls to tomorrow', () => {
    const t: ScheduleTiming = { kind: 'daily', time: '09:30' }
    expect(nextScheduleRun(t, L(2026, 6, 10, 8, 0))).toBe(L(2026, 6, 10, 9, 30))
    expect(nextScheduleRun(t, L(2026, 6, 10, 9, 30))).toBe(L(2026, 6, 11, 9, 30))
    expect(nextScheduleRun(t, L(2026, 6, 10, 23, 59))).toBe(L(2026, 6, 11, 9, 30))
  })

  it('daily with weekdays: skips the weekend (0 = Sunday)', () => {
    const t: ScheduleTiming = { kind: 'daily', time: '09:30', days: [1, 2, 3, 4, 5] }
    // 2026-06-12 is a Friday.
    expect(nextScheduleRun(t, L(2026, 6, 12, 10, 0))).toBe(L(2026, 6, 15, 9, 30))
    const sun: ScheduleTiming = { kind: 'daily', time: '00:00', days: [0] }
    expect(nextScheduleRun(sun, L(2026, 6, 10, 0, 0))).toBe(L(2026, 6, 14, 0, 0))
  })

  it('daily: lastSlotAt keeps a handled slot from firing again', () => {
    const t: ScheduleTiming = { kind: 'daily', time: '09:30' }
    const slot = L(2026, 6, 10, 9, 30)
    expect(nextScheduleRun(t, L(2026, 6, 10, 9, 0), slot)).toBe(L(2026, 6, 11, 9, 30))
  })

  it('interval: slots are anchor + k * n, never the anchor itself', () => {
    const anchor = L(2026, 6, 10, 12, 0)
    const t: ScheduleTiming = { kind: 'interval', everyMinutes: 120, anchor }
    expect(nextScheduleRun(t, anchor - 1)).toBe(anchor + 120 * 60_000)
    expect(nextScheduleRun(t, anchor)).toBe(anchor + 120 * 60_000)
    expect(nextScheduleRun(t, anchor + 120 * 60_000)).toBe(anchor + 240 * 60_000)
    expect(nextScheduleRun(t, anchor + 150 * 60_000)).toBe(anchor + 240 * 60_000)
    expect(nextScheduleRun(t, anchor + 1000 * 120 * 60_000 + 5)).toBe(anchor + 1001 * 120 * 60_000)
  })

  it('interval without an anchor counts from `after`', () => {
    const now = L(2026, 6, 10, 12, 7)
    expect(nextScheduleRun({ kind: 'interval', everyMinutes: 30 }, now)).toBe(now + 30 * 60_000)
  })

  it('once: the instant while it is ahead, then null', () => {
    const at = L(2026, 11, 14, 8, 0)
    expect(nextScheduleRun({ kind: 'once', at }, at - 1)).toBe(at)
    expect(nextScheduleRun({ kind: 'once', at }, at)).toBeNull()
    expect(nextScheduleRun({ kind: 'once', at }, at - 10_000, at)).toBeNull()
  })

  it('returns null for an invalid timing or time', () => {
    expect(nextScheduleRun({ kind: 'interval', everyMinutes: 1 }, 1000)).toBeNull()
    expect(nextScheduleRun(cron('* * * * *'), 1000)).toBeNull()
    expect(nextScheduleRun({ kind: 'daily', time: '09:30' }, Number.NaN)).toBeNull()
  })

  it('cron: lists, ranges and steps', () => {
    expect(nextScheduleRun(cron('0 0 * * *'), L(2026, 6, 10, 0, 0))).toBe(L(2026, 6, 11, 0, 0))
    expect(nextScheduleRun(cron('0,30 9-10 * * *'), L(2026, 6, 10, 9, 30))).toBe(L(2026, 6, 10, 10, 0))
    expect(nextScheduleRun(cron('*/20 * * * *'), L(2026, 6, 10, 9, 41))).toBe(L(2026, 6, 10, 10, 0))
    expect(nextScheduleRun(cron('0 0 * * 1'), L(2026, 6, 10, 0, 0))).toBe(L(2026, 6, 15, 0, 0))
    expect(nextScheduleRun(cron('0 9 * 12 *'), L(2026, 6, 10, 0, 0))).toBe(L(2026, 12, 1, 9, 0))
  })

  it('cron: day-of-month and day-of-week match either when both are restricted (Vixie)', () => {
    // The 15th or any Monday. 2026-06-10 is a Wednesday.
    const t = cron('0 0 15 * 1')
    expect(nextScheduleRun(t, L(2026, 6, 10, 12, 0))).toBe(L(2026, 6, 15, 0, 0)) // both: the 15th is also a Monday
    expect(nextScheduleRun(t, L(2026, 6, 15, 12, 0))).toBe(L(2026, 6, 22, 0, 0)) // next Monday, before the 15th of July
    expect(nextScheduleRun(t, L(2026, 6, 29, 12, 0))).toBe(L(2026, 7, 6, 0, 0))
    expect(upcomingScheduleRuns(cron('0 0 13 * 5'), L(2026, 11, 1), 3)).toEqual([L(2026, 11, 6), L(2026, 11, 13), L(2026, 11, 20)]) // Fridays plus the 13th
  })

  it('cron: a star in one day field leaves the other in charge', () => {
    // */2 starts with a star: day of week alone decides.
    expect(nextScheduleRun(cron('0 0 */2 * 3'), L(2026, 6, 10, 12, 0))).toBe(L(2026, 6, 17, 0, 0))
    expect(nextScheduleRun(cron('0 0 20 * *'), L(2026, 6, 10, 12, 0))).toBe(L(2026, 6, 20, 0, 0))
  })

  it('cron: month ends', () => {
    expect(nextScheduleRun(cron('0 0 31 * *'), L(2026, 4, 1))).toBe(L(2026, 5, 31)) // April has 30 days
    expect(nextScheduleRun(cron('0 0 31 * *'), L(2026, 5, 31))).toBe(L(2026, 7, 31)) // June has 30
    expect(nextScheduleRun(cron('0 0 30 * *'), L(2026, 1, 31))).toBe(L(2026, 3, 30)) // February has no 30th
  })

  it('cron: 29 February waits for a leap year', () => {
    expect(nextScheduleRun(cron('0 12 29 2 *'), L(2026, 3, 1))).toBe(L(2028, 2, 29, 12, 0))
    expect(nextScheduleRun(cron('0 12 29 2 *'), L(2028, 2, 29, 12, 0))).toBe(L(2032, 2, 29, 12, 0))
    // 2100 is not a leap year: from 2096 the next 29 Feb is 2104, past the five-year search.
    expect(nextScheduleRun(cron('0 12 29 2 *'), L(2096, 2, 29, 12, 0))).toBeNull()
  })

  it('cron: impossible dates terminate with null', () => {
    const started = Date.now()
    expect(nextScheduleRun(cron('0 0 31 2 *'), L(2026, 6, 10))).toBeNull()
    expect(nextScheduleRun(cron('0 0 30 2 *'), L(2026, 6, 10))).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('upcomingScheduleRuns caps the count at 5 and stops when the timing ends', () => {
    expect(upcomingScheduleRuns({ kind: 'daily', time: '09:30' }, L(2026, 6, 10), 9)).toHaveLength(5)
    expect(upcomingScheduleRuns({ kind: 'daily', time: '09:30' }, L(2026, 6, 10), 3)).toEqual([L(2026, 6, 10, 9, 30), L(2026, 6, 11, 9, 30), L(2026, 6, 12, 9, 30)])
    expect(upcomingScheduleRuns({ kind: 'once', at: L(2026, 11, 14, 8) }, L(2026, 6, 10), 3)).toEqual([L(2026, 11, 14, 8)])
    expect(upcomingScheduleRuns({ kind: 'daily', time: '09:30' }, L(2026, 6, 10), 0)).toEqual([])
    expect(upcomingScheduleRuns({ kind: 'daily', time: '09:30' }, L(2026, 6, 10), -2)).toEqual([])
  })
})

describe('compileScheduleTiming', () => {
  const after = L(2026, 6, 10, 9, 17)
  const timings: ScheduleTiming[] = [
    { kind: 'cron', expression: '*/15 * * * *' },
    { kind: 'cron', expression: '30 9 * * 1-5' },
    { kind: 'daily', time: '09:30' },
    { kind: 'daily', time: '23:45', days: [0, 6] },
    { kind: 'interval', everyMinutes: 90, anchor: L(2026, 6, 1, 8) },
    { kind: 'interval', everyMinutes: 15 },
    { kind: 'once', at: L(2026, 6, 20, 8) },
    { kind: 'once', at: L(2026, 6, 1, 8) }
  ]

  it('returns the same slots as nextScheduleRun, with and without lastSlotAt', () => {
    for (const t of timings) {
      const next = compileScheduleTiming(t)
      expect(next, JSON.stringify(t)).not.toBeNull()
      for (const a of [after, L(2026, 6, 20, 8), L(2025, 1, 1)]) {
        expect(next!(a), JSON.stringify(t)).toBe(nextScheduleRun(t, a))
        expect(next!(a, a + 3 * 3_600_000), JSON.stringify(t)).toBe(nextScheduleRun(t, a, a + 3 * 3_600_000))
      }
      expect(next!(Number.NaN)).toBeNull()
    }
  })

  it('walks a sequence the same way', () => {
    const t: ScheduleTiming = { kind: 'cron', expression: '*/15 * * * *' }
    const next = compileScheduleTiming(t)!
    let cursor = after
    for (let i = 0; i < 20; i++) {
      const slot = next(cursor)
      expect(slot).toBe(nextScheduleRun(t, cursor))
      cursor = slot!
    }
  })

  it('is null for an invalid timing', () => {
    expect(compileScheduleTiming({ kind: 'cron', expression: '* * * * *' })).toBeNull()
    expect(compileScheduleTiming({ kind: 'cron', expression: 'nonsense' })).toBeNull()
    expect(compileScheduleTiming({ kind: 'interval', everyMinutes: 1 })).toBeNull()
    expect(compileScheduleTiming({ kind: 'daily', time: '25:00' })).toBeNull()
    expect(compileScheduleTiming({ kind: 'once', at: Number.NaN })).toBeNull()
    expect(nextScheduleRun({ kind: 'cron', expression: 'nonsense' }, after)).toBeNull()
  })
})

describe.skipIf(!zoneApplied)('daylight saving time (America/New_York)', () => {
  it('spring forward: a time inside the gap fires at the first valid minute (03:00)', () => {
    // 2026-03-08, 02:00 -> 03:00 EDT.
    const t: ScheduleTiming = { kind: 'daily', time: '02:30' }
    const run = nextScheduleRun(t, L(2026, 3, 8, 0, 0))
    expect(run).toBe(new Date('2026-03-08T07:00:00Z').getTime()) // 03:00 EDT
    expect(new Date(run!).getHours()).toBe(3)
    expect(new Date(run!).getMinutes()).toBe(0)
    // The day after is normal again.
    expect(nextScheduleRun(t, run!)).toBe(L(2026, 3, 9, 2, 30))
  })

  it('spring forward: a cron slot in the gap fires once at 03:00 and the next hour is untouched', () => {
    const t = cron('0,30 2,3 * * *')
    const runs = upcomingScheduleRuns(t, L(2026, 3, 8, 0, 0), 5)
    const hhmm = runs.map((r) => `${new Date(r).getHours()}:${String(new Date(r).getMinutes()).padStart(2, '0')}`)
    // 02:00 and 02:30 both resolve to 03:00; one fire at 03:00, then 03:30, then the next day.
    expect(hhmm.slice(0, 2)).toEqual(['3:00', '3:30'])
    expect(new Set(runs).size).toBe(runs.length)
    expect(runs[2]).toBe(L(2026, 3, 9, 2, 0))
  })

  it('spring forward: a slot at exactly the gap start (02:00) fires at 03:00', () => {
    expect(nextScheduleRun({ kind: 'daily', time: '02:00' }, L(2026, 3, 8, 1, 0))).toBe(new Date('2026-03-08T07:00:00Z').getTime())
  })

  it('fall back: a time that occurs twice fires once, at the first occurrence', () => {
    // 2026-11-01, 02:00 EDT -> 01:00 EST: 01:30 happens twice.
    const t: ScheduleTiming = { kind: 'daily', time: '01:30' }
    const first = nextScheduleRun(t, L(2026, 11, 1, 0, 0))
    expect(first).toBe(new Date('2026-11-01T05:30:00Z').getTime()) // 01:30 EDT, the first one
    const after = nextScheduleRun(t, first!)
    expect(after).toBe(L(2026, 11, 2, 1, 30))
    // Asking from between the two occurrences (01:45 EDT, the first 01:30 has passed) does not offer the repeated 01:30 EST.
    expect(nextScheduleRun(t, new Date('2026-11-01T05:45:00Z').getTime())).toBe(L(2026, 11, 2, 1, 30))
  })

  it('fall back: a cron over the repeated hour lists each wall time once', () => {
    const runs = upcomingScheduleRuns(cron('0,30 0,1,2 * * *'), L(2026, 11, 1, 0, 0) - 1, 5)
    expect(new Set(runs).size).toBe(5)
    expect(runs).toEqual([L(2026, 11, 1, 0, 0), L(2026, 11, 1, 0, 30), L(2026, 11, 1, 1, 0), L(2026, 11, 1, 1, 30), L(2026, 11, 1, 2, 0)])
  })

  it('daily slots keep their wall-clock time across the change', () => {
    const t: ScheduleTiming = { kind: 'daily', time: '09:00' }
    const runs = upcomingScheduleRuns(t, L(2026, 3, 6, 12, 0), 4)
    expect(runs.map((r) => new Date(r).getHours())).toEqual([9, 9, 9, 9])
  })

  it('intervals are absolute durations across the change', () => {
    const anchor = L(2026, 3, 7, 12, 0)
    const runs = upcomingScheduleRuns({ kind: 'interval', everyMinutes: 1440, anchor }, anchor, 2)
    expect(runs[0]).toBe(anchor + 1440 * 60_000)
    expect(runs[1] - runs[0]).toBe(1440 * 60_000)
  })
})

describe('describeScheduleTiming', () => {
  it('describes each kind', () => {
    expect(describeScheduleTiming({ kind: 'daily', time: '00:00' })).toBe('Every day at 00:00')
    expect(describeScheduleTiming({ kind: 'daily', time: '00:00', days: [] })).toBe('Every day at 00:00')
    expect(describeScheduleTiming({ kind: 'daily', time: '00:00', days: [0, 1, 2, 3, 4, 5, 6] })).toBe('Every day at 00:00')
    expect(describeScheduleTiming({ kind: 'daily', time: '09:30', days: [5, 3, 1, 4, 2] })).toBe('Weekdays at 09:30')
    expect(describeScheduleTiming({ kind: 'daily', time: '10:00', days: [6, 0] })).toBe('Weekends at 10:00')
    expect(describeScheduleTiming({ kind: 'daily', time: '08:15', days: [1] })).toBe('Every Monday at 08:15')
    expect(describeScheduleTiming({ kind: 'daily', time: '08:15', days: [0, 5, 1] })).toBe('Mon, Fri and Sun at 08:15')
    expect(describeScheduleTiming({ kind: 'interval', everyMinutes: 120 })).toBe('Every 2 hours')
    expect(describeScheduleTiming({ kind: 'interval', everyMinutes: 60 })).toBe('Every hour')
    expect(describeScheduleTiming({ kind: 'interval', everyMinutes: 45 })).toBe('Every 45 minutes')
    expect(describeScheduleTiming({ kind: 'interval', everyMinutes: 1440 })).toBe('Every day')
    expect(describeScheduleTiming({ kind: 'interval', everyMinutes: 4320 })).toBe('Every 3 days')
    expect(describeScheduleTiming({ kind: 'once', at: L(2026, 11, 14, 8, 0) })).toBe('Once on 14 Nov 2026 at 08:00')
    expect(describeScheduleTiming(cron('0  0 * * 1'))).toBe('Cron: 0 0 * * 1')
  })

  it('honours a locale for dates and weekday names', () => {
    expect(describeScheduleTiming({ kind: 'daily', time: '08:15', days: [1] }, 'de-DE')).toBe('Every Montag at 08:15')
  })
})

describe('cleanScheduleInput', () => {
  const base = {
    name: 'PR monitor',
    prompt: 'Review new pull requests.',
    target: { kind: 'team', projectId: 'p_abc123' },
    timing: { kind: 'daily', time: '00:00' }
  }
  const ok = (over: Record<string, unknown> = {}) => cleanScheduleInput({ ...base, ...over })
  const problem = (over: Record<string, unknown> = {}): string => {
    const r = ok(over)
    if (r.ok) throw new Error('expected a problem')
    return r.problem
  }

  it('returns a rebuilt value and drops unknown keys and main-owned fields', () => {
    const r = cleanScheduleInput({ ...base, name: '  PR monitor  ', state: 'error', nextRunAt: 5, junk: { a: 1 }, target: { kind: 'team', projectId: 'p_abc123', extra: 1 } })
    expect(r).toEqual({ ok: true, value: { name: 'PR monitor', prompt: 'Review new pull requests.', target: { kind: 'team', projectId: 'p_abc123' }, timing: { kind: 'daily', time: '00:00' } } })
  })

  it('keeps optional fields, including nulls that clear', () => {
    const r = ok({
      id: 'sch_0123abcd',
      enabled: false,
      missed: 'skip',
      modelSelection: { model: ' haiku ', connection: 'anthropic' },
      permissionMode: 'acceptEdits',
      budgetUsd: 2.5,
      expiresAt: 1_900_000_000_000,
      expectedUpdatedAt: 12
    })
    expect(r.ok && r.value).toMatchObject({ id: 'sch_0123abcd', enabled: false, missed: 'skip', modelSelection: { model: 'haiku', connection: 'anthropic' }, permissionMode: 'acceptEdits', budgetUsd: 2.5, expiresAt: 1_900_000_000_000, expectedUpdatedAt: 12 })
    const cleared = ok({ modelSelection: null, permissionMode: null, budgetUsd: null, expiresAt: null })
    expect(cleared.ok && cleared.value).toMatchObject({ modelSelection: null, permissionMode: null, budgetUsd: null, expiresAt: null })
  })

  it('refuses a non-object and wrong-typed fields', () => {
    expect(cleanScheduleInput(null).ok).toBe(false)
    expect(cleanScheduleInput('x').ok).toBe(false)
    expect(cleanScheduleInput([]).ok).toBe(false)
    expect(problem({ name: 5 })).toMatch(/name/)
    expect(problem({ prompt: undefined })).toMatch(/do/)
    expect(problem({ enabled: 'yes' })).toMatch(/Enabled/)
    expect(problem({ missed: 'twice' })).toMatch(/missed/)
    expect(problem({ id: 'abc' })).toMatch(/id/)
    expect(problem({ id: 'sch_ZZ' })).toMatch(/id/)
  })

  it('name: 1..80 characters, one line, no hidden characters', () => {
    expect(problem({ name: '   ' })).toMatch(/name/)
    expect(ok({ name: 'x'.repeat(SCHEDULE_NAME_MAX_CHARS) }).ok).toBe(true)
    expect(problem({ name: 'x'.repeat(SCHEDULE_NAME_MAX_CHARS + 1) })).toMatch(/80/)
    expect(problem({ name: 'Nightly\u202Ereview' })).toMatch(/cannot be shown/) // bidi override
    expect(problem({ name: 'Zero\u200Bwidth' })).toMatch(/cannot be shown/)
    expect(problem({ name: 'two\nlines' })).toMatch(/one line/)
    expect(problem({ name: 'tab\there' })).toMatch(/one line/)
  })

  it('prompt: 1..8000 characters, no hidden characters, newlines allowed', () => {
    expect(problem({ prompt: '' })).toMatch(/do/)
    expect(ok({ prompt: 'x'.repeat(SCHEDULE_PROMPT_MAX_CHARS) }).ok).toBe(true)
    expect(problem({ prompt: 'x'.repeat(SCHEDULE_PROMPT_MAX_CHARS + 1) })).toMatch(/8000/)
    expect(ok({ prompt: 'line one\n\tline two' }).ok).toBe(true)
    expect(problem({ prompt: 'ignore\u2066this' })).toMatch(/cannot be shown/)
    expect(problem({ prompt: 'nul\u0000byte' })).toMatch(/cannot be shown/)
  })

  it('target: team needs a project id, ask takes a folder and allowEdits', () => {
    expect(problem({ target: null })).toMatch(/runs/)
    expect(problem({ target: { kind: 'team' } })).toMatch(/project/)
    expect(problem({ target: { kind: 'team', projectId: '../x' } })).toMatch(/project/)
    expect(problem({ target: { kind: 'team', projectId: 'p_1', team: 'all' } })).toMatch(/single/)
    expect(ok({ target: { kind: 'team', projectId: 'p_1', team: 'single' } }).ok).toBe(true)
    expect(problem({ target: { kind: 'other' } })).toMatch(/runs/)
    const ask = ok({ target: { kind: 'ask', folder: 'C:\\work', allowEdits: true } })
    expect(ask.ok && ask.value.target).toEqual({ kind: 'ask', folder: 'C:\\work', allowEdits: true })
    const bare = ok({ target: { kind: 'ask', folder: '' } })
    expect(bare.ok && bare.value.target).toEqual({ kind: 'ask' })
    expect(problem({ target: { kind: 'ask', allowEdits: 'yes' } })).toMatch(/Allow edits/)
    expect(problem({ target: { kind: 'ask', folder: 'a\u202Eb' } })).toMatch(/folder/)
    expect(problem({ target: { kind: 'ask', folder: 'x'.repeat(2000) } })).toMatch(/folder/)
  })

  it('timing: runs scheduleTimingProblem and normalises', () => {
    expect(problem({ timing: { kind: 'interval', everyMinutes: 5 } })).toMatch(/15 minutes/)
    expect(problem({ timing: { kind: 'cron', expression: '* * * * *' } })).toMatch(/15 minutes/)
    expect(problem({ timing: { kind: 'cron', expression: 5 } })).toBeTruthy()
    expect(problem({ timing: { kind: 'weekly' } })).toMatch(/when/)
    expect(problem({ timing: null })).toMatch(/when/)
    const t = ok({ timing: { kind: 'cron', expression: '  0   0 * * 1 ' } })
    expect(t.ok && t.value.timing).toEqual({ kind: 'cron', expression: '0 0 * * 1' })
    const d = ok({ timing: { kind: 'daily', time: '09:30', days: [5, 1, 3] } })
    expect(d.ok && d.value.timing).toEqual({ kind: 'daily', time: '09:30', days: [1, 3, 5] })
    const e = ok({ timing: { kind: 'daily', time: '09:30', days: [] } })
    expect(e.ok && e.value.timing).toEqual({ kind: 'daily', time: '09:30' })
  })

  it('permission mode: every mode but bypassPermissions', () => {
    const all: PermissionMode[] = ['auto', 'acceptEdits', 'default', 'dontAsk', 'plan', 'bypassPermissions']
    expect([...SCHEDULE_PERMISSION_MODES].sort()).toEqual(all.filter((m) => m !== 'bypassPermissions').sort())
    for (const m of SCHEDULE_PERMISSION_MODES) expect(ok({ permissionMode: m }).ok).toBe(true)
    expect(problem({ permissionMode: 'bypassPermissions' })).toMatch(/bypass/)
    expect(problem({ permissionMode: 'yolo' })).toMatch(/permission mode/)
    expect(problem({ permissionMode: 3 })).toMatch(/permission mode/)
  })

  it('budget: more than 0 and at most the maximum', () => {
    expect(ok({ budgetUsd: 0.01 }).ok).toBe(true)
    expect(ok({ budgetUsd: SCHEDULE_BUDGET_MAX_USD }).ok).toBe(true)
    expect(problem({ budgetUsd: 0 })).toMatch(/\$0/)
    expect(problem({ budgetUsd: -1 })).toMatch(/\$0/)
    expect(problem({ budgetUsd: Number.NaN })).toMatch(/\$0/)
    expect(problem({ budgetUsd: Infinity })).toMatch(/\$0/)
    expect(problem({ budgetUsd: '5' })).toMatch(/\$0/)
    expect(problem({ budgetUsd: SCHEDULE_BUDGET_MAX_USD + 0.01 })).toMatch(/1,000/)
  })

  it('model selection, expiry and expected update time', () => {
    expect(problem({ modelSelection: { model: '', connection: 'anthropic' } })).toMatch(/model/)
    expect(problem({ modelSelection: { model: 'm' } })).toMatch(/model/)
    expect(problem({ modelSelection: { model: 'm\u200B', connection: 'anthropic' } })).toMatch(/cannot be shown/)
    expect(problem({ modelSelection: { model: 'm'.repeat(300), connection: 'anthropic' } })).toMatch(/model/)
    expect(problem({ expiresAt: -5 })).toMatch(/end date/)
    expect(problem({ expiresAt: 'tomorrow' })).toMatch(/end date/)
    expect(problem({ expectedUpdatedAt: 'x' })).toMatch(/expected/)
  })

  it('result is structured-clone safe', () => {
    const r = ok({ budgetUsd: 1, modelSelection: { model: 'm', connection: 'c' } })
    expect(structuredClone(r)).toEqual(r)
  })
})
