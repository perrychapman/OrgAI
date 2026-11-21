import { describe, expect, it } from 'vitest'
import { countPlan } from './countUp'

describe('countPlan', () => {
  it('counts a known figure up from zero on arrival, over --dur-draw', () => {
    expect(countPlan(null, 42.18, true)).toEqual({ from: 0, to: 42.18, token: '--dur-draw' })
    expect(countPlan(10, 42.18, true)).toEqual({ from: 0, to: 42.18, token: '--dur-draw' })
  })
  it('never counts unknown, and zero has nothing to count', () => {
    expect(countPlan(null, null, true)).toBeNull()
    expect(countPlan(5, null, false)).toBeNull()
    expect(countPlan(null, 0, true)).toBeNull()
    expect(countPlan(null, Number.NaN, true)).toBeNull()
  })
  it('never tweens from unknown', () => {
    expect(countPlan(null, 12, false)).toBeNull()
  })
  it('tweens a live change of 1% or more over --dur-slow and snaps smaller ones', () => {
    expect(countPlan(100, 102, false)).toEqual({ from: 100, to: 102, token: '--dur-slow' })
    expect(countPlan(100, 100.5, false)).toBeNull()
    expect(countPlan(100, 100, false)).toBeNull()
    expect(countPlan(0, 3, false)).toEqual({ from: 0, to: 3, token: '--dur-slow' })
    expect(countPlan(3, 0, false)).toEqual({ from: 3, to: 0, token: '--dur-slow' })
  })
})
