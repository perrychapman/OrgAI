import type { CSSProperties, ReactElement } from 'react'
import { memo } from 'react'
import { ChevronDown } from 'lucide-react'
import { Handle, type Node, type NodeProps, type Position } from '@xyflow/react'
import { handlesFor, stationGeometry, stationHandleStyle, useCanvasOptions, useHandleRefresh } from '../../lib/canvas'
import { IconButton } from '../ui/IconButton'
import { retiredGroupLabel } from '../../lib/knowledgeGraph'

/**
 * The "N retired" group (docs/design/knowledge.md section 5, rec 5c): one per drawn node, standing for the retired
 * items (and the far ends of retired relations) hanging off it, on the Live canvas's `done-group` look. The chevron
 * (or Enter on the node) expands them for this session. `data-testid="knowledge-retired-group"`, `data-count`.
 */
export type KnowledgeRetiredFlowNode = Node<
  {
    parentId: string
    parentName: string
    count: number
    /** The parent's kind colour (the terminus bar and the hover border). */
    color: string
    /** The members' names, one per line, for the tooltip. */
    tip: string
    onToggle: (parentId: string) => void
  },
  'knowledge-retired'
>

function KnowledgeRetiredGroupNodeView({ id, data, selected }: NodeProps<KnowledgeRetiredFlowNode>): ReactElement {
  const { parentId, parentName, count, color, tip, onToggle } = data
  const { layout, nodeStyle } = useCanvasOptions()
  useHandleRefresh(id, layout, nodeStyle)
  const sides = handlesFor(layout)
  const station = nodeStyle === 'station'
  const hex = nodeStyle === 'hex'
  const geo = stationGeometry(layout)
  // The terminus bar is 10 px high and 28 wide: handles meet its edge, not the 32 px station circle's.
  const hs = (side: string): { style?: CSSProperties } => {
    if (!station) return {}
    const half = side === 'top' || side === 'bottom' ? 5 : 14
    return { style: stationHandleStyle({ ...geo, r: half }, side as `${Position}`) }
  }
  const label = retiredGroupLabel(count)
  const expand = (
    // Enter and Space on the chevron expand the group; the canvas's own key handler must not also run.
    <span
      className="done-expand"
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
      }}
    >
      <IconButton
        icon={ChevronDown}
        size="sm"
        label={`Show ${count === 1 ? 'the retired item' : `the ${count} retired items`} under ${parentName}`}
        testId="knowledge-retired-expand"
        onClick={(e) => {
          e.stopPropagation()
          onToggle(parentId)
        }}
      />
    </span>
  )
  const main = (
    <div className="done-group-main">
      <span className="done-count">
        <i /> {label}
      </span>
    </div>
  )
  return (
    <div
      data-testid="knowledge-retired-group"
      data-count={count}
      data-parent={parentId}
      data-style={nodeStyle}
      data-label={station ? geo.label : undefined}
      className={`done-group knowledge-retired-group ${selected ? 'selected' : ''}`}
      style={{ ['--role' as string]: color, ...(station ? { width: geo.width, height: geo.height } : {}) }}
      title={tip}
    >
      <Handle type="target" position={sides.target as Position} isConnectable={false} {...hs(sides.target)} />
      {station && (
        <>
          <div className="station-terminus" style={{ left: geo.cx - 14, top: geo.cy - 5 }} aria-hidden="true" />
          <div className="station-name">
            {main}
            {expand}
          </div>
        </>
      )}
      {hex && (
        <>
          <div className="hex-tile" aria-hidden="true">
            <div className="hex-fill" />
          </div>
          <div className="hex-content">
            {main}
            {expand}
          </div>
        </>
      )}
      {!station && !hex && (
        <>
          {main}
          {expand}
        </>
      )}
      <Handle type="source" position={sides.source as Position} isConnectable={false} {...hs(sides.source)} />
    </div>
  )
}

export const KnowledgeRetiredGroupNode = memo(KnowledgeRetiredGroupNodeView)
