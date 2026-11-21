import { useLayoutEffect, useRef, useState } from 'react'
import { countPlan } from './countUp'
import { tweenAt } from './tween'
import { tokenMs } from './useExitPresence'

/**
 * The number to display for `value` (lib/countUp.ts). `arriving` is the page-arrival flag (usePageArrival): while it is
 * true the first known value counts up from zero once; after that, changes tween over --dur-slow. `still` (reduced motion
 * or Pause motion) always shows the final value. Format the returned number with the same formatter as the final value
 * so the text never changes shape; announce only the final value, never the frames.
 *
 *   const shown = useCountUp(cost, { arriving, still: reduced })
 */
export function useCountUp(value: number | null, opts: { arriving: boolean; still: boolean }): number | null {
  const { arriving, still } = opts
  const [shown, setShown] = useState<number | null>(() => (arriving && !still && value !== null ? 0 : value))
  const shownRef = useRef<number | null>(shown)
  const counted = useRef(false)
  const raf = useRef(0)

  useLayoutEffect(() => {
    const set = (n: number | null): void => {
      shownRef.current = n
      setShown(n)
    }
    const arrive = arriving && !counted.current && value !== null
    if (value !== null) counted.current = true
    const plan = still ? null : countPlan(shownRef.current, value, arrive)
    cancelAnimationFrame(raf.current)
    const ms = plan ? tokenMs(plan.token) : 0
    if (!plan || ms < 1) {
      set(value)
      return
    }
    const start = performance.now()
    const step = (now: number): void => {
      const v = tweenAt(plan.from, plan.to, now - start, ms)
      set(v)
      if (v !== plan.to) raf.current = requestAnimationFrame(step)
    }
    set(plan.from)
    raf.current = requestAnimationFrame(step)
  }, [value, arriving, still])

  useLayoutEffect(() => () => cancelAnimationFrame(raf.current), [])
  return still ? value : shown
}
