import { describe, expect, it } from 'vitest'
import type { Schedule, TodoItem } from '@shared/types'
import { nextLocalMidnight, openTodoRows, scheduledToday, scheduleTargetLabel, startOfLocalDay } from './todayModel'

const at = (y: number, m: number, d: number, h = 0, min = 0): number => new Date(y, m, d, h, min).getTime()

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

const entry = (when: number, result: 'started' | 'skipped' | 'failed' = 'started'): NonNullable<Schedule['lastEntry']> => ({ at: when, slotAt: when, trigger: 'timer', result, runId: 'run_1' }) as NonNullable<Schedule['lastEntry']>

describe('scheduledToday', () => {
  const now = at(2026, 10, 19, 10, 0)

  it('keeps 23:59 today and drops 00:01 tomorrow', () => {
    const rows = scheduledToday([sched('late', { nextRunAt: at(2026, 10, 19, 23, 59) }), sched('next', { nextRunAt: at(2026, 10, 20, 0, 1) })], now)
    expect(rows.map((r) => r.schedule.id)).toEqual(['late'])
  })

  it('the midnight itself belongs to tomorrow', () => {
    expect(scheduledToday([sched('m', { nextRunAt: at(2026, 10, 20, 0, 0) })], now)).toEqual([])
  })

  it('drops an upcoming run that is already past', () => {
    expect(scheduledToday([sched('past', { nextRunAt: at(2026, 10, 19, 9, 0) })], now)).toEqual([])
  })

  it('a run that started at 00:01 today counts as ran, yesterday 23:59 does not', () => {
    const rows = scheduledToday([sched('a', { lastEntry: entry(at(2026, 10, 19, 0, 1)) }), sched('b', { lastEntry: entry(at(2026, 10, 18, 23, 59)) })], now)
    expect(rows.map((r) => [r.schedule.id, r.state])).toEqual([['a', 'ran']])
  })

  it('skipped and failed entries are not runs', () => {
    expect(scheduledToday([sched('s', { lastEntry: entry(at(2026, 10, 19, 8), 'skipped') }), sched('f', { lastEntry: entry(at(2026, 10, 19, 8), 'failed') })], now)).toEqual([])
  })

  it('orders ran by time, then upcoming by time', () => {
    const rows = scheduledToday(
      [
        sched('up2', { nextRunAt: at(2026, 10, 19, 16) }),
        sched('ran2', { lastEntry: entry(at(2026, 10, 19, 9)) }),
        sched('up1', { nextRunAt: at(2026, 10, 19, 12) }),
        sched('ran1', { lastEntry: entry(at(2026, 10, 19, 7)) })
      ],
      now
    )
    expect(rows.map((r) => `${r.schedule.id}:${r.state}`)).toEqual(['ran1:ran', 'ran2:ran', 'up1:upcoming', 'up2:upcoming'])
  })

  it('a schedule that ran and is due again shows both', () => {
    const rows = scheduledToday([sched('h', { lastEntry: entry(at(2026, 10, 19, 9)), nextRunAt: at(2026, 10, 19, 11) })], now)
    expect(rows.map((r) => r.state)).toEqual(['ran', 'upcoming'])
  })

  it('excludes disabled and non-active schedules from upcoming', () => {
    const next = at(2026, 10, 19, 12)
    const rows = scheduledToday([sched('off', { enabled: false, nextRunAt: next }), sched('paused', { state: 'paused', nextRunAt: next }), sched('err', { state: 'error', nextRunAt: next }), sched('done', { state: 'done', nextRunAt: next }), sched('none')], now)
    expect(rows).toEqual([])
  })

  it('a disabled schedule that ran today still shows as ran', () => {
    const rows = scheduledToday([sched('off', { enabled: false, lastEntry: entry(at(2026, 10, 19, 8)) })], now)
    expect(rows.map((r) => r.state)).toEqual(['ran'])
  })

  it('midnight helpers follow local calendar days across a DST change', () => {
    // Late March / late October: a 23 or 25 hour local day. Local midnights come from the calendar, not from +24 h.
    for (const [y, m, d] of [[2026, 2, 29], [2026, 9, 25], [2026, 10, 1], [2026, 2, 8]] as const) {
      const noon = at(y, m, d, 12)
      expect(startOfLocalDay(noon)).toBe(at(y, m, d))
      expect(nextLocalMidnight(noon)).toBe(at(y, m, d + 1))
      const rows = scheduledToday([sched('x', { nextRunAt: at(y, m, d, 23, 30) }), sched('y', { nextRunAt: at(y, m, d + 1, 0, 30) })], noon)
      expect(rows.map((r) => r.schedule.id)).toEqual(['x'])
    }
  })
})

describe('scheduleTargetLabel', () => {
  it('names the project or Chat', () => {
    const projects = [{ id: 'p1', name: 'Billing API' }]
    expect(scheduleTargetLabel({ kind: 'team', projectId: 'p1' }, projects)).toBe('Billing API')
    expect(scheduleTargetLabel({ kind: 'ask' }, projects)).toBe('Chat')
  })
})

function todo(id: string, scope: TodoItem['scope'], updatedAt: number, over: Partial<TodoItem> = {}): TodoItem {
  return { id, scope, title: id, status: 'open', createdAt: 0, updatedAt, createdBy: 'user', editedBy: 'user', statusBy: 'user', ...over }
}

describe('openTodoRows', () => {
  const projects = [
    { id: 'p1', name: 'Billing API' },
    { id: 'p2', name: 'Docs' }
  ]

  it('leaves done items out and sorts newest first across lists', () => {
    const rows = openTodoRows(
      {
        chat: [todo('c1', { kind: 'chat' }, 30), todo('c2', { kind: 'chat' }, 50, { status: 'done' })],
        'project:p1': [todo('a', { kind: 'project', projectId: 'p1' }, 40), todo('b', { kind: 'project', projectId: 'p1' }, 10)],
        'project:p2': [todo('d', { kind: 'project', projectId: 'p2' }, 20)]
      },
      projects
    )
    expect(rows.map((r) => r.item.id)).toEqual(['a', 'c1', 'd', 'b'])
  })

  it('captions Chat and project lists and flags assistant items', () => {
    const rows = openTodoRows({ chat: [todo('c', { kind: 'chat' }, 2, { createdBy: 'agent' })], 'project:p1': [todo('a', { kind: 'project', projectId: 'p1' }, 1)] }, projects)
    expect(rows.map((r) => [r.list, r.agentAdded])).toEqual([['Chat', true], ['Billing API', false]])
  })

  it('skips items of a project that is gone and tolerates missing lists', () => {
    const rows = openTodoRows({ 'project:gone': [todo('x', { kind: 'project', projectId: 'gone' }, 1)], 'project:p1': undefined }, projects)
    expect(rows).toEqual([])
  })
})
