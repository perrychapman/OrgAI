/**
 * Pure helpers for the KPI number tween (docs/design/motion.md; usage dashboard motion plan M8). No DOM, no React.
 * The hook in useTweenedNumber.ts drives these from one requestAnimationFrame loop.
 */

/** Relative change below which a number is not worth animating. */
export const TWEEN_MIN_CHANGE = 0.01

export function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t))
  return 1 - (1 - c) ** 3
}

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t
}

/** The value `elapsedMs` into a tween of `durationMs`; exactly `to` once the time is up. */
export function tweenAt(from: number, to: number, elapsedMs: number, durationMs: number): number {
  if (!(durationMs > 0) || elapsedMs >= durationMs) return to
  return lerp(from, to, easeOutCubic(elapsedMs / durationMs))
}

export interface TweenDecision {
  prev: number | null
  next: number | null
  /** The view's change counter now and as of the previous value change. */
  key: number
  lastKey: number
  reduced: boolean
  durationMs: number
  /** How long ago the key last moved; a change arriving later than TWEEN_ARM_MS after it is a refresh, not the user's. */
  keyAgeMs?: number
}

/** A user change arms the tween for this long (its data normally lands well within it); later changes are refreshes. */
export const TWEEN_ARM_MS = 5000

/**
 * Whether a value change animates: only after a user-triggered change (key moved, within TWEEN_ARM_MS), never for
 * unknown (null) on either side, never under reduced motion or a zero duration, and not for changes under 1%.
 */
export function shouldTween(d: TweenDecision): boolean {
  if (d.reduced || !(d.durationMs > 0)) return false
  if (d.key === d.lastKey) return false
  if (d.keyAgeMs !== undefined && d.keyAgeMs > TWEEN_ARM_MS) return false
  if (d.prev === null || d.next === null) return false
  if (!Number.isFinite(d.prev) || !Number.isFinite(d.next) || d.prev === d.next) return false
  const base = Math.max(Math.abs(d.prev), Math.abs(d.next))
  return Math.abs(d.next - d.prev) / base >= TWEEN_MIN_CHANGE
}

/** Inverse of formatTokens for display text ("620", "6.0k", "1.20M"); null when it is not a figure. */
export function parseTokenText(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([kM]?)$/.exec(text.trim())
  if (!m) return null
  return Number(m[1]) * (m[2] === 'M' ? 1_000_000 : m[2] === 'k' ? 1000 : 1)
}

/** Inverse of formatDuration ("42s", "3m 05s", "1h 02m") in milliseconds; null when it is not a duration. */
export function parseDurationText(text: string): number | null {
  const t = text.trim()
  let m = /^(\d+)s$/.exec(t)
  if (m) return Number(m[1]) * 1000
  m = /^(\d+)m (\d+)s$/.exec(t)
  if (m) return (Number(m[1]) * 60 + Number(m[2])) * 1000
  m = /^(\d+)h (\d+)m$/.exec(t)
  if (m) return (Number(m[1]) * 3600 + Number(m[2]) * 60) * 1000
  return null
}
