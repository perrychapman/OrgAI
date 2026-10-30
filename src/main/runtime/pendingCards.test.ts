import { describe, expect, it, vi } from 'vitest'
import type { McpInstallRequest, MergeReview, PermissionRequest, PermissionRuleRequest, Proposal, RunEvent, UserQuestion } from '@shared/types'
import { cancelPending, emptyPending, listPending, type PendingCardMaps } from './pendingCards'

function cards(): { c: PendingCardMaps; resolves: Record<string, ReturnType<typeof vi.fn>> } {
  const resolves = { perm: vi.fn(), prop: vi.fn(), q: vi.fn(), merge: vi.fn(), install: vi.fn(), rules: vi.fn() }
  const c: PendingCardMaps = {
    pending: new Map([['perm-1', { request: { id: 'perm-1' } as PermissionRequest, resolve: resolves.perm }]]),
    pendingProposals: new Map([['prop-1', { proposal: { id: 'prop-1' } as Proposal, resolve: resolves.prop }]]),
    pendingQuestions: new Map([['q-1', { question: {} as UserQuestion, resolve: resolves.q }]]),
    pendingMerges: new Map([['m-1', { review: { id: 'm-1' } as MergeReview, resolve: resolves.merge }]]),
    pendingInstalls: new Map([['i-1', { request: {} as McpInstallRequest, resolve: resolves.install }]]),
    pendingRules: new Map([['r-1', { request: {} as PermissionRuleRequest, resolve: resolves.rules }]])
  }
  return { c, resolves }
}

describe('listPending', () => {
  it('returns the stored request objects per kind', () => {
    const { c } = cards()
    const list = listPending(c)
    expect(list.permissions).toEqual([{ id: 'perm-1' }])
    expect(list.proposals).toEqual([{ id: 'prop-1' }])
    expect(list.questions).toHaveLength(1)
    expect(list.mergeReviews).toEqual([{ id: 'm-1' }])
    expect(list.ruleRequests).toHaveLength(1)
    expect(list.mcpInstalls).toHaveLength(1)
    expect(structuredClone(list)).toEqual(list)
  })

  it('is empty once the cards are cancelled', () => {
    const { c } = cards()
    cancelPending(c, 'run-1', () => {})
    expect(listPending(c)).toEqual(emptyPending())
  })
})

describe('cancelPending', () => {
  it('answers every card, emits one cancelled resolution each and empties the maps', () => {
    const { c, resolves } = cards()
    const events: RunEvent[] = []
    expect(cancelPending(c, 'run-1', (e) => events.push(e))).toBe(6)

    expect(resolves.perm).toHaveBeenCalledWith({ behavior: 'deny', message: 'Run ended' })
    expect(resolves.prop).toHaveBeenCalledWith({ behavior: 'revise', feedback: 'Run ended' })
    expect(resolves.q).toHaveBeenCalledWith({ selected: [] })
    expect(resolves.rules).toHaveBeenCalledWith({ behavior: 'deny', message: 'Run ended' })
    expect(resolves.merge).toHaveBeenCalledWith({ behavior: 'hold' })
    // The install resolve broadcasts its own event (secrets stay out of it); it is told the run ended.
    expect(resolves.install).toHaveBeenCalledWith({ approved: false, scope: 'run' }, true)

    expect(events).toEqual([
      { type: 'permission.resolved', runId: 'run-1', requestId: 'perm-1', cancelled: true },
      { type: 'proposal.resolved', runId: 'run-1', proposalId: 'prop-1', decision: { behavior: 'revise', feedback: 'Run ended' }, cancelled: true },
      { type: 'question.resolved', runId: 'run-1', questionId: 'q-1', answer: { selected: [] }, cancelled: true },
      { type: 'rules.resolved', runId: 'run-1', requestId: 'r-1', decision: { behavior: 'deny', message: 'Run ended' }, cancelled: true },
      { type: 'merge.resolved', runId: 'run-1', reviewId: 'm-1', decision: { behavior: 'hold' }, cancelled: true }
    ])
    expect(structuredClone(events)).toEqual(events)
    for (const map of Object.values(c)) expect(map.size).toBe(0)
  })

  it('is a no-op the second time', () => {
    const { c } = cards()
    const broadcast = vi.fn()
    cancelPending(c, 'run-1', broadcast)
    broadcast.mockClear()
    expect(cancelPending(c, 'run-1', broadcast)).toBe(0)
    expect(broadcast).not.toHaveBeenCalled()
  })
})
