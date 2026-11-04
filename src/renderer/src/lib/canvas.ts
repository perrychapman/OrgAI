import { useEffect, useState } from 'react'
import type { Position } from '@xyflow/react'
import type { AppearanceSettings, CanvasEdgeStyle, CanvasLayout, CanvasNodeStyle, CanvasPattern } from '@shared/types'
import { CANVAS_EDGE_STYLES, CANVAS_LAYOUTS, CANVAS_NODE_STYLES, CANVAS_PATTERNS } from '@shared/types'
import { CANVAS_PRESETS, DEFAULT_APPEARANCE, activeCanvasPreset, type CanvasPreset, type CanvasPresetId } from '@shared/defaults'

/**
 * Canvas appearance for the renderer's React Flow canvases (Live run, Team editor, the settings sample).
 * lib/theme.ts writes the settings to <html> as data-canvas-* attributes; canvases read them only through
 * `useCanvasOptions()` here, never from the settings store. Spec: docs/design/canvas-themes.md.
 */

/**
 * Node styles built in this release. Phase A: 'station' and 'hex' exist in the contract but are not built; every
 * selector filters through this list and a stored unavailable style renders as 'card'. Phase B adds them here.
 */
export const AVAILABLE_NODE_STYLES: readonly CanvasNodeStyle[] = ['card', 'compact']

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

export interface CanvasOptions {
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
    pattern: pick(get('data-canvas-pattern'), CANVAS_PATTERNS, d.pattern),
    edges: pick(get('data-canvas-edges'), CANVAS_EDGE_STYLES, d.edges),
    layout: pick(get('data-canvas-layout'), CANVAS_LAYOUTS, d.layout),
    nodeStyle: effectiveNodeStyle(get('data-canvas-node-style') ?? d.nodeStyle),
    tint: tint === null ? d.tint : tint === 'on',
    minimap: minimap === null ? d.minimap : minimap === 'on'
  }
}

function sameOptions(a: CanvasOptions, b: CanvasOptions): boolean {
  return a.pattern === b.pattern && a.edges === b.edges && a.layout === b.layout && a.nodeStyle === b.nodeStyle && a.tint === b.tint && a.minimap === b.minimap
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

/** Live agent node box per node style (layout input and fit). Phase B adds station and hex. */
export const AGENT_NODE_SIZE: Record<'card' | 'compact', { width: number; height: number }> = {
  card: { width: 240, height: 112 },
  compact: { width: 160, height: 40 }
}

/** Done-group node box per node style. */
export const GROUP_NODE_SIZE: Record<'card' | 'compact', { width: number; height: number }> = {
  card: { width: 240, height: 56 },
  compact: { width: 160, height: 40 }
}

export function agentNodeSize(style: CanvasNodeStyle): { width: number; height: number } {
  return style === 'compact' ? AGENT_NODE_SIZE.compact : AGENT_NODE_SIZE.card
}

/**
 * Edge colour (docs/design/canvas-themes.md section 5): the role colour mixed toward `ink` in sRGB, keeping `mix`
 * percent of the role colour, as '#rrggbb'. Inputs are hex; `mix` is a number 0-100 or a string like '50%'.
 * SEAM: placeholder until the canvas-engine brief implements it (returns the role colour).
 */
export function edgeStroke(role: string, _mix: number | string, _ink: string): string {
  return role
}

/**
 * Minimap size for a stage (section 6): width clamp(120, round(0.18 * w), 200), height min(round(0.3 * h),
 * round(0.75 * width)); null below 240 px high or 480 px wide. SEAM: the canvas-engine brief owns it and its tests.
 */
export function minimapSize(stageWidth: number, stageHeight: number): { width: number; height: number } | null {
  if (stageHeight < 240 || stageWidth < 480) return null
  const width = Math.min(200, Math.max(120, Math.round(0.18 * stageWidth)))
  return { width, height: Math.min(Math.round(0.3 * stageHeight), Math.round(0.75 * width)) }
}

export function groupNodeSize(style: CanvasNodeStyle): { width: number; height: number } {
  return style === 'compact' ? GROUP_NODE_SIZE.compact : GROUP_NODE_SIZE.card
}
