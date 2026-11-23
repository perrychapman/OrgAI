import { describe, expect, it } from 'vitest'
import type { UsageStatus } from '@shared/types'
import { planLimit, untilText } from './ConnectionsPanel'

const now = Date.parse('2026-11-22T12:00:00Z')
const u = (over: Partial<UsageStatus> = {}): UsageStatus => ({
  authMode: 'subscription',
  subscriptionType: 'max',
  available: true,
  windows: { fiveHour: { utilization: 22, resetsAt: now + 220 * 60_000 }, sevenDay: { utilization: 10, resetsAt: now + 3 * 86_400_000 } },
  updatedAt: now,
  ...over
})

describe('planLimit', () => {
  it('picks the window closest to its limit and says when it resets', () => {
    expect(planLimit(u(), now)).toEqual({ pct: 22, resets: '3 h 40 min', label: 'five-hour' })
  })
  it('is null for API keys, unreported plans and unknown utilisation', () => {
    expect(planLimit(u({ authMode: 'apiKey' }), now)).toBeNull()
    expect(planLimit(u({ available: false }), now)).toBeNull()
    expect(planLimit(u({ windows: { fiveHour: { utilization: null, resetsAt: null } } }), now)).toBeNull()
    expect(planLimit(undefined, now)).toBeNull()
  })
  it('formats time until a reset', () => {
    expect(untilText(now + 30_000, now)).toBe('1 min')
    expect(untilText(now + 120 * 60_000, now)).toBe('2 h')
    expect(untilText(now + 72 * 3_600_000, now)).toBe('3 days')
    expect(untilText(now - 1, now)).toBeNull()
  })
})
