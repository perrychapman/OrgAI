import { describe, expect, it } from 'vitest'
import {
  FIRST_LAUNCH_BRIEF,
  NO_RUNS_BRIEF,
  costClause,
  dashboardBrief,
  greetingWord,
  salutation,
  sinceIsLongAgo,
  type BriefInput
} from './dashboardBrief'
import type { CostInput } from './cost'

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000

const base: BriefInput = {
  firstLaunch: false,
  ready: true,
  anyRunEver: true,
  now: NOW,
  lastSeen: NOW - 3 * 60 * 60 * 1000,
  firstVisit: false,
  finished: 0,
  failed: 0,
  closedWaiting: 0,
  decisions: 0,
  workingAgents: 0,
  workingRuns: 0,
  paused: 0
}
const brief = (over: Partial<BriefInput>): string => dashboardBrief({ ...base, ...over })

const known = (usd: number): CostInput => ({ costUsd: usd, costSource: 'provider' })
const partial = (usd: number): CostInput => ({ costUsd: usd, costSource: 'provider', costPartial: true })
const unknown: CostInput = { costUsd: null, costSource: 'unknown' }
const nothing: CostInput = { costUsd: 0, costSource: 'none' }

describe('greetingWord and salutation', () => {
  it('splits the day at 05, 12, 17 and 22', () => {
    const at = (h: number): string => greetingWord(h)
    expect([4, 5, 11, 12, 16, 17, 21, 22, 0, 23].map(at)).toEqual([
      'Hello',
      'Good morning',
      'Good morning',
      'Good afternoon',
      'Good afternoon',
      'Good evening',
      'Good evening',
      'Hello',
      'Hello',
      'Hello'
    ])
  })
  it('adds the name after a comma, or not at all', () => {
    expect(salutation(9, 'Sam', false)).toBe('Good morning, Sam.')
    expect(salutation(9, undefined, false)).toBe('Good morning.')
    expect(salutation(23, 'Sam', false)).toBe('Hello, Sam.')
    expect(salutation(23, undefined, false)).toBe('Hello.')
  })
  it('welcomes on first launch and never uses the name there', () => {
    expect(salutation(9, 'Sam', true)).toBe('Welcome to OrgAI.')
    expect(salutation(9, undefined, true)).toBe('Welcome to OrgAI.')
  })
})

describe('costClause', () => {
  it('names a known figure', () => expect(costClause(known(1.42))).toBe(', costing $1.42'))
  it('says at least for a partial figure', () => expect(costClause(partial(1.42))).toBe(', costing at least $1.42'))
  it('says less than a cent for a known amount under a cent', () => {
    expect(costClause(known(0.004))).toBe(', costing less than $0.01')
    expect(costClause(known(0.0001))).toBe(', costing less than $0.01')
  })
  it('is empty for unknown, reported zero, nothing spent and absent', () => {
    expect(costClause(unknown)).toBe('')
    expect(costClause(known(0))).toBe('')
    expect(costClause(nothing)).toBe('')
    expect(costClause(undefined)).toBe('')
  })
  it('is empty for a partial figure under a cent (a tiny lower bound claims nothing)', () => {
    expect(costClause(partial(0.004))).toBe('')
  })
  it('never prints $0.00', () => {
    for (const c of [unknown, known(0), nothing, partial(0), known(0.004), partial(0.004)]) expect(costClause(c)).not.toContain('$0.00')
  })
  it('rounds to cents', () => {
    expect(costClause(known(0.01))).toBe(', costing $0.01')
    expect(costClause(known(12.4))).toBe(', costing $12.40')
  })
})

describe('dashboardBrief variants (section 5.4)', () => {
  it('first launch', () => {
    expect(brief({ firstLaunch: true, decisions: 3, finished: 2 })).toBe('Start a project or just chat. Nothing runs until you say so.')
    expect(FIRST_LAUNCH_BRIEF).toBe('Start a project or just chat. Nothing runs until you say so.')
  })
  it('projects but no run ever', () => {
    expect(brief({ anyRunEver: false })).toBe('No runs yet. Open a project to start one.')
    expect(NO_RUNS_BRIEF).toBe('No runs yet. Open a project to start one.')
  })
  it('quiet', () => {
    expect(brief({})).toBe('Nothing has changed since you were last here, and nothing is waiting on you.')
  })
  it('waiting, singular and plural', () => {
    expect(brief({ decisions: 1 })).toBe('1 decision is waiting on you.')
    expect(brief({ decisions: 2 })).toBe('2 decisions are waiting on you.')
  })
  it('finished, singular and plural', () => {
    expect(brief({ finished: 1 })).toBe('1 run finished since you were last here.')
    expect(brief({ finished: 3 })).toBe('3 runs finished since you were last here.')
  })
  it('finished and failed', () => {
    expect(brief({ finished: 3, failed: 2 })).toBe('3 runs finished and 2 failed since you were last here.')
    expect(brief({ finished: 1, failed: 1 })).toBe('1 run finished and 1 failed since you were last here.')
  })
  it('failed only', () => {
    expect(brief({ failed: 1 })).toBe('1 run failed since you were last here.')
    expect(brief({ failed: 4 })).toBe('4 runs failed since you were last here.')
  })
  it('puts the cost clause before the full stop', () => {
    expect(brief({ finished: 3, cost: known(1.42) })).toBe('3 runs finished since you were last here, costing $1.42.')
    expect(brief({ finished: 3, failed: 1, cost: partial(1.42) })).toBe('3 runs finished and 1 failed since you were last here, costing at least $1.42.')
    expect(brief({ finished: 1, cost: known(0.004) })).toBe('1 run finished since you were last here, costing less than $0.01.')
    expect(brief({ finished: 1, cost: unknown })).toBe('1 run finished since you were last here.')
    expect(brief({ finished: 1, cost: known(0) })).toBe('1 run finished since you were last here.')
    expect(brief({ finished: 1, cost: nothing })).toBe('1 run finished since you were last here.')
  })
  it('closed while waiting', () => {
    expect(brief({ closedWaiting: 1 })).toBe('1 run was waiting on you when OrgAI closed.')
    expect(brief({ closedWaiting: 2 })).toBe('2 runs were waiting on you when OrgAI closed.')
  })
  it('working', () => {
    expect(brief({ workingAgents: 1, workingRuns: 1 })).toBe('1 agent is working in 1 run.')
    expect(brief({ workingAgents: 3, workingRuns: 2 })).toBe('3 agents are working in 2 runs.')
    expect(brief({ workingAgents: 2, workingRuns: 1 })).toBe('2 agents are working in 1 run.')
    expect(brief({ workingAgents: 1, workingRuns: 0 })).toBe('1 agent is working in 1 run.')
  })
  it('paused', () => {
    expect(brief({ paused: 1, pausedUntilLabel: '14:05' })).toBe('1 run is paused until 14:05.')
    expect(brief({ paused: 2, pausedUntilLabel: '14:05' })).toBe('2 runs are paused until 14:05.')
    expect(brief({ paused: 1 })).toBe('1 run is paused.')
    expect(brief({ paused: 3 })).toBe('3 runs are paused.')
  })
  it('reads "in the past 7 days" when lastSeen is older than 7 days or on a first visit', () => {
    const old = { lastSeen: NOW - 8 * DAY }
    expect(brief({ ...old, finished: 4 })).toBe('4 runs finished in the past 7 days.')
    expect(brief({ ...old, failed: 1 })).toBe('1 run failed in the past 7 days.')
    expect(brief({ ...old, finished: 2, failed: 1, cost: known(1.42) })).toBe('2 runs finished and 1 failed in the past 7 days, costing $1.42.')
    expect(brief({ firstVisit: true, lastSeen: NOW, finished: 2 })).toBe('2 runs finished in the past 7 days.')
    expect(brief({ ...old })).toBe('Nothing has changed in the past 7 days, and nothing is waiting on you.')
    expect(brief({ lastSeen: NOW - 7 * DAY, finished: 1 })).toBe('1 run finished since you were last here.')
  })
  it('the 7 day test', () => {
    expect(sinceIsLongAgo(NOW - 7 * DAY, NOW, false)).toBe(false)
    expect(sinceIsLongAgo(NOW - 7 * DAY - 1, NOW, false)).toBe(true)
    expect(sinceIsLongAgo(NOW, NOW, true)).toBe(true)
  })
})

describe('dashboardBrief composition', () => {
  it('examples of the spec', () => {
    expect(brief({ decisions: 2, finished: 3, cost: known(1.42) })).toBe('2 decisions are waiting on you. 3 runs finished since you were last here, costing $1.42.')
    expect(brief({ finished: 3, cost: known(1.42), workingAgents: 1, workingRuns: 1 })).toBe(
      '3 runs finished since you were last here, costing $1.42. 1 agent is working in 1 run.'
    )
  })
  it('waiting leads, then exactly one more sentence in the order since, closed, working, paused', () => {
    expect(brief({ decisions: 1, finished: 1, closedWaiting: 1, workingAgents: 1, workingRuns: 1, paused: 1 })).toBe('1 decision is waiting on you. 1 run finished since you were last here.')
    expect(brief({ decisions: 1, closedWaiting: 2, workingAgents: 1, workingRuns: 1, paused: 1 })).toBe('1 decision is waiting on you. 2 runs were waiting on you when OrgAI closed.')
    expect(brief({ decisions: 1, workingAgents: 1, workingRuns: 1, paused: 1 })).toBe('1 decision is waiting on you. 1 agent is working in 1 run.')
    expect(brief({ decisions: 1, paused: 2, pausedUntilLabel: '09:30' })).toBe('1 decision is waiting on you. 2 runs are paused until 09:30.')
  })
  it('with nothing waiting shows the first two present, in order', () => {
    expect(brief({ finished: 2, closedWaiting: 1, workingAgents: 1, workingRuns: 1, paused: 1 })).toBe(
      '2 runs finished since you were last here. 1 run was waiting on you when OrgAI closed.'
    )
    expect(brief({ closedWaiting: 1, workingAgents: 2, workingRuns: 1, paused: 1 })).toBe('1 run was waiting on you when OrgAI closed. 2 agents are working in 1 run.')
    expect(brief({ workingAgents: 2, workingRuns: 1, paused: 1, pausedUntilLabel: '14:05' })).toBe('2 agents are working in 1 run. 1 run is paused until 14:05.')
  })
  it('never more than two sentences', () => {
    const text = brief({ decisions: 5, finished: 1, failed: 1, closedWaiting: 1, workingAgents: 2, workingRuns: 2, paused: 2, cost: known(2) })
    expect(text.match(/\. /g)?.length ?? 0).toBeLessThanOrEqual(1)
    expect(text.endsWith('.')).toBe(true)
  })
  it('a working or paused sentence replaces the quiet sentence', () => {
    expect(brief({ workingAgents: 1, workingRuns: 1 })).not.toContain('Nothing has changed')
    expect(brief({ paused: 1 })).not.toContain('Nothing has changed')
  })
  it('the quiet sentence needs a run to have existed; otherwise the empty-history line', () => {
    expect(brief({ anyRunEver: false })).toBe(NO_RUNS_BRIEF)
    expect(brief({ anyRunEver: true })).toContain('Nothing has changed')
  })
})

describe('dashboardBrief before history is ready', () => {
  const loading = { ready: false, anyRunEver: false }
  it('never says Nothing has changed or No runs yet', () => {
    expect(brief({ ...loading })).toBe('')
    expect(brief({ ...loading, anyRunEver: true })).toBe('')
  })
  it('leaves out since and closed, keeps waiting, working and paused', () => {
    expect(brief({ ...loading, finished: 3, closedWaiting: 1 })).toBe('')
    expect(brief({ ...loading, decisions: 2, finished: 3 })).toBe('2 decisions are waiting on you.')
    expect(brief({ ...loading, decisions: 2, workingAgents: 1, workingRuns: 1, paused: 1 })).toBe('2 decisions are waiting on you. 1 agent is working in 1 run.')
    expect(brief({ ...loading, workingAgents: 1, workingRuns: 1, paused: 1, pausedUntilLabel: '14:05' })).toBe('1 agent is working in 1 run. 1 run is paused until 14:05.')
  })
  it('first launch is not gated by loading', () => {
    expect(brief({ ...loading, firstLaunch: true })).toBe(FIRST_LAUNCH_BRIEF)
  })
})

describe('copy rules', () => {
  it('no emoji, exclamation mark or em dash in any variant', () => {
    const variants = [
      brief({}),
      brief({ anyRunEver: false }),
      brief({ decisions: 2, finished: 3, failed: 1, cost: partial(1.42) }),
      brief({ closedWaiting: 2, paused: 1, pausedUntilLabel: '14:05' }),
      brief({ lastSeen: NOW - 9 * DAY, finished: 2 }),
      FIRST_LAUNCH_BRIEF
    ]
    for (const v of variants) {
      expect(v).not.toMatch(/[!—]/)
      expect(v).not.toMatch(/\p{Extended_Pictographic}/u)
    }
  })
})
