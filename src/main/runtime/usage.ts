import type { ModelRateLimitWindow, RateLimitWindow, UsageStatus } from '@shared/types'

/**
 * Subscription usage: pure mapping from a provider's usage reports onto the shared UsageStatus, plus the
 * decisions built on it (window-share cap, Sonnet steering). Vendor-neutral: inputs are typed
 * structurally so the Claude adapter can pass SDK objects straight in, and nothing here imports the SDK.
 *
 * Observed with Claude Agent SDK 0.3.312 on a Max login (scripts/smoke-usage.mjs, 2026-10-29):
 * - usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }) answers right after
 *   init with { subscription_type: 'max', rate_limits_available: true, rate_limits: {...}, session, behaviors: null }.
 *   rate_limits.five_hour and .seven_day were objects { utilization: 22, resets_at: '2026-10-29T20:20:00.414759+00:00',
 *   limit_dollars, used_dollars, remaining_dollars, locked_reason } (utilization is a 0-100 percent, resets_at an ISO
 *   string with microseconds). seven_day_opus, seven_day_sonnet and seven_day_oauth_apps were null. The per-model
 *   weekly window came instead as rate_limits.model_scoped: [{ display_name: 'Fable', utilization: 9, resets_at }]
 *   (also mirrored in rate_limits.limits[] as kind 'weekly_scoped'). Many other keys were null placeholders.
 * - A rate_limit_event arrives during a normal, allowed run (once per request), e.g.
 *   { status: 'allowed', resetsAt: 1793305200, rateLimitType: 'five_hour', overageStatus: 'rejected',
 *     isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.22, resetsAt: 1793305200, status: 'allowed' },
 *     seven_day: { utilization: 0.06, resetsAt: 1793718000, status: 'allowed' } } }.
 *   Units differ from the usage response: resetsAt is epoch SECONDS and utilization a 0-1 FRACTION.
 *   unifiedWindows is not in the SDK typings.
 *
 * Observed again on 2026-11-04 (same SDK, same Max login, scripts/smoke-usage-probe.mjs, token-free):
 * - rate_limits.five_hour was null. seven_day was still an object ({ utilization: 18, resets_at, limit_dollars: null, ... })
 *   and model_scoped still [{ display_name: 'Fable', utilization: 20, resets_at }]. seven_day_oauth_apps, seven_day_opus,
 *   seven_day_sonnet and pace were null. New non-null keys: extra_usage, spend, seven_day_breakdown ({ as_of,
 *   window_started_at, rows: [{ key: 'claude_code', display_name: 'Claude Code', percent: 100 }, ...] }) and
 *   weekly_scoped_shares ([{ limit_index: 1, used_percent_of_weekly: 10, allowance_percent_of_weekly: 50 }]), plus many
 *   null placeholder keys. There was NO rate_limits.limits[] array in this control reply (the typings describe one on a
 *   message's usage_report, kinds 'session' | 'weekly_all' | 'weekly_scoped'; the control reply does not carry it).
 *   So the server stopped reporting the five-hour window here; a live run's rate_limit_event is the only other source,
 *   and whether those events still carry five_hour is unverified. mergeUsage therefore keeps event-only windows until
 *   they reset instead of letting the next poll erase them.
 */

export type AuthMode = UsageStatus['authMode']

interface RawWindow {
  utilization?: number | null
  resets_at?: string | null
}

/** The parts of the provider's usage response this module reads. */
export interface UsageResponseLike {
  subscription_type?: string | null
  rate_limits_available?: boolean
  rate_limits?: {
    five_hour?: RawWindow | null
    seven_day?: RawWindow | null
    seven_day_opus?: RawWindow | null
    seven_day_sonnet?: RawWindow | null
    model_scoped?: ({ display_name?: string | null } & RawWindow)[] | null
  } | null
}

interface RawEventWindow {
  utilization?: number
  resetsAt?: number
  status?: string
}

/** The parts of a live rate-limit event this module reads. */
export interface RateLimitInfoLike {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  resetsAt?: number
  rateLimitType?: string
  utilization?: number
  overageInUse?: boolean
  isUsingOverage?: boolean
  /** Undocumented; seen in practice. */
  unifiedWindows?: Record<string, RawEventWindow | undefined>
}

const WINDOW_KEYS = {
  five_hour: 'fiveHour',
  seven_day: 'sevenDay',
  seven_day_opus: 'sevenDayOpus',
  seven_day_sonnet: 'sevenDaySonnet'
} as const

type WindowKey = keyof UsageStatus['windows']

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function isoToMs(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : null
}

/** Event timestamps are epoch seconds; accept milliseconds too in case that changes. */
export function epochToMs(v: unknown): number | null {
  const n = num(v)
  if (n === null || n <= 0) return null
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
}

/** Event utilization is a 0-1 fraction; anything above 1 is taken as already a percent. */
function fractionToPercent(v: unknown): number | null {
  const n = num(v)
  if (n === null) return null
  return n <= 1 ? Math.round(n * 1000) / 10 : n
}

function mapWindow(w: RawWindow | null | undefined): RateLimitWindow | undefined {
  if (!w || typeof w !== 'object') return undefined
  return { utilization: num(w.utilization), resetsAt: isoToMs(w.resets_at) }
}

/** UsageStatus from the provider's usage report. A missing or malformed report maps to available: false. */
export function mapUsageResponse(resp: UsageResponseLike | null | undefined, authMode: AuthMode, now = Date.now()): UsageStatus {
  const base: UsageStatus = { authMode, subscriptionType: null, available: false, windows: {}, updatedAt: now }
  if (!resp || typeof resp !== 'object') return base
  const subscriptionType = typeof resp.subscription_type === 'string' ? resp.subscription_type : null
  const limits = resp.rate_limits
  if (!resp.rate_limits_available || !limits || typeof limits !== 'object') return { ...base, subscriptionType }
  const windows: UsageStatus['windows'] = {}
  for (const [raw, key] of Object.entries(WINDOW_KEYS)) {
    const w = mapWindow(limits[raw as keyof typeof WINDOW_KEYS])
    if (w) windows[key] = w
  }
  const modelWindows: ModelRateLimitWindow[] = []
  for (const m of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    const w = mapWindow(m)
    if (w && typeof m.display_name === 'string' && m.display_name) modelWindows.push({ model: m.display_name, ...w })
  }
  // Plans without a dedicated Opus/Sonnet key may still report the model by name.
  for (const [pattern, key] of [
    [/opus/i, 'sevenDayOpus'],
    [/sonnet/i, 'sevenDaySonnet']
  ] as const) {
    if (windows[key]) continue
    const named = modelWindows.find((m) => pattern.test(m.model))
    if (named) windows[key] = { utilization: named.utilization, resetsAt: named.resetsAt }
  }
  return {
    ...base,
    authMode: authMode === 'apiKey' ? 'apiKey' : 'subscription',
    subscriptionType,
    available: true,
    windows,
    ...(modelWindows.length ? { modelWindows } : {})
  }
}

/** Merge a live rate-limit event into the previous status (windows it does not mention are kept). */
export function mapRateLimitEvent(info: RateLimitInfoLike, prev: UsageStatus | null, now = Date.now()): UsageStatus {
  const windows: UsageStatus['windows'] = { ...(prev?.windows ?? {}) }
  const put = (rawKey: string | undefined, utilization: unknown, resetsAt: unknown): void => {
    const key = rawKey ? (WINDOW_KEYS as Record<string, WindowKey | undefined>)[rawKey] : undefined
    if (!key) return
    const old = windows[key]
    windows[key] = {
      utilization: fractionToPercent(utilization) ?? old?.utilization ?? null,
      resetsAt: epochToMs(resetsAt) ?? old?.resetsAt ?? null
    }
  }
  for (const [rawKey, w] of Object.entries(info.unifiedWindows ?? {})) if (w) put(rawKey, w.utilization, w.resetsAt)
  put(info.rateLimitType, info.utilization, info.resetsAt)

  const next: UsageStatus = {
    authMode: prev?.authMode === 'apiKey' ? 'apiKey' : 'subscription',
    subscriptionType: prev?.subscriptionType ?? null,
    // Any rate-limit event means plan limits apply, even before the first usage report.
    available: true,
    windows,
    ...(prev?.modelWindows ? { modelWindows: prev.modelWindows } : {}),
    status: info.status,
    updatedAt: now
  }
  const overage = info.overageInUse ?? info.isUsingOverage
  if (typeof overage === 'boolean') next.overageInUse = overage
  if (info.status === 'rejected') {
    if (info.rateLimitType) next.limitedWindow = info.rateLimitType
    const until = epochToMs(info.resetsAt)
    if (until) next.limitedUntil = until
  }
  return next
}

/**
 * Fold a fresh usage report into the previous status, keeping the live request status from events.
 *
 * Windows the report names take the report's value. A window the previous status knew but the report leaves out is
 * kept until its reset time has passed (resetsAt null or later than the report): since 2026-11-04 the usage reply
 * omits five_hour on at least one Max account while a run's rate_limit_event still may report it, and without this
 * the next poll (a minute later) erased what the event had just told us. A window whose reset has passed is dropped.
 */
export function mergeUsage(prev: UsageStatus | null, report: UsageStatus): UsageStatus {
  if (!prev) return report
  const merged: UsageStatus = { ...report }
  if (!report.available && prev.available) {
    // A failed report does not erase what events told us.
    merged.available = true
    merged.windows = prev.windows
    if (prev.modelWindows) merged.modelWindows = prev.modelWindows
  } else if (report.available) {
    const windows: UsageStatus['windows'] = { ...report.windows }
    for (const [k, w] of Object.entries(prev.windows) as [WindowKey, RateLimitWindow | undefined][]) {
      if (!w || windows[k]) continue
      if (w.resetsAt === null || w.resetsAt > report.updatedAt) windows[k] = w
    }
    merged.windows = windows
  }
  if (prev.status) merged.status = prev.status
  if (prev.limitedWindow) merged.limitedWindow = prev.limitedWindow
  if (prev.limitedUntil) merged.limitedUntil = prev.limitedUntil
  if (prev.overageInUse !== undefined) merged.overageInUse = prev.overageInUse
  // Past the reset, the limit no longer holds.
  if (merged.limitedUntil && merged.limitedUntil <= report.updatedAt) {
    delete merged.limitedUntil
    delete merged.limitedWindow
    if (merged.status === 'rejected') merged.status = 'allowed'
  }
  return merged
}

/** Reset times of one window period differ by rounding and clock skew (ISO microseconds vs epoch seconds) by far less than this. */
const SAME_PERIOD_TOLERANCE_MS = 2 * 60_000

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined)
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined)
  if (ka.length !== kb.length) return false
  return ka.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/** One window of the same name: the higher figure inside a period, the newer period's figure across a reset. */
function reconcileWindow(p: RateLimitWindow, n: RateLimitWindow, now: number): RateLimitWindow {
  if (p.resetsAt !== null && p.resetsAt <= now) return n // prev's period is over: the figure may drop
  if (p.resetsAt !== null && n.resetsAt !== null) {
    if (n.resetsAt > p.resetsAt + SAME_PERIOD_TOLERANCE_MS) return n // a new period
    if (n.resetsAt < p.resetsAt - SAME_PERIOD_TOLERANCE_MS) return p // a stale snapshot
  }
  const utilization = p.utilization === null ? n.utilization : n.utilization === null ? p.utilization : Math.max(p.utilization, n.utilization)
  const resetsAt = p.resetsAt ?? n.resetsAt
  return p.utilization === utilization && p.resetsAt === resetsAt ? p : { utilization, resetsAt }
}

/**
 * Fold a Claude usage snapshot (any live session's, or a probe's) onto the newest status known, so the sidebar meter
 * holds steady when several sessions report out of order or in different units (poll: integer percent; events: 0.1
 * steps). Per window, inside one period utilization never goes down; a later reset time starts a new period (the
 * figure may drop); an earlier one is a stale snapshot and loses. Windows only prev has stay until their reset has
 * passed. Request state (status, limitedWindow, limitedUntil, overageInUse) follows the newer snapshot by updatedAt,
 * and a limit clears once limitedUntil has passed. API-key reports pass through. Idempotent, and returns prev itself
 * when nothing changed.
 */
export function reconcileUsage(prev: UsageStatus | null, next: UsageStatus): UsageStatus {
  if (!prev || next.authMode === 'apiKey' || prev.authMode === 'apiKey') return next
  const updatedAt = Math.max(prev.updatedAt, next.updatedAt)
  const now = next.updatedAt
  const result: UsageStatus = { ...next, updatedAt }
  delete result.status
  delete result.limitedWindow
  delete result.limitedUntil
  delete result.overageInUse
  if (result.subscriptionType === null) result.subscriptionType = prev.subscriptionType

  if (!next.available && prev.available) {
    result.available = true
    result.windows = prev.windows
    if (prev.modelWindows) result.modelWindows = prev.modelWindows
    else delete result.modelWindows
  } else if (next.available) {
    const windows: UsageStatus['windows'] = {}
    for (const k of Object.keys({ ...prev.windows, ...next.windows }) as WindowKey[]) {
      const p = prev.windows[k]
      const n = next.windows[k]
      if (p && n) windows[k] = reconcileWindow(p, n, now)
      else if (n) windows[k] = n
      else if (p && (p.resetsAt === null || p.resetsAt > now)) windows[k] = p
    }
    result.windows = windows
    const byModel = new Map<string, ModelRateLimitWindow>()
    for (const m of next.modelWindows ?? []) byModel.set(m.model, m)
    const models: ModelRateLimitWindow[] = []
    for (const m of next.modelWindows ?? []) {
      const p = (prev.modelWindows ?? []).find((x) => x.model === m.model)
      models.push(p ? { model: m.model, ...reconcileWindow(p, m, now) } : m)
    }
    for (const p of prev.modelWindows ?? []) {
      if (!byModel.has(p.model) && (p.resetsAt === null || p.resetsAt > now)) models.push(p)
    }
    if (models.length) result.modelWindows = models
    else delete result.modelWindows
  }

  const take = (s: UsageStatus): void => {
    if (s.status !== undefined) result.status = s.status
    if (s.limitedWindow !== undefined) result.limitedWindow = s.limitedWindow
    if (s.limitedUntil !== undefined) result.limitedUntil = s.limitedUntil
    if (s.overageInUse !== undefined) result.overageInUse = s.overageInUse
  }
  if (next.updatedAt >= prev.updatedAt) {
    if (next.status !== undefined) take(next)
    else {
      take(prev) // a report without request state (a poll) keeps the last known one
      if (next.overageInUse !== undefined) result.overageInUse = next.overageInUse
    }
  } else take(prev)
  if (result.limitedUntil !== undefined && result.limitedUntil <= updatedAt) {
    delete result.limitedUntil
    delete result.limitedWindow
    if (result.status === 'rejected') result.status = 'allowed'
  }
  return sameJson(result, prev) ? prev : result
}

/** Has a run used at least `cap` percentage points of the window since it started? Off when cap is unset. */
export function windowShareExceeded(startUtil: number | null | undefined, nowUtil: number | null | undefined, cap: number | undefined): boolean {
  if (cap === undefined || !Number.isFinite(cap) || cap <= 0) return false
  if (typeof startUtil !== 'number' || typeof nowUtil !== 'number') return false
  return nowUtil - startUtil >= cap
}

/**
 * Tracks a run's share of the five-hour window across a window reset: when utilization drops, the
 * share used before the reset is carried and the baseline restarts at zero.
 */
export interface ShareTracker {
  start: number
  last: number
  carried: number
}

export function trackShare(t: ShareTracker | null, nowUtil: number): ShareTracker {
  if (!t) return { start: nowUtil, last: nowUtil, carried: 0 }
  if (nowUtil < t.last) return { start: 0, last: nowUtil, carried: t.carried + (t.last - t.start) }
  return { ...t, last: nowUtil }
}

/** Percentage points of the window the run has used so far. */
export function shareUsed(t: ShareTracker): number {
  return t.carried + (t.last - t.start)
}

/** The weekly window that guards Opus: the Opus-specific one, else the overall seven-day window. */
export function opusWeeklyWindow(usage: UsageStatus | null | undefined): RateLimitWindow | undefined {
  if (!usage?.available) return undefined
  const opus = usage.windows.sevenDayOpus
  if (opus && opus.utilization !== null) return opus
  return usage.windows.sevenDay
}

/**
 * Should new deep- and top-tier reports be spawned on the everyday tier? True when the guarding weekly window is at
 * or above the threshold.
 */
export function shouldSteerToEveryday(usage: UsageStatus | null | undefined, threshold: number): boolean {
  if (!Number.isFinite(threshold)) return false
  const w = opusWeeklyWindow(usage)
  return typeof w?.utilization === 'number' && w.utilization >= threshold
}

/** @deprecated Old name of shouldSteerToEveryday. */
export const shouldSteerToSonnet = shouldSteerToEveryday
