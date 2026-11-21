import { describe, expect, it } from 'vitest'
import { FIRST_LAUNCH_BRIEF, NO_RUNS_BRIEF, continueProjectId, decisionsSentence, greetingWord, salutation, statusParts, statusSentence, type StatusInput } from './dashboardBrief'

const base: StatusInput = {
  firstLaunch: false,
  ready: true,
  anyRunEver: true,
  decisions: 0,
  workingAgents: 0,
  workingRuns: 0,
  paused: 0
}
const status = (over: Partial<StatusInput>): string => statusSentence({ ...base, ...over })

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
  it('adds the name after a comma, or not at all, with no full stop', () => {
    expect(salutation(9, 'Sam', false)).toBe('Good morning, Sam')
    expect(salutation(9, undefined, false)).toBe('Good morning')
    expect(salutation(23, 'Sam', false)).toBe('Hello, Sam')
    expect(salutation(23, undefined, false)).toBe('Hello')
  })
  it('welcomes on first launch', () => {
    expect(salutation(9, 'Sam', true)).toBe('Welcome to OrgAI, Sam')
    expect(salutation(9, undefined, true)).toBe('Welcome to OrgAI')
  })
})

describe('statusSentence', () => {
  it('is the one welcome line on first launch', () => {
    expect(status({ firstLaunch: true, decisions: 2, workingAgents: 3, workingRuns: 1 })).toBe(FIRST_LAUNCH_BRIEF)
  })
  it('says what is working, then what needs the person', () => {
    expect(status({ workingAgents: 3, workingRuns: 2 })).toBe('3 agents are working in 2 runs. Nothing needs you.')
    expect(status({ workingAgents: 1, workingRuns: 1 })).toBe('1 agent is working in 1 run. Nothing needs you.')
    expect(status({ workingAgents: 3, workingRuns: 2, decisions: 2 })).toBe('3 agents are working in 2 runs. 2 decisions need you.')
  })
  it('counts decisions, never runs, and marks that sentence', () => {
    expect(decisionsSentence(1)).toBe('1 decision needs you.')
    expect(decisionsSentence(3)).toBe('3 decisions need you.')
    expect(statusParts({ ...base, decisions: 3 })).toEqual([{ text: '3 decisions need you.', attention: true }])
  })
  it('does not say nothing needs you while a run waits for a reply', () => {
    expect(status({ awaitingReply: 1 })).toBe('1 run is idle and waiting on your reply.')
    expect(status({ awaitingReply: 2, decisions: 1 })).toBe('1 decision needs you. 2 runs are idle and waiting on your reply.')
  })
  it('names paused runs and when they resume', () => {
    expect(status({ paused: 1, pausedUntilLabel: '14:05' })).toBe('1 run is paused until 14:05. Nothing needs you.')
    expect(status({ paused: 2 })).toBe('2 runs are paused. Nothing needs you.')
  })
  it('is "Nothing needs you." when all is quiet, and "No runs yet" only once history says so', () => {
    expect(status({})).toBe('Nothing needs you.')
    expect(status({ anyRunEver: false })).toBe(NO_RUNS_BRIEF)
    expect(status({ anyRunEver: false, ready: false })).toBe('Nothing needs you.')
  })
})

describe('continueProjectId', () => {
  const projects = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  it('prefers the first pinned project that still exists', () => {
    expect(continueProjectId(['x', 'c', 'b'], projects, [{ projectId: 'a', startedAt: 9 }])).toBe('c')
  })
  it('falls back to the project with the newest run', () => {
    expect(
      continueProjectId(
        [],
        projects,
        [
          { projectId: 'a', startedAt: 5 },
          { projectId: 'b', startedAt: 9 },
          { projectId: 'gone', startedAt: 99 }
        ]
      )
    ).toBe('b')
  })
  it('falls back to the first project, and to null without projects', () => {
    expect(continueProjectId([], projects, [])).toBe('a')
    expect(continueProjectId(['a'], [], [])).toBeNull()
  })
})
