import { describe, expect, it } from 'vitest'
import { ArrivalMemory } from './pageArrival'

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
