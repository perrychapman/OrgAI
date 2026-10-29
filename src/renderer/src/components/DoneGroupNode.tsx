import type { ReactElement } from 'react'
import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { MSG_IN, MSG_OUT } from './AgentNode'
import type { AgentInstance } from '@shared/types'
import { formatCost } from '../lib/layout'

/**
 * One compact node standing in for every finished report under a parent, so the canvas
 * stays readable once an orchestrator has cycled through many delegations.
 */
export type DoneGroupFlowNode = Node<
  { parentId: string; agents: AgentInstance[]; color: string; onToggle: (parentId: string) => void },
  'done-group'
>

export const GROUP_W = 240
export const GROUP_H = 56

export function groupId(parentId: string): string {
  return `group:${parentId}`
}

function DoneGroupNodeView({ data, selected }: NodeProps<DoneGroupFlowNode>): ReactElement {
  const { agents, color, parentId, onToggle } = data
  const failed = agents.filter((a) => a.state === 'error').length
  const done = agents.length - failed
  const cost = agents.reduce((sum, a) => sum + (a.costUsd || 0), 0)
  const conflicts = agents.filter((a) => a.worktree?.status === 'conflict' || a.worktree?.status === 'held').length
  const names = agents
    .slice(0, 4)
    .map((a) => a.name)
    .join(', ')

  return (
    <div className={`done-group ${selected ? 'selected' : ''}`} style={{ ['--role' as string]: color }} title={names + (agents.length > 4 ? ', …' : '')}>
      <Handle type="target" position={Position.Top} />
      <Handle id={MSG_OUT} type="source" position={Position.Right} className="msg-handle" isConnectable={false} />
      <Handle id={MSG_IN} type="target" position={Position.Left} className="msg-handle" isConnectable={false} />
      <div className="done-group-main">
        <span className="done-count">
          <i /> {done} done
        </span>
        {failed > 0 && <span className="done-failed">{failed} failed</span>}
        {conflicts > 0 && <span className="done-conflict">{conflicts} unmerged</span>}
        {cost > 0 && <span className="done-cost">{formatCost(cost)}</span>}
      </div>
      <button
        className="done-expand"
        title="Show these reports on the chart"
        onClick={(e) => {
          e.stopPropagation()
          onToggle(parentId)
        }}
      >
        ▾
      </button>
    </div>
  )
}

export const DoneGroupNode = memo(DoneGroupNodeView)
