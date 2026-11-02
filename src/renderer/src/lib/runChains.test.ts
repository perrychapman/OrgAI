// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { RunStatus } from '@shared/types'
import { adoptEndFacts, canContinue, chainIdsToLoad, chainOf, continuedBy, newestOf, predecessorOf, projectCounts, relativeTime, sessionOpenRunId } from './runChains'

const r = (id: string, startedAt: number, extra: { sessionId?: string; resumedFrom?: string; status?: RunStatus; projectId?: string } = {}) => ({
  id,
  startedAt,
  status: extra.status ?? ('finished' as RunStatus),
  sessionId: extra.sessionId,
  resumedFrom: extra.resumedFrom,
  projectId: extra.projectId ?? 'p'
})

describe('runChains', () => {
  const runs = [
    r('c', 30, { sessionId: 's1', resumedFrom: 'b' }),
    r('b', 20, { sessionId: 's1', resumedFrom: 'a' }),
    r('a', 10, { sessionId: 's1' }),
    r('x', 15, { sessionId: 's2' }),
    r('y', 40)
  ]
  it('groups by session and resumedFrom, oldest first', () => {
    expect(chainOf(runs, 'b').map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(chainOf(runs, 'x').map((x) => x.id)).toEqual(['x'])
    expect(chainOf(runs, 'nope')).toEqual([])
  })
  it('follows resumedFrom when the session id is missing', () => {
    const list = [r('a', 1), r('b', 2, { resumedFrom: 'a' })]
    expect(chainOf(list, 'a').map((x) => x.id)).toEqual(['a', 'b'])
  })
  it('finds newest and continuer', () => {
    expect(newestOf(runs, 'a')?.id).toBe('c')
    expect(continuedBy(runs, 'a')?.id).toBe('b')
    expect(continuedBy(runs, 'c')).toBeUndefined()
  })
  it('offers Continue on the newest finished member with a session only', () => {
    expect(canContinue(runs, 'c')).toBe(true)
    expect(canContinue(runs, 'a')).toBe(false)
    expect(canContinue(runs, 'y')).toBe(false)
    expect(canContinue([r('l', 1, { sessionId: 's', status: 'running' })], 'l')).toBe(false)
  })
  it('counts open and waiting runs per project', () => {
    const list = [
      { summary: r('1', 1, { status: 'running' }), permissions: [{}] },
      { summary: r('2', 2, { status: 'idle' }) },
      { summary: r('3', 3, { status: 'finished' }), permissions: [{}] },
      { summary: r('4', 4, { status: 'running', projectId: 'q' }) }
    ]
    expect(projectCounts(list, 'p')).toEqual({ open: 2, needsYou: 1 })
  })
  it('links chains in both directions, through a shared session id alone, and survives cycles', () => {
    const list = [r('a', 1, { sessionId: 's' }), r('b', 2, { sessionId: 's' }), r('c', 3, { resumedFrom: 'b' })]
    for (const id of ['a', 'b', 'c']) expect(chainOf(list, id).map((x) => x.id)).toEqual(['a', 'b', 'c'])
    const cyc = [r('a', 1, { resumedFrom: 'b' }), r('b', 2, { resumedFrom: 'a' })]
    expect(chainOf(cyc, 'a').map((x) => x.id)).toEqual(['a', 'b'])
    expect(continuedBy(cyc, 'a')?.id).toBeDefined()
  })
  it('offers Continue on finished, error and paused newest members only', () => {
    for (const status of ['finished', 'error', 'paused'] as RunStatus[]) expect(canContinue([r('a', 1, { sessionId: 's', status })], 'a')).toBe(true)
    for (const status of ['starting', 'running', 'idle', 'stopping'] as RunStatus[]) expect(canContinue([r('a', 1, { sessionId: 's', status })], 'a')).toBe(false)
    expect(canContinue([r('a', 1, { status: 'finished' })], 'a')).toBe(false)
    expect(canContinue([], 'a')).toBe(false)
  })
  it('finds the direct predecessor of a continued run', () => {
    expect(predecessorOf(runs, 'c')?.id).toBe('b')
    expect(predecessorOf(runs, 'a')).toBeUndefined()
  })
  it('counts merge reviews and MCP installs as needing the user', () => {
    const list = [
      { summary: r('1', 1, { status: 'idle' }), mergeReviews: [{}] },
      { summary: r('2', 2, { status: 'running' }), mcpInstalls: [{}] }
    ]
    expect(projectCounts(list, 'p')).toEqual({ open: 2, needsYou: 2 })
  })
  it('counts questions, proposals and blocked plans as needing the user, only on open runs', () => {
    const list = [
      { summary: r('1', 1, { status: 'idle' }), questions: [{}] },
      { summary: r('2', 2, { status: 'running' }), proposals: [{}] },
      { summary: r('3', 3, { status: 'running' }), plan: { status: 'blocked' } },
      { summary: r('4', 4, { status: 'running' }), plan: { status: 'active' } },
      { summary: r('5', 5, { status: 'paused' }), questions: [{}] },
      { summary: r('6', 6, { status: 'running' }), ruleRequests: [{}] }
    ]
    expect(projectCounts(list, 'p')).toEqual({ open: 5, needsYou: 4 })
    expect(projectCounts(list, 'none')).toEqual({ open: 0, needsYou: 0 })
  })
  it('formats relative time and parses the refusal', () => {
    expect(relativeTime(0, 10_000)).toBe('just now')
    expect(relativeTime(0, 5 * 60_000)).toBe('5 min ago')
    expect(relativeTime(0, 3 * 3_600_000)).toBe('3 h ago')
    expect(sessionOpenRunId('Session already open: it is live in run run_ab-12 now')).toBe('run_ab-12')
    expect(sessionOpenRunId('Session already open: run run_x1 ("hi…") is continuing it; reply there instead.')).toBe('run_x1')
    expect(sessionOpenRunId('other')).toBeNull()
  })
})

describe('chainIdsToLoad', () => {
  const r = (id: string, startedAt: number, extra: Record<string, unknown> = {}) => ({ id, startedAt, status: 'finished' as const, ...extra })
  it('asks for the run alone when unknown and for resumedFrom targets that are not known yet', () => {
    expect(chainIdsToLoad([], 'a', new Set())).toEqual(['a'])
    const list = [r('c', 3, { resumedFrom: 'b' })]
    expect(chainIdsToLoad(list, 'c', new Set())).toEqual(['c', 'b'])
    expect(chainIdsToLoad(list, 'c', new Set(['c', 'b']))).toEqual([])
  })
  it('walks back once the earlier record is known', () => {
    const list = [r('c', 3, { resumedFrom: 'b' }), r('b', 2, { resumedFrom: 'a' })]
    expect(chainIdsToLoad(list, 'c', new Set(['c', 'b']))).toEqual(['a'])
  })
})

describe('adoptEndFacts', () => {
  const base = { id: 'a', projectId: 'p', kind: 'work', prompt: '', startedAt: 1, totalCostUsd: 0 } as never as import('@shared/types').RunSummary
  it('adopts end facts for a terminal run only and returns null when nothing differs', () => {
    const fin = { ...base, status: 'finished' as const }
    expect(adoptEndFacts(fin, { endedBy: 'user', endedAt: 5 })).toMatchObject({ endedBy: 'user', endedAt: 5 })
    expect(adoptEndFacts({ ...fin, endedBy: 'user' }, { endedBy: 'user' })).toBeNull()
    expect(adoptEndFacts({ ...base, status: 'stopping' as const }, { endedBy: 'user' })).toBeNull()
    expect(adoptEndFacts(fin, {})).toBeNull()
  })
})
