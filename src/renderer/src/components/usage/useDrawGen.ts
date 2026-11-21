import { useLayoutEffect, useRef, useState } from 'react'
import { useReducedMotion } from '../../lib/canvas'
import { initDrawTracker, stepDraw, type DrawTracker } from '../../lib/usageDraw'

/**
 * The draw generation of a Usage panel (dashboard-usage-redesign motion.md "Draw"): 0 while nothing has drawn, then 1 on
 * mount when the page is arriving, then one more for each filter or metric change the person made (`drawSeq`) once its
 * new data (`fingerprint`) has rendered. A background refresh never raises it. Callers key the drawn element on the
 * generation, so a new one restarts the CSS draw animation; under reduced motion the generation stays 0 (end states).
 */
export function useDrawGen({ arriving, drawSeq, fingerprint }: { arriving?: boolean; drawSeq?: number; fingerprint: readonly unknown[] }): number {
  const reduced = useReducedMotion()
  const tracker = useRef<DrawTracker | null>(null)
  const [gen, setGen] = useState(() => (arriving ? 1 : 0))
  // Layout effect, so the generation is raised before the browser paints the new data unclipped.
  useLayoutEffect(() => {
    const cur = tracker.current ?? initDrawTracker(drawSeq, fingerprint)
    const { next, draw } = stepDraw(cur, { seq: drawSeq, fp: fingerprint, now: performance.now() })
    tracker.current = next
    if (draw) setGen((g) => g + 1)
  })
  return reduced ? 0 : gen
}
