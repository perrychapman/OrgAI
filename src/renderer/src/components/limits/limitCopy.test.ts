import { describe, expect, it } from 'vitest'
import { reachedText, spentText } from './limitCopy'

const period = (spentUsd: number, unknownRuns = 0) => ({ spentUsd, runs: 1, unknownRuns, from: 0, until: 1 })

describe('limit copy', () => {
  it('formats money with the compact rule and never shows five decimals', () => {
    expect(spentText(period(0.05581), false)).toBe('Spent so far: $0.06.')
    expect(spentText(period(0.004), false)).toBe('Spent so far: <$0.01.')
    expect(spentText(period(12.5), false)).toBe('Spent so far: $12.50.')
  })
  it('says unknown, never $0, when only unpriced runs exist', () => {
    expect(spentText(period(0, 2), false)).toMatch(/^Spent so far: unknown\./)
    expect(spentText(period(1.2, 1), false)).toMatch(/^Spent so far: at least \$1\.20\./)
  })
  it('handles loading and failure', () => {
    expect(spentText(undefined, false)).toMatch(/Measuring/)
    expect(spentText(undefined, true)).toMatch(/not available/)
  })
  it('names a cap that is already reached', () => {
    expect(reachedText(period(5), 3, 'day', 'pause')).toMatch(/Already reached.*will pause/)
    expect(reachedText(period(5), 3, 'month', 'stop')).toMatch(/will stop/)
    expect(reachedText(period(1), 3, 'day', 'pause')).toBe('')
    expect(reachedText(period(5), undefined, 'day', 'pause')).toBe('')
  })
})
