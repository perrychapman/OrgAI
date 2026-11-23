import { BookOpen, Plug, TriangleAlert, Wrench } from 'lucide-react'
import { Icon } from './ui/Icon'
import type { CSSProperties, KeyboardEvent, ReactElement, SyntheticEvent } from 'react'
import { memo } from 'react'
import { Handle, NodeToolbar, useConnection, type Position, type Node, type NodeProps } from '@xyflow/react'
import { useRoleNodeActions } from './team/roleNodeActions'
import { handlesFor, stationGeometry, stationHandleStyle, useCanvasOptions, useHandleRefresh } from '../lib/canvas'
import { TOOL_CATALOG, type CanvasLayout, type CanvasNodeStyle, type Role } from '@shared/types'
import { projectConnection, roleConnection } from '@shared/defaults'
import { selectedProject, useAppStore } from '../store/useAppStore'
import { connectionTagTitle } from '../lib/roleConnection'
import { initials } from '../lib/layout'
import { roleChipLabel } from '../lib/roleModels'
import { elevatedTools, toolsAriaLabel } from '../lib/roleCapabilities'
import { capabilityLabel, capabilityParts, type CapabilityCounts } from '../lib/teamView'

/** `delegateCount`: direct reports the role may actually delegate to (canSpawn and listed in spawnable), not every report. */
export type RoleFlowNode = Node<
  {
    role: Role
    delegateCount: number
    capabilities: CapabilityCounts
    arrived?: boolean
    /**
     * The Team editor draws its own fixed look (team-tab overhaul 4.4): the card style and `layout`, whatever the app-wide
     * canvas settings say. Absent: the node follows the canvas settings as before.
     */
    team?: boolean
    layout?: CanvasLayout
  },
  'role'
>

const CAP_ICONS = { tools: Wrench, connections: Plug, skills: BookOpen } as const

/** What a connection being dragged is doing to this node: 'self' it started here, 'valid' / 'invalid' it hovers here. */
type DropState = 'self' | 'valid' | 'invalid' | null

function RoleNodeView({ id, data, selected }: NodeProps<RoleFlowNode>): ReactElement {
  const { role, delegateCount, capabilities, arrived, team } = data
  // The reporting line being dragged (from a source handle). A whole-node drop target takes pointer events only while
  // one is in progress (React Flow's own CSS), so clicks, drags and selection on the node are unaffected the rest of the time.
  const drop = useConnection((c): DropState => (!c.inProgress ? null : c.fromNode.id === id ? 'self' : c.toNode?.id === id ? (c.isValid ? 'valid' : 'invalid') : null))
  const parts = capabilityParts(capabilities)
  const elevated = elevatedTools(role.tools, TOOL_CATALOG)
  const options = useCanvasOptions()
  const layout: CanvasLayout = team ? (data.layout ?? 'top-down') : options.layout
  const nodeStyle: CanvasNodeStyle = team ? 'card' : options.nodeStyle
  useHandleRefresh(id, layout, nodeStyle)
  const sides = handlesFor(layout)
  const station = nodeStyle === 'station'
  const hex = nodeStyle === 'hex'
  // Every style but the card moves its details into the tooltip and the sr-only line.
  const compact = nodeStyle !== 'card'
  const geo = stationGeometry(layout)
  const hs = (side: string): { style?: CSSProperties } => (station ? { style: stationHandleStyle(geo, side as `${Position}`) } : {})
  const isRoot = role.reportsTo === null
  const actions = useRoleNodeActions()
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
  // Screen readers get the provider too (every node style), not only the tooltip (review M4).
  const capsLabel = `${role.name}. ${delegateCount > 0 ? `Delegates to ${delegateCount}. ` : ''}${capabilityLabel(capabilities)}${elevated.length > 0 ? `. ${toolsAriaLabel(role.tools, TOOL_CATALOG)}` : ''}${pinnedTitle ? `. ${pinnedTitle}` : ''}`
  const tip = compact
    ? [role.name, role.slug, chip, pinnedTitle ?? '', delegateCount > 0 ? `Delegates to ${delegateCount}` : '', parts.length === 0 ? 'No tools' : capabilityLabel(capabilities)]
        .filter(Boolean)
        .join('\n')
    : undefined
  return (
    <div
      className={`role-node ${selected ? 'selected' : ''} ${isRoot ? 'is-root' : ''} ${arrived ? 'motion-pop' : ''}`}
      data-style={nodeStyle}
      data-label={station ? geo.label : undefined}
      style={{ ['--role' as string]: role.color, ...(station ? { width: geo.width, height: geo.height } : {}) }}
      title={tip}
      data-drop={drop && drop !== 'self' ? drop : undefined}
    >
      {!isRoot && <Handle type="target" position={sides.target as Position} {...hs(sides.target)} />}
      {/* Drop anywhere on the node: a second, transparent target handle covering the whole box (React Flow's "easy
          connect" pattern). It follows the layout's target side, so a snapped line still ends where the edge does. */}
      {!isRoot && <Handle type="target" id="drop" className="role-drop" position={sides.target as Position} isConnectableStart={false} isConnectableEnd={drop !== 'self'} />}
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
          <div className="name" title={role.name}>{role.name}</div>
          {!compact && <div className="slug" title={role.slug}>{role.slug}</div>}
        </div>
      </div>}
      {compact && (
        <span className="sr-only" data-testid="role-node-caps" role="img" aria-label={capsLabel} />
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
        {delegateCount > 0 && <span className="chip" data-testid="role-node-leads">Delegates to {delegateCount}</span>}
        {typeof role.maxConcurrent === 'number' && (
          <span className="chip" data-testid="role-node-many" title={`At most ${role.maxConcurrent} of this role at once`}>
            up to {role.maxConcurrent}
          </span>
        )}
      </div>}
      {!compact && <div className="caps" data-testid="role-node-caps" role="img" aria-label={capsLabel}>
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
      {team && actions && (
        <NodeToolbar isVisible={selected} position={'top' as Position} offset={8} align="start" className="role-node-toolbar" data-testid="role-node-toolbar">
          {/* The toolbar is portalled, but React still bubbles its events to the node wrapper (select, menu, keys):
              stop them here so an action never re-selects the node it came from (review H1). */}
          <div
            role="toolbar"
            aria-label={`Actions for ${role.name}`}
            className="role-node-toolbar-row"
            onKeyDown={onToolbarKey}
            onClick={stop}
            onDoubleClick={stop}
            onContextMenu={stop}
            onPointerDown={stop}
            onMouseDown={stop}
          >
            <button type="button" data-testid="role-node-add-report" onClick={() => actions.addReport(id)}>
              Add a report
            </button>
            {!isRoot && (
              <>
                <button type="button" data-testid="role-node-duplicate" onClick={() => actions.duplicate(id)}>
                  Duplicate
                </button>
                <button type="button" data-testid="role-node-move" onClick={() => actions.move(id)}>
                  Move
                </button>
                <button type="button" className="is-danger" data-testid="role-node-remove" onClick={() => actions.remove(id)}>
                  Remove
                </button>
              </>
            )}
          </div>
        </NodeToolbar>
      )}
    </div>
  )
}

/** Left / Right, Home and End move between the toolbar's buttons (one toolbar, every button still a Tab stop). */
function stop(e: SyntheticEvent): void {
  e.stopPropagation()
}

function onToolbarKey(e: KeyboardEvent<HTMLDivElement>): void {
  // Enter, Space, Escape, Delete and the menu keys belong to the button, not to the node behind the portal.
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    e.stopPropagation()
    return
  }
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
  const at = items.indexOf(document.activeElement as HTMLButtonElement)
  if (items.length === 0) return
  e.preventDefault()
  e.stopPropagation()
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowRight' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
  items[next]?.focus()
}

export const RoleNode = memo(RoleNodeView)
