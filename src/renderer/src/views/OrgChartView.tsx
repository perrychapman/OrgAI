import type { ReactElement } from 'react'
import { useCallback, useMemo } from 'react'
import { LayoutGrid, Plus } from 'lucide-react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  type Connection,
  type Edge,
  type NodeChange,
  type NodeMouseHandler
} from '@xyflow/react'
import type { Project, Role } from '@shared/types'
import { ROLE_COLORS, newId, slugify } from '@shared/defaults'
import { useAppStore } from '../store/useAppStore'
import { CanvasFrame, FrameFooter, FrameStage, FrameToolbar } from '../components/layout/CanvasFrame'
import { SidePanel } from '../components/layout/SidePanel'
import { Button } from '../components/ui/Button'
import { RoleNode, type RoleFlowNode } from '../components/RoleNode'
import RoleInspector from '../components/RoleInspector'
import DraftPanel from '../components/DraftPanel'
import { treeLayout } from '../lib/layout'

const nodeTypes = { role: RoleNode }

export default function OrgChartView({ project }: { project: Project }): ReactElement {
  const selectedRoleId = useAppStore((s) => s.selectedRoleId)
  const selectRole = useAppStore((s) => s.selectRole)
  const updateRoles = useAppStore((s) => s.updateRoles)

  const nodes: RoleFlowNode[] = useMemo(
    () =>
      project.roles.map((role) => ({
        id: role.id,
        type: 'role',
        position: role.position,
        selected: role.id === selectedRoleId,
        data: { role, reportCount: project.roles.filter((r) => r.reportsTo === role.id).length }
      })),
    [project.roles, selectedRoleId]
  )

  const edges: Edge[] = useMemo(
    () =>
      project.roles
        .filter((r) => r.reportsTo && project.roles.some((x) => x.id === r.reportsTo))
        .map((r) => {
          const parent = project.roles.find((x) => x.id === r.reportsTo)!
          const allowed = parent.canSpawn && parent.spawnable.includes(r.id)
          return {
            id: `e-${parent.id}-${r.id}`,
            source: parent.id,
            target: r.id,
            style: { stroke: allowed ? r.color : 'var(--text-faint)', strokeDasharray: allowed ? undefined : '4 4' },
            markerEnd: { type: MarkerType.ArrowClosed, color: allowed ? r.color : '#646d84' },
            label: allowed ? undefined : 'not delegable',
            labelStyle: { fill: '#9aa3b8', fontSize: 10 },
            labelBgStyle: { fill: '#11141c' }
          }
        }),
    [project.roles]
  )

  const onNodesChange = useCallback(
    (changes: NodeChange<RoleFlowNode>[]) => {
      const moves = changes.filter((c) => c.type === 'position' && c.position)
      if (moves.length) {
        updateRoles(project.id, (roles) =>
          roles.map((r) => {
            const m = moves.find((c) => c.type === 'position' && c.id === r.id)
            return m && m.type === 'position' && m.position ? { ...r, position: m.position } : r
          })
        )
      }
    },
    [project.id, updateRoles]
  )

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return
      updateRoles(project.id, (roles) =>
        roles.map((r) => {
          if (r.id === c.target) return { ...r, reportsTo: c.source }
          if (r.id === c.source) return { ...r, canSpawn: true, spawnable: [...new Set([...r.spawnable, c.target as string])] }
          return { ...r, spawnable: r.spawnable.filter((id) => id !== c.target) }
        })
      )
    },
    [project.id, updateRoles]
  )

  const onNodeClick: NodeMouseHandler<RoleFlowNode> = useCallback((_e, node) => selectRole(node.id), [selectRole])

  const addRole = (): void => {
    const root = project.roles.find((r) => r.reportsTo === null)
    const selected = project.roles.find((r) => r.id === selectedRoleId)
    const manager = selected ?? root
    const name = `New role ${project.roles.length + 1}`
    const role: Role = {
      id: newId('role'),
      slug: slugify(name),
      name,
      description: 'Describe when a manager should delegate to this role.',
      responsibilities: [],
      prompt: 'You are a specialist. Complete the assigned task and report back concisely.',
      tools: ['Read', 'Glob', 'Grep'],
      model: 'sonnet',
      canSpawn: false,
      spawnable: [],
      reportsTo: manager?.id ?? null,
      position: { x: (manager?.position.x ?? 0) + 120, y: (manager?.position.y ?? 0) + 210 },
      color: ROLE_COLORS[project.roles.length % ROLE_COLORS.length]
    }
    updateRoles(project.id, (roles) => [
      ...roles.map((r) => (r.id === manager?.id ? { ...r, canSpawn: true, spawnable: [...r.spawnable, role.id] } : r)),
      role
    ])
    selectRole(role.id)
  }

  const autoLayout = (): void => {
    const pos = treeLayout(
      project.roles.map((r) => ({ id: r.id, parentId: r.reportsTo, width: 220, height: 96 })),
      { nodesep: 60, ranksep: 110 }
    )
    updateRoles(project.id, (roles) => roles.map((r) => ({ ...r, position: pos[r.id] ?? r.position })))
  }

  const selectedRole = project.roles.find((r) => r.id === selectedRoleId)

  return (
    <div className="editor">
      <CanvasFrame>
        <FrameToolbar label="Org chart actions">
          <Button size="sm" icon={Plus} onClick={addRole}>
            Add role
          </Button>
          <Button size="sm" icon={LayoutGrid} onClick={autoLayout}>
            Auto-layout
          </Button>
        </FrameToolbar>
        <FrameStage>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={() => selectRole(null)}
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={null}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#1f2432" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </FrameStage>
        <FrameFooter>
          <span>Drag from a node's bottom handle to another node to make it a report.</span>
        </FrameFooter>
      </CanvasFrame>
      <SidePanel label={selectedRole ? 'role inspector' : 'AI draft panel'}>
        {selectedRole ? <RoleInspector project={project} role={selectedRole} /> : <DraftPanel project={project} />}
      </SidePanel>
    </div>
  )
}
