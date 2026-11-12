import type { CSSProperties, ReactElement } from 'react'
import { memo } from 'react'
import { ChevronDown } from 'lucide-react'
import { Handle, type Position, type Node, type NodeProps } from '@xyflow/react'
import { handlesFor, stationGeometry, stationHandleStyle, useCanvasOptions, useHandleRefresh } from '../lib/canvas'
import { MessageHandles } from './AgentNode'
import type { AgentInstance } from '@shared/types'
import { IconButton } from './ui/IconButton'
import { Cost } from './ui/Cost'
import { agentCostInput, sumCosts } from '../lib/cost'
import { agentLabel } from '../lib/agentTree'
import { groupConnectionNote } from '../lib/roleConnection'
import { activeRun, useAppStore } from '../store/useAppStore'

/**
 * One compact node standing in for every finished agent folded under a visible parent (its whole settled subtree,
 * direct reports first; lib/foldFinished.ts), so the canvas stays readable once an orchestrator has cycled through
 * many delegations. Counts and cost cover the subtree.
 */
export type DoneGroupFlowNode = Node<
  { parentId: string; parentName: string; agents: AgentInstance[]; color: string; onToggle: (parentId: string) => void; label?: string; earlier?: boolean; arrived?: boolean },
  'done-group'
>

export const GROUP_W = 240
export const GROUP_H = 56

export function groupId(parentId: string): string {
  return `group:${parentId}`
}

function DoneGroupNodeView({ id, data, selected }: NodeProps<DoneGroupFlowNode>): ReactElement {
  const { agents, color, parentId, parentName, onToggle, label, earlier, arrived } = data
  const failed = agents.filter((a) => a.state === 'error').length
  const done = agents.length - failed
  const cost = sumCosts(agents.map(agentCostInput))
  const conflicts = agents.filter((a) => a.worktree?.status === 'conflict' || a.worktree?.status === 'held').length
  const names = agents
    .slice(0, 4)
    .map(agentLabel)
    .join(', ')

  const { layout, nodeStyle } = useCanvasOptions()
  useHandleRefresh(id, layout, nodeStyle)
  const sides = handlesFor(layout)
  const station = nodeStyle === 'station'
  const hex = nodeStyle === 'hex'
  // Every style but the card moves its details into the tooltip.
  const compact = nodeStyle !== 'card'
  const geo = stationGeometry(layout)
  // The terminus bar is 10 px high and 28 wide: handles meet its edge, not the 32 px station circle's.
  const hs = (side: string): { style?: CSSProperties } => {
    if (!station) return {}
    const half = side === 'top' || side === 'bottom' ? 5 : 14
    return { style: stationHandleStyle({ ...geo, r: half }, side as `${Position}`) }
  }
  const runConnection = useAppStore((s) => activeRun(s)?.summary.connection)
  const tip = names + (agents.length > 4 ? ', …' : '') + groupConnectionNote(agents, runConnection) + (compact && conflicts > 0 ? ` · ${conflicts} unmerged` : '')
  const expand = (
    // Enter and Space on the chevron expand the group; React Flow's node handler must not also select it.
    <span className="done-expand" onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation() }}>
      <IconButton
        icon={ChevronDown}
        size="sm"
        label={earlier && label ? `Show ${label} on the chart` : `Show reports under ${parentName}`}
        onClick={(e) => {
          // The click expands the group; it must not also select the node.
          e.stopPropagation()
          onToggle(parentId)
        }}
      />
    </span>
  )
  const main = (
    <div className="done-group-main">
      <span className="done-count">
        <i /> {label ?? `${done} done`}
      </span>
      {failed > 0 && <span className="done-failed">{compact ? `· ${failed} failed` : `${failed} failed`}</span>}
      {!compact && conflicts > 0 && <span className="done-conflict">{conflicts} unmerged</span>}
      {!compact && <Cost value={cost} hideEmpty className="done-cost" />}
    </div>
  )

  return (
    <div
      data-testid="done-group"
      data-count={agents.length}
      data-style={nodeStyle}
      data-label={station ? geo.label : undefined}
      className={`done-group ${earlier ? 'earlier' : ''} ${selected ? 'selected' : ''} ${arrived ? 'motion-pop' : ''}`}
      data-earlier={earlier ? 'true' : undefined}
      style={{ ['--role' as string]: color, ...(station ? { width: geo.width, height: geo.height } : {}) }}
      title={tip}
    >
      <Handle type="target" position={sides.target as Position} {...hs(sides.target)} />
      <MessageHandles hs={hs} />
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
    </div>
  )
}

export const DoneGroupNode = memo(DoneGroupNodeView)
