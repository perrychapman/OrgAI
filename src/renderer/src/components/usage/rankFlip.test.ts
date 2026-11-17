import { describe, expect, it } from 'vitest'
import { enterIndex, flipPlan } from './rankFlip'

const tops = (...pairs: [string, number][]): Map<string, number> => new Map(pairs)

describe('flipPlan', () => {
  it('moves rows whose order changed', () => {
    const plan = flipPlan(['a', 'b'], ['b', 'a'], tops(['a', 0], ['b', 40]), tops(['b', 0], ['a', 40]))
    expect(plan).toEqual([
      { key: 'b', delta: 40 },
      { key: 'a', delta: -40 }
    ])
  })
  it('does nothing when the order is unchanged or the key set differs', () => {
    expect(flipPlan(['a', 'b'], ['a', 'b'], tops(['a', 0], ['b', 40]), tops(['a', 0], ['b', 40]))).toEqual([])
    expect(flipPlan(['a', 'b'], ['a', 'c'], tops(['a', 0], ['b', 40]), tops(['a', 0], ['c', 40]))).toEqual([])
    expect(flipPlan(['a'], ['a', 'b'], tops(['a', 0]), tops(['a', 0], ['b', 40]))).toEqual([])
    expect(flipPlan([], [], tops(), tops())).toEqual([])
  })
  it('caps the animated rows at eight', () => {
    const prev = Array.from({ length: 12 }, (_, i) => `k${i}`)
    const next = [...prev].reverse()
    const a = new Map(prev.map((k, i) => [k, i * 40] as [string, number]))
    const b = new Map(next.map((k, i) => [k, i * 40] as [string, number]))
    expect(flipPlan(prev, next, a, b)).toHaveLength(8)
  })
})

describe('enterIndex', () => {
  it('staggers the first six rows only', () => {
    expect(enterIndex(0)).toBe(0)
    expect(enterIndex(5)).toBe(5)
    expect(enterIndex(6)).toBeNull()
  })
})
