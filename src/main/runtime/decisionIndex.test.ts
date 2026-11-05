import { describe, expect, it } from 'vitest'
import { DECISION_TOMBSTONES_MAX } from '@shared/types'
import { DecisionIndex } from './decisionIndex'

const card = { runId: 'run-1', projectId: 'p1', kind: 'permission' as const, revision: 1 }

describe('DecisionIndex', () => {
  it('looks up a pending card', () => {
    const d = new DecisionIndex()
    d.add('perm-1', card)
    expect(d.lookup('perm-1')).toEqual({ status: 'pending', requestId: 'perm-1', runId: 'run-1', projectId: 'p1', kind: 'permission', revision: 1 })
    expect(d.get('perm-1')).toEqual(card)
  })

  it('moves a resolved card to an applied tombstone', () => {
    const d = new DecisionIndex()
    d.add('perm-1', card)
    d.resolve('perm-1', { status: 'applied', effectiveDecision: 'deny', decidedBy: { surface: 'cli' }, at: 5 })
    expect(d.get('perm-1')).toBeUndefined()
    expect(d.lookup('perm-1')).toEqual({ status: 'applied', requestId: 'perm-1', runId: 'run-1', kind: 'permission', effectiveDecision: 'deny', decidedBy: { surface: 'cli' }, at: 5 })
    expect(d.missOutcome('perm-1')).toEqual({ status: 'already-resolved', requestId: 'perm-1', runId: 'run-1', effectiveDecision: 'deny', decidedBy: { surface: 'cli' } })
  })

  it('records cancelled cards', () => {
    const d = new DecisionIndex()
    d.add('q-1', { ...card, kind: 'question' })
    d.resolve('q-1', { status: 'cancelled', at: 1 })
    expect(d.lookup('q-1')).toMatchObject({ status: 'cancelled', kind: 'question', runId: 'run-1' })
    expect(d.missOutcome('q-1')).toEqual({ status: 'cancelled', requestId: 'q-1', runId: 'run-1' })
  })

  it('answers not-found for unknown ids', () => {
    const d = new DecisionIndex()
    expect(d.lookup('x')).toEqual({ status: 'not-found', requestId: 'x' })
    expect(d.missOutcome('x')).toEqual({ status: 'not-found', requestId: 'x' })
    // A resolve of an unindexed card without kind / run records nothing.
    d.resolve('x', { status: 'applied' })
    expect(d.lookup('x').status).toBe('not-found')
  })

  it('evicts the oldest tombstone past the cap', () => {
    const d = new DecisionIndex(3)
    for (const id of ['a', 'b', 'c', 'd']) {
      d.add(id, card)
      d.resolve(id, { status: 'applied' })
    }
    expect(d.lookup('a').status).toBe('not-found')
    expect(d.lookup('b').status).toBe('applied')
    expect(d.lookup('d').status).toBe('applied')
    expect(d.size()).toEqual({ pending: 0, tombstones: 3 })
  })

  it('defaults to DECISION_TOMBSTONES_MAX', () => {
    const d = new DecisionIndex()
    for (let i = 0; i <= DECISION_TOMBSTONES_MAX; i++) d.resolve(`r${i}`, { status: 'applied', kind: 'merge', runId: 'run-1' })
    expect(d.size().tombstones).toBe(DECISION_TOMBSTONES_MAX)
    expect(d.lookup('r0').status).toBe('not-found')
  })
})
