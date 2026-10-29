import type { RateLimitWindow, UsageStatus } from '@shared/types'

/**
 * Map Codex `account/rateLimits/read` onto the shared UsageStatus (provider 'codex', connection 'openai').
 * Shape (generated TS, 0.166.0): { rateLimits: RateLimitSnapshot, rateLimitsByLimitId: {..} | null, ... }
 * with RateLimitSnapshot { planType, primary, secondary, ... } and RateLimitWindow
 * { usedPercent (0-100), windowDurationMins | null, resetsAt | null }. resetsAt is not documented in the
 * generated types; Codex uses unix SECONDS, so values below 1e12 are treated as seconds (UNVERIFIED live).
 */

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

interface Parsed {
  minutes: number | null
  window: RateLimitWindow
}

function parseWindow(raw: unknown): Parsed | null {
  if (!raw || typeof raw !== 'object') return null
  const w = obj(raw)
  const used = typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) ? Math.min(100, Math.max(0, w.usedPercent)) : null
  const resets = typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? (w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt) : null
  const minutes = typeof w.windowDurationMins === 'number' && w.windowDurationMins > 0 ? w.windowDurationMins : null
  return { minutes, window: { utilization: used, resetsAt: resets } }
}

export function mapCodexRateLimits(raw: unknown, now: number = Date.now()): UsageStatus | null {
  const r = obj(raw)
  let snapshot = obj(r.rateLimits)
  if (!Object.keys(snapshot).length) {
    // Fall back to the "codex" bucket (or the first) of the multi-bucket view.
    const byId = obj(r.rateLimitsByLimitId)
    snapshot = obj(byId.codex ?? Object.values(byId)[0])
  }
  const primary = parseWindow(snapshot.primary)
  const secondary = parseWindow(snapshot.secondary)
  if (!primary && !secondary) return null

  const windows: UsageStatus['windows'] = {}
  const DAY = 1440
  const assign = (p: Parsed | null, fallback: 'fiveHour' | 'sevenDay'): void => {
    if (!p) return
    // By duration when known: up to a day = the short window, longer = the weekly one.
    const slot = p.minutes === null ? fallback : p.minutes <= DAY ? 'fiveHour' : 'sevenDay'
    if (!windows[slot]) windows[slot] = p.window
    else windows[fallback === 'fiveHour' ? 'sevenDay' : 'fiveHour'] ??= p.window
  }
  assign(primary, 'fiveHour')
  assign(secondary, 'sevenDay')

  const plan = typeof snapshot.planType === 'string' && snapshot.planType ? snapshot.planType : null
  const reached = typeof snapshot.rateLimitReachedType === 'string' && snapshot.rateLimitReachedType
  const limitedUntil = [windows.fiveHour, windows.sevenDay]
    .filter((w): w is RateLimitWindow => !!w && (w.utilization ?? 0) >= 100 && w.resetsAt !== null)
    .map((w) => w.resetsAt as number)
    .sort((a, b) => b - a)[0]
  return {
    provider: 'codex',
    connection: 'openai',
    authMode: 'subscription',
    subscriptionType: plan,
    available: true,
    windows,
    ...(reached || limitedUntil ? { status: 'rejected' as const, ...(limitedUntil ? { limitedUntil } : {}) } : {}),
    updatedAt: now
  }
}
