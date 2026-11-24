/**
 * Which controls the run canvas toolbar shows for a run state, and in what form (docs/design/canvas-toolbar-declutter.md).
 * Pure: no store, no React, no DOM. `planToolbar` is the one place that decides; the toolbar renders the plan.
 *
 * Rules, in order: a control that does not apply is not drawn; a rare option lives in the one View menu; what stays
 * visible is the scene switch, find / filter (only with more than a handful of agents), zoom and fit, the conversation
 * buttons. When the frame is narrow the richest form that still fits is chosen from a fixed ladder, so a control
 * first loses its word, then moves into the View menu; it never disappears from every place.
 */

/** Up to this many agents (the whole run, earlier sessions included) the filter and Find are not drawn: five names fit in the chart. */
export const AGENT_HANDFUL = 5

/** Room taken by the run header's status, cost, permission and "more" chips at the start of the row. run-header.css keeps 256 from 800 px. */
export const META_FLOOR = 256
/** The meta row shrinks (and folds into "more") below 800 px; status and "more" still need about this much. */
export const META_FLOOR_NARROW = 150
/** The All / Working / Waiting group and Zoom out / Zoom in are drawn in the row only in a frame this wide (the 1100 px the earlier container query used); below it they sit in the View menu. */
export const FILTER_MIN_FRAME = 1100
const ROW_PADDING = 24
const GAP = 6

/** Estimated widths in px of each form of a control (measured in the built app, 28 px icon buttons). */
export const WIDTHS = {
  sceneFull: 152,
  sceneCompact: 68,
  find: 28,
  filter: 205,
  zoomSteps: 86,
  fit: 28,
  viewLabel: 72,
  viewIcon: 28,
  dockLabel: 111,
  dockIcon: 36,
  layoutToggle: 28,
  loadEarlier: 150
} as const

export type SceneForm = 'full' | 'compact' | 'none'
export type Place = 'inline' | 'view' | 'none'

export interface ToolbarInput {
  /** The stage shows a scene (Pocket Office or Factory floor), not the org chart. */
  scene: boolean
  /** The stage is the conversation (the layout toggle reads "Show agents"). */
  conversation: boolean
  /** One agent has the stage (AgentFocus). */
  agentView: boolean
  /** Agents in the run, earlier sessions included. */
  agentCount: number
  /** The conversation dock is hidden or the narrow-window rail: the feed is not on screen. */
  dockClosed: boolean
  /** Earlier sessions still to load (scenes only). */
  earlierToLoad: number
  /** Hide finished agents applies: more than one agent or an earlier session. */
  canFold: boolean
  /** The run frame's width in px; null before it is measured (the richest form). */
  frameWidth: number | null
}

export interface ToolbarPlan {
  scene: SceneForm
  find: Place
  filter: Place
  /** 'steps' draws Zoom out, Zoom in and Fit; 'fit' draws Fit only and the two steps sit in the View menu. */
  zoom: 'steps' | 'fit' | 'none'
  view: 'label' | 'icon' | 'none'
  /** In the View menu: the Hide finished agents switch, the legend. */
  hideFinished: boolean
  legend: boolean
  /** The layout toggle ("Show conversation" / "Show agents"); in the View menu while the dock is closed (the Conversation button is the way to it). */
  layoutToggle: Place
  dockShow: 'label' | 'icon' | 'none'
  loadEarlier: boolean
  /** The step of the narrow ladder this plan is at (0 = everything in its richest form). */
  level: number
}

const LAST_LEVEL = 7

function build(i: ToolbarInput, level: number, roomyFrame: boolean): ToolbarPlan {
  const chart = !i.scene && !i.conversation && !i.agentView
  const many = chart && i.agentCount > AGENT_HANDFUL
  const canvasChrome = !i.conversation && !i.agentView
  return {
    scene: canvasChrome ? (level >= LAST_LEVEL ? 'none' : level >= 4 ? 'compact' : 'full') : 'none',
    find: many ? (level >= 6 ? 'view' : 'inline') : 'none',
    filter: many ? (level >= 1 || !roomyFrame ? 'view' : 'inline') : 'none',
    // Zoom out / in are in the row only where there is room to spare; the wheel, a pinch and the View menu zoom everywhere.
    zoom: chart ? (level >= 5 || !roomyFrame ? 'fit' : 'steps') : 'none',
    view: canvasChrome ? (level >= 3 ? 'icon' : 'label') : 'none',
    hideFinished: chart && i.canFold,
    legend: chart,
    layoutToggle: i.dockClosed && canvasChrome ? 'view' : 'inline',
    dockShow: i.dockClosed ? (level >= 2 ? 'icon' : 'label') : 'none',
    loadEarlier: canvasChrome && i.scene && i.earlierToLoad > 0,
    level
  }
}

/** The room the plan's inline controls take, estimated. */
export function planWidth(p: ToolbarPlan): number {
  const parts: number[] = []
  if (p.scene === 'full') parts.push(WIDTHS.sceneFull)
  if (p.scene === 'compact') parts.push(WIDTHS.sceneCompact)
  if (p.find === 'inline') parts.push(WIDTHS.find)
  if (p.filter === 'inline') parts.push(WIDTHS.filter)
  if (p.zoom === 'steps') parts.push(WIDTHS.zoomSteps)
  if (p.zoom === 'fit') parts.push(WIDTHS.fit)
  if (p.view === 'label') parts.push(WIDTHS.viewLabel)
  if (p.view === 'icon') parts.push(WIDTHS.viewIcon)
  if (p.loadEarlier) parts.push(WIDTHS.loadEarlier)
  if (p.dockShow === 'label') parts.push(WIDTHS.dockLabel)
  if (p.dockShow === 'icon') parts.push(WIDTHS.dockIcon)
  if (p.layoutToggle === 'inline') parts.push(WIDTHS.layoutToggle)
  return parts.reduce((n, w) => n + w + GAP, 0)
}

/** The plan for a run state: the richest form whose controls leave the meta row its floor. */
export function planToolbar(input: ToolbarInput): ToolbarPlan {
  if (input.frameWidth === null) return build(input, 0, true)
  const roomy = input.frameWidth >= FILTER_MIN_FRAME
  const floor = input.frameWidth >= 800 ? META_FLOOR : META_FLOOR_NARROW
  const room = input.frameWidth - ROW_PADDING - floor
  for (let level = 0; level < LAST_LEVEL; level++) {
    const plan = build(input, level, roomy)
    if (planWidth(plan) <= room) return plan
  }
  return build(input, LAST_LEVEL, roomy)
}

/** The ids of every control drawn in the row itself at rest (not the ones inside the View menu), in reading order. */
export function restControls(p: ToolbarPlan): string[] {
  const ids: string[] = []
  if (p.scene !== 'none') ids.push('scene')
  if (p.find === 'inline') ids.push('find')
  if (p.filter === 'inline') ids.push('filter')
  if (p.zoom === 'steps') ids.push('zoom-out', 'zoom-in', 'fit')
  if (p.zoom === 'fit') ids.push('fit')
  if (p.loadEarlier) ids.push('load-earlier')
  if (p.view !== 'none') ids.push('view')
  if (p.dockShow !== 'none') ids.push('dock-show')
  if (p.layoutToggle === 'inline') ids.push('layout-toggle')
  return ids
}

/** The ids of the controls that live in the View menu for this plan. */
export function viewMenuControls(p: ToolbarPlan): string[] {
  const ids: string[] = []
  if (p.find === 'view') ids.push('find')
  if (p.filter === 'view') ids.push('filter')
  if (p.zoom === 'fit') ids.push('zoom-out', 'zoom-in')
  if (p.layoutToggle === 'view') ids.push('layout-toggle')
  if (p.hideFinished) ids.push('hide-finished')
  ids.push('canvas-style')
  if (p.legend) ids.push('legend')
  return ids
}
