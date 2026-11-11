import { describe, expect, it } from 'vitest'
import { compactionCount, compactionLine, ordinal } from './compactionText'

describe('compaction wording', () => {
  it('ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th'])
  })
  it('the exec line and the row count', () => {
    expect(compactionLine('Lead', 3)).toBe('Lead compacted its context (3rd time).')
    expect(compactionCount(2)).toBe('compacted 2x')
    expect(compactionCount(0)).toBe('')
    expect(compactionCount(undefined)).toBe('')
  })
})
