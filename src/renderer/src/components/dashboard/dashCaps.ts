import { useEffect, useState } from 'react'

/**
 * Row caps per section and the page's two width steps (docs/design/dashboard-usage-redesign/project/dashboard.md "Reading
 * order"), measured on the `.dash-page` container:
 * - under 880 px: one column ("narrow");
 * - from 880 px (`wide`): the work area is two columns (Needs you and Your week left, Right now right);
 * - from 1280 px (`pair`): Pick up and Up next sit side by side (`placeSections` pairs the half-width sections).
 * Nothing on the page sizes itself to a neighbouring column; layout itself is container queries in dashboard.css.
 */
export interface DashCaps {
  /** From 880 px: two work columns. */
  wide: boolean
  /** From 1280 px: half-width sections share a row. */
  pair: boolean
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

export const WIDE_AT_PX = 880
export const PAIR_AT_PX = 1280

export const NARROW_CAPS: DashCaps = { wide: false, pair: false, needs: 3, bandRuns: 3, bandAgents: 6, bandAgentsPerRun: 4, setup: 3, resume: 4, schedules: 4, todos: 3 }
export const WIDE_CAPS: DashCaps = { wide: true, pair: false, needs: 5, bandRuns: 5, bandAgents: 12, bandAgentsPerRun: 6, setup: 5, resume: 6, schedules: 6, todos: 5 }
export const PAIR_CAPS: DashCaps = { ...WIDE_CAPS, pair: true }

/** Pick up never lists more than this, even after "Show more" (History is the archive). */
export const RESUME_MAX = 12

export function capsFor(width: number): DashCaps {
  if (width >= PAIR_AT_PX) return PAIR_CAPS
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
      setCaps((c) => (c.wide === next.wide && c.pair === next.pair ? c : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return caps
}
