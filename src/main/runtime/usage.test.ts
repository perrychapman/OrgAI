import { describe, expect, it } from 'vitest'
import type { UsageStatus } from '@shared/types'
import {
  epochToMs,
  mapRateLimitEvent,
  mapUsageResponse,
  mergeUsage,
  opusWeeklyWindow,
  shareUsed,
  shouldSteerToSonnet,
  trackShare,
  windowShareExceeded,
  type UsageResponseLike
} from './usage'

/** Trimmed from the real response seen by scripts/smoke-usage.mjs (SDK 0.3.312, Max plan). */
const REAL_RESPONSE = {
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 691, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: {
      utilization: 22,
      resets_at: '2026-10-29T20:20:00.414759+00:00',
      limit_dollars: null,
      used_dollars: null,
      remaining_dollars: null,
      locked_reason: null
    },
    seven_day: {
      utilization: 6,
      resets_at: '2026-11-03T15:00:00.414775+00:00',
      limit_dollars: null,
      used_dollars: null,
      remaining_dollars: null,
      locked_reason: null
    },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    seven_day_cowork: null,
    pace: null,
    model_scoped: [{ display_name: 'Fable', utilization: 9, resets_at: '2026-11-03T15:00:00.414910+00:00' }]
  },
  behaviors: null
}

/**
 * The reply seen on 2026-11-04 (scripts/smoke-usage-probe.mjs, same SDK and Max login): five_hour is null, new keys
 * appeared, and there is no rate_limits.limits[] array.
 */
const RESPONSE_2026_11_04 = {
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: null,
    seven_day: {
      utilization: 18,
      resets_at: '2026-11-10T15:00:00.211350+00:00',
      limit_dollars: null,
      used_dollars: null,
      remaining_dollars: null,
      locked_reason: null
    },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    seven_day_cowork: null,
    extra_usage: { enabled: false, limit_dollars: null, used_dollars: null },
    spend: { current_period_usd: null, period_start: null },
    seven_day_breakdown: {
      as_of: '2026-11-04T12:00:00+00:00',
      window_started_at: '2026-11-03T15:00:00+00:00',
      rows: [{ key: 'claude_code', display_name: 'Claude Code', percent: 100 }, { key: 'other', display_name: 'Other', percent: 0 }]
    },
    weekly_scoped_shares: [{ limit_index: 1, used_percent_of_weekly: 10, allowance_percent_of_weekly: 50 }],
    model_scoped: [{ display_name: 'Fable', utilization: 20, resets_at: '2026-11-10T15:00:00.211484+00:00' }],
    pace: null,
    some_future_key: null,
    another_future_key: { nested: [1, 2, 3] }
  }
}

/** The rate_limit_event seen in the same smoke run. */
const REAL_EVENT = {
  status: 'allowed' as const,
  resetsAt: 1793305200,
  rateLimitType: 'five_hour',
  overageStatus: 'rejected',
  overageDisabledReason: 'org_level_disabled',
  isUsingOverage: false,
  unifiedWindows: {
    five_hour: { utilization: 0.22, resetsAt: 1793305200, status: 'allowed' },
    seven_day: { utilization: 0.06, resetsAt: 1793718000, status: 'allowed' }
  }
}

const NOW = Date.parse('2026-10-29T19:21:17Z')

function status(over: Partial<UsageStatus> = {}): UsageStatus {
  return { authMode: 'subscription', subscriptionType: 'max', available: true, windows: {}, updatedAt: NOW, ...over }
}

describe('mapUsageResponse', () => {
  it('maps the real response shape', () => {
    const u = mapUsageResponse(REAL_RESPONSE as UsageResponseLike, 'unknown', NOW)
    expect(u).toEqual({
      authMode: 'subscription',
      subscriptionType: 'max',
      available: true,
      windows: {
        fiveHour: { utilization: 22, resetsAt: Date.parse('2026-10-29T20:20:00.414Z') },
        sevenDay: { utilization: 6, resetsAt: Date.parse('2026-11-03T15:00:00.414Z') }
      },
      modelWindows: [{ model: 'Fable', utilization: 9, resetsAt: Date.parse('2026-11-03T15:00:00.414Z') }],
      updatedAt: NOW
    })
  })

  it('fills the Opus window from a per-model entry when the dedicated key is null', () => {
    const resp = { ...REAL_RESPONSE, rate_limits: { ...REAL_RESPONSE.rate_limits, model_scoped: [{ display_name: 'Opus', utilization: 85, resets_at: null }] } }
    const u = mapUsageResponse(resp as UsageResponseLike, 'subscription', NOW)
    expect(u.windows.sevenDayOpus).toEqual({ utilization: 85, resetsAt: null })
    expect(u.windows.sevenDaySonnet).toBeUndefined()
  })

  it('reports unavailable for API keys, missing responses and garbage', () => {
    expect(mapUsageResponse({ subscription_type: null, rate_limits_available: false, rate_limits: null }, 'apiKey', NOW)).toEqual({
      authMode: 'apiKey',
      subscriptionType: null,
      available: false,
      windows: {},
      updatedAt: NOW
    })
    expect(mapUsageResponse(null, 'unknown', NOW).available).toBe(false)
    expect(mapUsageResponse('nope' as unknown as UsageResponseLike, 'unknown', NOW).available).toBe(false)
    const bad = mapUsageResponse({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 'x' as unknown as number, resets_at: 'not a date' } } }, 'unknown', NOW)
    expect(bad.windows.fiveHour).toEqual({ utilization: null, resetsAt: null })
  })

  it('maps the 2026-11-04 shape: five_hour null, seven_day and Fable only, unknown keys ignored', () => {
    let u: UsageStatus | undefined
    expect(() => { u = mapUsageResponse(RESPONSE_2026_11_04 as unknown as UsageResponseLike, 'unknown', NOW) }).not.toThrow()
    expect(u).toEqual({
      authMode: 'subscription',
      subscriptionType: 'max',
      available: true,
      windows: { sevenDay: { utilization: 18, resetsAt: Date.parse('2026-11-10T15:00:00.211Z') } },
      modelWindows: [{ model: 'Fable', utilization: 20, resetsAt: Date.parse('2026-11-10T15:00:00.211Z') }],
      updatedAt: NOW
    })
    expect(Object.keys(u!.windows)).toEqual(['sevenDay'])
  })
})

describe('mapRateLimitEvent', () => {
  it('converts the real event: seconds to ms, fractions to percent', () => {
    const u = mapRateLimitEvent(REAL_EVENT, null, NOW)
    expect(u.windows.fiveHour).toEqual({ utilization: 22, resetsAt: 1793305200_000 })
    expect(u.windows.sevenDay).toEqual({ utilization: 6, resetsAt: 1793718000_000 })
    expect(u).toMatchObject({ authMode: 'subscription', available: true, status: 'allowed', overageInUse: false })
    expect(u.limitedUntil).toBeUndefined()
  })

  it('records the limit on a rejection and keeps windows the event does not mention', () => {
    const prev = status({ windows: { sevenDayOpus: { utilization: 70, resetsAt: 5 } }, modelWindows: [{ model: 'Fable', utilization: 1, resetsAt: null }] })
    const u = mapRateLimitEvent({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1793305200, utilization: 1 }, prev, NOW)
    expect(u.status).toBe('rejected')
    expect(u.limitedWindow).toBe('five_hour')
    expect(u.limitedUntil).toBe(1793305200_000)
    expect(u.windows.fiveHour).toEqual({ utilization: 100, resetsAt: 1793305200_000 })
    expect(u.windows.sevenDayOpus).toEqual({ utilization: 70, resetsAt: 5 })
    expect(u.modelWindows).toEqual(prev.modelWindows)
  })

  it('keeps apiKey auth from the previous status', () => {
    expect(mapRateLimitEvent({ status: 'allowed' }, status({ authMode: 'apiKey' }), NOW).authMode).toBe('apiKey')
  })

  it('accepts millisecond timestamps too', () => {
    expect(epochToMs(1793305200)).toBe(1793305200_000)
    expect(epochToMs(1793305200_000)).toBe(1793305200_000)
    expect(epochToMs(0)).toBeNull()
    expect(epochToMs(undefined)).toBeNull()
  })
})

describe('mergeUsage', () => {
  it('keeps the live status from events and drops a limit once its reset has passed', () => {
    const prev = status({ status: 'rejected', limitedWindow: 'five_hour', limitedUntil: NOW + 1000 })
    expect(mergeUsage(prev, status({ updatedAt: NOW })).limitedUntil).toBe(NOW + 1000)
    const later = mergeUsage(prev, status({ updatedAt: NOW + 2000 }))
    expect(later.limitedUntil).toBeUndefined()
    expect(later.status).toBe('allowed')
  })

  it('does not let a failed report erase known windows', () => {
    const prev = status({ windows: { fiveHour: { utilization: 40, resetsAt: null } } })
    const merged = mergeUsage(prev, { authMode: 'subscription', subscriptionType: null, available: false, windows: {}, updatedAt: NOW })
    expect(merged.available).toBe(true)
    expect(merged.windows.fiveHour?.utilization).toBe(40)
  })

  describe('windows the report leaves out', () => {
    const sevenDayOnly = (updatedAt: number): UsageStatus =>
      status({ windows: { sevenDay: { utilization: 18, resetsAt: updatedAt + 6 * 86_400_000 } }, updatedAt })

    it('keeps an event-reported five-hour window whose reset is still ahead', () => {
      const fromEvent = mapRateLimitEvent(REAL_EVENT, null, NOW - 60_000)
      expect(fromEvent.windows.fiveHour).toEqual({ utilization: 22, resetsAt: 1793305200_000 })
      const report = sevenDayOnly(NOW) // NOW is 2026-10-29T19:21:17Z, before the 20:20 reset
      const merged = mergeUsage(fromEvent, report)
      expect(merged.windows).toEqual({ fiveHour: { utilization: 22, resetsAt: 1793305200_000 }, sevenDay: report.windows.sevenDay })
      expect(merged.available).toBe(true)
      // Pure: neither input was touched.
      expect(fromEvent.windows.sevenDay).toEqual({ utilization: 6, resetsAt: 1793718000_000 })
      expect(report.windows.fiveHour).toBeUndefined()
    })

    it('drops a kept window once its reset time has passed', () => {
      const prev = status({ windows: { fiveHour: { utilization: 22, resetsAt: 1793305200_000 }, sevenDay: { utilization: 6, resetsAt: 1793718000_000 } } })
      const merged = mergeUsage(prev, sevenDayOnly(1793305200_000 + 1))
      expect(merged.windows.fiveHour).toBeUndefined()
      expect(merged.windows.sevenDay?.utilization).toBe(18)
      // Exactly at the reset moment it is already gone (resetsAt must be later than the report).
      expect(mergeUsage(prev, sevenDayOnly(1793305200_000)).windows.fiveHour).toBeUndefined()
    })

    it('keeps a window with no known reset time', () => {
      const prev = status({ windows: { fiveHour: { utilization: 40, resetsAt: null } } })
      const merged = mergeUsage(prev, sevenDayOnly(NOW + 365 * 86_400_000))
      expect(merged.windows.fiveHour).toEqual({ utilization: 40, resetsAt: null })
    })

    it('takes the report value for every window the report names', () => {
      const prev = status({
        windows: {
          fiveHour: { utilization: 22, resetsAt: NOW + 3_600_000 },
          sevenDay: { utilization: 99, resetsAt: NOW + 3_600_000 },
          sevenDayOpus: { utilization: 50, resetsAt: NOW + 3_600_000 }
        }
      })
      const report = status({
        windows: { sevenDay: { utilization: 18, resetsAt: NOW + 7 * 86_400_000 }, sevenDayOpus: { utilization: 51, resetsAt: null } },
        updatedAt: NOW + 60_000
      })
      const merged = mergeUsage(prev, report)
      expect(merged.windows.sevenDay).toEqual({ utilization: 18, resetsAt: NOW + 7 * 86_400_000 })
      expect(merged.windows.sevenDayOpus).toEqual({ utilization: 51, resetsAt: null })
      expect(merged.windows.fiveHour).toEqual({ utilization: 22, resetsAt: NOW + 3_600_000 })
      expect(merged.modelWindows).toBeUndefined()
    })

    it('takes the report modelWindows and leaves the unavailable-report branch as it was', () => {
      const prev = status({ windows: { fiveHour: { utilization: 22, resetsAt: NOW + 3_600_000 } }, modelWindows: [{ model: 'Fable', utilization: 1, resetsAt: null }] })
      const report = status({ windows: { sevenDay: { utilization: 18, resetsAt: null } }, modelWindows: [{ model: 'Fable', utilization: 20, resetsAt: null }], updatedAt: NOW + 1 })
      expect(mergeUsage(prev, report).modelWindows).toEqual(report.modelWindows)
      // The existing unavailable branch is unchanged: the whole previous window set stays.
      const failed = mergeUsage(prev, status({ available: false, windows: {}, updatedAt: NOW + 1 }))
      expect(failed.windows).toEqual(prev.windows)
    })
  })
})

describe('window share', () => {
  it('compares the delta since run start with the cap', () => {
    expect(windowShareExceeded(20, 39, 20)).toBe(false)
    expect(windowShareExceeded(20, 40, 20)).toBe(true)
    expect(windowShareExceeded(20, 90, undefined)).toBe(false)
    expect(windowShareExceeded(20, 90, 0)).toBe(false)
    expect(windowShareExceeded(null, 90, 10)).toBe(false)
  })

  it('carries the share across a window reset', () => {
    let t = trackShare(null, 80)
    t = trackShare(t, 95)
    expect(shareUsed(t)).toBe(15)
    t = trackShare(t, 4) // the window reset
    expect(shareUsed(t)).toBe(19)
    t = trackShare(t, 10)
    expect(shareUsed(t)).toBe(25)
    expect(windowShareExceeded(0, shareUsed(t), 25)).toBe(true)
  })
})

describe('Sonnet steering', () => {
  it('uses the Opus weekly window when reported', () => {
    const u = status({ windows: { sevenDay: { utilization: 10, resetsAt: null }, sevenDayOpus: { utilization: 85, resetsAt: null } } })
    expect(opusWeeklyWindow(u)?.utilization).toBe(85)
    expect(shouldSteerToSonnet(u, 80)).toBe(true)
    expect(shouldSteerToSonnet(u, 90)).toBe(false)
  })

  it('falls back to the seven-day window', () => {
    const u = status({ windows: { sevenDay: { utilization: 80, resetsAt: null }, sevenDayOpus: { utilization: null, resetsAt: null } } })
    expect(shouldSteerToSonnet(u, 80)).toBe(true)
    expect(shouldSteerToSonnet(status({ windows: { sevenDay: { utilization: 79, resetsAt: null } } }), 80)).toBe(false)
  })

  it('never steers without usage data', () => {
    expect(shouldSteerToSonnet(null, 80)).toBe(false)
    expect(shouldSteerToSonnet(status({ available: false, windows: { sevenDay: { utilization: 99, resetsAt: null } } }), 80)).toBe(false)
    expect(shouldSteerToSonnet(status(), 80)).toBe(false)
  })
})
