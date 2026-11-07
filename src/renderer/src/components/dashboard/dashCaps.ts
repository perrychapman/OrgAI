import { useEffect, useState } from 'react'

/** Row caps per region (docs/design/dashboard-2.md 2.4): "narrow" under 1280 px of work-area width, "wide" from it. */
export interface DashCaps {
  wide: boolean
  needs: number
  bandRuns: number
  bandAgents: number
  bandAgentsPerRun: number
  setup: number
  paused: number
  ended: number
}

export const WIDE_AT_PX = 1280

export const NARROW_CAPS: DashCaps = { wide: false, needs: 3, bandRuns: 3, bandAgents: 6, bandAgentsPerRun: 4, setup: 3, paused: 4, ended: 4 }
export const WIDE_CAPS: DashCaps = { wide: true, needs: 5, bandRuns: 5, bandAgents: 12, bandAgentsPerRun: 6, setup: 5, paused: 6, ended: 6 }

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
