import type { ReactElement } from 'react'
import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { Role } from '@shared/types'
import { initials } from '../lib/layout'
import { capabilityParts, type CapabilityCounts } from '../lib/teamView'

export type RoleFlowNode = Node<{ role: Role; reportCount: number; capabilities: CapabilityCounts }, 'role'>

function RoleNodeView({ data, selected }: NodeProps<RoleFlowNode>): ReactElement {
  const { role, reportCount, capabilities } = data
  const parts = capabilityParts(capabilities)
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
        {role.canSpawn && <span className="chip">leads {reportCount}</span>}
      </div>
      <div className="caps" data-testid="role-node-caps">
        {parts.length === 0 ? 'No tools' : parts.map((p, i) => (
          <span key={p.key}>
            {i > 0 && <span className="caps-sep" aria-hidden="true"> · </span>}
            {p.n} {p.word}
          </span>
        ))}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

export const RoleNode = memo(RoleNodeView)
