import { describe, expect, it } from 'vitest'
import type { Schedule } from '@shared/types'
import { awayText, dayWord, scheduleKindLabel, scheduleTargetLabel, SOON_MS, upNextName, upNextRows } from './upNext'

const at = (y: number, m: number, d: number, h = 0, min = 0): number => new Date(y, m, d, h, min).getTime()
const MIN = 60_000
const HOUR = 60 * MIN

function sched(id: string, over: Partial<Schedule> = {}): Schedule {
  return {
    id,
    name: id,
    prompt: 'p',
    target: { kind: 'ask' },
    timing: { kind: 'daily', time: '09:00' } as unknown as Schedule['timing'],
    enabled: true,
    missed: 'run-once',
    state: 'active',
    createdAt: 0,
    updatedAt: 0,
    createdBy: 'user',
    consecutiveFailures: 0,
    unread: 0,
    ...over
  }
}

const NOW = at(2026, 10, 19, 10, 0)
const projects = [{ id: 'p1', name: 'Billing API' }]
const clock = (ms: number): string => `c${ms % 1000}`

describe('upNextRows', () => {
  it('lists enabled active schedules with a next time, soonest first, and nothing else', () => {
    const next = NOW + 2 * HOUR
    const rows = upNextRows(
      [
        sched('later', { nextRunAt: NOW + 3 * HOUR }),
        sched('soon', { nextRunAt: NOW + 20 * MIN }),
        sched('off', { enabled: false, nextRunAt: next }),
        sched('paused', { state: 'paused', nextRunAt: next }),
        sched('err', { state: 'error', nextRunAt: next }),
        sched('done', { state: 'done', nextRunAt: next }),
        sched('none')
      ],
      NOW,
      projects,
      clock
    )
    expect(rows.map((r) => r.schedule.id)).toEqual(['soon', 'later'])
  })

  it('breaks a tie by id', () => {
    const t = NOW + HOUR
    expect(upNextRows([sched('b', { nextRunAt: t }), sched('a', { nextRunAt: t })], NOW, projects, clock).map((r) => r.schedule.id)).toEqual(['a', 'b'])
  })

  it('marks the firing within the hour soon, including one that is due', () => {
    const rows = upNextRows([sched('a', { nextRunAt: NOW + SOON_MS }), sched('b', { nextRunAt: NOW + SOON_MS + 1 }), sched('c', { nextRunAt: NOW - 5 * MIN })], NOW, projects, clock)
    expect(rows.map((r) => [r.schedule.id, r.soon])).toEqual([['c', true], ['a', true], ['b', false]])
    expect(rows[0].away).toBe('Due now')
  })

  it('names the project and the kind of run', () => {
    const [a, b, c] = upNextRows(
      [
        sched('a', { target: { kind: 'team', projectId: 'p1' }, nextRunAt: NOW + MIN * 5 }),
        sched('b', { target: { kind: 'team', projectId: 'p1', team: 'single' }, nextRunAt: NOW + MIN * 6 }),
        sched('c', { target: { kind: 'team', projectId: 'gone' }, nextRunAt: NOW + MIN * 7 })
      ],
      NOW,
      projects,
      clock
    )
    expect([a.project, a.kind]).toEqual(['Billing API', 'Team run'])
    expect([b.project, b.kind]).toEqual(['Billing API', 'One assistant'])
    expect(c.project).toBe('A project that no longer exists')
    expect(scheduleTargetLabel({ kind: 'ask' }, projects)).toBe('Chat')
    expect(scheduleKindLabel({ kind: 'ask' })).toBe('Chat run')
  })
})

describe('awayText', () => {
  it('reads minutes under an hour, hours under a day, days after', () => {
    expect(awayText(NOW + 20 * MIN, NOW)).toBe('In 20 min')
    expect(awayText(NOW + 30_000, NOW)).toBe('In under a minute')
    expect(awayText(NOW + 3 * HOUR, NOW)).toBe('In 3 h')
    expect(awayText(NOW + 24 * HOUR, NOW)).toBe('In 1 day')
    expect(awayText(NOW + 50 * HOUR, NOW)).toBe('In 2 days')
    expect(awayText(NOW, NOW)).toBe('Due now')
  })
})

describe('dayWord', () => {
  it('says Today, Tomorrow, a weekday within a week and a date after that', () => {
    expect(dayWord(at(2026, 10, 19, 23, 59), NOW)).toBe('Today')
    expect(dayWord(at(2026, 10, 20, 0, 1), NOW)).toBe('Tomorrow')
    expect(dayWord(at(2026, 10, 23, 9), NOW)).toBe('Mon')
    expect(dayWord(at(2026, 10, 30, 9), NOW)).toBe('30 Nov')
  })

  it('follows local calendar days across a daylight saving change', () => {
    for (const [y, m, d] of [[2026, 2, 29], [2026, 9, 25], [2026, 10, 1], [2026, 2, 8]] as const) {
      expect(dayWord(at(y, m, d + 1, 0, 30), at(y, m, d, 12))).toBe('Tomorrow')
      expect(dayWord(at(y, m, d, 23, 30), at(y, m, d, 12))).toBe('Today')
    }
  })
})

describe('upNextName', () => {
  it('names the schedule, when, where, how far and what it opens', () => {
    const [row] = upNextRows([sched('Weekly review', { target: { kind: 'team', projectId: 'p1' }, nextRunAt: NOW + 17 * HOUR })], NOW, projects, () => '09:00 AM')
    expect(upNextName(row)).toBe('Weekly review, Tomorrow 09:00 AM, Billing API, Team run. In 17 h. Open schedule')
  })
})
