import { useEffect, useState } from 'react'
import { bandBudget } from '../../lib/dashboardBand'

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

/** Under this much height in the scroll region the page is "short" (1024x640 leaves 584 px): the strip draws dense. */
export const SHORT_REGION_PX = 700

export function isShortRegion(height: number): boolean {
  return height > 0 && height < SHORT_REGION_PX
}

/** Whether the Dashboard's scroll region (the element's closest `.dashboard`) is short, kept current by a ResizeObserver. */
export function useShortRegion(el: HTMLElement | null): boolean {
  const [short, setShort] = useState(false)
  useEffect(() => {
    const region = el?.closest<HTMLElement>('.dashboard')
    if (!region || typeof ResizeObserver === 'undefined') return
    const measure = (): void => setShort(isShortRegion(region.clientHeight))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(region)
    return () => ro.disconnect()
  }, [el])
  return short
}

/**
 * The band's height budget (walk-3 M4): in two tracks, the other column's measured height plus the slack. The other
 * column is every visible area except the band's; it never depends on the band, so this cannot feed back on itself.
 * Undefined in one track and while nothing else is drawn.
 */
export function useBandBudget(el: HTMLElement | null): number | undefined {
  const [budget, setBudget] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = (): void => {
      const twoTracks = getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length >= 2
      let other = 0
      if (twoTracks) {
        const top = el.getBoundingClientRect().top
        for (const area of Array.from(el.children) as HTMLElement[]) {
          if (area.classList.contains('dash-area-now') || area.offsetParent === null) continue
          other = Math.max(other, area.getBoundingClientRect().bottom - top)
        }
      }
      const next = twoTracks ? bandBudget(other) : undefined
      setBudget((b) => (b === next ? b : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    for (const child of Array.from(el.children)) ro.observe(child)
    return () => ro.disconnect()
  }, [el])
  return budget
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
