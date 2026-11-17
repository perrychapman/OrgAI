import { describe, expect, it } from 'vitest'
import type { UsageStatus } from '@shared/types'
import { reconcileUsage } from './usage'

const T0 = 1_800_000_000_000
const H = 3_600_000
const FIVE = T0 + 3 * H
const WEEK = T0 + 5 * 24 * H

const status = (over: Partial<UsageStatus> = {}, at = T0): UsageStatus => ({
  provider: 'claude',
  authMode: 'subscription',
  subscriptionType: 'max',
  available: true,
  windows: { fiveHour: { utilization: 20, resetsAt: FIVE }, sevenDay: { utilization: 10, resetsAt: WEEK } },
  updatedAt: at,
  ...over
})

describe('reconcileUsage', () => {
  it('returns next when there is no previous status', () => {
    const n = status()
    expect(reconcileUsage(null, n)).toBe(n)
  })

  it('never lowers utilization inside one period (two interleaved sessions, one stale)', () => {
    const fresh = status({ windows: { fiveHour: { utilization: 31, resetsAt: FIVE }, sevenDay: { utilization: 12, resetsAt: WEEK } } }, T0 + 1000)
    const stale = status({ windows: { fiveHour: { utilization: 25, resetsAt: FIVE }, sevenDay: { utilization: 11, resetsAt: WEEK } } }, T0 + 500)
    const a = reconcileUsage(status(), fresh)
    const b = reconcileUsage(a, stale)
    expect(b.windows.fiveHour?.utilization).toBe(31)
    expect(b.windows.sevenDay?.utilization).toBe(12)
    expect(b.updatedAt).toBe(T0 + 1000)
    expect(b).toBe(a) // nothing changed: same reference
  })

  it('does not flip between an integer poll and a fractional event for the same period', () => {
    const poll = status({ windows: { fiveHour: { utilization: 22, resetsAt: FIVE + 414 } } }, T0 + 10)
    const event = status({ windows: { fiveHour: { utilization: 22.4, resetsAt: FIVE - 414 } } }, T0 + 20)
    let r = reconcileUsage(status({ windows: {} }), poll)
    r = reconcileUsage(r, event)
    expect(r.windows.fiveHour?.utilization).toBe(22.4)
    r = reconcileUsage(r, poll)
    expect(r.windows.fiveHour?.utilization).toBe(22.4)
    expect(r.windows.fiveHour?.resetsAt).toBe(FIVE + 414)
  })

  it('lets the figure drop in a new period (later reset) and ignores a stale earlier one', () => {
    const prev = status()
    const later = status({ windows: { fiveHour: { utilization: 3, resetsAt: FIVE + 5 * H } } }, T0 + 1000)
    const r = reconcileUsage(prev, later)
    expect(r.windows.fiveHour).toEqual({ utilization: 3, resetsAt: FIVE + 5 * H })
    const earlier = status({ windows: { fiveHour: { utilization: 90, resetsAt: FIVE - 5 * H } } }, T0 + 2000)
    expect(reconcileUsage(r, earlier).windows.fiveHour).toEqual({ utilization: 3, resetsAt: FIVE + 5 * H })
  })

  it('takes next once prev reset time has passed', () => {
    const prev = status()
    const next = status({ windows: { fiveHour: { utilization: 1, resetsAt: FIVE } } }, FIVE + 1000)
    expect(reconcileUsage(prev, next).windows.fiveHour?.utilization).toBe(1)
  })

  it('keeps a known resetsAt over null and a number over null utilization', () => {
    const next = status({ windows: { fiveHour: { utilization: null, resetsAt: null } } }, T0 + 5)
    expect(reconcileUsage(status(), next).windows.fiveHour).toEqual({ utilization: 20, resetsAt: FIVE })
  })

  it('keeps a window only prev has until its reset passes', () => {
    const next = status({ windows: { sevenDay: { utilization: 11, resetsAt: WEEK } } }, T0 + 1000)
    expect(reconcileUsage(status(), next).windows.fiveHour).toEqual({ utilization: 20, resetsAt: FIVE })
    const later = status({ windows: { sevenDay: { utilization: 11, resetsAt: WEEK } } }, FIVE + 1)
    expect(reconcileUsage(status(), later).windows.fiveHour).toBeUndefined()
  })

  it('matches model windows by name', () => {
    const prev = status({ modelWindows: [{ model: 'Fable', utilization: 20, resetsAt: WEEK }, { model: 'Old', utilization: 5, resetsAt: WEEK }] })
    const next = status({ modelWindows: [{ model: 'Fable', utilization: 9, resetsAt: WEEK }, { model: 'New', utilization: 1, resetsAt: WEEK }] }, T0 + 5)
    const r = reconcileUsage(prev, next)
    expect(r.modelWindows).toEqual([
      { model: 'Fable', utilization: 20, resetsAt: WEEK },
      { model: 'New', utilization: 1, resetsAt: WEEK },
      { model: 'Old', utilization: 5, resetsAt: WEEK }
    ])
  })

  it('keeps prev windows when next is unavailable', () => {
    const r = reconcileUsage(status(), status({ available: false, windows: {} }, T0 + 5))
    expect(r.available).toBe(true)
    expect(r.windows.fiveHour?.utilization).toBe(20)
  })

  it('passes an apiKey report through unchanged', () => {
    const n = status({ authMode: 'apiKey', available: false, windows: {} }, T0 + 5)
    expect(reconcileUsage(status(), n)).toBe(n)
  })

  describe('request state', () => {
    const rejected = status({ status: 'rejected', limitedWindow: 'five_hour', limitedUntil: FIVE }, T0 + 100)
    it('shows a fresh rejected immediately and clears after limitedUntil', () => {
      const r = reconcileUsage(status({ status: 'allowed' }), rejected)
      expect(r.status).toBe('rejected')
      expect(r.limitedUntil).toBe(FIVE)
      const later = status({ windows: { sevenDay: { utilization: 12, resetsAt: WEEK } } }, FIVE + 10)
      const cleared = reconcileUsage(r, later)
      expect(cleared.status).toBe('allowed')
      expect(cleared.limitedUntil).toBeUndefined()
      expect(cleared.limitedWindow).toBeUndefined()
    })

    it('an older snapshot never replaces newer request state', () => {
      const old = status({ status: 'allowed' }, T0 + 50)
      const r = reconcileUsage(rejected, old)
      expect(r.status).toBe('rejected')
      expect(r.limitedWindow).toBe('five_hour')
    })

    it('a newer allowed snapshot clears an earlier rejected one', () => {
      const r = reconcileUsage(rejected, status({ status: 'allowed' }, T0 + 200))
      expect(r.status).toBe('allowed')
      expect(r.limitedUntil).toBeUndefined()
    })

    it('a newer report without request state keeps the last one', () => {
      expect(reconcileUsage(rejected, status({}, T0 + 200)).status).toBe('rejected')
    })
  })

  it('is idempotent', () => {
    const prev = status({ status: 'rejected', limitedWindow: 'five_hour', limitedUntil: FIVE }, T0 + 1)
    const next = status({ windows: { fiveHour: { utilization: 40, resetsAt: FIVE + 9 } }, modelWindows: [{ model: 'Fable', utilization: 2, resetsAt: WEEK }] }, T0 + 9)
    const once = reconcileUsage(prev, next)
    expect(reconcileUsage(once, next)).toEqual(once)
    expect(reconcileUsage(once, once)).toBe(once)
  })
})
