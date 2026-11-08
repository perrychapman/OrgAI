import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrivalTracker } from './useArrival'
import { tokenMs } from './useExitPresence'
import { useUpdateNodeInternals, type NodeChange, type Position } from '@xyflow/react'
import type { AppearanceSettings, CanvasEdgeStyle, CanvasLayout, CanvasNodeStyle, CanvasPattern, CanvasPresentation, CanvasScenePalette } from '@shared/types'
import { CANVAS_EDGE_STYLES, CANVAS_LAYOUTS, CANVAS_NODE_STYLES, CANVAS_PATTERNS, CANVAS_PRESENTATIONS, CANVAS_SCENE_PALETTES } from '@shared/types'
import { CANVAS_PRESETS, DEFAULT_APPEARANCE, activeCanvasPreset, applyCanvasPreset, type CanvasPreset, type CanvasPresetId } from '@shared/defaults'

/**
 * Canvas appearance for the renderer's React Flow canvases (Live run, Team editor, the settings sample).
 * lib/theme.ts writes the settings to <html> as data-canvas-* attributes; canvases read them only through
 * `useCanvasOptions()` here, never from the settings store. Spec: docs/design/canvas-themes.md.
 */

/**
 * Node styles built in this release (phase B added 'station' and 'hex'). Every selector filters through this list and
 * a stored unavailable style renders as 'card'.
 */
export const AVAILABLE_NODE_STYLES: readonly CanvasNodeStyle[] = ['card', 'compact', 'station', 'hex']

export function isAvailableNodeStyle(style: CanvasNodeStyle): boolean {
  return AVAILABLE_NODE_STYLES.includes(style)
}

/** The node style a canvas draws: the stored one when it is built, else 'card' (silently). */
export function effectiveNodeStyle(style: string | null | undefined): CanvasNodeStyle {
  return CANVAS_NODE_STYLES.includes(style as CanvasNodeStyle) && isAvailableNodeStyle(style as CanvasNodeStyle) ? (style as CanvasNodeStyle) : 'card'
}

/** Presets whose node style is built (phase A hides Subway and Hive). */
export const AVAILABLE_PRESETS: readonly CanvasPreset[] = CANVAS_PRESETS.filter((p) => isAvailableNodeStyle(p.canvas.nodeStyle))

/** The preset to show as selected, or undefined ("Custom") when none matches or the match is not available. */
export function shownPreset(canvas: AppearanceSettings['canvas']): CanvasPresetId | undefined {
  const id = activeCanvasPreset(canvas)
  return id && AVAILABLE_PRESETS.some((p) => p.id === id) ? id : undefined
}

/** The gallery's first entry: the way OrgAI starts (DEFAULT_APPEARANCE.canvas). Not a preset in the shared contract. */
export const DEFAULT_STYLE_ID = 'default'
export type CanvasStyleId = CanvasPresetId | typeof DEFAULT_STYLE_ID

export interface CanvasStyleOption {
  id: CanvasStyleId
  label: string
  description: string
  canvas: CanvasPreset['canvas']
}

const DEFAULT_LOOK = DEFAULT_APPEARANCE.canvas

export const DEFAULT_STYLE: CanvasStyleOption = {
  id: DEFAULT_STYLE_ID,
  label: 'Default',
  description: 'Dots, curved lines, cards, top down. The way OrgAI starts.',
  canvas: { pattern: DEFAULT_LOOK.pattern, edges: DEFAULT_LOOK.edges, layout: DEFAULT_LOOK.layout, nodeStyle: DEFAULT_LOOK.nodeStyle, tint: DEFAULT_LOOK.tint }
}

/** Every gallery entry in order: Default, then the available presets. */
export const CANVAS_STYLE_OPTIONS: readonly CanvasStyleOption[] = [DEFAULT_STYLE, ...AVAILABLE_PRESETS]

function sameLook(a: CanvasPreset['canvas'], b: AppearanceSettings['canvas']): boolean {
  return a.pattern === b.pattern && a.edges === b.edges && a.layout === b.layout && a.nodeStyle === b.nodeStyle && a.tint === b.tint
}

/** The entry to show as selected: 'default', a preset id, or undefined ("Custom"). The minimap never counts. */
export function shownStyle(canvas: AppearanceSettings['canvas']): CanvasStyleId | undefined {
  if (sameLook(DEFAULT_STYLE.canvas, canvas)) return DEFAULT_STYLE_ID
  return shownPreset(canvas)
}

/** A new canvas with the default look's five fields; the minimap is kept. */
export function applyDefaultCanvas(canvas: AppearanceSettings['canvas']): AppearanceSettings['canvas'] {
  return { ...canvas, ...DEFAULT_STYLE.canvas }
}

/** A new canvas after picking a gallery entry (Default or a preset); the minimap is kept. */
export function applyCanvasStyle(canvas: AppearanceSettings['canvas'], id: CanvasStyleId): AppearanceSettings['canvas'] {
  return { ...(id === DEFAULT_STYLE_ID ? applyDefaultCanvas(canvas) : applyCanvasPreset(canvas, id)), presentation: 'graph' }
}

/** The label of a shown entry, or undefined for Custom. */
export function styleLabel(id: CanvasStyleId | undefined): string | undefined {
  return CANVAS_STYLE_OPTIONS.find((o) => o.id === id)?.label
}

export interface CanvasOptions {
  presentation: CanvasPresentation
  scenePalette: CanvasScenePalette
  pattern: CanvasPattern
  edges: CanvasEdgeStyle
  layout: CanvasLayout
  /** Always an available style (see effectiveNodeStyle). */
  nodeStyle: CanvasNodeStyle
  tint: boolean
  minimap: boolean
}

/** The <html> attributes lib/theme.ts writes, in the order canvases read them. */
export const CANVAS_ATTRS = [
  'data-canvas-presentation',
  'data-canvas-scene-palette',
  'data-canvas-pattern',
  'data-canvas-edges',
  'data-canvas-layout',
  'data-canvas-node-style',
  'data-canvas-tint',
  'data-canvas-minimap'
] as const

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value !== null && allowed.includes(value as T) ? (value as T) : fallback
}

/** Pure: canvas options from an attribute reader. Unknown or missing values fall back to DEFAULT_APPEARANCE. */
export function readCanvasOptions(get: (name: (typeof CANVAS_ATTRS)[number]) => string | null): CanvasOptions {
  const d = DEFAULT_APPEARANCE.canvas
  const tint = get('data-canvas-tint')
  const minimap = get('data-canvas-minimap')
  return {
    presentation: pick(get('data-canvas-presentation'), CANVAS_PRESENTATIONS, d.presentation),
    scenePalette: pick(get('data-canvas-scene-palette'), CANVAS_SCENE_PALETTES, d.scenePalette),
    pattern: pick(get('data-canvas-pattern'), CANVAS_PATTERNS, d.pattern),
    edges: pick(get('data-canvas-edges'), CANVAS_EDGE_STYLES, d.edges),
    layout: pick(get('data-canvas-layout'), CANVAS_LAYOUTS, d.layout),
    nodeStyle: effectiveNodeStyle(get('data-canvas-node-style') ?? d.nodeStyle),
    tint: tint === null ? d.tint : tint === 'on',
    minimap: minimap === null ? d.minimap : minimap === 'on'
  }
}

function sameOptions(a: CanvasOptions, b: CanvasOptions): boolean {
  return a.presentation === b.presentation && a.scenePalette === b.scenePalette && a.pattern === b.pattern && a.edges === b.edges && a.layout === b.layout && a.nodeStyle === b.nodeStyle && a.tint === b.tint && a.minimap === b.minimap
}

/** Reads a data-* attribute on <html> and follows changes (the appearance settings write them). */
export function useHtmlAttr(name: string, fallback: string): string {
  const read = (): string => document.documentElement.getAttribute(name) ?? fallback
  const [value, setValue] = useState(read)
  useEffect(() => {
    const update = (): void => setValue(read())
    update()
    const mo = new MutationObserver(update)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: [name] })
    return () => mo.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])
  return value
}

/** The canvas settings every canvas follows (Live run, Team editor, settings sample). One observer for all six attributes. */
export function useCanvasOptions(): CanvasOptions {
  const read = (): CanvasOptions => readCanvasOptions((n) => document.documentElement.getAttribute(n))
  const [value, setValue] = useState(read)
  useEffect(() => {
    const update = (): void => setValue((prev) => {
      const next = read()
      return sameOptions(prev, next) ? prev : next
    })
    update()
    const mo = new MutationObserver(update)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: [...CANVAS_ATTRS] })
    return () => mo.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return value
}

/** React Flow edge type per Connection lines setting. */
export const EDGE_TYPE: Record<CanvasEdgeStyle, 'default' | 'smoothstep' | 'straight'> = { curved: 'default', orthogonal: 'smoothstep', straight: 'straight' }

type Side = `${Position}`

/**
 * Where a node's handles sit per layout: reporting lines enter at `target` and leave at `source`; agent-to-agent
 * messages use the other two sides so they never share a reporting line's handle. Radial uses the top-down sides as
 * handle anchors; its edges are drawn centre to centre (see docs/design/canvas-themes.md).
 */
export interface LayoutHandles {
  target: Side
  source: Side
  msgIn: Side
  msgOut: Side
}

export function handlesFor(layout: CanvasLayout): LayoutHandles {
  if (layout === 'left-right') return { target: 'left', source: 'right', msgIn: 'top', msgOut: 'bottom' }
  return { target: 'top', source: 'bottom', msgIn: 'left', msgOut: 'right' }
}

/**
 * React Flow measures a node's handles only when the node resizes. A layout change moves the handles to other sides
 * without a resize (a card stays 240 x 112), so edges would keep leaving from the old side: re-measure the node after
 * the layout or node style changes. Call it in every node component with the node's id.
 */
export function useHandleRefresh(id: string, layout: CanvasLayout, nodeStyle: CanvasNodeStyle): void {
  const update = useUpdateNodeInternals()
  useEffect(() => {
    update(id)
  }, [id, layout, nodeStyle, update])
}

/**
 * Station geometry (docs/design/canvas-themes.md section 4b). The node box holds the station circle and its name.
 * Top down: the name sits beside the circle (reporting lines run vertically through the circle, never through the
 * name). Left to right and radial: the name sits below the circle (lines run horizontally or centre to centre).
 * `cx` / `cy` is the circle's centre inside the box, `r` its radius (border included).
 */
export interface StationGeometry {
  width: number
  height: number
  cx: number
  cy: number
  r: number
  label: 'beside' | 'below'
}

export const STATION_RADIUS = 16

export function stationGeometry(layout: CanvasLayout): StationGeometry {
  if (layout === 'top-down') return { width: 160, height: 40, cx: 20, cy: 20, r: STATION_RADIUS, label: 'beside' }
  return { width: 120, height: 64, cx: 60, cy: 18, r: STATION_RADIUS, label: 'below' }
}

/** Hex tile box (flat-top hexagon, about 120 across): the same for agents, groups and roles in every layout. */
export const HEX_TILE = { width: 120, height: 104 } as const
/** Gap between neighbouring honeycomb cells in the radial layout. */
export const HEX_GAP = 12

/**
 * Where each handle sits inside a station box: on the circle's edge, so a reporting line meets the station and not
 * the box around its name. Pass the result as the Handle's `style` (left / top of the handle's centre; React Flow's
 * handle classes translate by -50% / -50% on top and left, the overrides in flow.css make bottom and right do so too).
 */
export function stationHandleStyle(geo: StationGeometry, side: `${Position}`): { left: number; top: number } {
  switch (side) {
    case 'top':
      return { left: geo.cx, top: geo.cy - geo.r }
    case 'bottom':
      return { left: geo.cx, top: geo.cy + geo.r }
    case 'left':
      return { left: geo.cx - geo.r, top: geo.cy }
    default:
      return { left: geo.cx + geo.r, top: geo.cy }
  }
}

/** Live agent node box per node style (layout input and fit). Station is the left-to-right / radial box. */
export const AGENT_NODE_SIZE: Record<CanvasNodeStyle, { width: number; height: number }> = {
  card: { width: 240, height: 112 },
  compact: { width: 160, height: 40 },
  station: { width: 120, height: 64 },
  hex: { width: HEX_TILE.width, height: HEX_TILE.height }
}

/** Done-group node box per node style. */
export const GROUP_NODE_SIZE: Record<CanvasNodeStyle, { width: number; height: number }> = {
  card: { width: 240, height: 56 },
  compact: { width: 160, height: 40 },
  station: { width: 120, height: 64 },
  hex: { width: HEX_TILE.width, height: HEX_TILE.height }
}

/** Agent node box for a style; stations depend on the layout (see stationGeometry). */
export function agentNodeSize(style: CanvasNodeStyle, layout: CanvasLayout = 'left-right'): { width: number; height: number } {
  if (style === 'station') {
    const g = stationGeometry(layout)
    return { width: g.width, height: g.height }
  }
  return AGENT_NODE_SIZE[effectiveNodeStyle(style)]
}

/**
 * Reporting line colour before the ink mix: stations draw one coloured line per lead, so a report's line takes its
 * lead's (parent's) role colour; every other style colours the line by the report's own role.
 */
export function reportingLineRole(style: CanvasNodeStyle, parentColor: string, childColor: string): string {
  return style === 'station' ? parentColor : childColor
}

type Rgb = [number, number, number]

/** '#rgb', '#rrggbb' or 'rgb(r, g, b)' to channels; null for anything else (var(), named colours, hsl...). */
function parseColor(value: string): Rgb | null {
  const v = value.trim()
  const hex3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v)
  if (hex3) return [parseInt(hex3[1] + hex3[1], 16), parseInt(hex3[2] + hex3[2], 16), parseInt(hex3[3] + hex3[3], 16)]
  const hex6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v)
  if (hex6) return [parseInt(hex6[1], 16), parseInt(hex6[2], 16), parseInt(hex6[3], 16)]
  const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i.exec(v)
  if (rgb) return [Math.min(255, +rgb[1]), Math.min(255, +rgb[2]), Math.min(255, +rgb[3])]
  return null
}

function toHex(c: Rgb): string {
  return `#${c.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')}`
}

/**
 * Edge colour (docs/design/canvas-themes.md section 5): the role colour mixed toward `ink` in sRGB, keeping `mix`
 * percent of the role colour, as '#rrggbb'. `mix` is a number 0-100 or a string like '50%'. A role or ink that is not
 * a hex (or rgb()) colour, or a mix that is not a number, returns `role` unchanged.
 */
export function edgeStroke(role: string, mix: number | string, ink: string): string {
  const a = parseColor(role)
  const b = parseColor(ink)
  const pct = typeof mix === 'number' ? mix : Number.parseFloat(mix)
  if (!a || !b || !Number.isFinite(pct)) return role
  const t = Math.max(0, Math.min(100, pct)) / 100
  return toHex([a[0] * t + b[0] * (1 - t), a[1] * t + b[1] * (1 - t), a[2] * t + b[2] * (1 - t)])
}

/** True when the OS or the app asks for reduced motion (animated edges stay still, refits are instant). */
export function useReducedMotion(): boolean {
  const attr = useHtmlAttr('data-reduce-motion', '')
  const [os, setOs] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const on = (): void => setOs(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return os || (attr !== '' && attr !== 'false' && attr !== 'off')
}

export type NodeDims = Record<string, { width: number; height: number }>

/**
 * Measured node sizes for a canvas whose nodes are rebuilt from state (controlled nodes). React Flow reports sizes as
 * `dimensions` changes; a rebuilt node without `measured` is invisible to the minimap (ux-review-canvas-themes H1).
 * Feed `apply` the changes from `onNodesChange` and spread `dims[id]` into each node's `measured`.
 */
export function useNodeDims(): { dims: NodeDims; apply: (changes: NodeChange[]) => void } {
  const [dims, setDims] = useState<NodeDims>({})
  const apply = useCallback((changes: NodeChange[]) => {
    const sized = changes.filter((c): c is Extract<NodeChange, { type: 'dimensions' }> => c.type === 'dimensions' && !!c.dimensions)
    if (sized.length === 0) return
    setDims((prev) => {
      let next: NodeDims | null = null
      for (const c of sized) {
        const d = c.dimensions!
        const old = prev[c.id]
        if (old && old.width === d.width && old.height === d.height) continue
        next ??= { ...prev }
        next[c.id] = { width: d.width, height: d.height }
      }
      return next ?? prev
    })
  }, [])
  return { dims, apply }
}

/**
 * Ring step of the radial layout per node style (section 3): 300 for cards, 200 for compact, 180 for stations, and one
 * honeycomb cell (tile height plus gap) for hex, so ring-1 tiles land on the cells next to the root.
 */
export function ringStepFor(style: CanvasNodeStyle): number {
  if (style === 'compact') return 200
  if (style === 'station') return 180
  if (style === 'hex') return HEX_TILE.height + HEX_GAP
  return 300
}

/**
 * Minimap size for a stage (section 6): width clamp(120, round(0.18 * w), 200), height min(round(0.3 * h),
 * round(0.75 * width)); null below 240 px high or 480 px wide.
 */
export function minimapSize(stageWidth: number, stageHeight: number): { width: number; height: number } | null {
  if (stageHeight < 240 || stageWidth < 480) return null
  const width = Math.min(200, Math.max(120, Math.round(0.18 * stageWidth)))
  return { width, height: Math.min(Math.round(0.3 * stageHeight), Math.round(0.75 * width)) }
}

export function groupNodeSize(style: CanvasNodeStyle, layout: CanvasLayout = 'left-right'): { width: number; height: number } {
  if (style === 'station') return agentNodeSize(style, layout)
  return GROUP_NODE_SIZE[effectiveNodeStyle(style)]
}

/* ---------- Motion: arrival, glide, fit duration (docs/design/motion.md 3.12, 3.13) ---------- */

/** Above this many nodes a layout change snaps instead of gliding (per-frame edge work). */
export const GLIDE_MAX_NODES = 60
/** The glide attribute is removed this long after the transition should have ended. */
export const GLIDE_END_MARGIN_MS = 50
/** At most this many working nodes breathe at once (motion.md 3.18). */
export const BREATHE_MAX_NODES = 12
// Not data-layout-moving: that one sits on <html> (lib/layoutMotion.ts) for column and tray glides.
const GLIDE_ATTR = 'data-canvas-gliding'
const glideTimers = new WeakMap<Element, number>()

/** The glide length in ms, or 0 when the canvas has too many nodes or motion is reduced. */
export function glideMs(nodeCount: number): number {
  if (nodeCount > GLIDE_MAX_NODES) return 0
  const ms = tokenMs('--dur-slow')
  return ms > 1 ? ms : 0
}

/** The fit animation length: 0 reduced, else the slow token. */
/** True when the OS or App settings > Reduce motion asks for reduced motion, read now (for callbacks outside render). */
export function reducedMotionNow(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.getAttribute('data-reduce-motion') === 'on') return true
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Duration of a quiet refit after a resize (ms): 0 under either reduced-motion switch, else --dur-fast + --dur-instant. */
export function refitMs(): number {
  if (reducedMotionNow()) return 0
  return tokenMs('--dur-fast') + tokenMs('--dur-instant')
}

export function fitMs(reduced: boolean): number {
  if (reduced) return 0
  const ms = tokenMs('--dur-slow')
  return ms > 1 ? ms : 0
}

/**
 * Marks the canvas as gliding: its `.react-flow` gets `data-canvas-gliding` (flow.css turns the node transition on and
 * hides edges meanwhile) and loses it after the glide. Call it before the commit that moves the nodes. Returns the ms
 * until the glide has settled (0 when nothing glides, so the caller may refit at once).
 */
export function beginCanvasGlide(root: Element | null | undefined, nodeCount: number): number {
  const ms = glideMs(nodeCount)
  const flow = root ? (root.matches('.react-flow') ? root : root.querySelector('.react-flow')) : null
  if (!flow || ms === 0) return 0
  const total = ms + GLIDE_END_MARGIN_MS
  flow.setAttribute(GLIDE_ATTR, '')
  const prev = glideTimers.get(flow)
  if (prev !== undefined) window.clearTimeout(prev)
  glideTimers.set(
    flow,
    window.setTimeout(() => {
      flow.removeAttribute(GLIDE_ATTR)
      glideTimers.delete(flow)
    }, total)
  )
  return total
}

/** The first `BREATHE_MAX_NODES` working ids in node order: the only nodes that breathe. Pure. */
export function breatheIndex(nodes: readonly { id: string; working: boolean }[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const n of nodes) {
    if (!n.working) continue
    if (out.size >= BREATHE_MAX_NODES) break
    out.set(n.id, out.size)
  }
  return out
}

/**
 * Arrival tracking for canvas nodes: ids new since the canvas was shown (or since `scope` changed) pop in once. At most
 * 12 ids arriving together animate. `arrivedKey` changes when the set of new ids does, for memo deps.
 */
export function useNodeArrival(ids: readonly string[], scope: string): { isNew: (id: string) => boolean; arrivedKey: string; markArrived: (ids: readonly string[]) => void } {
  const ref = useRef<{ tracker: ArrivalTracker; started: boolean } | null>(null)
  if (!ref.current) ref.current = { tracker: new ArrivalTracker({ maxPerBatch: 12 }), started: false }
  const state = ref.current
  const now = Date.now()
  // An empty first list (the run is still loading) must not make everything that follows look new.
  if (ids.length > 0 || state.started) {
    state.started = true
    state.tracker.update(ids, scope, now)
  }
  const isNew = (id: string): boolean => state.tracker.isNew(id, now)
  const arrivedKey = ids.filter(isNew).join('|')
  const markArrived = useCallback((list: readonly string[]): void => state.tracker.markArrived(list, Date.now()), [state])
  return { isNew, arrivedKey, markArrived }
}
