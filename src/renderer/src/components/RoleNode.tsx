import type { ReactElement } from 'react'
import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { Role } from '@shared/types'
import { initials } from '../lib/layout'

export type RoleFlowNode = Node<{ role: Role; reportCount: number }, 'role'>

function RoleNodeView({ data, selected }: NodeProps<RoleFlowNode>): ReactElement {
  const { role, reportCount } = data
  return (
    <div className={`role-node ${selected ? 'selected' : ''}`} style={{ ['--role' as string]: role.color }}>
      {role.reportsTo !== null && <Handle type="target" position={Position.Top} />}
      <div className="head">
        <div className="avatar">{initials(role.name)}</div>
        <div className="head-text">
          <div className="name">{role.name}</div>
          <div className="slug">{role.slug}</div>
        </div>
      </div>
      <div className="meta">
        <span className="chip">{role.model}</span>
        <span className="chip">{role.tools.length} tools</span>
        {role.canSpawn && <span className="chip">leads {reportCount}</span>}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

export const RoleNode = memo(RoleNodeView)
