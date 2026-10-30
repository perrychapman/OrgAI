import type { KeyboardEvent, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LayoutGrid, Plus, Undo2 } from 'lucide-react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type NodeMouseHandler
} from '@xyflow/react'
import type { Project, Role } from '@shared/types'
import { ROLE_COLORS, newId, slugify } from '@shared/defaults'
import { useAppStore } from '../store/useAppStore'
import { CanvasFrame, FrameFooter, FrameStage, FrameToolbar } from '../components/layout/CanvasFrame'
import { SidePanel } from '../components/layout/SidePanel'
import { Button } from '../components/ui/Button'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { RoleNode, type RoleFlowNode } from '../components/RoleNode'
import RoleInspector from '../components/RoleInspector'
import DraftPanel from '../components/DraftPanel'
import { treeLayout } from '../lib/layout'
import { nextRoleName, removeRole, restoreRole, setReportsTo, wouldCycle, type RemovedRole } from '../lib/roleOps'
import { useCssVar } from '../lib/useCssVar'

const nodeTypes = { role: RoleNode }

/** How long the "Role removed. Undo" row stays in the toolbar. */
const UNDO_MS = 12_000

export default function OrgChartView({ project }: { project: Project }): ReactElement {
  // Re-fit when the frame changes size (window, sidebar or side panel resize), as the live view does.
  const frameRef = useRef<HTMLDivElement>(null)
  const flowRef = useRef<{ fitView: (o?: { padding?: number; maxZoom?: number; duration?: number }) => unknown } | null>(null)
  useEffect(() => {
    const el = frameRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    let t: ReturnType<typeof setTimeout> | undefined
    let first = true
    const ro = new ResizeObserver(() => {
      if (first) {
        first = false
        return
      }
      clearTimeout(t)
      t = setTimeout(() => {
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        void flowRef.current?.fitView({ padding: 0.3, maxZoom: 1, duration: reduced ? 0 : 150 })
      }, 100)
    })
    ro.observe(el)
    return () => {
      clearTimeout(t)
      ro.disconnect()
    }
  }, [])
  const selectedRoleId = useAppStore((s) => s.selectedRoleId)
  const selectRole = useAppStore((s) => s.selectRole)
  const updateRoles = useAppStore((s) => s.updateRoles)
  const { confirm, dialog } = useConfirm()
  const patternColor = useCssVar('--canvas-pattern')
  const faintColor = useCssVar('--text-tertiary')
  const labelBg = useCssVar('--surface-1')

  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ roleId: string; text: string } | null>(null)
  const [undo, setUndo] = useState<{ removed: RemovedRole; name: string } | null>(null)
  const [focusTick, setFocusTick] = useState(0)
  const [panelOpen, setPanelOpen] = useState(true)
  const focusWanted = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const root = project.roles.find((r) => r.reportsTo === null)
  const selectedRole = project.roles.find((r) => r.id === selectedRoleId)
  const addParent = selectedRole ?? root

  useEffect(() => {
    if (!undo) return
    const t = window.setTimeout(() => setUndo(null), UNDO_MS)
    return () => window.clearTimeout(t)
  }, [undo])

  // Move focus into the inspector's name field once it is mounted, after a keyboard open or an add.
  useEffect(() => {
    if (!focusWanted.current || !selectedRole) return
    focusWanted.current = false
    const id = window.requestAnimationFrame(() => {
      const field = document.getElementById('role-name-input') as HTMLInputElement | null
      field?.focus()
      field?.select()
    })
    return () => window.cancelAnimationFrame(id)
  }, [focusTick, selectedRole])

  const nodes: RoleFlowNode[] = useMemo(
    () =>
      project.roles.map((role) => ({
        id: role.id,
        type: 'role',
        position: role.position,
        selected: role.id === selectedRoleId,
        deletable: role.reportsTo !== null,
        ariaLabel: `${role.name}, ${role.reportsTo === null ? 'root role' : 'role'}. Press Enter to edit${role.reportsTo === null ? '' : ', Delete to remove'}.`,
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
          const id = `e-${parent.id}-${r.id}`
          return {
            id,
            source: parent.id,
            target: r.id,
            selected: id === selectedEdgeId,
            ariaLabel:
              parent.id === root?.id
                ? `${parent.name} manages ${r.name}.`
                : `${parent.name} manages ${r.name}. Press Delete to make ${r.name} report to ${root?.name ?? 'the root'} instead.`,
            style: { stroke: allowed ? r.color : 'var(--text-faint)', strokeDasharray: allowed ? undefined : '4 4' },
            markerEnd: { type: MarkerType.ArrowClosed, color: allowed ? r.color : faintColor },
            label: allowed ? undefined : 'not delegable',
            labelStyle: { fill: faintColor, fontSize: 11 },
            labelBgStyle: { fill: labelBg }
          }
        }),
    [project.roles, selectedEdgeId, root, faintColor, labelBg]
  )

  const reparentToRoot = useCallback(
    (childId: string) => {
      if (!root) return
      const child = project.roles.find((r) => r.id === childId)
      if (!child || child.reportsTo === root.id) return
      updateRoles(project.id, (roles) => setReportsTo(roles, childId, root.id))
      setSelectedEdgeId(null)
      selectRole(childId)
      setNotice({ roleId: childId, text: `Now reports to ${root.name}.` })
    },
    [project.id, project.roles, root, updateRoles, selectRole]
  )

  const requestRemove = useCallback(
    async (roleId: string): Promise<void> => {
      const role = project.roles.find((r) => r.id === roleId)
      if (!role || role.reportsTo === null) return
      const reports = project.roles.filter((r) => r.reportsTo === roleId).length
      const ok = await confirm({
        title: `Remove ${role.name}?`,
        body: reports
          ? `Its ${reports === 1 ? 'report moves' : `${reports} reports move`} up to its manager. You can undo this for a few seconds.`
          : 'You can undo this for a few seconds.',
        confirmLabel: 'Remove role',
        danger: true
      })
      if (!ok) return
      const current = useAppStore.getState().projects.find((p) => p.id === project.id)?.roles ?? project.roles
      const { removed } = removeRole(current, roleId)
      if (!removed) return
      updateRoles(project.id, (roles) => removeRole(roles, roleId).roles)
      selectRole(null)
      setNotice(null)
      setUndo({ removed, name: role.name })
      window.requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>('.react-flow__node')?.focus())
    },
    [project.id, project.roles, confirm, updateRoles, selectRole]
  )

  const undoRemove = (): void => {
    if (!undo) return
    const { removed } = undo
    updateRoles(project.id, (roles) => restoreRole(roles, removed))
    selectRole(removed.role.id)
    setUndo(null)
  }

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
      // Keyboard activation (Enter/Space on a focused node) arrives as a select change.
      const picked = changes.find((c) => c.type === 'select' && c.selected)
      if (picked && picked.type === 'select') {
        setSelectedEdgeId(null)
        selectRole(picked.id)
      }
    },
    [project.id, updateRoles, selectRole]
  )

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const c of changes) {
      if (c.type === 'select') setSelectedEdgeId((cur) => (c.selected ? c.id : cur === c.id ? null : cur))
    }
  }, [])

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return
      const source = c.source
      const target = c.target
      updateRoles(project.id, (roles) => (wouldCycle(roles, target, source) ? roles : setReportsTo(roles, target, source)))
    },
    [project.id, updateRoles]
  )

  // Deletion is handled here (confirm, re-parenting, undo); React Flow never removes elements itself.
  const onBeforeDelete = useCallback(
    async ({ nodes: dn, edges: de }: { nodes: { id: string }[]; edges: { id: string; target: string }[] }): Promise<boolean> => {
      // A selected edge wins over the node that is still selected beside it.
      const edge = selectedEdgeId ? de.find((e) => e.id === selectedEdgeId) : undefined
      if (edge) reparentToRoot(edge.target)
      else if (dn.length > 0) void requestRemove(dn[0].id)
      else if (de.length > 0) reparentToRoot(de[0].target)
      return false
    },
    [requestRemove, reparentToRoot, selectedEdgeId]
  )

  const onNodeClick: NodeMouseHandler<RoleFlowNode> = useCallback(
    (_e, node) => {
      setSelectedEdgeId(null)
      setPanelOpen(true)
      selectRole(node.id)
    },
    [selectRole]
  )

  const onRootKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>): void => {
    const el = e.target as HTMLElement
    if ((e.key === 'Enter' || e.key === ' ') && el.classList.contains('react-flow__node')) {
      focusWanted.current = true
      setPanelOpen(true)
      setFocusTick((t) => t + 1)
    }
  }

  const returnToNode = useCallback((roleId: string) => {
    rootRef.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(roleId)}"]`)?.focus()
  }, [])

  const addRole = (): void => {
    const manager = addParent
    const name = nextRoleName(project.roles)
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
    setNotice(manager && !manager.canSpawn ? { roleId: role.id, text: `${manager.name} can now create subagents, because ${name} reports to it.` } : null)
    setUndo(null)
    setSelectedEdgeId(null)
    focusWanted.current = true
    setPanelOpen(true)
    setFocusTick((t) => t + 1)
    selectRole(role.id)
  }

  const autoLayout = (): void => {
    const pos = treeLayout(
      project.roles.map((r) => ({ id: r.id, parentId: r.reportsTo, width: 220, height: 96 })),
      { nodesep: 60, ranksep: 110 }
    )
    updateRoles(project.id, (roles) => roles.map((r) => ({ ...r, position: pos[r.id] ?? r.position })))
  }

  return (
    <div className="editor" ref={rootRef} onKeyDownCapture={onRootKeyDownCapture}>
      <CanvasFrame frameRef={frameRef}>
        <FrameToolbar label="Org chart actions">
          <Button size="sm" icon={Plus} onClick={addRole}>
            Add role
          </Button>
          <Button size="sm" icon={LayoutGrid} onClick={autoLayout}>
            Auto-layout
          </Button>
          <span className="toolbar-note">{addParent ? `New roles report to ${addParent.name}.` : 'The first role becomes the root.'}</span>
          {undo && (
            <span className="toolbar-undo" role="status">
              Role removed.
              <Button size="sm" variant="ghost" icon={Undo2} onClick={undoRemove}>
                Undo
              </Button>
            </span>
          )}
        </FrameToolbar>
        <FrameStage>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={() => {
              selectRole(null)
              setSelectedEdgeId(null)
            }}
            onBeforeDelete={onBeforeDelete}
            onInit={(inst) => {
              flowRef.current = inst
            }}
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={['Delete', 'Backspace']}
            elementsSelectable
            edgesFocusable
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color={patternColor} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </FrameStage>
        <FrameFooter>
          <span>Drag from a node's bottom handle to another node to make it a report. With a node focused, Enter edits it and Delete removes it.</span>
        </FrameFooter>
      </CanvasFrame>
      <SidePanel label={selectedRole ? 'role inspector' : 'AI draft panel'} open={panelOpen} onOpenChange={setPanelOpen}>
        {selectedRole ? (
          <RoleInspector
            project={project}
            role={selectedRole}
            notice={notice && notice.roleId === selectedRole.id ? notice.text : null}
            onNotice={(text) => setNotice(text ? { roleId: selectedRole.id, text } : null)}
            onRemove={() => void requestRemove(selectedRole.id)}
            onEscape={() => returnToNode(selectedRole.id)}
          />
        ) : (
          <DraftPanel project={project} />
        )}
      </SidePanel>
      {dialog}
    </div>
  )
}
