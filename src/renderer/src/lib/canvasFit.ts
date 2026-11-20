import type { CanvasNodeStyle } from '@shared/types'

/** The smallest a node name may be drawn when fitting, in CSS px (names are 13 px at zoom 1). */
export const MIN_NAME_PX = 9
const NAME_PX = 13
/** A stage shorter than this keeps nodes readable instead of shrinking the whole chart into it. */
export const SHORT_STAGE_PX = 300
export const SHORT_STAGE_MIN_ZOOM = 0.8

/**
 * React Flow 12 read a fit padding of `p` as "bounds times (1 + p)", so each side kept p / (1 + p) / 2 of the stage.
 * React Flow 13 reads a bare number as pixels (0.3 would be 0.3 px) and wants a percentage of the stage per side. This
 * turns a v12 value into the same fit as a v13 percentage string, so the canvases frame exactly as before. Pure.
 */
export function legacyFitPadding(p: number): `${number}%` {
  const side = Math.round((p / (1 + p) / 2) * 10000) / 100
  return `${side}%`
}

export interface FitInput {
  /** Height of the canvas stage in px. */
  stageHeight: number
  radial: boolean
  /** The node style on screen; unknown counts as a card. */
  nodeStyle?: CanvasNodeStyle | undefined
  duration: number
}

export interface FitOptions {
  padding: `${number}%`
  maxZoom: number
  duration: number
  minZoom?: number
}

/**
 * Fit-to-view options. A stage under 300 px tall keeps zoom at 0.8 or more and the chart pans; the radial layout fits
 * with less padding (spec section 3) and, with cards (whose rings are wide), never below the zoom that keeps names
 * about 9 px, so a crowded ring pans instead of turning to specks (1024x640 with the side panel open fit at 0.43).
 * Name tags, stations and hexes are small enough to fit as they are. Top-down and left-right are unchanged. Pure.
 */
export function fitOptions(i: FitInput): FitOptions {
  const floors: number[] = []
  if (i.stageHeight < SHORT_STAGE_PX) floors.push(SHORT_STAGE_MIN_ZOOM)
  if (i.radial && (i.nodeStyle === undefined || i.nodeStyle === 'card')) floors.push(Math.ceil((MIN_NAME_PX / NAME_PX) * 100) / 100)
  return { padding: legacyFitPadding(i.radial ? 0.12 : 0.25), maxZoom: 1, duration: i.duration, ...(floors.length ? { minZoom: Math.max(...floors) } : {}) }
}
