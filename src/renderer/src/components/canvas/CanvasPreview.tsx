import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef } from 'react'
import { ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { useCanvasOptions } from '../../lib/canvas'
import { buildSample, type SampleInks } from '../../lib/canvasSample'
import { useCssVar } from '../../lib/useCssVar'
import { AgentNode } from '../AgentNode'
import { DoneGroupNode } from '../DoneGroupNode'
import { CanvasBackdrop } from './CanvasBackdrop'
import { CanvasMinimap } from './CanvasMinimap'
import { CANVAS_EDGE_TYPES } from './RadialEdge'
import { OfficeSample } from './CanvasPresentationChoices'
import '../../styles/office.css'

const nodeTypes = { agent: AgentNode, 'done-group': DoneGroupNode }

function PreviewFlow(): ReactElement {
  const options = useCanvasOptions()
  const edgeMix = useCssVar('--canvas-edge-role-mix')
  const edgeInk = useCssVar('--canvas-edge-ink')
  const groupEdge = useCssVar('--canvas-edge-group')
  const message = useCssVar('--edge-message')
  const doneRaw = useCssVar('--canvas-edge-done-opacity')
  const doneOpacity = Number.parseFloat(doneRaw)
  const { layout, nodeStyle, edges: edgeStyle } = options
  const graph = useMemo(() => {
    const inks: SampleInks = { edgeMix: edgeMix || '85%', edgeInk, groupEdge, message, ...(Number.isFinite(doneOpacity) ? { doneOpacity } : {}) }
    return buildSample({ layout, nodeStyle, edges: edgeStyle }, inks)
  }, [layout, nodeStyle, edgeStyle, edgeMix, edgeInk, groupEdge, message, doneOpacity])
  const { fitView } = useReactFlow()
  const box = useRef<HTMLDivElement>(null)

  // Refit at once (no animation) whenever the sample changes shape or the preview changes size.
  const padding = layout === 'radial' ? 0.12 : 0.2
  useEffect(() => {
    const t = setTimeout(() => void fitView({ padding, maxZoom: 1, duration: 0 }), 30)
    return () => clearTimeout(t)
  }, [graph, padding, fitView])
  useEffect(() => {
    const el = box.current
    if (!el) return undefined
    let t: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      clearTimeout(t)
      t = setTimeout(() => void fitView({ padding, maxZoom: 1, duration: 0 }), 30)
    })
    ro.observe(el)
    return () => {
      clearTimeout(t)
      ro.disconnect()
    }
  }, [padding, fitView])

  return (
    <div ref={box} className="canvas-preview-flow">
      <ReactFlow
        nodes={graph.nodes}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        edgeTypes={CANVAS_EDGE_TYPES}
        data-layout={layout}
        fitView
        fitViewOptions={{ padding, maxZoom: 1 }}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        panOnDrag={false}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        disableKeyboardA11y
        panActivationKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        deleteKeyCode={null}
        zoomActivationKeyCode={null}
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
      >
        <CanvasBackdrop rings={graph.rings} />
        <CanvasMinimap ariaLabel="Sample minimap" />
      </ReactFlow>
    </div>
  )
}

/**
 * A static sample org chart drawn with the real node, edge, backdrop and minimap components in the current canvas
 * settings, so a change shows at once (docs/design/canvas-themes.md 7.1). One image for assistive tech; the wrapper is
 * inert so nothing in it takes focus or clicks.
 */
export function CanvasPreview(): ReactElement {
  const options = useCanvasOptions()
  return (
    <div className="canvas-preview" data-testid="canvas-preview" data-presentation={options.presentation} role="img" aria-label={options.presentation === 'pocket-office' ? 'Static sample office in the current style' : 'Sample canvas in the current style'} inert>
      {options.presentation === 'pocket-office' ? (
        <OfficeSample palette={options.scenePalette} />
      ) : (
      <ReactFlowProvider>
        <PreviewFlow />
      </ReactFlowProvider>
      )}
    </div>
  )
}
