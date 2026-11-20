import { describe, expect, it } from 'vitest'
import { compareWaiting, orderKeys, waitingOrder, WAITING_KIND_WEIGHT, type WaitingOrderFacts } from './waitingOrder'

interface Row {
  key: string
  kind: string
  start: number
  /** Something that changes on an event without changing the key. */
  tick?: number
}
const facts = (r: Row): WaitingOrderFacts => ({ key: r.key, kind: r.kind, start: r.start })
const keys = (rows: readonly Row[]): string[] => rows.map((r) => r.key)

describe('waitingOrder', () => {
  it('weighs plan, question, permission, merge, proposal, install, rules, team in that order', () => {
    const kinds = ['team', 'rules', 'install', 'proposal', 'merge', 'permission', 'question', 'plan']
    const rows = kinds.map((kind, i): Row => ({ key: `k${i}`, kind, start: 1 }))
    expect(waitingOrder(rows, facts).map((r) => r.kind)).toEqual(['plan', 'question', 'permission', 'merge', 'proposal', 'install', 'rules', 'team'])
    expect(Object.keys(WAITING_KIND_WEIGHT)).toEqual(['plan', 'question', 'permission', 'merge', 'proposal', 'install', 'rules', 'team'])
  })

  it('puts the oldest run first within a kind, then the key', () => {
    const rows: Row[] = [
      { key: 'c', kind: 'permission', start: 30 },
      { key: 'b', kind: 'permission', start: 10 },
      { key: 'a', kind: 'permission', start: 10 },
      { key: 'q', kind: 'question', start: 99 }
    ]
    expect(keys(waitingOrder(rows, facts))).toEqual(['q', 'a', 'b', 'c'])
  })

  it('ranks an unknown kind after every known one', () => {
    expect(compareWaiting({ key: 'a', kind: 'future', start: 0 }, { key: 'b', kind: 'team', start: 0 })).toBeGreaterThan(0)
  })

  it('does not move a row when an unrelated event changes data but not the set of keys', () => {
    const first: Row[] = [
      { key: 'p1', kind: 'permission', start: 10 },
      { key: 'p2', kind: 'permission', start: 20 }
    ]
    const shown = waitingOrder(first, facts)
    const previous = orderKeys(shown, facts)
    // The same keys arrive in another input order with new data on one row.
    const after: Row[] = [
      { key: 'p2', kind: 'permission', start: 20, tick: 5 },
      { key: 'p1', kind: 'permission', start: 10, tick: 5 }
    ]
    expect(keys(waitingOrder(after, facts, previous))).toEqual(['p1', 'p2'])
    // Even a start time that would sort differently does not reorder rows that stay.
    const changed: Row[] = [
      { key: 'p1', kind: 'permission', start: 50 },
      { key: 'p2', kind: 'permission', start: 20 }
    ]
    expect(keys(waitingOrder(changed, facts, previous))).toEqual(['p1', 'p2'])
  })

  it('hands back the fresh item of a kept row', () => {
    const previous = ['a']
    const out = waitingOrder([{ key: 'a', kind: 'question', start: 1, tick: 9 }], facts, previous)
    expect(out[0].tick).toBe(9)
  })

  it('keeps the shown order when a row leaves', () => {
    const rows: Row[] = [
      { key: 'x', kind: 'question', start: 1 },
      { key: 'y', kind: 'permission', start: 2 },
      { key: 'z', kind: 'rules', start: 3 }
    ]
    const previous = keys(waitingOrder(rows, facts))
    expect(keys(waitingOrder(rows.filter((r) => r.key !== 'y'), facts, previous))).toEqual(['x', 'z'])
  })

  it('places a new key by the rule among the rows already shown', () => {
    const rows: Row[] = [
      { key: 'perm', kind: 'permission', start: 2 },
      { key: 'rule', kind: 'rules', start: 3 }
    ]
    const previous = keys(waitingOrder(rows, facts))
    const withPlan = [...rows, { key: 'plan', kind: 'plan', start: 9 }]
    expect(keys(waitingOrder(withPlan, facts, previous))).toEqual(['plan', 'perm', 'rule'])
    const withMerge = [...rows, { key: 'merge', kind: 'merge', start: 1 }]
    expect(keys(waitingOrder(withMerge, facts, previous))).toEqual(['perm', 'merge', 'rule'])
    const withTeam = [...rows, { key: 'team', kind: 'team', start: 0 }]
    expect(keys(waitingOrder(withTeam, facts, previous))).toEqual(['perm', 'rule', 'team'])
  })

  it('places several new keys together by the rule', () => {
    const previous = ['perm']
    const rows: Row[] = [
      { key: 'perm', kind: 'permission', start: 2 },
      { key: 'q2', kind: 'question', start: 8 },
      { key: 'q1', kind: 'question', start: 4 }
    ]
    expect(keys(waitingOrder(rows, facts, previous))).toEqual(['q1', 'q2', 'perm'])
  })

  it('returns an empty list for no items and ignores a duplicate key', () => {
    expect(waitingOrder([], facts, ['a'])).toEqual([])
    const dup: Row[] = [
      { key: 'a', kind: 'question', start: 1, tick: 1 },
      { key: 'a', kind: 'question', start: 1, tick: 2 }
    ]
    expect(waitingOrder(dup, facts)).toHaveLength(1)
  })
})
