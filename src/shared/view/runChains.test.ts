// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { RunStatus } from '@shared/types'
import { adoptEndFacts, endedComposerCopy, canContinue, CHAIN_EAGER_MEMBERS, CHAIN_FETCH_CONCURRENCY, chainIdsToLoad, earlierMembersToLoad, runBatched, statusEventEndFacts, chainOf, continuedBy, newestOf, predecessorOf, projectCounts, relativeTime, sessionOpenRunId } from './runChains'

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
  it('continues only the latest stopped chain member with a staged model after an API error without a session', () => {
    const selection = { model: 'next-model', connection: 'custom-connection' }
    for (const kind of ['work', 'setup', 'mcp-assist', 'skill-assist'] as const) {
      const first = { ...r('first', 1), kind, modelSelection: selection }
      const failed = { ...r('failed', 2, { resumedFrom: 'first', status: 'error' }), kind, modelSelection: selection }
      const chain = [first, failed]
      expect(canContinue(chain, 'first')).toBe(false)
      expect(canContinue(chain, 'failed')).toBe(true)
      expect(canContinue([first, { ...failed, modelSelection: undefined }], 'failed')).toBe(false)
      for (const status of ['finished', 'paused'] as const) expect(canContinue([first, { ...failed, status }], 'failed')).toBe(true)
      for (const status of ['starting', 'running', 'idle', 'stopping'] as const) expect(canContinue([first, { ...failed, status }], 'failed')).toBe(false)
    }
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

describe('chain load caps (M2)', () => {
  const r = (id: string, startedAt: number, extra: Record<string, unknown> = {}) => ({ id, startedAt, status: 'finished' as const, ...extra })
  // 15 members linked by resumedFrom: m0 <- m1 <- ... <- m14.
  const chain = Array.from({ length: 15 }, (_, i) => r(`m${i}`, i, i > 0 ? { resumedFrom: `m${i - 1}`, sessionId: 's' } : { sessionId: 's' }))
  it('loads only the newest members eagerly, plus the viewed run', () => {
    expect(CHAIN_EAGER_MEMBERS).toBe(10)
    const ids = chainIdsToLoad(chain, 'm14', new Set())
    expect(ids).toHaveLength(10)
    expect(ids).toContain('m14')
    expect(ids).toContain('m5')
    expect(ids).not.toContain('m4')
    expect(chainIdsToLoad(chain, 'm14', new Set(), 12)).toContain('m3')
    // Opening an older member loads it too.
    expect(chainIdsToLoad(chain, 'm0', new Set())).toContain('m0')
  })
  it('does not walk past a full window', () => {
    // m4..m14 known (11 members), m4 resumedFrom the unknown m3.
    const partial = chain.slice(4)
    expect(chainIdsToLoad(partial, 'm14', new Set())).not.toContain('m3')
    // Only m12..m14 known: the window is not full, so the walk goes on to m11.
    expect(chainIdsToLoad(partial.slice(-3), 'm14', new Set())).toContain('m11')
  })
  it('counts earlier members not loaded yet', () => {
    const loaded = new Set(['m10', 'm11', 'm12', 'm13', 'm14', 'm2'])
    expect(earlierMembersToLoad(chain, (id) => loaded.has(id), 5)).toBe(9)
    expect(earlierMembersToLoad(chain, () => true, 5)).toBe(0)
    expect(earlierMembersToLoad(chain.slice(0, 3), () => false, 10)).toBe(0)
  })
  it('runs at most the batch size of fetches at once and runs them all', async () => {
    expect(CHAIN_FETCH_CONCURRENCY).toBe(4)
    let inFlight = 0
    let peak = 0
    const done: number[] = []
    await runBatched(
      Array.from({ length: 11 }, (_, i) => i),
      4,
      async (i) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((res) => setTimeout(res, 1 + (i % 3)))
        inFlight--
        done.push(i)
        if (i === 5) throw new Error('one failure does not stop the rest')
      }
    )
    expect(peak).toBe(4)
    expect(done.sort((a, b) => a - b)).toEqual(Array.from({ length: 11 }, (_, i) => i))
    await runBatched([], 4, async () => undefined)
  })
})

describe('statusEventEndFacts', () => {
  it('takes endedBy / endedWhile from terminal events and endedBy user from stopping', () => {
    expect(statusEventEndFacts({ status: 'finished', endedBy: 'app', endedWhile: 'waiting' })).toEqual({ endedBy: 'app', endedWhile: 'waiting' })
    expect(statusEventEndFacts({ status: 'error', endedBy: 'user' })).toEqual({ endedBy: 'user' })
    expect(statusEventEndFacts({ status: 'stopping', endedBy: 'user', endedWhile: 'working' })).toEqual({ endedBy: 'user' })
    expect(statusEventEndFacts({ status: 'stopping', endedBy: 'app' })).toEqual({})
    expect(statusEventEndFacts({ status: 'running', endedBy: 'user' })).toEqual({})
    expect(statusEventEndFacts({ status: 'finished' })).toEqual({})
  })
})

describe('endedComposerCopy placeholder', () => {
  const s = { id: 'a', startedAt: 1, status: 'finished' as const }
  it('names the assistant for an Ask run and the orchestrator otherwise', () => {
    expect(endedComposerCopy({ ...s, team: 'single' }, { continuable: true }).placeholder).toBe('Message the assistant')
    expect(endedComposerCopy(s, { continuable: true }).placeholder).toBe('Message the orchestrator')
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
