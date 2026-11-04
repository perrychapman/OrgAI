import type { ReactElement } from 'react'
import { StraightEdge, type EdgeProps } from '@xyflow/react'

/**
 * Edge type 'radial' (docs/design/canvas-themes.md section 3): centre to centre, clipped at each node's box, bowed
 * clockwise 12% for "Curved", counter-clockwise 20% for message edges. SEAM: placeholder until the canvas-engine
 * brief implements it (a straight handle-to-handle edge).
 */
export function RadialEdge(props: EdgeProps): ReactElement {
  return <StraightEdge {...props} />
}

/** Custom edge types shared by every canvas (pass as <ReactFlow edgeTypes>). Keep this object stable. */
export const CANVAS_EDGE_TYPES = { radial: RadialEdge }
