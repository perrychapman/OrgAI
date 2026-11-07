/**
 * Scroll an element into view inside its own scroll container only (ux-review-config-2 N1).
 *
 * `Element.scrollIntoView` also scrolls every ancestor, including `overflow: hidden` ones such as `<html>` and the app
 * shell, when the container cannot bring the target to the requested edge (a section near the end of the settings
 * scroller). That shifted the whole window. This sets the container's `scrollTop` (clamped) and then resets any
 * non-scrolling ancestor that was shifted anyway.
 */

/** The nearest ancestor that scrolls vertically (overflow-y auto or scroll), or null. */
export function scrollContainerOf(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY
    if (oy === 'auto' || oy === 'scroll') return p
  }
  return null
}

/** The clamped scrollTop that puts a target at `block` inside a container (pure; offsets in px). */
export function targetScrollTop(
  block: 'start' | 'center' | 'nearest',
  m: { current: number; targetTop: number; targetHeight: number; clientHeight: number; scrollHeight: number; padTop?: number }
): number {
  const max = Math.max(0, m.scrollHeight - m.clientHeight)
  const pad = m.padTop && m.padTop > 0 ? m.padTop : 0
  let top: number
  if (block === 'start') top = m.current + m.targetTop - pad
  else if (block === 'center') top = m.current + m.targetTop - (m.clientHeight - m.targetHeight) / 2
  else if (m.targetTop < pad) top = m.current + m.targetTop - pad
  else if (m.targetTop + m.targetHeight > m.clientHeight) top = m.current + Math.min(m.targetTop, m.targetTop + m.targetHeight - m.clientHeight)
  else top = m.current
  return Math.round(Math.min(max, Math.max(0, top)))
}

/** Undo any scroll the browser put on non-scrolling ancestors (overflow hidden / visible), up to the document. */
export function resetShiftedAncestors(from: Element | null): void {
  for (let p = from; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY
    if (oy !== 'auto' && oy !== 'scroll' && p.scrollTop !== 0) p.scrollTop = 0
  }
  if (document.documentElement.scrollTop !== 0) document.documentElement.scrollTop = 0
  if (document.body.scrollTop !== 0) document.body.scrollTop = 0
}

/** Scroll `el` to `block` within its scroll container only; never moves the window or the app shell. */
export function scrollWithin(el: Element | null | undefined, block: 'start' | 'center' | 'nearest' = 'start'): void {
  if (!el) return
  const box = scrollContainerOf(el)
  if (box) {
    const b = box.getBoundingClientRect()
    const t = el.getBoundingClientRect()
    box.scrollTop = targetScrollTop(block, {
      current: box.scrollTop,
      targetTop: t.top - b.top,
      targetHeight: t.height,
      clientHeight: box.clientHeight,
      scrollHeight: box.scrollHeight,
      padTop: Number.parseFloat(getComputedStyle(box).scrollPaddingTop) || 0
    })
  }
  resetShiftedAncestors(box?.parentElement ?? el.parentElement)
}
