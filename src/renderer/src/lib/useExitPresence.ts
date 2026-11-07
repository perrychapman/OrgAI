import { useEffect, useState } from 'react'

/**
 * Exit retention (docs/design/motion.md 2.3). CSS cannot play an exit for a node React already removed, so a surface
 * that should fade out on a direct user action keeps it mounted for one exit duration:
 *
 *   const exit = useExitPresence(open)
 *   {exit.mounted && <div className="motion-exit" {...exitProps(exit.state)}>...</div>}
 *
 * The duration is read from a token on <html> (default --dur-fast), so reduced motion (0.01 ms) unmounts at once.
 * While leaving, the node is `inert` and `aria-hidden` (exitProps), so focus and screen readers never meet a dying
 * control. Never move focus after the exit: move it in the same tick as the action. Use only for user-driven removals,
 * never for streaming rows.
 */
export type PresenceState = 'in' | 'out'

export interface ExitPresence {
  mounted: boolean
  state: PresenceState
}

/** Parses a CSS time ('100ms', '0.01ms', '0.2s') to whole milliseconds; anything else is 0. */
export function cssTimeMs(value: string | null | undefined): number {
  const v = (value ?? '').trim()
  const m = /^(-?\d*\.?\d+)(ms|s)$/i.exec(v)
  if (!m) return 0
  const n = Number.parseFloat(m[1]) * (m[2].toLowerCase() === 's' ? 1000 : 1)
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : 0
}

/** Reads a duration token from <html> in ms (0 under reduced motion, or outside a DOM). */
export function tokenMs(token = '--dur-fast'): number {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return 0
  return cssTimeMs(getComputedStyle(document.documentElement).getPropertyValue(token))
}

/** Pure transition used by the hook: what to do when `present` changes. */
export function nextPresence(present: boolean, wasMounted: boolean, exitMs: number): { lingering: boolean } {
  return { lingering: !present && wasMounted && exitMs > 0 }
}

/** Props for the retained element: data-state, and inert / aria-hidden while leaving. */
export function exitProps(state: PresenceState): {
  'data-state': PresenceState
  inert?: boolean
  'aria-hidden'?: true
} {
  return state === 'out' ? { 'data-state': 'out', inert: true, 'aria-hidden': true } : { 'data-state': 'in' }
}

export function useExitPresence(present: boolean, token = '--dur-fast'): ExitPresence {
  const [prev, setPrev] = useState(present)
  const [lingering, setLingering] = useState(false)
  const [ms, setMs] = useState(0)
  // Derived state during render: the leaving frame already renders state 'out' (no frame of a stale 'in').
  if (present !== prev) {
    setPrev(present)
    const exitMs = present ? 0 : tokenMs(token)
    setLingering(nextPresence(present, prev, exitMs).lingering)
    setMs(exitMs)
  }
  useEffect(() => {
    if (!lingering) return undefined
    const t = window.setTimeout(() => setLingering(false), ms)
    return () => window.clearTimeout(t)
  }, [lingering, ms])
  return { mounted: present || lingering, state: present ? 'in' : 'out' }
}
