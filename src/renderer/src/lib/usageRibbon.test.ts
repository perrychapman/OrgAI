import { describe, expect, it } from 'vitest'
import { buildRibbon, percentWord, ribbonNote, ribbonTitle, type RibbonEntry } from './usageRibbon'

const e = (id: string, value: number | null, o: Partial<RibbonEntry> = {}): RibbonEntry => ({ id, name: id.toUpperCase(), value, partial: false, fill: `var(--${id})`, ...o })

describe('buildRibbon', () => {
  it('keeps the top five rows and folds the rest into Other with its own colour', () => {
    const r = buildRibbon([e('a', 50), e('b', 20), e('c', 10), e('d', 8), e('e', 6), e('f', 4), e('g', 2)], 'var(--other)')
    expect(r.segments.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd', 'e', null])
    const other = r.segments[5]!
    expect(other).toMatchObject({ name: 'Other (2)', value: 6, count: 2, fill: 'var(--other)' })
    expect(r.segments.reduce((n, s) => n + s.share, 0)).toBeCloseTo(1)
    expect(r.total).toBe(100)
  })
  it('gives no Other segment when five or fewer rows have cost', () => {
    const r = buildRibbon([e('a', 3), e('b', 1)], 'var(--other)')
    expect(r.segments).toHaveLength(2)
    expect(r.segments[0]!.percent).toBe('75%')
  })
  it('leaves an unknown-cost row out of the widths and counts it, never as zero', () => {
    const r = buildRibbon([e('a', 3), e('b', null), e('c', 1)], 'var(--other)')
    expect(r.segments.map((s) => s.id)).toEqual(['a', 'c'])
    expect(r.unknown).toBe(1)
    expect(ribbonNote(r)).toBe('1 row has no known price and is not in the ribbon.')
  })
  it('has nothing to split when no cost is known', () => {
    const r = buildRibbon([e('a', null), e('b', null)], 'var(--other)')
    expect(r.segments).toEqual([])
    expect(r.unknown).toBe(2)
    expect(ribbonNote(r)).toBe('2 rows have no known price, so there is nothing to split.')
    expect(ribbonNote(buildRibbon([e('a', 1)], 'x'))).toBe('')
  })
  it('marks a lower bound and words a tiny share as under one percent', () => {
    const r = buildRibbon([e('a', 1000, { partial: true }), e('b', 1)], 'var(--other)')
    expect(r.segments[0]!.partial).toBe(true)
    expect(r.segments[1]!.percent).toBe('<1%')
    expect(percentWord(0)).toBe('0%')
    expect(ribbonTitle(r.segments[0]!)).toContain('at least')
    expect(ribbonTitle(r.segments[1]!)).toBe('B: <1% of the estimated cost')
  })
})
