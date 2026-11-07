/**
 * Shared "a layout is gliding" signal (docs/design/motion.md 3.5, 3.8, 3.12). Whoever starts a size transition that
 * resizes a canvas (sidebar collapse, tray collapse, side panel collapse) calls `beginLayoutMotion(ms)`. Canvases skip
 * refits while `isLayoutMoving()` and refit once on `onLayoutSettled`. Nothing here animates; it only coordinates.
 * While moving, <html> carries data-layout-moving (for CSS and e2e).
 */
type Listener = () => void

let until = 0
let timer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<Listener>()

/** Extra time after the transition before the settled signal, so the last frame has been laid out. */
export const LAYOUT_SETTLE_MARGIN_MS = 50

function setAttr(name: string, on: boolean): void {
  if (typeof document === 'undefined') return
  if (on) document.documentElement.setAttribute(name, '')
  else document.documentElement.removeAttribute(name)
}

/**
 * Marks a layout glide of `ms` starting now. Overlapping calls extend the window; one settled signal at the end.
 * `columns: true` (the user's side panel Hide / Show) also sets <html data-columns-moving>, the only window in which
 * layout.css lets panel columns transition; a tray glide never does, so an auto-collapse or a window resize during it
 * still snaps (review L).
 */
export function beginLayoutMotion(ms: number, options: { columns?: boolean } = {}, now = Date.now()): void {
  if (!(ms > 0)) {
    // Reduced motion or no transition: the resize is instant, a refit right away is what the canvas already does.
    return
  }
  if (options.columns) setAttr('data-columns-moving', true)
  const end = now + ms + LAYOUT_SETTLE_MARGIN_MS
  if (end <= until) return
  until = end
  setAttr('data-layout-moving', true)
  if (timer !== undefined) clearTimeout(timer)
  timer = setTimeout(settle, end - now)
}

function settle(): void {
  timer = undefined
  until = 0
  setAttr('data-layout-moving', false)
  setAttr('data-columns-moving', false)
  for (const l of [...listeners]) {
    try {
      l()
    } catch {
      // A listener's failure never stops the others.
    }
  }
}

export function isLayoutMoving(now = Date.now()): boolean {
  return until > now
}

/** Subscribe to the end of a glide. Returns the unsubscribe function. */
export function onLayoutSettled(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test hook: forget any pending glide. */
export function resetLayoutMotion(): void {
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  until = 0
  listeners.clear()
  setAttr('data-layout-moving', false)
  setAttr('data-columns-moving', false)
}
