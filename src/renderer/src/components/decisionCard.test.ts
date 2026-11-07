import { describe, expect, it } from 'vitest'
import { overflowsVertically } from './DecisionCard'

describe('overflowsVertically', () => {
  it('is true only for a shown box whose content is taller than it', () => {
    expect(overflowsVertically({ scrollHeight: 1600, clientHeight: 320 })).toBe(true)
    expect(overflowsVertically({ scrollHeight: 320, clientHeight: 320 })).toBe(false)
  })
  it('allows a pixel of rounding', () => {
    expect(overflowsVertically({ scrollHeight: 321, clientHeight: 320 })).toBe(false)
    expect(overflowsVertically({ scrollHeight: 322, clientHeight: 320 })).toBe(true)
  })
  it('is false for a hidden (folded) body and for no element', () => {
    expect(overflowsVertically({ scrollHeight: 0, clientHeight: 0 })).toBe(false)
    expect(overflowsVertically(null)).toBe(false)
  })
})
