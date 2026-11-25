/**
 * Opt-in window placement for tests and walkthroughs (ORGAI_WINDOW_DISPLAY, ORGAI_WINDOW_INACTIVE). Pure: index.ts feeds
 * it the screen's displays. Unset or any other spelling means today's behaviour.
 */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayInfo {
  id: number
  bounds: Rect
  workArea: Rect
}

export type DisplayChoice = { kind: 'secondary' } | { kind: 'index'; index: number }

/** Accepts exactly 'secondary' or a positive integer written as plain digits (1..99). Anything else is null. */
export function parseWindowDisplay(value: string | undefined): DisplayChoice | null {
  if (value === undefined) return null
  if (value === 'secondary') return { kind: 'secondary' }
  if (/^[1-9][0-9]{0,1}$/.test(value)) return { kind: 'index', index: Number(value) }
  return null
}

/** Only the exact value '1' turns it on. */
export function parseWindowInactive(value: string | undefined): boolean {
  return value === '1'
}

/**
 * Only the exact value '1' turns it on, and only when ORGAI_DATA_DIR is also set to a non-empty value (test plumbing: e2e and
 * scripts/verify-pack.mjs always set it; a real install's persistent environment cannot hide the app by itself).
 * ORGAI_WINDOW_HIDDEN: windows load and paint but nothing shows or takes focus, see windowShowMode.
 */
export function parseWindowHidden(value: string | undefined, dataDir?: string): boolean {
  return value === '1' && typeof dataDir === 'string' && dataDir !== ''
}

/**
 * How a window is shown when it is ready. 'ghost' (ORGAI_WINDOW_HIDDEN=1) is shown without activation but fully transparent,
 * click-through and off the taskbar: nothing appears on screen or takes focus, yet the page keeps painting and its frames,
 * timers and visibility run as in a real window (a window that is never shown has no frames: screenshots and rAF stall).
 * setOpacity works only on Windows and macOS, so on Linux hidden keeps the old behaviour, 'never' (the window is never
 * shown; verify-pack's Linux boot check relies on that). Hidden wins over inactive; neither is today's behaviour ('normal').
 */
export type WindowShowMode = 'ghost' | 'never' | 'inactive' | 'normal'
export function windowShowMode(hidden: boolean, inactive: boolean, platform: string = process.platform): WindowShowMode {
  if (hidden) return platform === 'win32' || platform === 'darwin' ? 'ghost' : 'never'
  return inactive ? 'inactive' : 'normal'
}

/** Only the exact value '1' turns it on (ORGAI_WINDOW_LARGER_THAN_SCREEN, macOS CI only). */
export function parseLargerThanScreen(value: string | undefined): boolean {
  return value === '1'
}

/** Displays in left-to-right, top-to-bottom order of their bounds (ties by id). */
export function orderDisplays(displays: readonly DisplayInfo[]): DisplayInfo[] {
  return [...displays].sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y || a.id - b.id)
}

export function pickDisplay(choice: DisplayChoice, displays: readonly DisplayInfo[], primaryId: number): DisplayInfo | null {
  if (choice.kind === 'secondary') return displays.find((d) => d.id !== primaryId) ?? null
  return orderDisplays(displays)[choice.index - 1] ?? null
}

/** Centre a width x height window in the display's work area; a window larger than the area is pinned to its top-left. */
export function centerIn(display: DisplayInfo, width: number, height: number): { x: number; y: number } {
  const wa = display.workArea
  const x = Math.round(wa.x + (wa.width - width) / 2)
  const y = Math.round(wa.y + (wa.height - height) / 2)
  return { x: Math.max(wa.x, x), y: Math.max(wa.y, y) }
}

export type Placement = { position: { x: number; y: number } | null; note?: string }

export function windowPlacement(
  value: string | undefined,
  displays: readonly DisplayInfo[],
  primaryId: number,
  width: number,
  height: number
): Placement {
  if (value === undefined) return { position: null }
  const choice = parseWindowDisplay(value)
  if (!choice) return { position: null, note: 'ORGAI_WINDOW_DISPLAY is not "secondary" or a display number; using the default placement.' }
  const display = pickDisplay(choice, displays, primaryId)
  if (!display) return { position: null, note: `ORGAI_WINDOW_DISPLAY=${value}: no such display; using the default placement.` }
  return { position: centerIn(display, width, height) }
}
