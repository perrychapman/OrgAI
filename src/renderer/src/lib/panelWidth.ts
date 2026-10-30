import { useCallback, useState } from 'react'

/** Sidebar column range (px) and default; the default matches `--sidebar-w`. */
export const SIDEBAR_W = { min: 200, max: 420, def: 232 } as const
/** Right side panel minimum (px). There is no fixed maximum: the canvas minimum below bounds it. The default is whatever the CSS gives. */
export const PANEL_W = { min: 280 } as const
/** The canvas next to a side panel never gets narrower than this. */
export const CANVAS_MIN_PX = 280
/** From this panel width the Live view moves the composer into the panel column (SidePanel sets data-side-wide). */
export const PANEL_WIDE_PX = 480
/** The main area next to the sidebar never gets narrower than this. */
export const MAIN_MIN_PX = 480
/** Arrow-key step and the Shift step (px). */
export const STEP_PX = 16
export const STEP_BIG_PX = 64

export const clampWidth = (w: number, min: number, max: number): number => Math.round(Math.min(Math.max(w, min), Math.max(min, max)))

/** Largest allowed width: the hard max, but leaving `reserve` px of the container for the neighbouring area. Never below min. */
export function maxWidthFor(container: number, reserve: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(container - reserve)))
}

/**
 * One width budget for the panel next to the canvas. `parent` is the grid width (0 = not measured yet). The canvas keeps
 * CANVAS_MIN_PX; the panel gets what is left, clamped to its range. When even the panel's minimum does not fit, `fits`
 * is false and the panel must show as its rail instead of squeezing the canvas. `saved` is never changed here.
 */
export function panelBudget(parent: number, saved: number | null): { fits: boolean; max: number; width: number | null } {
  if (parent <= 0) return { fits: true, max: Infinity, width: saved === null ? null : Math.max(saved, PANEL_W.min) }
  const room = Math.floor(parent - CANVAS_MIN_PX)
  const fits = room >= PANEL_W.min
  const max = Math.max(PANEL_W.min, room)
  return { fits, max, width: saved === null ? null : clampWidth(saved, PANEL_W.min, max) }
}

/** New width for a pointer drag. `dir` is 1 when moving right grows the column (sidebar), -1 when it shrinks it (right panel). */
export function dragWidth(start: number, dx: number, dir: 1 | -1, min: number, max: number): number {
  return clampWidth(start + dir * dx, min, max)
}

/** New width for a key on a vertical separator, or null for keys it ignores. Right grows by `dir` (see dragWidth). */
export function keyWidth(value: number, key: string, shift: boolean, dir: 1 | -1, min: number, max: number): number | null {
  const step = shift ? STEP_BIG_PX : STEP_PX
  if (key === 'ArrowRight') return clampWidth(value + dir * step, min, max)
  if (key === 'ArrowLeft') return clampWidth(value - dir * step, min, max)
  if (key === 'Home') return min
  if (key === 'End') return max
  return null
}

export function readWidth(storageKey: string): number | null {
  try {
    const raw = localStorage.getItem(storageKey)
    const n = raw === null ? NaN : Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

export function writeWidth(storageKey: string, w: number | null): void {
  try {
    if (w === null) localStorage.removeItem(storageKey)
    else localStorage.setItem(storageKey, String(Math.round(w)))
  } catch {
    /* storage unavailable: the width lasts until reload */
  }
}

/** A width saved in localStorage; null means "use the CSS default". Setting persists at once. */
export function usePersistedWidth(storageKey: string): [number | null, (w: number | null) => void] {
  const [w, setW] = useState<number | null>(() => readWidth(storageKey))
  const set = useCallback(
    (next: number | null) => {
      setW(next)
      writeWidth(storageKey, next)
    },
    [storageKey]
  )
  return [w, set]
}
