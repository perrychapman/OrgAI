import type { ReactElement } from 'react'
import { BaseEdge, useInternalNode, type EdgeProps, type InternalNode } from '@xyflow/react'
import { useCanvasOptions } from '../../lib/canvas'

/** Reporting lines bow clockwise by this share of their length in the "Curved" style; message edges counter-clockwise. */
const BOW_REPORTING = 0.12
const BOW_MESSAGE = -0.2
/** Gap left between the line and a node's box so the arrow tip does not touch the border. */
const CLIP_GAP = 2

interface Box {
  cx: number
  cy: number
  hw: number
  hh: number
}

function boxOf(node: InternalNode | undefined): Box | null {
  if (!node) return null
  const w = node.measured?.width ?? node.width ?? 0
  const h = node.measured?.height ?? node.height ?? 0
  if (w <= 0 || h <= 0) return null
  const p = node.internals.positionAbsolute
  return { cx: p.x + w / 2, cy: p.y + h / 2, hw: w / 2, hh: h / 2 }
}

/** Where the ray from the box centre toward (tx, ty) leaves the box. */
function exitPoint(b: Box, tx: number, ty: number): { x: number; y: number } {
  const dx = tx - b.cx
  const dy = ty - b.cy
  if (dx === 0 && dy === 0) return { x: b.cx, y: b.cy }
  const sx = dx === 0 ? Infinity : (b.hw + CLIP_GAP) / Math.abs(dx)
  const sy = dy === 0 ? Infinity : (b.hh + CLIP_GAP) / Math.abs(dy)
  const t = Math.min(sx, sy)
  return { x: b.cx + dx * t, y: b.cy + dy * t }
}

/**
 * Edge type 'radial' (docs/design/canvas-themes.md section 3): from source centre to target centre, clipped where the
 * line leaves each node's box. "Curved" bows it clockwise 12% of its length (a quadratic control point at the
 * midpoint); "Right angle" and "Straight" draw it straight. Message edges (`data.message`) bow counter-clockwise 20%
 * so they never lie on a reporting line. Falls back to the handle points until both nodes are measured.
 */
export function RadialEdge(props: EdgeProps): ReactElement {
  const { id, source, target, sourceX, sourceY, targetX, targetY, markerEnd, markerStart, style, data, label, labelStyle, labelBgStyle, interactionWidth } = props
  const { edges } = useCanvasOptions()
  const a = boxOf(useInternalNode(source))
  const b = boxOf(useInternalNode(target))
  const message = (data as { message?: boolean } | undefined)?.message === true
  const start = a && b ? exitPoint(a, b.cx, b.cy) : { x: sourceX, y: sourceY }
  const end = a && b ? exitPoint(b, a.cx, a.cy) : { x: targetX, y: targetY }
  const bow = message ? BOW_MESSAGE : edges === 'curved' ? BOW_REPORTING : 0
  const dx = end.x - start.x
  const dy = end.y - start.y
  const mx = (start.x + end.x) / 2
  const my = (start.y + end.y) / 2
  let d: string
  let lx = mx
  let ly = my
  if (bow === 0) {
    d = `M ${start.x},${start.y} L ${end.x},${end.y}`
  } else {
    // Screen y points down, so (-dy, dx) is the clockwise side of the direction of travel.
    const cx = mx - dy * bow
    const cy = my + dx * bow
    d = `M ${start.x},${start.y} Q ${cx},${cy} ${end.x},${end.y}`
    lx = 0.25 * start.x + 0.5 * cx + 0.25 * end.x
    ly = 0.25 * start.y + 0.5 * cy + 0.25 * end.y
  }
  return (
    <BaseEdge
      id={id}
      path={d}
      labelX={lx}
      labelY={ly}
      label={label}
      labelStyle={labelStyle}
      labelBgStyle={labelBgStyle}
      markerEnd={markerEnd}
      markerStart={markerStart}
      style={style}
      interactionWidth={interactionWidth}
    />
  )
}

/** Custom edge types shared by every canvas (pass as <ReactFlow edgeTypes>). Keep this object stable. */
export const CANVAS_EDGE_TYPES = { radial: RadialEdge }
