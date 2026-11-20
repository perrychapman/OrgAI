import { describe, expect, it } from 'vitest'
import type { CostSource, RunStatus } from '@shared/types'
import { TIME_WORKING_TOOLTIP, topProjectText, weekRecap, type RecapRun } from './weekRecap'

const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h, 0, 0).getTime()
const NOW = at(2026, 11, 7, 15)
const MIN = 60_000
const projects = [
  { id: 'p1', name: 'Mobile app' },
  { id: 'p2', name: 'Billing API' },
  { id: 'p3', name: 'Docs site' }
]

interface Opts {
  project?: string
  cost?: number | null
  source?: CostSource
  wall?: number
  idle?: number
  waiting?: number
  limitHold?: number
  noUsage?: boolean
  status?: RunStatus
  kind?: RecapRun['kind']
}

function run(id: string, startedAt: number, o: Opts = {}): RecapRun {
  const usage = o.noUsage
    ? undefined
    : ({
        costUsd: o.cost === undefined ? 0 : o.cost,
        costSource: o.source ?? (o.cost === null ? 'unknown' : !o.cost ? 'none' : 'provider'),
        wallMs: o.wall ?? 0,
        idleMs: o.idle ?? 0,
        waitingMs: o.waiting ?? 0,
        limitHoldMs: o.limitHold ?? 0
      } as unknown as NonNullable<RecapRun['usage']>)
  return { id, projectId: o.project ?? 'p1', startedAt, status: o.status ?? 'finished', totalCostUsd: 0, ...(o.kind ? { kind: o.kind } : {}), ...(usage ? { usage } : {}) }
}

describe('weekRecap figures (a fixture computed by hand)', () => {
  const runs = [
    run('a', at(2026, 11, 7, 9), { project: 'p1', cost: 1.5, wall: 120 * MIN, idle: 30 * MIN, waiting: 10 * MIN }), // 80 min busy
    run('b', at(2026, 11, 7, 10), { project: 'p1', cost: 0.5, wall: 60 * MIN }), // 60 min
    run('c', at(2026, 11, 5, 9), { project: 'p2', cost: 2.2, wall: 40 * MIN, status: 'error' }), // 40 min, failed
    run('d', at(2026, 11, 1, 9), { project: 'p3', cost: 0, wall: 0 }) // 0 min
  ]
  const r = weekRecap(runs, projects, NOW)

  it('counts runs, failures and time working', () => {
    expect(r.runs).toBe(4)
    expect(r.failed).toBe(1)
    expect(r.workMs).toBe(180 * MIN)
    expect(r.workPartial).toBe(false)
    expect(r.workText).toBe('3h 00m')
    expect(r.workLabel).toBe('3h 00m')
  })

  it('sums spend and shows it', () => {
    expect(r.costKind).toBe('known')
    expect(r.cost.costUsd).toBeCloseTo(4.2)
    expect(r.costShown).toBe(true)
  })

  it('names the most active project, newest run breaking a tie, when two or more projects ran', () => {
    expect(r.top).toEqual({ id: 'p1', name: 'Mobile app', runs: 2 })
    expect(topProjectText(r.top!)).toBe('Most active: Mobile app, 2 runs')
    const tie = weekRecap([run('a', at(2026, 11, 7, 9), { project: 'p1' }), run('b', at(2026, 11, 6, 9), { project: 'p2' })], projects, NOW)
    expect(tie.top?.id).toBe('p1')
    const tie2 = weekRecap([run('a', at(2026, 11, 5, 9), { project: 'p1' }), run('b', at(2026, 11, 6, 9), { project: 'p2' })], projects, NOW)
    expect(tie2.top?.id).toBe('p2')
    expect(topProjectText({ id: 'x', name: 'Docs site', runs: 1 })).toBe('Most active: Docs site, 1 run')
  })

  it('has the ledger days summing to the run figure', () => {
    expect(r.days).toHaveLength(7)
    expect(r.days.reduce((n, d) => n + d.runs, 0)).toBe(r.runs)
  })
})

describe('weekRecap most active', () => {
  it('is absent with one active project, or only Chat runs beside one project', () => {
    expect(weekRecap([run('a', at(2026, 11, 7), { project: 'p1' }), run('b', at(2026, 11, 6), { project: 'p1' })], projects, NOW).top).toBeNull()
    expect(weekRecap([run('a', at(2026, 11, 7), { project: 'p1' }), run('b', at(2026, 11, 6), { project: 'quick' })], projects, NOW).top).toBeNull()
  })
  it('ignores runs outside the window and runs of unknown projects', () => {
    expect(weekRecap([run('a', at(2026, 11, 7), { project: 'p1' }), run('b', at(2026, 10, 20), { project: 'p2' }), run('c', at(2026, 11, 6), { project: 'gone' })], projects, NOW).top).toBeNull()
  })
})

describe('weekRecap time working', () => {
  it('does not subtract the limit hold, which sits inside idle time', () => {
    const r = weekRecap([run('a', at(2026, 11, 7), { wall: 100 * MIN, idle: 60 * MIN, limitHold: 50 * MIN })], projects, NOW)
    expect(r.workMs).toBe(40 * MIN)
  })
  it('floors a run at zero and never goes negative', () => {
    expect(weekRecap([run('a', at(2026, 11, 7), { wall: 10 * MIN, idle: 20 * MIN, waiting: 20 * MIN })], projects, NOW).workMs).toBe(0)
  })
  it('leaves a run without usage out and ends the figure in "+" with the accessible text "at least"', () => {
    const r = weekRecap([run('a', at(2026, 11, 7, 9), { wall: 400 * MIN, cost: 1 }), run('b', at(2026, 11, 7, 10), { noUsage: true })], projects, NOW)
    expect(r.workPartial).toBe(true)
    expect(r.workText).toBe('6h 40m+')
    expect(r.workLabel).toBe('at least 6h 40m')
  })
  it('says unknown when no run in the window has usage', () => {
    const r = weekRecap([run('a', at(2026, 11, 7), { noUsage: true })], projects, NOW)
    expect(r.workText).toBe('unknown')
    expect(r.workLabel).toBe('unknown')
  })
  it('carries the tooltip words', () => {
    expect(TIME_WORKING_TOOLTIP).toBe('Time runs were busy this week. Time spent waiting for you or idle is left out. Parallel agents are not added together.')
  })
})

describe('weekRecap spend is honest', () => {
  it('is unknown, never $0.00, when every run is unpriced', () => {
    const r = weekRecap([run('a', at(2026, 11, 7), { cost: null }), run('b', at(2026, 11, 6), { cost: null })], projects, NOW)
    expect(r.costKind).toBe('unknown')
    expect(r.costShown).toBe(true)
  })
  it('is a lower bound when one run is unpriced beside a priced one', () => {
    const r = weekRecap([run('a', at(2026, 11, 7), { cost: 4.2 }), run('b', at(2026, 11, 6), { cost: null })], projects, NOW)
    expect(r.costKind).toBe('partial')
    expect(r.costShown).toBe(true)
    expect(r.cost.costUsd).toBeCloseTo(4.2)
  })
  it('is omitted for a reported zero and for nothing spent (flat-rate plans)', () => {
    expect(weekRecap([run('a', at(2026, 11, 7), { cost: 0, source: 'provider' })], projects, NOW).costShown).toBe(false)
    expect(weekRecap([run('a', at(2026, 11, 7), { cost: 0 })], projects, NOW).costShown).toBe(false)
    expect(weekRecap([run('a', at(2026, 11, 7), { noUsage: true })], projects, NOW).costShown).toBe(false)
  })
})

describe('weekRecap scope', () => {
  it('counts work runs of every project, Chat included, and leaves setup and assistant kinds out', () => {
    const r = weekRecap(
      [
        run('w', at(2026, 11, 7), { project: 'p1' }),
        run('chat', at(2026, 11, 7), { project: 'quick' }),
        run('setup', at(2026, 11, 7), { project: 'p1', kind: 'setup' }),
        run('mcp', at(2026, 11, 7), { project: 'harness', kind: 'mcp-assistant' as never })
      ],
      projects,
      NOW
    )
    expect(r.runs).toBe(2)
  })
  it('counts each run id once and is empty for a quiet week', () => {
    expect(weekRecap([run('a', at(2026, 11, 7)), run('a', at(2026, 11, 7))], projects, NOW).runs).toBe(1)
    const quiet = weekRecap([], projects, NOW)
    expect(quiet.runs).toBe(0)
    expect(quiet.top).toBeNull()
    expect(quiet.costShown).toBe(false)
  })
})

describe('weekRecap share (the project share bar)', () => {
  it('divides the week over projects from the same runs the ledger counts', () => {
    const runs = [
      run('a', at(2026, 11, 7), { project: 'p2' }),
      run('b', at(2026, 11, 6), { project: 'p2' }),
      run('c', at(2026, 11, 5), { project: 'p1' }),
      run('old', at(2026, 10, 1), { project: 'p3' }),
      run('setup', at(2026, 11, 7), { project: 'p3', kind: 'setup' })
    ]
    const r = weekRecap(runs, projects, NOW)
    expect(r.share.show).toBe(true)
    expect(r.share.segments.map((s) => [s.name, s.runs])).toEqual([['Billing API', 2], ['Mobile app', 1]])
    expect(r.share.total).toBe(r.runs)
    expect(r.share.text).toBe('Runs by project this week: Billing API 2, Mobile app 1.')
  })
  it('does not show with one project', () => {
    expect(weekRecap([run('a', at(2026, 11, 7)), run('b', at(2026, 11, 6))], projects, NOW).share.show).toBe(false)
  })
})
