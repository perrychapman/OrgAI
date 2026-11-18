/**
 * Pure rules behind the shared context menu (components/ui/ContextMenu.tsx, docs/design/context-menus.md): where the
 * menu goes, which item a key moves to, and when the platform's own text menu must win over ours.
 */

export interface Point {
  x: number
  y: number
}
export interface Size {
  w: number
  h: number
}
export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/** Space kept between the menu and the window edge. */
export const MENU_MARGIN = 8
/** Gap between an anchoring element and the menu opened from it. */
export const MENU_GAP = 4

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, Math.max(lo, hi)))

/**
 * A menu opened at the pointer: its top left corner at the point; flipped to the left or above when it would run past
 * the right or bottom edge (as desktop menus do), then kept inside the viewport.
 */
export function placeAtPoint(at: Point, menu: Size, viewport: Size, margin = MENU_MARGIN): Point {
  let x = at.x
  let y = at.y
  if (x + menu.w > viewport.w - margin && at.x - menu.w >= margin) x = at.x - menu.w
  if (y + menu.h > viewport.h - margin && at.y - menu.h >= margin) y = at.y - menu.h
  return { x: Math.round(clamp(x, margin, viewport.w - menu.w - margin)), y: Math.round(clamp(y, margin, viewport.h - menu.h - margin)) }
}

/**
 * A menu opened from an element (keyboard or a More button): under the element, aligned to its start or end edge;
 * above it when there is no room below and there is room above; then kept inside the viewport.
 */
export function placeAtAnchor(anchor: Rect, menu: Size, viewport: Size, align: 'start' | 'end' = 'start', margin = MENU_MARGIN, gap = MENU_GAP): Point {
  let y = anchor.bottom + gap
  if (y + menu.h > viewport.h - margin && anchor.top - gap - menu.h >= margin) y = anchor.top - gap - menu.h
  const x = align === 'end' ? anchor.right - menu.w : anchor.left
  return { x: Math.round(clamp(x, margin, viewport.w - menu.w - margin)), y: Math.round(clamp(y, margin, viewport.h - menu.h - margin)) }
}

export type MenuNavKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'

/**
 * Roving focus inside a menu: the next index for an arrow, Home or End key, wrapping, over `count` items. Disabled
 * items stay focusable (WAI-ARIA menu pattern), so every index is a stop. -1 when there are no items.
 */
export function nextMenuIndex(current: number, key: MenuNavKey, count: number): number {
  if (count <= 0) return -1
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (current < 0 || current >= count) return key === 'ArrowDown' ? 0 : count - 1
  return key === 'ArrowDown' ? (current + 1) % count : (current - 1 + count) % count
}

/** Type-ahead: the next item after `current` whose label starts with `char` (case-insensitive, wrapping), else -1. */
export function typeAheadIndex(current: number, char: string, labels: readonly string[]): number {
  const c = char.toLocaleLowerCase()
  if (!c.trim() || labels.length === 0) return -1
  for (let step = 1; step <= labels.length; step++) {
    const i = (Math.max(current, -1) + step) % labels.length
    if (labels[i].trim().toLocaleLowerCase().startsWith(c)) return i
  }
  return -1
}

/** The keyboard way to ask for a context menu: the Menu (ContextMenu) key or Shift+F10, with no other modifier. */
export function isMenuKey(e: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return false
  return e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)
}

export interface NativeMenuFacts {
  /** The event target is (inside) an input, textarea, select or contenteditable element. */
  editable: boolean
  /** The event target is (inside) a link with an href. */
  link: boolean
  /** The current selection's text, when the selection touches the surface; '' otherwise. */
  selectedText: string
}

/**
 * The platform text menu (Cut / Copy / Paste, Copy, Copy link address; added in main) wins over a custom menu inside
 * editable fields, on links and over a non-empty text selection: the custom menu must not call preventDefault then.
 */
export function nativeMenuWins(f: NativeMenuFacts): boolean {
  return f.editable || f.link || f.selectedText.trim().length > 0
}
