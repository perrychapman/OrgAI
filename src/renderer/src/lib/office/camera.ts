/**
 * Pure camera maths for the Pocket Office stage (rework spec section 1). No React, no DOM.
 *
 * The stage is a native scroller. Its content is the building `area` (in tiles) drawn at `zoom`; when the content is
 * smaller than the stage on an axis it is centred (`mapOffset`) and cannot scroll. "World" points are building pixels
 * (16 per tile, zoom independent) exactly as `data-office-x/y` reports them; "screen" points are CSS pixels inside the
 * stage's client box.
 */
export const OFFICE_TILE_PX = 16
export const ZOOMS = [0.5, 1, 2, 3, 4] as const
export type Zoom = (typeof ZOOMS)[number]
/** Arrow keys move this far (Shift moves the larger step). */
export const PAN_STEP = 48
export const PAN_STEP_LARGE = 192
/** Find and Show keep the person and plate this far inside the stage. */
export const REVEAL_MARGIN = 24
/** Below this stage height the default view starts at 1x instead of 2x. */
export const SHORT_STAGE = 320

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Rect { x: number; y: number; width: number; height: number }
/** `area` is in tiles; `client` is the stage's client size and `scroll` its scroll offsets, both in CSS pixels. */
export interface View { area: Rect; zoom: number; client: Size; scroll: Point }

/** The next zoom in the set (0.5, 1, 2, 3, 4), clamped at both ends. A value outside the set steps from the nearest member. */
export function stepZoom(zoom: number, direction: 1 | -1): Zoom {
  let index = 0
  for (let i = 0; i < ZOOMS.length; i++) if (Math.abs(ZOOMS[i] - zoom) < Math.abs(ZOOMS[index] - zoom)) index = i
  return ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, index + direction))]
}

/** `½×`, `1×`, `2×` ... */
export function zoomLabel(zoom: number): string {
  return zoom === 0.5 ? '½×' : `${zoom}×`
}
/** Spoken form of the zoom readout: "Zoom 50%", "Zoom 200%". */
export function zoomName(zoom: number): string {
  return `Zoom ${Math.round(zoom * 100)}%`
}
/** Fallback for `--office-find-duration` when the token cannot be read (tests, no stylesheet). */
export const FIND_RING_MS = 3000

/** The drawn rectangle: building bounds, plus one tile on the west for the cell outside the front door. */
export function cameraArea(bounds: Rect, hasFrontDoor: boolean): Rect {
  return hasFrontDoor ? { x: bounds.x - 1, y: bounds.y, width: bounds.width + 1, height: bounds.height } : { ...bounds }
}

export function contentSize(view: Pick<View, 'area' | 'zoom'>): Size {
  return { width: view.area.width * OFFICE_TILE_PX * view.zoom, height: view.area.height * OFFICE_TILE_PX * view.zoom }
}

/** Where the content starts inside the scroller: centred when smaller than the stage, 0 when it scrolls. Whole pixels. */
export function mapOffset(view: Pick<View, 'area' | 'zoom' | 'client'>): Point {
  const content = contentSize(view)
  return { x: Math.max(0, Math.floor((view.client.width - content.width) / 2)), y: Math.max(0, Math.floor((view.client.height - content.height) / 2)) }
}

/** Largest scroll offsets the content allows. */
export function maxScroll(view: Pick<View, 'area' | 'zoom' | 'client'>): Point {
  const content = contentSize(view)
  return { x: Math.max(0, content.width - view.client.width), y: Math.max(0, content.height - view.client.height) }
}

export function clampScroll(view: Pick<View, 'area' | 'zoom' | 'client'>, scroll: Point): Point {
  const max = maxScroll(view)
  return { x: Math.min(max.x, Math.max(0, scroll.x)), y: Math.min(max.y, Math.max(0, scroll.y)) }
}

/** Content-space pixel (before the centring offset) of a world point. */
export function toContent(view: Pick<View, 'area' | 'zoom'>, world: Point): Point {
  return { x: (world.x - view.area.x * OFFICE_TILE_PX) * view.zoom, y: (world.y - view.area.y * OFFICE_TILE_PX) * view.zoom }
}

export function toScreen(view: View, world: Point): Point {
  const content = toContent(view, world)
  const offset = mapOffset(view)
  return { x: offset.x + content.x - view.scroll.x, y: offset.y + content.y - view.scroll.y }
}

export function toWorld(view: View, screen: Point): Point {
  const offset = mapOffset(view)
  return {
    x: view.area.x * OFFICE_TILE_PX + (screen.x + view.scroll.x - offset.x) / view.zoom,
    y: view.area.y * OFFICE_TILE_PX + (screen.y + view.scroll.y - offset.y) / view.zoom
  }
}

/** The scroll offsets that put `world` under `screen` (clamped to what the content allows). */
export function pinScroll(view: Pick<View, 'area' | 'zoom' | 'client'>, world: Point, screen: Point): Point {
  const offset = mapOffset(view)
  const content = toContent(view, world)
  return clampScroll(view, { x: offset.x + content.x - screen.x, y: offset.y + content.y - screen.y })
}

export const stageCentre = (client: Size): Point => ({ x: client.width / 2, y: client.height / 2 })

/** True when `area` at `zoom` fits inside `stage` without scrolling. */
export function fitsAt(area: Size, stage: Size, zoom: number): boolean {
  return area.width * OFFICE_TILE_PX * zoom <= stage.width && area.height * OFFICE_TILE_PX * zoom <= stage.height
}

/** Largest zoom in the set at which the whole area fits the stage, never below 0.5. */
export function fitZoom(area: Size, stage: Size): Zoom {
  for (let i = ZOOMS.length - 1; i >= 0; i--) if (fitsAt(area, stage, ZOOMS[i])) return ZOOMS[i]
  return ZOOMS[0]
}

export const rectCentre = (rect: Rect): Point => ({ x: (rect.x + rect.width / 2) * OFFICE_TILE_PX, y: (rect.y + rect.height / 2) * OFFICE_TILE_PX })

/** Fit: the biggest zoom that shows the whole building, centred. */
export function fitView(area: Rect, stage: Size): { zoom: Zoom; focus: Point } {
  return { zoom: fitZoom(area, stage), focus: rectCentre(area) }
}

/**
 * Default view (first measure, run switch, Home): 2x centred when the building fits at 2x; otherwise 2x (1x on a stage
 * under 320 px tall) centred on the lobby.
 */
export function defaultView(area: Rect, lobby: Rect | null, stage: Size): { zoom: Zoom; focus: Point } {
  if (fitsAt(area, stage, 2)) return { zoom: 2, focus: rectCentre(area) }
  return { zoom: stage.height < SHORT_STAGE ? 1 : 2, focus: rectCentre(lobby ?? area) }
}

/**
 * Smallest scroll change that brings `target` (content-space pixels, before the centring offset) inside the stage with
 * `margin` to spare. A target bigger than the stage aligns to its top-left. Unchanged when it is already inside.
 */
export function revealScroll(view: View, target: Rect, margin = REVEAL_MARGIN): Point {
  const offset = mapOffset(view)
  const axis = (start: number, size: number, scroll: number, extent: number, shift: number): number => {
    const lo = shift + start - margin
    const hi = shift + start + size + margin
    if (size + 2 * margin >= extent) return lo
    if (lo < scroll) return lo
    if (hi > scroll + extent) return hi - extent
    return scroll
  }
  return clampScroll(view, {
    x: axis(target.x, target.width, view.scroll.x, view.client.width, offset.x),
    y: axis(target.y, target.height, view.scroll.y, view.client.height, offset.y)
  })
}

/** Arrow-key pan: `key` is an ArrowX name. */
export function panBy(key: string, large: boolean): Point | null {
  const step = large ? PAN_STEP_LARGE : PAN_STEP
  switch (key) {
    case 'ArrowLeft': return { x: -step, y: 0 }
    case 'ArrowRight': return { x: step, y: 0 }
    case 'ArrowUp': return { x: 0, y: -step }
    case 'ArrowDown': return { x: 0, y: step }
    default: return null
  }
}
