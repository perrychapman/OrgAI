import { useLayoutEffect, useRef, useState } from 'react'
import { shouldTween, tweenAt } from './tween'

/**
 * The number to display for `value`. It follows `value` at once unless the change was user-triggered (`key` moved since
 * the last value change), both ends are known, the move is at least 1% and motion is not reduced; then one
 * requestAnimationFrame loop eases it across `durationMs`. The loop is cancelled on the next change and on unmount, and
 * a change that arrives mid-tween starts from the number on screen (rapid reversal).
 */
export function useTweenedNumber(
  value: number | null,
  opts: { key: number; reduced: boolean; durationMs: number }
): number | null {
  const [shown, setShown] = useState<number | null>(value)
  const shownRef = useRef<number | null>(value)
  const lastValue = useRef<number | null>(value)
  const lastKey = useRef(opts.key)
  const raf = useRef(0)
  const { key, reduced, durationMs } = opts

  useLayoutEffect(() => {
    if (value === lastValue.current) return
    const prev = shownRef.current
    const animate = shouldTween({ prev, next: value, key, lastKey: lastKey.current, reduced, durationMs })
    lastValue.current = value
    lastKey.current = key
    cancelAnimationFrame(raf.current)
    const set = (n: number | null): void => {
      shownRef.current = n
      setShown(n)
    }
    if (!animate || prev === null || value === null) {
      set(value)
      return
    }
    const from = prev
    const to = value
    const start = performance.now()
    const step = (now: number): void => {
      const v = tweenAt(from, to, now - start, durationMs)
      set(v)
      if (v !== to) raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
  }, [value, key, reduced, durationMs])

  useLayoutEffect(() => () => cancelAnimationFrame(raf.current), [])
  // Until the effect has run for a new value (and when reduced), the final value is what shows.
  return reduced ? value : shown
}
