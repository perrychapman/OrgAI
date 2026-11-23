import { describe, expect, it } from 'vitest'
import type { Schedule, ScheduleHistoryEntry } from '@shared/types'
import { runBars, runBarsSummary, scheduleCostFigure, totalCostFigure, boardSummary, dayTimeWords, detailFacts, lastTone, mayChangeFiles, scheduleColour, spendingLimit, summaryText, weekDays, weekStart } from './schedulesBoard'

function sched(over: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sch_a',
    name: 'Daily check',
    prompt: 'Check things',
    target: { kind: 'team', projectId: 'p1' },
    timing: { kind: 'daily', time: '06:00', days: [1, 2, 3, 4, 5] },
    enabled: true,
    missed: 'run-once',
    state: 'active',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'user',
    consecutiveFailures: 0,
    unread: 0,
    ...over
  }
}

// Wednesday 18 Nov 2026, 10:00 local.
const NOW = new Date(2026, 10, 18, 10, 0, 0).getTime()

describe('week strip', () => {
  it('starts on Monday', () => {
    expect(new Date(weekStart(NOW)).getDay()).toBe(1)
    expect(new Date(weekStart(NOW)).getDate()).toBe(16)
  })
  it('puts a weekday schedule on Mon..Fri and marks today', () => {
    const days = weekDays([sched()], NOW)
    expect(days.map((d) => d.chips.length)).toEqual([1, 1, 1, 1, 1, 0, 0])
    expect(days[2].today).toBe(true)
    expect(days[0].chips[0].time).toBe('06:00')
  })
  it('keeps turned-off schedules but flags them', () => {
    const days = weekDays([sched({ enabled: false, state: 'paused' })], NOW)
    expect(days[0].chips[0].off).toBe(true)
    expect(weekDays([sched()], NOW, true)[0].chips[0].off).toBe(true)
  })
  it('caps chips per day and counts the rest', () => {
    const many = Array.from({ length: 5 }, (_, i) => sched({ id: `s${i}`, name: `S${i}`, timing: { kind: 'daily', time: `0${i}:00` } }))
    const d = weekDays(many, NOW)[0]
    expect(d.chips).toHaveLength(3)
    expect(d.more).toBe(2)
    expect(d.label).toContain('S4')
  })
  it('an interval schedule does not run away', () => {
    const d = weekDays([sched({ timing: { kind: 'interval', everyMinutes: 15, anchor: NOW } })], NOW)
    expect(d.reduce((n, x) => n + x.chips.length + x.more, 0)).toBeLessThanOrEqual(200)
  })
  it('a past one-off has no slot', () => {
    expect(weekDays([sched({ timing: { kind: 'once', at: NOW - 10 * 86_400_000 } })], NOW).every((d) => d.chips.length === 0)).toBe(true)
  })
})

describe('summary', () => {
  it('counts schedules that are on and finds the soonest', () => {
    const list = [sched({ id: 'a', nextRunAt: NOW + 5000 }), sched({ id: 'b', nextRunAt: NOW + 1000, name: 'B' }), sched({ id: 'c', enabled: false, state: 'paused', nextRunAt: NOW + 10 })]
    const s = boardSummary(list, false)
    expect(s.on).toBe(2)
    expect(s.nextName).toBe('B')
    expect(summaryText(s, NOW, false)).toMatch(/^2 on · next run today/)
  })
  it('says so when everything is paused or empty', () => {
    expect(summaryText(boardSummary([sched()], true), NOW, true)).toBe('1 on · all paused')
    expect(summaryText(boardSummary([], false), NOW, false)).toBe('No schedules yet')
    expect(summaryText(boardSummary([sched({ enabled: false, state: 'paused' })], false), NOW, false)).toBe('0 on · nothing due')
  })
  it('words tomorrow', () => {
    expect(dayTimeWords(NOW + 86_400_000, NOW)).toMatch(/^tomorrow /)
  })
})

describe('facts', () => {
  it('reads the contract, never invents', () => {
    expect(mayChangeFiles(sched({ target: { kind: 'ask', allowEdits: true } }))).toBe('Yes, in its folder')
    expect(mayChangeFiles(sched({ target: { kind: 'ask' } }))).toBe('No, it only reads')
    expect(mayChangeFiles(sched({ permissionMode: 'plan' }))).toBe('No, it only plans')
    expect(mayChangeFiles(sched())).toBe('As the project is set')
    expect(spendingLimit({ budgetUsd: 0.5 })).toBe('$0.50 a run')
    expect(spendingLimit({ budgetUsd: 3 })).toBe('$3 a run')
    expect(spendingLimit({})).toBe("The project's own limit")
    expect(detailFacts(sched({ target: { kind: 'team', projectId: 'p', team: 'single' } }), 'Every day').map((f) => f.value)[1]).toBe('One assistant')
  })
  it('last tone', () => {
    expect(lastTone({ consecutiveFailures: 0 })).toBe('none')
    expect(lastTone({ consecutiveFailures: 2 })).toBe('bad')
    expect(lastTone({ consecutiveFailures: 0, lastEntry: { at: 1, slotAt: 1, trigger: 'timer', result: 'started', outcome: 'error' } })).toBe('bad')
    expect(lastTone({ consecutiveFailures: 0, lastEntry: { at: 1, slotAt: 1, trigger: 'timer', result: 'started', outcome: 'finished' } })).toBe('ok')
  })
  it('colours are stable per schedule', () => {
    const l = [{ id: 'a', createdAt: 1 }, { id: 'b', createdAt: 2 }]
    expect(scheduleColour(l, 'a')).not.toBe(scheduleColour(l, 'b'))
    expect(scheduleColour(l, 'a')).toBe(scheduleColour([...l].reverse(), 'a'))
  })
})

describe('cost and last runs', () => {
  it('never turns unknown into zero', () => {
    expect(scheduleCostFigure(undefined).known).toBe(false)
    expect(scheduleCostFigure({ perRunUsd: null, sampleRuns: 0, runsPerWeek: 7, weeklyUsd: null }).text).toBe('Weekly cost unknown')
    expect(scheduleCostFigure({ perRunUsd: 0, sampleRuns: 3, runsPerWeek: 7, weeklyUsd: 0 }).text).toBe('$0.00 a week')
  })
  it('states the basis', () => {
    const f = scheduleCostFigure({ perRunUsd: 0.2, sampleRuns: 5, runsPerWeek: 7, weeklyUsd: 1.4 })
    expect(f.text).toBe('$1.40 a week')
    expect(f.basis).toContain('last 5 runs')
  })
  it('total says what it leaves out', () => {
    expect(totalCostFigure({ weeklyTotalUsd: 3, unknownCount: 2 }).basis).toContain('excludes 2 schedules')
    expect(totalCostFigure({ weeklyTotalUsd: null, unknownCount: 1 }).known).toBe(false)
  })
  it('keeps the newest seven started runs, oldest first, skipping skipped slots', () => {
    const mk = (i: number, o: Partial<ScheduleHistoryEntry> = {}): ScheduleHistoryEntry => ({ id: `e${i}`, scheduleId: 's', slotAt: i, at: i * 1000, trigger: 'timer', result: 'started', outcome: 'finished', costUsd: 0.1, ...o })
    const entries = [...Array.from({ length: 9 }, (_, i) => mk(i + 1)), mk(20, { result: 'skipped', reason: 'app-closed' }), mk(10, { result: 'failed', outcome: undefined, costUsd: null })]
    const bars = runBars(entries)
    expect(bars).toHaveLength(7)
    expect(bars[6].kind).toBe('error')
    expect(bars[6].costUsd).toBeNull()
    expect(bars[0].at).toBeLessThan(bars[1].at)
    expect(runBarsSummary(bars)).toContain('1 failed')
    expect(runBarsSummary([])).toBe('No runs yet.')
  })
})
