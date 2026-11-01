import { BookOpen, Plug, Wrench } from 'lucide-react'
import { Icon } from './ui/Icon'
import type { ReactElement } from 'react'
import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { Role } from '@shared/types'
import { initials } from '../lib/layout'
import { capabilityLabel, capabilityParts, type CapabilityCounts } from '../lib/teamView'

export type RoleFlowNode = Node<{ role: Role; reportCount: number; capabilities: CapabilityCounts }, 'role'>

const CAP_ICONS = { tools: Wrench, connections: Plug, skills: BookOpen } as const

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
      <div className="caps" data-testid="role-node-caps" role="img" aria-label={`${role.name}. ${capabilityLabel(capabilities)}`}>
        {parts.length === 0 ? 'No tools' : parts.map((p, i) => (
          <span key={p.key} className="caps-part" aria-hidden="true">
            {i > 0 && <span className="caps-sep"> · </span>}
            <Icon icon={CAP_ICONS[p.key]} size="xs" />
            {p.n}
            <span className="caps-word"> {p.word}</span>
          </span>
        ))}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

export const RoleNode = memo(RoleNodeView)
