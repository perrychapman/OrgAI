import type { KeyboardEvent, RefObject } from 'react'
import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * One tab stop for a long run of buttons or options: only the current item has tabindex 0, the arrow keys (and Home / End)
 * move focus by position, so a 50-tile grid or a 50-row list costs a single Tab. Items are found by selector inside the
 * container on every render; the current one survives re-renders while it still exists.
 */
export function useRovingFocus(
  container: RefObject<HTMLElement | null>,
  selector: string
): { onKeyDown: (e: KeyboardEvent<HTMLElement>) => void; onFocus: () => void; focusCurrent: () => void } {
  const current = useRef<HTMLElement | null>(null)
  const items = useCallback((): HTMLElement[] => Array.from(container.current?.querySelectorAll<HTMLElement>(selector) ?? []), [container, selector])

  useLayoutEffect(() => {
    const all = items()
    if (all.length === 0) return
    const active = document.activeElement as HTMLElement | null
    const keep = active && all.includes(active) ? active : current.current && all.includes(current.current) ? current.current : all[0]
    current.current = keep
    for (const el of all) el.tabIndex = el === keep ? 0 : -1
  })

  const onFocus = useCallback((): void => {
    const active = document.activeElement as HTMLElement | null
    const all = items()
    if (!active || !all.includes(active)) return
    current.current = active
    for (const el of all) el.tabIndex = el === active ? 0 : -1
  }, [items])

  const focusCurrent = useCallback((): void => {
    const all = items()
    const target = current.current && all.includes(current.current) ? current.current : all[0]
    target?.focus()
  }, [items])

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>): void => {
      const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End']
      if (!keys.includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return
      const all = items()
      const from = all.indexOf(document.activeElement as HTMLElement)
      if (from < 0) return
      let to = from
      if (e.key === 'Home') to = 0
      else if (e.key === 'End') to = all.length - 1
      else if (e.key === 'ArrowRight') to = Math.min(all.length - 1, from + 1)
      else if (e.key === 'ArrowLeft') to = Math.max(0, from - 1)
      else {
        // Up / Down: the nearest item in the next row (by position), so it works for one column and for a grid.
        const r = all[from].getBoundingClientRect()
        const down = e.key === 'ArrowDown'
        let best = -1
        let bestScore = Infinity
        all.forEach((el, i) => {
          if (i === from) return
          const b = el.getBoundingClientRect()
          const dy = down ? b.top - r.top : r.top - b.top
          if (dy <= 4) return
          const score = dy * 1000 + Math.abs(b.left - r.left)
          if (score < bestScore) {
            bestScore = score
            best = i
          }
        })
        if (best >= 0) to = best
      }
      e.preventDefault()
      if (to !== from) all[to].focus()
    },
    [items]
  )

  return { onKeyDown, onFocus, focusCurrent }
}
