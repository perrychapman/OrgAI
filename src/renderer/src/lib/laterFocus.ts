/**
 * Focus that a handler hands back after React has rendered (a pinned tile or a moved section is re-inserted, so the control
 * the person pressed has to be found again) runs a frame or two later. On a slow or throttled window those frames can come
 * late, after the person has already moved on with the keyboard; the late focus must not pull them back.
 *
 * `from` is what had focus when the handler ran, `active` what has it now. Restore only when focus is still where it was, when
 * it fell to the page (the re-insert dropped it) or when `from` left the page (so nobody can have chosen to stay on it).
 */
export function mayRestoreFocus(from: { isConnected: boolean } | null, active: unknown, body: unknown): boolean {
  if (active === null || active === undefined || active === body || active === from) return true
  return from !== null && !from.isConnected
}

/** `focus()` on what `find` returns after `frames` animation frames, unless the person moved focus elsewhere in the meantime. */
export function focusLaterUnlessMoved(find: () => HTMLElement | null | undefined, frames = 1): void {
  const from = document.activeElement
  const step = (left: number): void => {
    requestAnimationFrame(() => {
      if (left > 1) return step(left - 1)
      if (mayRestoreFocus(from, document.activeElement, document.body)) find()?.focus()
    })
  }
  step(Math.max(1, frames))
}
