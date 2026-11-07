import { useEffect, useRef, useState } from 'react'
import { tokenMs } from './useExitPresence'

/** At most one bell cue per this many ms (docs/design/motion.md 3.9). */
export const BELL_CUE_THROTTLE_MS = 5000
/** Counts that settle in right after mount (a relaunch restoring pending decisions) are not news. */
export const BELL_CUE_MOUNT_GRACE_MS = 2000

/** Pure: the cue plays only when the count rose, the surface is past its mount grace and the last cue is old enough. */
export function shouldCue(prev: number, next: number, lastCueAt: number | null, now: number, mountedAt: number): boolean {
  if (!(next > prev)) return false
  if (now - mountedAt < BELL_CUE_MOUNT_GRACE_MS) return false
  if (lastCueAt !== null && now - lastCueAt < BELL_CUE_THROTTLE_MS) return false
  return true
}

/**
 * One-shot attention cue for a rising decision count. `ping` goes on the badge (data-ping, cleared on animationend
 * through `onPingEnd`), `ring` on the bell (a `.motion-ring` class, cleared by a timer). Never a loop, never speaks.
 * `scope` (a project id) resets the baseline, so switching projects is not a rise.
 */
export function useBellCue(count: number, scope = ''): { ping: boolean; ring: boolean; onPingEnd: () => void } {
  const [ping, setPing] = useState(false)
  const [ring, setRing] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const state = useRef({ prev: count, scope, last: null as number | null, mountedAt: Date.now() })
  useEffect(() => {
    const s = state.current
    const now = Date.now()
    if (s.scope !== scope) {
      s.scope = scope
      s.prev = count
      return undefined
    }
    const play = shouldCue(s.prev, count, s.last, now, s.mountedAt)
    s.prev = count
    if (!play) return undefined
    s.last = now
    setPing(true)
    setRing(true)
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    // The timer also clears the ping, in case the animation never ran (a hidden element).
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      setRing(false)
      setPing(false)
    }, Math.round(tokenMs('--dur-slow') * 2.3) + 60)
    return undefined
  }, [count, scope])
  useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current)
    },
    []
  )
  return { ping, ring, onPingEnd: () => setPing(false) }
}
