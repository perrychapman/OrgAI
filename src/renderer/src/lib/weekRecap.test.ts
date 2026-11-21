import { describe, expect, it } from 'vitest'
import type { CostSource, RunStatus } from '@shared/types'
import { AGENT_TIME_TOOLTIP, OPENS_USAGE_HINT, hasDecisionsCard, statCards, weekRecap, type RecapRun } from './weekRecap'

const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h, 0, 0).getTime()
// Saturday 7 November 2026: the week is Sun 1 Nov to Sat 7 Nov, the week before Sun 25 Oct to Sat 31 Oct.
const NOW = at(2026, 11, 7, 15)
const MIN = 60_000
const projects = [{ id: 'p1', name: 'Mobile app' }]

interface Opts {
  project?: string
  cost?: number | null
  source?: CostSource
  partial?: boolean
  wall?: number
  idle?: number
  waiting?: number
  limitHold?: number
  decisions?: number
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
        ...(o.partial ? { costPartial: true } : {}),
        wallMs: o.wall ?? 0,
        idleMs: o.idle ?? 0,
        waitingMs: o.waiting ?? 0,
        limitHoldMs: o.limitHold ?? 0,
        ...(o.decisions !== undefined ? { decisions: o.decisions } : {})
      } as unknown as NonNullable<RecapRun['usage']>)
  return { id, projectId: o.project ?? 'p1', startedAt, status: o.status ?? 'finished', totalCostUsd: 0, ...(o.kind ? { kind: o.kind } : {}), ...(usage ? { usage } : {}) }
}

describe('weekRecap figures (a fixture computed by hand)', () => {
  const runs = [
    run('a', at(2026, 11, 7, 9), { cost: 1.5, wall: 120 * MIN, idle: 30 * MIN, waiting: 10 * MIN }), // 80 min busy
    run('b', at(2026, 11, 7, 10), { cost: 0.5, wall: 60 * MIN }), // 60 min
    run('c', at(2026, 11, 5, 9), { cost: 2.2, wall: 40 * MIN, status: 'error' }), // 40 min, failed
    run('d', at(2026, 11, 1, 9), { cost: 0, wall: 0 }), // 0 min
    run('e', at(2026, 10, 28, 9), { cost: 1, wall: 30 * MIN }) // the week before
  ]
  const r = weekRecap(runs, projects, NOW)

  it('counts runs, failures and agent time of the week only', () => {
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

  it('has 7 days that sum to the run figure and 7 days before', () => {
    expect(r.days).toHaveLength(7)
    expect(r.days.reduce((n, d) => n + d.runs, 0)).toBe(r.runs)
    expect(r.previousDays).toHaveLength(7)
    expect(r.previous.runs).toBe(1)
    expect(r.previous.cost.costUsd).toBe(1)
  })
})

describe('statCards', () => {
  const runs = [run('a', at(2026, 11, 7, 9), { cost: 5, wall: 120 * MIN }), run('b', at(2026, 11, 6, 9), { cost: 3, wall: 60 * MIN }), run('p', at(2026, 10, 28), { cost: 4, wall: 90 * MIN })]
  const r = weekRecap(runs, projects, NOW)

  it('has the figures in canonical order, the focus first, and no Decisions card without the count', () => {
    expect(statCards(r, 'spend').map((c) => c.id)).toEqual(['spend', 'runs', 'time'])
    expect(statCards(r, 'time').map((c) => c.id)).toEqual(['time', 'spend', 'runs'])
    expect(statCards(r, 'decisions').map((c) => c.id)).toEqual(['spend', 'runs', 'time'])
  })

  it('says how each figure moved, with the amount and a direction, against the 7 days before', () => {
    const [spend, count, time] = statCards(r, 'spend')
    expect(spend.value).toBe(8)
    expect(spend.movement).toMatchObject({ dir: 'up', text: '$4.00 vs the 7 days before' })
    expect(count.movement).toMatchObject({ dir: 'up', text: '1 vs the 7 days before' })
    expect(time.text).toBe('3h 00m')
    expect(time.movement).toMatchObject({ dir: 'up', text: '1h 30m vs the 7 days before' })
    const down = statCards(weekRecap([run('a', at(2026, 11, 7), { cost: 1 }), run('p1', at(2026, 10, 28), { cost: 4 }), run('p2', at(2026, 10, 29), { cost: 4 })], projects, NOW), 'runs')
    expect(down[0].movement).toMatchObject({ dir: 'down', text: '1 vs the 7 days before' })
    expect(statCards(weekRecap([run('a', at(2026, 11, 7)), run('p', at(2026, 10, 28))], projects, NOW), 'runs')[0].movement.dir).toBe('same')
  })

  it('names the figure once and keeps the instruction out of the name (it is the description)', () => {
    const spend = statCards(r, 'spend')[0]
    expect(spend.name).toBe('Spend $8.00, up $4.00 vs the 7 days before')
    expect(spend.name.match(/\$8\.00/g)).toHaveLength(1)
    for (const c of statCards(r, 'spend')) expect(c.name).not.toMatch(/Opens Usage/)
    expect(OPENS_USAGE_HINT).toBe('Opens Usage for the same 7 days.')
  })

  it('offers Decisions as a lead figure only when its card is drawn', () => {
    expect(hasDecisionsCard(r)).toBe(statCards(r, 'spend').some((c) => c.id === 'decisions'))
    expect(hasDecisionsCard(weekRecap([], projects, NOW))).toBe(false)
  })

  it('opens Usage with a metric for Spend and Runs only', () => {
    const cards = Object.fromEntries(statCards(r, 'spend').map((c) => [c.id, c.metric]))
    expect(cards).toEqual({ spend: 'cost', runs: 'runs', time: undefined })
  })

  it('has one sparkline point per day', () => {
    for (const c of statCards(r, 'spend')) expect(c.series).toHaveLength(7)
  })
})

describe('agent time', () => {
  it('does not subtract the limit hold, which sits inside idle time', () => {
    const r = weekRecap([run('a', at(2026, 11, 7), { wall: 100 * MIN, idle: 60 * MIN, limitHold: 50 * MIN })], projects, NOW)
    expect(r.workMs).toBe(40 * MIN)
  })
  it('floors a run at zero and never goes negative', () => {
    expect(weekRecap([run('a', at(2026, 11, 7), { wall: 10 * MIN, idle: 20 * MIN, waiting: 20 * MIN })], projects, NOW).workMs).toBe(0)
  })
  it('leaves a run without usage out, ends the figure in "+" and says "at least" in words, and does not compare', () => {
    const r = weekRecap([run('a', at(2026, 11, 7, 9), { wall: 400 * MIN, cost: 1 }), run('b', at(2026, 11, 7, 10), { noUsage: true })], projects, NOW)
    expect(r.workPartial).toBe(true)
    expect(r.workText).toBe('6h 40m+')
    expect(r.workLabel).toBe('at least 6h 40m')
    const time = statCards(r, 'time')[0]
    expect(time.label2).toBe('at least 6h 40m')
    expect(time.movement.dir).toBe('none')
  })
  it('says not measured when no run in the window has usage', () => {
    const r = weekRecap([run('a', at(2026, 11, 7), { noUsage: true })], projects, NOW)
    expect(r.workText).toBe('unknown')
    const time = statCards(r, 'time')[0]
    expect(time.text).toBe('Not measured')
    expect(time.value).toBeNull()
  })
  it('is defined apart from Wall time', () => {
    expect(AGENT_TIME_TOOLTIP).toContain('Not the same as Wall time')
  })
})

describe('spend is honest', () => {
  it('is Not priced, never $0.00, when every run is unpriced, and is not compared', () => {
    const r = weekRecap([run('a', at(2026, 11, 7), { cost: null }), run('b', at(2026, 11, 6), { cost: null })], projects, NOW)
    expect(r.costKind).toBe('unknown')
    const spend = statCards(r, 'spend')[0]
    expect(spend.text).toBe('Not priced')
    expect(spend.value).toBeNull()
    expect(spend.movement.dir).toBe('none')
    expect(spend.series.every((p) => p.value === null || p.value === 0)).toBe(true)
    expect(spend.series.some((p) => p.kind === 'unknown')).toBe(true)
  })
  it('is a lower bound when one run is unpriced beside a priced one', () => {
    const r = weekRecap([run('a', at(2026, 11, 7), { cost: 4.2 }), run('b', at(2026, 11, 6), { cost: null })], projects, NOW)
    expect(r.costKind).toBe('partial')
    expect(r.cost.costUsd).toBeCloseTo(4.2)
    const spend = statCards(r, 'spend')[0]
    expect(spend.text).toBe('$4.20+')
    expect(spend.label2).toBe('at least $4.20')
  })
  it('says None, not $0.00, for a reported zero and for nothing spent (flat-rate plans)', () => {
    for (const o of [{ cost: 0, source: 'provider' as const }, { cost: 0 }]) {
      const r = weekRecap([run('a', at(2026, 11, 7), o)], projects, NOW)
      expect(r.costShown).toBe(false)
      expect(statCards(r, 'spend')[0].text).toBe('None')
    }
  })
})

describe('decisions', () => {
  it('shows only when a run of the week carries the count, and is a lower bound beside one that lacks it', () => {
    const all = weekRecap([run('a', at(2026, 11, 7), { decisions: 3 }), run('b', at(2026, 11, 6), { decisions: 2 }), run('p', at(2026, 10, 28), { decisions: 1 })], projects, NOW)
    const card = statCards(all, 'decisions')[0]
    expect(card.id).toBe('decisions')
    expect(card.value).toBe(5)
    expect(card.text).toBe('5')
    expect(card.movement).toMatchObject({ dir: 'up', text: '4 vs the 7 days before' })
    const mixed = weekRecap([run('a', at(2026, 11, 7), { decisions: 3 }), run('b', at(2026, 11, 6))], projects, NOW)
    const partial = statCards(mixed, 'decisions')[0]
    expect(partial.text).toBe('3+')
    expect(partial.label2).toBe('at least 3')
    expect(partial.movement.dir).toBe('none')
    expect(statCards(weekRecap([run('a', at(2026, 11, 7))], projects, NOW), 'decisions').some((c) => c.id === 'decisions')).toBe(false)
  })
  it('treats an absent count as unknown, never 0', () => {
    expect(weekRecap([run('a', at(2026, 11, 7), { noUsage: true })], projects, NOW).days[6].decisionRuns).toBe(0)
  })
})

describe('scope', () => {
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
    expect(quiet.costShown).toBe(false)
  })
})
