import { describe, expect, it } from 'vitest'
import { addedRules, breakdownLine, mergeFacts, priorAllowsLine, waitingAbsolute, waitingLabel } from './decisionCard'

describe('decision card helpers', () => {
  it('waitingLabel', () => {
    const now = 10_000_000_000
    expect(waitingLabel(undefined, now)).toBeNull()
    expect(waitingLabel(0, now)).toBeNull()
    expect(waitingLabel(now + 5 * 60_000, now)).toBeNull()
    expect(waitingLabel(now - 20_000, now)).toBe('just now')
    expect(waitingLabel(now - 2 * 60_000, now)).toBe('2 min')
    expect(waitingLabel(now - 3 * 3_600_000, now)).toBe('3 h')
    expect(waitingLabel(now - 72 * 3_600_000, now)).toBe('3 d')
    expect(waitingAbsolute(undefined)).toBeNull()
    expect(waitingAbsolute(now)).toMatch(/^Raised /)
  })
  it('priorAllowsLine shows nothing for absent or zero', () => {
    expect(priorAllowsLine(undefined)).toBeNull()
    expect(priorAllowsLine(0)).toBeNull()
    expect(priorAllowsLine(1)).toBe('You have allowed this once before')
    expect(priorAllowsLine(4)).toBe('You have allowed this 4 times')
  })
  it('mergeFacts never shows unknown as passed', () => {
    expect(mergeFacts(undefined)).toEqual([])
    const f = mergeFacts({ tests: 'unknown', review: 'unknown' })
    expect(f.map((x) => x.text)).toEqual(['not known', 'not known'])
    expect(f.every((x) => x.tone === 'unknown')).toBe(true)
    const g = mergeFacts({ tests: 'failed', testDetail: '2 failing', review: 'reported' })
    expect(g[0]).toMatchObject({ tone: 'bad', detail: '2 failing' })
    expect(g[1].tone).toBe('ok')
  })
  it('breakdownLine and addedRules', () => {
    expect(breakdownLine(['question', 'permission', 'permission'])).toBe('2 permissions · 1 question')
    expect(breakdownLine([])).toBe('')
    expect(addedRules(['a'], ['a', 'b'])).toEqual(['b'])
  })
})
