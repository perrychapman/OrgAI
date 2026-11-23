import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { MiniMap, useOptionsStore, type Node } from '@xyflow/react'
import { minimapSize, useCanvasOptions } from '../../lib/canvas'
import { useCssVar } from '../../lib/useCssVar'

/**
 * The minimap every canvas mounts inside <ReactFlow> (docs/design/canvas-themes.md section 6): shown only when the
 * setting is on and the stage (`.frame-stage`, or the settings sample's `.canvas-preview`) is big enough
 * (`minimapSize`), bottom-left, token colours, the selected node in the focus-ring colour.
 */
export function CanvasMinimap({ ariaLabel }: { ariaLabel: string }): ReactElement | null {
  const { minimap } = useCanvasOptions()
  const domNode = useOptionsStore((s) => s.domNode)
  const [stage, setStage] = useState<{ w: number; h: number } | null>(null)
  const nodeColor = useCssVar('--canvas-minimap-node')
  const focusColor = useCssVar('--canvas-focus-ring')
  const mask = useCssVar('--canvas-minimap-mask')
  const glass = useCssVar('--glass')
  const minimapBg = useCssVar('--canvas-minimap-bg')
  const bg = glass || minimapBg
  const working = useCssVar('--working')
  const waiting = useCssVar('--warning')
  const done = useCssVar('--success')
  const failed = useCssVar('--danger')
  // Node colours follow the state scheme of the nodes; colour is a hint here, the minimap is aria-labelled and not the only view.
  const colorOf = (n: Node): string => {
    if (n.selected) return focusColor
    const state = (n.data as { agent?: { state?: string } } | undefined)?.agent?.state
    switch (state) {
      case 'thinking':
      case 'tool':
      case 'delegating':
      case 'starting':
        return working || nodeColor
      case 'waiting':
        return waiting || nodeColor
      case 'done':
        return done || nodeColor
      case 'error':
        return failed || nodeColor
      default:
        return nodeColor
    }
  }

  useEffect(() => {
    const el = domNode?.closest<HTMLElement>('.frame-stage, .canvas-preview') ?? domNode
    if (!el) return undefined
    const read = (): void => {
      const w = el.clientWidth
      const h = el.clientHeight
      setStage((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }))
    }
    read()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [domNode])

  if (!minimap || !stage) return null
  const size = minimapSize(stage.w, stage.h)
  if (!size) return null
  return (
    <MiniMap
      pannable
      zoomable
      position="bottom-left"
      ariaLabel={ariaLabel}
      style={{ width: size.width, height: size.height }}
      nodeColor={colorOf}
      nodeStrokeColor="transparent"
      nodeBorderRadius={4}
      maskColor={mask}
      bgColor={bg}
    />
  )
}
