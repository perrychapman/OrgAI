import { describe, expect, it } from 'vitest'
import { CardSwapGuard } from './cardGuard'
import { CARD_SWAP_GUARD_MS, cardKey } from './types'

const key = (requestId: string, revision = 1): string => cardKey({ hostInstanceId: 'h', runId: 'r', kind: 'permission', requestId, revision })

describe('CardSwapGuard', () => {
  it('uses 750 ms by default', () => {
    expect(CARD_SWAP_GUARD_MS).toBe(750)
  })

  it('starts the window on the first observation (the tray just appeared)', () => {
    const g = new CardSwapGuard()
    expect(g.observe(key('a'), 1000)).toBe(true)
    expect(g.key).toBe(key('a'))
    expect(g.accepts(1000)).toBe(false)
    expect(g.accepts(1749)).toBe(false)
    expect(g.accepts(1750)).toBe(true)
  })

  it('an unchanged key does not restart the window', () => {
    const g = new CardSwapGuard()
    g.observe(key('a'), 0)
    expect(g.observe(key('a'), 700)).toBe(false)
    expect(g.accepts(750)).toBe(true)
  })

  it('a different card restarts the window', () => {
    const g = new CardSwapGuard()
    g.observe(key('a'), 0)
    expect(g.accepts(1000)).toBe(true)
    expect(g.observe(key('b'), 1000)).toBe(true)
    expect(g.accepts(1500)).toBe(false)
    expect(g.remaining(1500)).toBe(250)
    expect(g.accepts(1750)).toBe(true)
  })

  it('a revision change of the same request counts as a change', () => {
    const g = new CardSwapGuard()
    g.observe(key('a', 1), 0)
    expect(g.observe(key('a', 2), 2000)).toBe(true)
    expect(g.accepts(2100)).toBe(false)
    expect(g.accepts(2750)).toBe(true)
  })

  it('accepts nothing without a card; a card arriving after an empty tray starts the window', () => {
    const g = new CardSwapGuard()
    expect(g.observe(undefined, 0)).toBe(false)
    expect(g.accepts(5000)).toBe(false)
    expect(g.observe(key('a'), 5000)).toBe(true)
    expect(g.accepts(5100)).toBe(false)
    expect(g.accepts(5750)).toBe(true)
  })

  it('takes a custom window', () => {
    const g = new CardSwapGuard(100)
    g.observe(key('a'), 0)
    expect(g.accepts(99)).toBe(false)
    expect(g.accepts(100)).toBe(true)
  })
})
