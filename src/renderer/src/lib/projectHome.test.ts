import { describe, expect, it } from 'vitest'
import type { AgentInstance, Schedule, TodoItem } from '@shared/types'
import {
  HOME_TODOS_MAX,
  PERMISSION_WORDS,
  TEAM_GROUPS_MAX,
  TYPICAL_MIN_RUNS,
  firstRunDate,
  homeTodos,
  isRunningNow,
  median,
  mergeDraftText,
  safeSquareColor,
  monthSpend,
  monthStart,
  permissionWords,
  plural,
  projectSchedules,
  runningLine,
  runningNow,
  scheduleTone,
  teamLine,
  teamSummary,
  type RunningNowIn
} from './projectHome'

const agent = (id: string, state: AgentInstance['state'], parentId: string | null = 'root'): AgentInstance =>
  ({ id, roleId: null, roleSlug: id, name: id, parentId, spawnToolUseId: null, state, activity: '', inputTokens: 0, outputTokens: 0, costUsd: 0 }) as AgentInstance

const run = (id: string, status: string, startedAt: number, agents: AgentInstance[], extra: Partial<RunningNowIn> = {}): RunningNowIn => ({
  summary: { id, status, kind: 'work', startedAt, prompt: 'p', totalCostUsd: 0 } as RunningNowIn['summary'],
  agents: Object.fromEntries(agents.map((a) => [a.id, a])),
  decisions: 0,
  ...extra
})

describe('permission words and plurals', () => {
  it('has words for every mode and defaults to asking', () => {
    for (const mode of Object.keys(PERMISSION_WORDS)) expect(permissionWords(mode as keyof typeof PERMISSION_WORDS).length).toBeGreaterThan(5)
    expect(permissionWords(undefined)).toBe('asks before risky actions')
  })
  it('says the team line from the count and mode', () => {
    expect(teamLine(12, 'default')).toBe('12 roles · asks before risky actions')
    expect(teamLine(1, 'plan')).toBe('1 role · plans only, changes nothing')
    expect(plural(1, 'role')).toBe('1 role')
    expect(plural(2, 'group')).toBe('2 groups')
  })
})

describe('mergeDraftText', () => {
  it('keeps what is there and adds the new text on its own line', () => {
    expect(mergeDraftText('', ' Fix a failing test ')).toBe('Fix a failing test')
    expect(mergeDraftText('Already typing', 'Fix a failing test')).toBe('Already typing\nFix a failing test')
    expect(mergeDraftText('Already typing  \n', 'Next')).toBe('Already typing\nNext')
  })
  it('never doubles the text and ignores a blank addition', () => {
    expect(mergeDraftText('Fix a failing test', 'Fix a failing test')).toBe('Fix a failing test')
    expect(mergeDraftText('a\nFix it', 'Fix it')).toBe('a\nFix it')
    expect(mergeDraftText('keep', '   ')).toBe('keep')
  })
})

describe('running now', () => {
  it('is nothing without a live work run', () => {
    expect(runningNow([])).toBeNull()
    expect(runningNow([run('r1', 'finished', 1, [])])).toBeNull()
    expect(runningNow([run('r1', 'idle', 1, [agent('root', 'idle', null)])])).toBeNull()
  })
  it('counts a run as running while it works or waits on a decision, work runs only', () => {
    expect(isRunningNow(run('a', 'running', 1, []))).toBe(true)
    expect(isRunningNow(run('a', 'idle', 1, [], { decisions: 2 }))).toBe(true)
    expect(isRunningNow(run('a', 'error', 1, [], { decisions: 2 }))).toBe(false)
    const setup = run('a', 'running', 1, [])
    setup.summary = { ...setup.summary, kind: 'setup' }
    expect(isRunningNow(setup)).toBe(false)
  })
  it('picks the newest live run and describes its agents, plan and cost', () => {
    const older = run('old', 'running', 100, [agent('root', 'thinking', null)])
    const newer = run(
      'new',
      'running',
      200,
      [agent('root', 'thinking', null), agent('a', 'tool'), agent('b', 'waiting'), agent('c', 'done'), agent('d', 'idle')],
      {
        decisions: 1,
        plan: { goal: 'g', status: 'active', autoContinues: 0, updatedAt: 1, steps: [{ id: 'p1', title: 'One', status: 'done' }, { id: 'p2', title: 'Two', status: 'in_progress' }, { id: 'p3', title: 'Three', status: 'pending' }] }
      }
    )
    newer.summary = { ...newer.summary, totalCostUsd: 2.31 }
    const r = runningNow([older, newer])!
    expect(r.runId).toBe('new')
    expect(r.agentCount).toBe(4)
    expect(r.working).toBe(1)
    expect(r.waiting).toBe(1)
    expect(r.marks.map((m) => m.state)).toEqual(['waiting', 'working', 'idle', 'done'])
    expect(r.summary).toContain('waiting on you')
    expect(r.planText).toBe('Step 2 of 3')
    expect(runningLine(r)).toEqual({ parts: ['Step 2 of 3', '1 working'], waitingText: '1 waiting on you', cost: '$2.31' })
  })
  it('leaves out parts it has no data for', () => {
    const r = runningNow([run('x', 'running', 1, [agent('root', 'thinking', null)])])!
    expect(r.marks).toEqual([])
    expect(r.planText).toBe('')
    expect(runningLine(r)).toEqual({ parts: [], waitingText: '', cost: '' })
  })
})

describe('month spend', () => {
  const row = (cost: number | null, partial = false, kind = 'work') => ({ kind, usage: { costUsd: cost, costSource: cost === null ? 'unknown' : 'provider', ...(partial ? { costPartial: true } : {}) } })
  const overview = (rows: ReturnType<typeof row>[], totalCost: number | null, extra: Record<string, unknown> = {}) =>
    ({
      matchedRuns: rows.length,
      runs: rows,
      totals: { costUsd: totalCost, costSource: totalCost === null ? 'unknown' : 'provider' },
      costKnownRuns: rows.length,
      costUnknownRuns: 0,
      ...extra
    }) as unknown as Parameters<typeof monthSpend>[0]

  it('is null with no runs', () => {
    expect(monthSpend(null)).toBeNull()
    expect(monthSpend(undefined)).toBeNull()
    expect(monthSpend(overview([], 0))).toBeNull()
  })
  it('gives the total, the count and the median once there are enough priced runs', () => {
    const s = monthSpend(overview([row(0.5), row(1), row(10)], 11.5))!
    expect(s.text).toBe('$11.50')
    expect(s.runs).toBe(3)
    expect(s.typicalUsd).toBe(1)
    expect(s.typicalText).toBe('$1.00')
  })
  it('says nothing typical below the minimum, and skips unpriced or partial runs', () => {
    expect(TYPICAL_MIN_RUNS).toBe(3)
    expect(monthSpend(overview([row(1), row(2)], 3))!.typicalText).toBeNull()
    const s = monthSpend(overview([row(1), row(2), row(null), row(5, true), row(3), row(9, false, 'setup')], 20, { costUnknownRuns: 2 }))!
    expect(s.typicalUsd).toBe(2)
    expect(s.unknownRuns).toBe(2)
    expect(s.text.endsWith('+')).toBe(true)
  })
  it('reads an unknown total as unknown, never $0', () => {
    expect(monthSpend(overview([row(null)], null))!.text).toBe('unknown')
  })
  it('never shows $0 when runs matched but their cost is not known', () => {
    // No figure at all for matched runs
    const none = { ...overview([row(null)], null), totals: { costUsd: null, costSource: 'none' } } as unknown as Parameters<typeof monthSpend>[0]
    expect(monthSpend(none)!.text).toBe('unknown')
    // A zero total that leaves out runs of unknown cost
    const zeroWithUnknown = { ...overview([row(null)], 0), totals: { costUsd: 0, costSource: 'none' }, costUnknownRuns: 1 } as unknown as Parameters<typeof monthSpend>[0]
    expect(monthSpend(zeroWithUnknown)!.text).toBe('unknown')
    expect(monthSpend(zeroWithUnknown)!.title).toMatch(/unknown/i)
  })
  it('keeps $0.00 for a true zero: every matched run known and nothing spent', () => {
    const zero = { ...overview([row(0)], 0), totals: { costUsd: 0, costSource: 'none' } } as unknown as Parameters<typeof monthSpend>[0]
    expect(monthSpend(zero)!.text).toBe('$0.00')
  })
  it('finds the start of the local month and the median', () => {
    const now = new Date(2026, 10, 22, 15, 30).getTime()
    expect(monthStart(now)).toBe(new Date(2026, 10, 1).getTime())
    expect(median([])).toBeNull()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
})

describe('role square colour', () => {
  it('lets only hex colours into an inline style', () => {
    expect(safeSquareColor('#12aBcd')).toBe('#12aBcd')
    expect(safeSquareColor('#fff')).toBe('#fff')
    expect(safeSquareColor('red')).toBe('var(--border-strong)')
    expect(safeSquareColor('url(https://x/y)')).toBe('var(--border-strong)')
    expect(safeSquareColor('#fff; background: red')).toBe('var(--border-strong)')
    expect(safeSquareColor(undefined)).toBe('var(--border-strong)')
  })
})

describe('team groups', () => {
  const r = (id: string, reportsTo: string | null, name = id) => ({ id, name, reportsTo, color: `#${id}` })
  it('has no groups for a chart with only the root', () => {
    expect(teamSummary([r('root', null)])).toEqual({ roleCount: 1, groups: [] })
    expect(teamSummary([])).toEqual({ roleCount: 0, groups: [] })
  })
  it('makes a group of each lead with reports and one of the leaf direct reports', () => {
    const t = teamSummary([r('root', null), r('lead-a', 'root', 'Build lead'), r('a1', 'lead-a'), r('a2', 'lead-a'), r('lead-b', 'root', 'Quality lead'), r('b1', 'lead-b'), r('solo', 'root', 'Solo')])
    expect(t.roleCount).toBe(7)
    expect(t.groups.map((g) => [g.name, g.count])).toEqual([
      ['Build lead', 3],
      ['Quality lead', 2],
      ['Direct reports', 1]
    ])
    expect(t.groups[0].colors).toEqual(['#lead-a', '#a1', '#a2'])
  })
  it('keeps every role even with an unknown parent or a cycle, and folds extra groups into Other', () => {
    const orphan = teamSummary([r('root', null), r('x', 'gone')])
    expect(orphan.groups.map((g) => g.count)).toEqual([2 - 1])
    const many = [r('root', null)]
    for (let i = 0; i < 8; i++) many.push(r(`l${i}`, 'root'), r(`k${i}`, `l${i}`))
    const t = teamSummary(many)
    expect(t.groups).toHaveLength(TEAM_GROUPS_MAX)
    expect(t.groups[TEAM_GROUPS_MAX - 1].name).toBe('Other')
    expect(t.groups.reduce((n, g) => n + g.count, 0)).toBe(16)
    const cyc = teamSummary([r('root', null), r('a', 'b'), r('b', 'a')])
    expect(cyc.roleCount).toBe(3)
  })
})

describe('to-dos', () => {
  const todo = (id: string, status: 'open' | 'done', createdBy: 'user' | 'agent', updatedAt: number): TodoItem =>
    ({ id, scope: { kind: 'project', projectId: 'p' }, title: id, status, createdAt: 1, updatedAt, createdBy, editedBy: createdBy, statusBy: createdBy }) as TodoItem
  it('lists open items, the team ones first, capped, with the open count', () => {
    const items = [todo('u-new', 'open', 'user', 50), todo('a-old', 'open', 'agent', 10), todo('done', 'done', 'agent', 99), todo('a-new', 'open', 'agent', 30)]
    const h = homeTodos(items)
    expect(h.open).toBe(3)
    expect(h.rows.map((x) => x.id)).toEqual(['a-new', 'a-old', 'u-new'])
    expect(h.rows[0].fromTeam).toBe(true)
    expect(h.rows[0].item.id).toBe('a-new')
    const many = Array.from({ length: 9 }, (_, i) => todo(`t${i}`, 'open', 'user', i))
    expect(homeTodos(many).rows).toHaveLength(HOME_TODOS_MAX)
    expect(homeTodos(many).open).toBe(9)
    expect(homeTodos(undefined)).toEqual({ rows: [], open: 0 })
  })
})

describe('schedules', () => {
  const sch = (id: string, projectId: string, over: Partial<Schedule> = {}): Schedule =>
    ({
      id,
      name: id,
      prompt: 'x',
      target: { kind: 'team', projectId },
      timing: { kind: 'daily' } as Schedule['timing'],
      enabled: true,
      missed: 'run-once',
      state: 'active',
      createdAt: 1,
      updatedAt: 1,
      createdBy: 'user',
      consecutiveFailures: 0,
      unread: 0,
      ...over
    }) as Schedule
  const entry = (over: Record<string, unknown>) => ({ at: 1_700_000_000_000, slotAt: 1_700_000_000_000, trigger: 'timer', result: 'started', ...over }) as Schedule['lastEntry']
  it('tones the newest result', () => {
    expect(scheduleTone(sch('a', 'p', { lastEntry: entry({ outcome: 'finished' }) }))).toBe('ok')
    expect(scheduleTone(sch('a', 'p', { lastEntry: entry({ outcome: 'error' }) }))).toBe('bad')
    expect(scheduleTone(sch('a', 'p', { lastEntry: entry({ result: 'failed' }) }))).toBe('bad')
    expect(scheduleTone(sch('a', 'p', { lastEntry: entry({ result: 'skipped', reason: 'previous-running' }) }))).toBe('warn')
    expect(scheduleTone(sch('a', 'p', { lastEntry: entry({ outcome: 'needs-you' }) }))).toBe('warn')
    expect(scheduleTone(sch('a', 'p', {}))).toBe('muted')
    expect(scheduleTone(sch('a', 'p', { consecutiveFailures: 2 }))).toBe('bad')
  })
  it('keeps only this project, drops done ones, newest handled first, paused ones stay', () => {
    const list = [
      sch('old', 'p', { lastEntry: entry({ at: 10, outcome: 'finished' }) }),
      sch('new', 'p', { lastEntry: entry({ at: 99, outcome: 'finished' }), enabled: false }),
      sch('other', 'q'),
      sch('ask', 'p', { target: { kind: 'ask' } }),
      sch('done', 'p', { state: 'done' })
    ]
    const lines = projectSchedules(list, 'p')
    expect(lines.map((l) => l.id)).toEqual(['new', 'old'])
    expect(lines[0].enabled).toBe(false)
    expect(lines[0].last).toContain('Finished')
    expect(projectSchedules(null, 'p')).toEqual([])
  })
})

describe('first run date', () => {
  it('is the oldest start, or nothing', () => {
    expect(firstRunDate([])).toBe('')
    expect(firstRunDate([{ startedAt: new Date(2026, 10, 3).getTime() }, { startedAt: new Date(2026, 10, 9).getTime() }])).toBe('3 Nov 2026')
  })
})
