import type { ReactElement } from 'react'
import { MiniMap } from '@xyflow/react'
import { useCanvasOptions } from '../../lib/canvas'

/**
 * The minimap every canvas mounts inside <ReactFlow> (docs/design/canvas-themes.md section 6): shown only when the
 * setting is on and the stage is large enough (minimapSize), bottom-left, token colours. SEAM: placeholder until the
 * canvas-engine brief implements sizing and colours.
 */
export function CanvasMinimap({ ariaLabel }: { ariaLabel: string }): ReactElement | null {
  const { minimap } = useCanvasOptions()
  if (!minimap) return null
  return <MiniMap pannable zoomable position="bottom-left" ariaLabel={ariaLabel} />
}
