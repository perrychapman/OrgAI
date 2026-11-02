// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { RunStatus } from '@shared/types'
import { chainGroups, chainKeyOf, continuationDivider, endedComposerCopy, gapLabel } from './runChains'

const r = (id: string, startedAt: number, extra: { sessionId?: string; resumedFrom?: string; status?: RunStatus } = {}) => ({
  id,
  startedAt,
  status: extra.status ?? ('finished' as RunStatus),
  sessionId: extra.sessionId,
  resumedFrom: extra.resumedFrom
})

describe('chain keys and groups', () => {
  const runs = [r('c', 300, { resumedFrom: 'b', sessionId: 's' }), r('b', 200, { resumedFrom: 'a', sessionId: 's' }), r('a', 100, { sessionId: 's' }), r('x', 250), r('y', 400, { sessionId: 't' }), r('z', 410, { sessionId: 't' })]
  it('keys a chain by its oldest member from any member', () => {
    expect(chainKeyOf(runs, 'c')).toBe('a')
    expect(chainKeyOf(runs, 'b')).toBe('a')
    expect(chainKeyOf(runs, 'x')).toBe('x')
    expect(chainKeyOf(runs, 'unknown')).toBe('unknown')
  })
  it('groups every run once, newest chain first, members oldest first', () => {
    const groups = chainGroups(runs)
    expect(groups.map((g) => g.key)).toEqual(['y', 'a', 'x'])
    expect(groups[1].members.map((m) => m.id)).toEqual(['a', 'b', 'c'])
    expect(groups[1].first.id).toBe('a')
    expect(groups[1].newest.id).toBe('c')
    expect(groups.flatMap((g) => g.members)).toHaveLength(runs.length)
  })
  it('links by sessionId alone and by resumedFrom alone', () => {
    const g = chainGroups([r('p', 1, { sessionId: 'q' }), r('q', 2, { sessionId: 'q' }), r('m', 3), r('n', 4, { resumedFrom: 'm' })])
    expect(g.map((x) => x.members.map((m) => m.id))).toEqual([['m', 'n'], ['p', 'q']])
  })
  it('ignores a resumedFrom that points at an unknown run', () => {
    const g = chainGroups([r('n', 4, { resumedFrom: 'gone' })])
    expect(g).toHaveLength(1)
    expect(g[0].key).toBe('n')
  })
})

describe('gapLabel and continuationDivider', () => {
  it('words the gap', () => {
    expect(gapLabel(10_000)).toBe('right away')
    expect(gapLabel(3 * 60_000)).toBe('3 min later')
    expect(gapLabel(2 * 3_600_000)).toBe('2 h later')
    expect(gapLabel(4 * 86_400_000)).toBe('4 d later')
  })
  it('says "after OrgAI closed" when the earlier session was cut, else the gap from its end', () => {
    const prev = { ...r('a', 0), endedAt: 60_000 }
    const next = r('b', 60_000 + 3 * 60_000)
    expect(continuationDivider(prev, next)).toMatchObject({ runId: 'b', label: 'Continued 3 min later' })
    expect(continuationDivider({ ...prev, endedBy: 'app' as const }, next).label).toBe('Continued after OrgAI closed')
    expect(continuationDivider({ ...prev, endedWithApp: true as const }, next).label).toBe('Continued after OrgAI closed')
    // endedBy beats the old flag
    expect(continuationDivider({ ...prev, endedBy: 'user' as const, endedWithApp: true as const }, next).label).toBe('Continued 3 min later')
  })
})

describe('endedComposerCopy', () => {
  const base = { ...r('a', 0), endedAt: 1000 }
  const now = 1000 + 5 * 60_000
  it('continues a normally ended run', () => {
    const c = endedComposerCopy(base, { continuable: true, now })
    expect(c.mode).toBe('continue')
    expect(c.modeLabel).toBe('Session ended 5 min ago. Send to continue with its memory.')
    expect(c.notice).toBeUndefined()
  })
  it('warns when OrgAI closed while it worked or waited', () => {
    const cut = { ...base, endedBy: 'app' as const }
    expect(endedComposerCopy(cut, { continuable: true, cutWhile: 'working', now }).notice).toMatch(/while this run was working/)
    expect(endedComposerCopy(cut, { continuable: true, cutWhile: 'waiting', now }).notice).toMatch(/while this run was waiting for you/)
    expect(endedComposerCopy(cut, { continuable: true, now }).notice).toMatch(/working/)
    expect(endedComposerCopy(cut, { continuable: true, now }).placeholder).toBe('Pick up where it was cut off')
  })
  it('lets endedWhile from main beat the loaded cutWhile', () => {
    const cut = { ...base, endedBy: 'app' as const, endedWhile: 'waiting' as const }
    expect(endedComposerCopy(cut, { continuable: true, cutWhile: 'working', now }).notice).toMatch(/waiting for you/)
  })
  it('names why a failed run ended', () => {
    const c = endedComposerCopy({ ...base, status: 'error', error: 'Rate limit hit.  Try later.' }, { continuable: true, now })
    expect(c.modeLabel).toBe('This run failed: Rate limit hit. Try later. Send to try again with its memory.')
    expect(endedComposerCopy({ ...base, status: 'error' }, { continuable: true, now }).modeLabel).toBe('This run failed. Send to try again with its memory.')
  })
  it('starts a new run when the session cannot be continued', () => {
    const c = endedComposerCopy(base, { continuable: false, now })
    expect(c.mode).toBe('new')
    expect(c.placeholder).toBe('Describe the task')
  })
})
