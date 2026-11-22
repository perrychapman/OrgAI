import { describe, expect, it } from 'vitest'
import { ArrivalMemory, stagesArrival } from './pageArrival'

describe('stagesArrival', () => {
  it('stages a fresh page with motion on once the saved appearance is known', () => {
    expect(stagesArrival({ appearanceKnown: true, slowMs: 360, fresh: true })).toBe(true)
  })
  it('never stages before the saved appearance is known (a late settings reply may carry Reduce motion)', () => {
    expect(stagesArrival({ appearanceKnown: false, slowMs: 360, fresh: true })).toBe(false)
  })
  it('never stages under reduced motion or on a return without a change', () => {
    expect(stagesArrival({ appearanceKnown: true, slowMs: 0, fresh: true })).toBe(false)
    expect(stagesArrival({ appearanceKnown: true, slowMs: 0.01, fresh: true })).toBe(false)
    expect(stagesArrival({ appearanceKnown: true, slowMs: 360, fresh: false })).toBe(false)
  })
})

describe('ArrivalMemory', () => {
  it('stages the first visit of each page in a session', () => {
    const m = new ArrivalMemory()
    expect(m.shouldStage('dashboard', 'a')).toBe(true)
    expect(m.shouldStage('usage', 'a')).toBe(true)
  })
  it('skips a return without a data change and stages one after a change', () => {
    const m = new ArrivalMemory()
    m.record('dashboard', 'a')
    expect(m.shouldStage('dashboard', 'a')).toBe(false)
    expect(m.shouldStage('dashboard', 'b')).toBe(true)
    expect(m.shouldStage('usage', 'a')).toBe(true)
  })
  it('compares with the latest signature recorded while the page was open', () => {
    const m = new ArrivalMemory()
    m.record('usage', 'a')
    m.record('usage', 'b')
    expect(m.shouldStage('usage', 'a')).toBe(true)
    expect(m.shouldStage('usage', 'b')).toBe(false)
    m.clear()
    expect(m.shouldStage('usage', 'b')).toBe(true)
  })
})
