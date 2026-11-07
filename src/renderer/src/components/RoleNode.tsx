import { BookOpen, Plug, TriangleAlert, Wrench } from 'lucide-react'
import { Icon } from './ui/Icon'
import type { CSSProperties, ReactElement } from 'react'
import { memo } from 'react'
import { Handle, type Position, type Node, type NodeProps } from '@xyflow/react'
import { handlesFor, stationGeometry, stationHandleStyle, useCanvasOptions, useHandleRefresh } from '../lib/canvas'
import { TOOL_CATALOG, type Role } from '@shared/types'
import { projectConnection, roleConnection } from '@shared/defaults'
import { selectedProject, useAppStore } from '../store/useAppStore'
import { connectionTagTitle } from '../lib/roleConnection'
import { initials } from '../lib/layout'
import { roleChipLabel } from '../lib/roleModels'
import { elevatedTools, toolsAriaLabel } from '../lib/roleCapabilities'
import { capabilityLabel, capabilityParts, type CapabilityCounts } from '../lib/teamView'

export type RoleFlowNode = Node<{ role: Role; reportCount: number; capabilities: CapabilityCounts }, 'role'>

const CAP_ICONS = { tools: Wrench, connections: Plug, skills: BookOpen } as const

function RoleNodeView({ id, data, selected }: NodeProps<RoleFlowNode>): ReactElement {
  const { role, reportCount, capabilities } = data
  const parts = capabilityParts(capabilities)
  const elevated = elevatedTools(role.tools, TOOL_CATALOG)
  const { layout, nodeStyle } = useCanvasOptions()
  useHandleRefresh(id, layout, nodeStyle)
  const sides = handlesFor(layout)
  const station = nodeStyle === 'station'
  const hex = nodeStyle === 'hex'
  // Every style but the card moves its details into the tooltip and the sr-only line.
  const compact = nodeStyle !== 'card'
  const geo = stationGeometry(layout)
  const hs = (side: string): { style?: CSSProperties } => (station ? { style: stationHandleStyle(geo, side as `${Position}`) } : {})
  const isRoot = role.reportsTo === null
  // The provider shows only when this role is pinned to a connection other than the project's (never on the root).
  const base = useAppStore((s) => {
    const p = selectedProject(s)
    return p ? projectConnection(p) : undefined
  })
  const on = useAppStore((s) => {
    const p = selectedProject(s)
    return p ? roleConnection(role, p) : undefined
  })
  const pinnedOn = on && base && on !== base ? on : undefined
  const chip = roleChipLabel(role, pinnedOn, base)
  const pinnedTitle = pinnedOn && base ? connectionTagTitle(pinnedOn, base) : undefined
  const tip = compact
    ? [role.name, role.slug, chip, pinnedTitle ?? '', role.canSpawn ? `leads ${reportCount}` : '', parts.length === 0 ? 'No tools' : capabilityLabel(capabilities)]
        .filter(Boolean)
        .join('\n')
    : undefined
  return (
    <div
      className={`role-node ${selected ? 'selected' : ''} ${isRoot ? 'is-root' : ''}`}
      data-style={nodeStyle}
      data-label={station ? geo.label : undefined}
      style={{ ['--role' as string]: role.color, ...(station ? { width: geo.width, height: geo.height } : {}) }}
      title={tip}
    >
      {!isRoot && <Handle type="target" position={sides.target as Position} {...hs(sides.target)} />}
      {station && (
        <>
          <div className="station" style={{ left: geo.cx - geo.r, top: geo.cy - geo.r }} />
          <div className="station-name">{role.name}</div>
        </>
      )}
      {hex && (
        <>
          <div className="hex-tile" aria-hidden="true">
            <div className="hex-fill" />
          </div>
          <div className="hex-content">
            <div className="avatar">{initials(role.name)}</div>
            <div className="hex-name">{role.name}</div>
          </div>
        </>
      )}
      {!station && !hex && <div className="head">
        <div className="avatar">{initials(role.name)}</div>
        <div className="head-text">
          <div className="name">{role.name}</div>
          {!compact && <div className="slug">{role.slug}</div>}
        </div>
      </div>}
      {compact && (
        <span className="sr-only" data-testid="role-node-caps" role="img" aria-label={`${role.name}. ${capabilityLabel(capabilities)}${elevated.length > 0 ? `. ${toolsAriaLabel(role.tools, TOOL_CATALOG)}` : ''}`} />
      )}
      {!compact && <div className="meta">
        <span
          className="chip"
          data-testid="role-model-chip"
          data-connection={pinnedOn}
          title={[pinnedTitle, role.model === 'inherit' ? '' : role.model].filter(Boolean).join('\n') || undefined}
        >
          {chip}
        </span>
        {role.canSpawn && <span className="chip">leads {reportCount}</span>}
      </div>}
      {!compact && <div className="caps" data-testid="role-node-caps" role="img" aria-label={`${role.name}. ${capabilityLabel(capabilities)}${elevated.length > 0 ? `. ${toolsAriaLabel(role.tools, TOOL_CATALOG)}` : ''}`}>
        {parts.length === 0 ? 'No tools' : parts.map((p, i) => (
          <span key={p.key} className="caps-part" aria-hidden="true">
            {i > 0 && <span className="caps-sep"> · </span>}
            <Icon icon={CAP_ICONS[p.key]} size="xs" />
            {p.n}
            <span className="caps-word"> {p.word}</span>
          </span>
        ))}
        {elevated.length > 0 && (
          <span className="caps-elevated" aria-hidden="true" data-testid="role-node-elevated" title={`Can change files or run commands: ${elevated.join(', ')}`}>
            <Icon icon={TriangleAlert} size="xs" />
          </span>
        )}
      </div>}
      <Handle type="source" position={sides.source as Position} {...hs(sides.source)} />
    </div>
  )
}

export const RoleNode = memo(RoleNodeView)
