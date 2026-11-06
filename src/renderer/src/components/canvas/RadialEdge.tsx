import type { ReactElement } from 'react'
import { BaseEdge, useInternalNode, type EdgeProps, type InternalNode } from '@xyflow/react'
import type { CanvasLayout, CanvasNodeStyle } from '@shared/types'
import { stationGeometry, useCanvasOptions } from '../../lib/canvas'
import { exitPoint, type NodeShape } from '../../lib/canvasShapes'

/** Reporting lines bow clockwise by this share of their length in the "Curved" style; message edges counter-clockwise. */
const BOW_REPORTING = 0.12
const BOW_MESSAGE = -0.2
/**
 * The outline of a node: the station circle for the Stations style (centre inside the box from stationGeometry), the
 * flat-top hexagon for Honeycomb, the box otherwise.
 */
function shapeOf(node: InternalNode | undefined, nodeStyle: CanvasNodeStyle, layout: CanvasLayout): NodeShape | null {
  if (!node) return null
  const w = node.measured?.width ?? node.width ?? 0
  const h = node.measured?.height ?? node.height ?? 0
  if (w <= 0 || h <= 0) return null
  const p = node.internals.positionAbsolute
  if (nodeStyle === 'station') {
    const g = stationGeometry(layout)
    return { kind: 'circle', cx: p.x + g.cx, cy: p.y + g.cy, r: g.r }
  }
  if (nodeStyle === 'hex') return { kind: 'hex', cx: p.x + w / 2, cy: p.y + h / 2, hw: w / 2, hh: h / 2 }
  return { kind: 'box', cx: p.x + w / 2, cy: p.y + h / 2, hw: w / 2, hh: h / 2 }
}

/**
 * Edge type 'radial' (docs/design/canvas-themes.md section 3): from source centre to target centre, clipped where the
 * line leaves each node's outline (box, station circle or hexagon, by the node style). "Curved" bows it clockwise 12% of its length (a quadratic control point at the
 * midpoint); "Right angle" and "Straight" draw it straight. Message edges (`data.message`) bow counter-clockwise 20%
 * so they never lie on a reporting line. Falls back to the handle points until both nodes are measured.
 */
export function RadialEdge(props: EdgeProps): ReactElement {
  const { id, source, target, sourceX, sourceY, targetX, targetY, markerEnd, markerStart, style, data, label, labelStyle, labelBgStyle, interactionWidth } = props
  const { edges, nodeStyle, layout } = useCanvasOptions()
  const a = shapeOf(useInternalNode(source), nodeStyle, layout)
  const b = shapeOf(useInternalNode(target), nodeStyle, layout)
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
