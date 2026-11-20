import { useEffect, useState } from 'react'

/**
 * Row caps per section (docs/design/dashboard-overhaul.md section 7): "narrow" under 1000 px of `.dash-page` width (one
 * track), "wide" from it (two tracks). Nothing on the page sizes itself to a neighbouring column.
 */
export interface DashCaps {
  wide: boolean
  needs: number
  bandRuns: number
  bandAgents: number
  bandAgentsPerRun: number
  setup: number
  /** Pick up where you left off. */
  resume: number
  /** Today, Scheduled group. */
  schedules: number
  /** Today, To-dos group. */
  todos: number
}

export const WIDE_AT_PX = 1000

export const NARROW_CAPS: DashCaps = { wide: false, needs: 3, bandRuns: 3, bandAgents: 6, bandAgentsPerRun: 4, setup: 3, resume: 4, schedules: 4, todos: 3 }
export const WIDE_CAPS: DashCaps = { wide: true, needs: 5, bandRuns: 5, bandAgents: 12, bandAgentsPerRun: 6, setup: 5, resume: 6, schedules: 6, todos: 5 }

/** Pick up never lists more than this, even after "Show more" (History is the archive). */
export const RESUME_MAX = 12

export function capsFor(width: number): DashCaps {
  return width >= WIDE_AT_PX ? WIDE_CAPS : NARROW_CAPS
}

/**
 * The caps for an element's width (pass the element from a callback ref, so a later mount is seen), kept current by a
 * ResizeObserver. Narrow until first measured.
 */
export function useDashCaps(el: HTMLElement | null): DashCaps {
  const [caps, setCaps] = useState<DashCaps>(NARROW_CAPS)
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = (): void => {
      const next = capsFor(el.clientWidth)
      setCaps((c) => (c.wide === next.wide ? c : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return caps
}
