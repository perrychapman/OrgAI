import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mapCodexRateLimits } from './codexUsage'

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'codex-rate-limits.json'), 'utf8'))

describe('mapCodexRateLimits', () => {
  it('maps primary/secondary by duration and converts seconds to ms', () => {
    const u = mapCodexRateLimits(fixture, 5)!
    expect(u).toMatchObject({ provider: 'codex', connection: 'openai', authMode: 'subscription', subscriptionType: 'plus', available: true, updatedAt: 5 })
    expect(u.windows.fiveHour).toEqual({ utilization: 22, resetsAt: 1793305200000 })
    expect(u.windows.sevenDay).toEqual({ utilization: 6.5, resetsAt: 1793718000000 })
    expect(u.status).toBeUndefined()
  })

  it('puts a single weekly primary window in sevenDay and keeps ms values', () => {
    const u = mapCodexRateLimits({ rateLimits: { primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1793718000000 }, secondary: null } })!
    expect(u.windows.sevenDay).toEqual({ utilization: 40, resetsAt: 1793718000000 })
    expect(u.windows.fiveHour).toBeUndefined()
  })

  it('falls back to positions without durations and flags exhausted windows', () => {
    const u = mapCodexRateLimits({ rateLimits: { primary: { usedPercent: 100, windowDurationMins: null, resetsAt: 1000 }, secondary: { usedPercent: 3, windowDurationMins: null, resetsAt: null } } })!
    expect(u.windows.fiveHour?.utilization).toBe(100)
    expect(u.windows.sevenDay?.resetsAt).toBeNull()
    expect(u).toMatchObject({ status: 'rejected', limitedUntil: 1_000_000 })
  })

  it('uses the multi-bucket view and returns null when nothing is reported', () => {
    const u = mapCodexRateLimits({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: null } } } })
    expect(u?.windows.fiveHour?.utilization).toBe(1)
    expect(mapCodexRateLimits({})).toBeNull()
    expect(mapCodexRateLimits(null)).toBeNull()
    expect(mapCodexRateLimits({ rateLimits: { primary: null, secondary: null } })).toBeNull()
  })
})
