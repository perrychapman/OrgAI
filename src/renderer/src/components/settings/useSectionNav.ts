import type { RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

/** Gap kept between the top of the scroller (or the sticky nav) and a section heading after a jump. */
const JUMP_GAP_PX = 8
/** A heading counts as "current" while it sits in the top share of the scroller; once above it, the last one passed wins. */
const BAND_ROOT_MARGIN = '0px 0px -65% 0px'
const TAKEOVER_EVENTS = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const

type Where = 'above' | 'in' | 'below'

function headingOf(section: HTMLElement): HTMLElement {
  return section.querySelector<HTMLElement>('h2') ?? section
}

/**
 * Sub-nav behaviour for a settings page: `go(id)` scrolls only the page's own scroll container (never the document)
 * and focuses the section heading; `active` follows the headings through an IntersectionObserver.
 */
export function useSectionNav(ids: string[], scroller: RefObject<HTMLElement | null>, ready = true, rev?: unknown): { active: string; go: (id: string) => void } {
  const [active, setActive] = useState(ids[0])
  const pinned = useRef<string | null>(null)
  const key = ids.join('|')

  const go = useCallback(
    (id: string): void => {
      const box = scroller.current
      const section = document.getElementById(id)
      if (!box || !section) return
      const heading = headingOf(section)
      const nav = box.querySelector<HTMLElement>('.settings-nav')
      // In the narrow layout the nav is a sticky row over the content; in the wide layout it is a side rail.
      const stuckRow = nav && getComputedStyle(nav).flexDirection === 'row' ? nav.offsetHeight : 0
      const top = heading.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - stuckRow - JUMP_GAP_PX
      box.scrollTo({ top: Math.max(0, top) })
      pinned.current = id
      setActive(id)
      if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1
      heading.focus({ preventScroll: true })
    },
    [scroller]
  )

  useEffect(() => {
    const box = scroller.current
    if (!box || !ready) return
    const list = key.split('|')
    const state = new Map<string, Where>(list.map((id) => [id, 'below']))
    const headings = new Map<Element, string>()
    const release = (): void => {
      pinned.current = null
    }
    const pick = (): void => {
      if (pinned.current) return
      let current = list[0]
      for (const id of list) {
        const w = state.get(id)
        if (w === 'above') current = id
        else if (w === 'in') {
          current = id
          break
        }
      }
      setActive(current)
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = headings.get(e.target)
          if (!id) continue
          const rootTop = e.rootBounds?.top ?? 0
          state.set(id, e.isIntersecting ? 'in' : e.boundingClientRect.top < rootTop ? 'above' : 'below')
        }
        pick()
      },
      { root: box, rootMargin: BAND_ROOT_MARGIN, threshold: 0 }
    )
    for (const id of list) {
      const el = document.getElementById(id)
      if (!el) continue
      const h = headingOf(el)
      headings.set(h, id)
      io.observe(h)
    }
    // The user took over the scrolling: the headings decide again.
    for (const ev of TAKEOVER_EVENTS) box.addEventListener(ev, release, { passive: true })
    return () => {
      io.disconnect()
      for (const ev of TAKEOVER_EVENTS) box.removeEventListener(ev, release)
    }
  }, [key, scroller, ready, rev])

  return { active, go }
}
