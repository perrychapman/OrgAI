import { describe, expect, it, vi } from 'vitest'
import type { McpInstallRequest, PermissionRuleRequest, RunEvent, UserQuestion } from '@shared/types'
import { cancelPending, type PendingCards } from './pendingCards'

function cards(): { c: PendingCards; resolves: Record<string, ReturnType<typeof vi.fn>> } {
  const resolves = { perm: vi.fn(), prop: vi.fn(), q: vi.fn(), merge: vi.fn(), install: vi.fn(), rules: vi.fn() }
  const c: PendingCards = {
    pending: new Map([['perm-1', resolves.perm]]),
    pendingProposals: new Map([['prop-1', resolves.prop]]),
    pendingQuestions: new Map([['q-1', { question: {} as UserQuestion, resolve: resolves.q }]]),
    pendingMerges: new Map([['m-1', resolves.merge]]),
    pendingInstalls: new Map([['i-1', { request: {} as McpInstallRequest, resolve: resolves.install }]]),
    pendingRules: new Map([['r-1', { request: {} as PermissionRuleRequest, resolve: resolves.rules }]])
  }
  return { c, resolves }
}

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
