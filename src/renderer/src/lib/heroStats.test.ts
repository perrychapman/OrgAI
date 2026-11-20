import { describe, expect, it } from 'vitest'
import { costView, type CostInput } from './cost'
import { HERO_MAX_TILES, heroStats, heroTileName, type HeroInput } from './heroStats'

const view = (c: CostInput) => costView(c, { compact: true })
const known: CostInput = { costUsd: 4.2, costSource: 'provider' }
const partial: CostInput = { costUsd: 4.2, costSource: 'provider', costPartial: true }
const unknown: CostInput = { costUsd: null, costSource: 'unknown' }
const nothing: CostInput = { costUsd: 0, costSource: 'none' }

const quiet: HeroInput = {
  firstLaunch: false,
  ready: true,
  anyRunEver: true,
  decisions: 0,
  awaitingReply: 0,
  workingAgents: 0,
  workingRuns: 0,
  finished: 0,
  failed: 0,
  longAgo: false,
  runsToday: 0,
  spend: { shown: false, view: view(nothing) }
}
const make = (over: Partial<HeroInput>): ReturnType<typeof heroStats> => heroStats({ ...quiet, ...over })
const stats = (over: Partial<HeroInput>): string[] => make(over).tiles.map((t) => t.stat)

describe('heroStats', () => {
  it('shows only the calm all-clear tile and the sentence when nothing is going on', () => {
    const m = make({})
    expect(m.tiles).toHaveLength(1)
    expect(m.tiles[0]).toMatchObject({ stat: 'waiting', tone: 'success', calm: true, label: 'Nothing waiting', target: 'needs' })
    expect(m.sentence).toBe(true)
    expect(heroTileName(m.tiles[0]!, false)).toBe('All clear, nothing waiting on you.')
  })

  it('never draws a row of zeros: zero tiles are left out', () => {
    expect(stats({ finished: 2 })).toEqual(['waiting', 'finished'])
    for (const t of make({ finished: 2, runsToday: 0 }).tiles) expect(t.figure).not.toBe('0')
  })

  it('puts waiting first and replaces the all-clear tile when a decision waits', () => {
    const m = make({ decisions: 2, workingAgents: 3, workingRuns: 2, finished: 1, runsToday: 4, spend: { shown: true, view: view(known) } })
    expect(m.tiles.map((t) => t.stat)).toEqual(['waiting', 'working', 'finished', 'today', 'spend'])
    expect(m.tiles[0]).toMatchObject({ tone: 'warning', figure: '2', calm: false, target: 'needs' })
    expect(heroTileName(m.tiles[0]!, true)).toBe('2 decisions waiting on you. Go to Waiting on you.')
    expect(m.sentence).toBe(false)
  })

  it('is capped at five tiles', () => {
    const m = make({ decisions: 1, workingAgents: 1, workingRuns: 1, finished: 1, failed: 1, runsToday: 1, spend: { shown: true, view: view(known) } })
    expect(m.tiles.length).toBeLessThanOrEqual(HERO_MAX_TILES)
  })

  it('says 1 decision in the singular', () => {
    expect(make({ decisions: 1 }).tiles[0]!.summary).toBe('1 decision waiting on you')
  })

  it('does not call it all clear while a run waits for a reply', () => {
    const t = make({ awaitingReply: 2 }).tiles[0]!
    expect(t).toMatchObject({ stat: 'waiting', tone: 'warning', calm: false, figure: '2', target: 'needs' })
    expect(t.summary).toBe('2 runs idle and awaiting reply')
  })

  it('counts working agents, falling back to runs', () => {
    const agents = make({ workingAgents: 3, workingRuns: 2 }).tiles.find((t) => t.stat === 'working')!
    expect(agents).toMatchObject({ figure: '3', label: 'Agents working', target: 'working', tone: 'info' })
    expect(agents.summary).toBe('3 agents working in 2 runs')
    const one = make({ workingAgents: 1, workingRuns: 1 }).tiles.find((t) => t.stat === 'working')!
    expect(one.summary).toBe('1 agent working in 1 run')
    const runs = make({ workingAgents: 0, workingRuns: 2 }).tiles.find((t) => t.stat === 'working')!
    expect(runs).toMatchObject({ figure: '2', label: 'Runs working' })
  })

  it('words the finished tile by window and mentions failures in its name', () => {
    const f = make({ finished: 3, failed: 1 }).tiles.find((t) => t.stat === 'finished')!
    expect(f).toMatchObject({ figure: '3', tone: 'success', target: 'resume' })
    expect(f.summary).toBe('3 runs newly finished and 1 failed since you were last here')
    const old = make({ finished: 1, longAgo: true }).tiles.find((t) => t.stat === 'finished')!
    expect(old.summary).toBe('1 run newly finished this week')
    expect(old.label).toBe('Finished this week')
    const failedOnly = make({ failed: 2 }).tiles.find((t) => t.stat === 'finished')!
    expect(failedOnly).toMatchObject({ tone: 'danger', figure: '2', glyph: 'failed' })
  })

  it('leads runs today and spend to Your week', () => {
    const m = make({ runsToday: 2, spend: { shown: true, view: view(known) } })
    expect(m.tiles.find((t) => t.stat === 'today')).toMatchObject({ figure: '2', target: 'week', label: 'Runs today' })
    expect(m.tiles.find((t) => t.stat === 'spend')).toMatchObject({ figure: '$4.20', target: 'week', tone: 'neutral' })
  })

  it('never shows an unknown cost as $0 and keeps the lower bound of a partial one', () => {
    const u = make({ runsToday: 1, spend: { shown: true, view: view(unknown) } }).tiles.find((t) => t.stat === 'spend')!
    expect(u.figure).toBe('unknown')
    expect(u.figureWord).toBe(true)
    expect(u.summary).toBe('Spend this week: unknown')
    expect(u.figure + u.summary).not.toContain('$0')
    const p = make({ runsToday: 1, spend: { shown: true, view: view(partial) } }).tiles.find((t) => t.stat === 'spend')!
    expect(p.figure).toBe('$4.20+')
    expect(p.summary).toBe('Spend this week: at least $4.20')
  })

  it('omits spend for a reported zero or nothing spent', () => {
    expect(stats({ runsToday: 1, spend: { shown: false, view: view(nothing) } })).not.toContain('spend')
    expect(stats({ runsToday: 1, spend: { shown: true, view: view(nothing) } })).not.toContain('spend')
  })

  it('shows only the sentence on first launch and when no run ever existed', () => {
    expect(heroStats({ ...quiet, firstLaunch: true })).toEqual({ tiles: [], sentence: true, pending: false })
    expect(make({ anyRunEver: false })).toEqual({ tiles: [], sentence: true, pending: false })
  })

  it('still shows a decision when no run ever existed (team files)', () => {
    expect(stats({ anyRunEver: false, decisions: 1 })).toEqual(['waiting'])
  })

  it('before history loads shows only waiting and working and reserves the row', () => {
    expect(make({ ready: false })).toEqual({ tiles: [], sentence: false, pending: true })
    const m = make({ ready: false, decisions: 1, workingAgents: 1, workingRuns: 1, finished: 5, runsToday: 3, spend: { shown: true, view: view(known) } })
    expect(m.tiles.map((t) => t.stat)).toEqual(['waiting', 'working'])
    expect(m.pending).toBe(false)
    expect(m.sentence).toBe(false)
  })

  it('names a tile without a target as plain text', () => {
    expect(heroTileName(make({ runsToday: 1 }).tiles.find((t) => t.stat === 'today')!, false)).toBe('1 run today.')
  })

  it('keeps every visible label inside the accessible name (label in name)', () => {
    const many = make({ decisions: 2, workingAgents: 3, workingRuns: 2, finished: 3, failed: 1, runsToday: 2, spend: { shown: true, view: view(partial) } })
    const others = [make({}), make({ awaitingReply: 1 }), make({ failed: 1, longAgo: true }), make({ finished: 1, longAgo: true }), make({ workingRuns: 1 }), make({ runsToday: 1 })]
    for (const m of [many, ...others]) {
      for (const t of m.tiles) {
        expect(heroTileName(t, true).toLowerCase()).toContain(t.label.toLowerCase())
        expect(heroTileName(t, true)).toMatch(/\. Go to [A-Za-z ]+\.$/)
      }
    }
  })
})
