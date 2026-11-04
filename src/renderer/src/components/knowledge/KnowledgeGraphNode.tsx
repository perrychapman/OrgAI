import type { CSSProperties, ReactElement } from 'react'
import { memo } from 'react'
import { Handle, type Node, type NodeProps, type Position } from '@xyflow/react'
import { handlesFor, stationGeometry, stationHandleStyle, useCanvasOptions, useHandleRefresh } from '../../lib/canvas'
import { SIDES, msgHandleId } from '../../lib/canvasShapes'
import { initials } from '../../lib/layout'

/**
 * One item of the Knowledge graph (docs/design/knowledge.md section 5): the name, the kind, the fact and relation
 * counts and the "Retired" word when retired. The markup mirrors the Team editor's role node (`.role-node`, so the
 * card, name tag, station and honeycomb styles and both themes come from editor.css and run.css), with
 * `.knowledge-node` for what differs (styles/knowledge-graph.css). Every string is agent-written data rendered as
 * plain text. The spoken name is the node's `ariaLabel` (set by KnowledgeGraph), never built here.
 */
export type KnowledgeFlowNode = Node<
  {
    name: string
    /** "Person", "Open question" (kindLabel). */
    kindLabel: string
    /** The kind's colour slot (kindColor). */
    color: string
    /** "3 facts · 2 relations". */
    counts: string
    retired: boolean
    /** The selected item at the centre of the neighbourhood (the station interchange look). */
    centre: boolean
    /** The tooltip: name, kind, counts and relations, one per line. */
    tip: string
  },
  'knowledge'
>

function KnowledgeGraphNodeView({ id, data, selected }: NodeProps<KnowledgeFlowNode>): ReactElement {
  const { name, kindLabel, color, counts, retired, centre, tip } = data
  const { layout, nodeStyle } = useCanvasOptions()
  useHandleRefresh(id, layout, nodeStyle)
  const sides = handlesFor(layout)
  const station = nodeStyle === 'station'
  const hex = nodeStyle === 'hex'
  const compact = nodeStyle !== 'card'
  const geo = stationGeometry(layout)
  const hs = (side: string): { style?: CSSProperties } => (station ? { style: stationHandleStyle(geo, side as `${Position}`) } : {})
  const retiredWord = retired ? <span className="knowledge-retired-word">Retired</span> : null
  return (
    <div
      className={`role-node knowledge-node ${selected ? 'selected' : ''} ${centre ? 'is-root' : ''} ${retired ? 'retired' : ''}`}
      data-testid="knowledge-node"
      data-id={id}
      data-kind-label={kindLabel}
      data-style={nodeStyle}
      data-label={station ? geo.label : undefined}
      data-retired={retired ? 'true' : undefined}
      style={{ ['--role' as string]: color, ...(station ? { width: geo.width, height: geo.height } : {}) }}
      title={tip}
    >
      <Handle type="target" position={sides.target as Position} isConnectable={false} {...hs(sides.target)} />
      {station && (
        <>
          <div className="station" style={{ left: geo.cx - geo.r, top: geo.cy - geo.r }} aria-hidden="true" />
          <div className="station-name">
            <span className="knowledge-name-text">{name}</span>
            {retiredWord}
          </div>
        </>
      )}
      {hex && (
        <>
          <div className="hex-tile" aria-hidden="true">
            <div className="hex-fill" />
          </div>
          <div className="hex-content">
            <div className="avatar" aria-hidden="true">
              {initials(name)}
            </div>
            <div className="hex-name">{name}</div>
            {retiredWord}
          </div>
        </>
      )}
      {!station && !hex && (
        <div className="head">
          <div className="avatar" aria-hidden="true">
            {initials(name)}
          </div>
          <div className="head-text">
            <div className="name">
              <span className="knowledge-name-text">{name}</span>
              {compact && retiredWord}
            </div>
            {!compact && <div className="knowledge-kind">{kindLabel}</div>}
          </div>
        </div>
      )}
      {!compact && (
        <div className="meta knowledge-meta">
          <span className="knowledge-counts">{counts}</span>
          {retiredWord}
        </div>
      )}
      <Handle type="source" position={sides.source as Position} isConnectable={false} {...hs(sides.source)} />
      {/* Relation edges pick the pair of sides that face each other (relationHandles); the two handles above serve the
          retired-group edge. All hidden. */}
      {SIDES.map((side) => (
        <Handle key={`out-${side}`} id={msgHandleId('out', side)} type="source" position={side as Position} className="msg-handle" isConnectable={false} {...hs(side)} />
      ))}
      {SIDES.map((side) => (
        <Handle key={`in-${side}`} id={msgHandleId('in', side)} type="target" position={side as Position} className="msg-handle" isConnectable={false} {...hs(side)} />
      ))}
    </div>
  )
}

export const KnowledgeGraphNode = memo(KnowledgeGraphNodeView)
