import type { ReactElement } from 'react'
import { Background, BackgroundVariant } from '@xyflow/react'
import { useCanvasOptions } from '../../lib/canvas'
import { useCssVar } from '../../lib/useCssVar'
import type { RingGuides } from '../../lib/layout'

/**
 * The canvas backdrop, rendered as a child of <ReactFlow> on every canvas (Live run, Team editor, settings sample).
 * It reads the pattern from useCanvasOptions() and follows pan and zoom. `rings` draws the radial layout's guides as
 * part of the backdrop. SEAM: placeholder until the backdrops brief lands (docs/design/canvas-themes.md section 2).
 */
export function CanvasBackdrop({ rings: _rings }: { rings?: RingGuides }): ReactElement | null {
  const { pattern } = useCanvasOptions()
  const color = useCssVar('--canvas-pattern')
  if (pattern === 'none') return null
  return <Background variant={pattern === 'grid' ? BackgroundVariant.Lines : BackgroundVariant.Dots} gap={22} size={1.2} color={color} />
}
