import type { KeyboardEvent, MouseEvent, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Download, LayoutGrid, LayoutTemplate, MousePointerClick, Pencil, Plus, Trash2, Undo2, UserPlus } from 'lucide-react'
import {
  ReactFlow,
  Controls,
  MarkerType,
  type Connection,
  type OnConnectEnd,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type NodeMouseHandler
} from '@xyflow/react'
import type { AgentImportScan, CanvasLayout, CanvasNodeStyle, Project, Role } from '@shared/types'
import { ROLE_COLORS, modelForTier, newId, projectConnection, slugify } from '@shared/defaults'
import { useAppStore } from '../store/useAppStore'
import { CanvasFrame, FrameFooter, FrameStage, FrameToolbar, FrameTray } from '../components/layout/CanvasFrame'
import { SidePanel } from '../components/layout/SidePanel'
import { Banner } from '../components/ui/Banner'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { Icon } from '../components/ui/Icon'
import { Popover } from '../components/ui/Popover'
import SaveTemplateDialog from '../components/templates/SaveTemplateDialog'
import ApplyTemplateDialog from '../components/templates/ApplyTemplateDialog'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../lib/settingsTarget'
import { Tabs, panelDomId, tabDomId } from '../components/ui/Tabs'
import TeamAssistantTray, { type TeamAssistantMode } from '../components/team/TeamAssistantTray'
import TeamCatalog from '../components/team/TeamCatalog'
import { capabilityCounts, capabilityLabel } from '../lib/teamView'
import ImportAgentsDialog from '../components/import/ImportAgentsDialog'
import { importBannerVisible, notImportedLine, readBannerMemory, writeBannerMemory, type BannerMemory } from '../lib/agentImport'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { ContextMenu, useContextMenu, type MenuEntry } from '../components/ui/ContextMenu'
import { RoleNode, type RoleFlowNode } from '../components/RoleNode'
import RoleInspector from '../components/RoleInspector'
import { layoutCanvas } from '../lib/layout'
import { CanvasBackdrop } from '../components/canvas/CanvasBackdrop'
import { CanvasMinimap } from '../components/canvas/CanvasMinimap'
import { OfficeScene } from '../components/canvas/office/OfficeScene'
import { withOfficeDepartments } from '../lib/office/departments'
import { CanvasStyleButton } from '../components/canvas/CanvasStyleButton'
import { CANVAS_EDGE_TYPES } from '../components/canvas/RadialEdge'
import { EDGE_TYPE, HEX_GAP, HEX_TILE, beginCanvasGlide, edgeStroke, fitMs, refitMs, reportingLineRole, ringStepFor, stationGeometry, useCanvasOptions, useNodeArrival, useNodeDims, useReducedMotion } from '../lib/canvas'
import { isLayoutMoving, onLayoutSettled } from '../lib/layoutMotion'
import { STATION_CORNER_RADIUS, STATION_LINE_WIDTH } from '../lib/canvasShapes'

/** Role node box per node style for layout and fit (section 4): cards 220 wide, name tags 160 x 40. */
const ROLE_NODE_SIZE = { card: { width: 220, height: 96 }, compact: { width: 160, height: 40 } } as const

/** Role node box per node style: stations follow the layout (stationGeometry), hex is the tile. */
function roleNodeSize(style: CanvasNodeStyle, layout: CanvasLayout): { width: number; height: number } {
  if (style === 'station') {
    const g = stationGeometry(layout)
    return { width: g.width, height: g.height }
  }
  if (style === 'hex') return { width: HEX_TILE.width, height: HEX_TILE.height }
  return ROLE_NODE_SIZE[style === 'compact' ? 'compact' : 'card']
}
import { addRoleUnder, moveNotice, nextRoleName, removeRole, restoreRole, setReportsTo, spawnNotice, wouldCycle, type RemovedRole } from '../lib/roleOps'
import { placeNewRole, revealShift, type StageRect } from '../lib/rolePlacement'
import TeamFilesLine from '../components/team/TeamFilesLine'
import TeamFilesCard from '../components/team/TeamFilesCard'
import TeamFilesAppliedNotice from '../components/team/TeamFilesAppliedNotice'
import { useTeamFilesActions } from '../components/team/useTeamFilesActions'
import { approveBlockedReason, cardVisible, importSourcesFor } from '../lib/teamFiles'
import { useCssVar } from '../lib/useCssVar'
import { LiveChangeNote } from '../components/LiveChangeNote'

const nodeTypes = { role: RoleNode }

type PanelTab = 'role' | 'catalog'
const PANEL_TABS = [
  { id: 'role', label: 'Role', testId: 'team-panel-tab-role' },
  { id: 'catalog', label: 'Catalog', testId: 'team-panel-tab-catalog' }
]

/** How long the "Role removed. Undo" row stays in the toolbar. */
const UNDO_MS = 12_000
/** How long the reason for a refused reporting line stays in the toolbar. */
const DROP_NOTE_MS = 8_000
/** Room kept between a new role and the stage edges when the chart pans to it (the controls and minimap are cleared separately, revealShift). */
const REVEAL_MARGIN = { top: 24, right: 24, bottom: 24, left: 24 }

/** The current roles of a project from the store (the render's `project` can lag a just-made change). */
function storedRoles(projectId: string, fallback: Role[]): Role[] {
  return useAppStore.getState().projects.find((p) => p.id === projectId)?.roles ?? fallback
}

/** The node under a pointer event's end position, for naming the role a refused drop landed on. */
function nodeIdAt(event: globalThis.MouseEvent | TouchEvent): string | undefined {
  const point = 'changedTouches' in event ? event.changedTouches[0] : event
  if (!point) return undefined
  return document.elementFromPoint(point.clientX, point.clientY)?.closest<HTMLElement>('.react-flow__node')?.dataset.id
}

/** Arrow keys, Home and End move between the Templates menu's items (a disabled item stays reachable to read its reason). */
function onTemplateMenuKey(e: KeyboardEvent<HTMLDivElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitem]'))
  if (items.length === 0) return
  e.preventDefault()
  const at = items.indexOf(document.activeElement as HTMLButtonElement)
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
  items[next]?.focus()
}

export default function TeamView({ project }: { project: Project }): ReactElement {
  // Re-fit when the frame changes size (window, sidebar or side panel resize), as the live view does.
  const frameRef = useRef<HTMLDivElement>(null)
  const flowRef = useRef<{
    fitView: (o?: { padding?: number; maxZoom?: number; duration?: number }) => unknown
    getViewport: () => { x: number; y: number; zoom: number }
    setViewport: (v: { x: number; y: number; zoom: number }, o?: { duration?: number }) => unknown
  } | null>(null)
  useEffect(() => {
    const el = frameRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    let t: ReturnType<typeof setTimeout> | undefined
    let first = true
    let pending = false
    const ro = new ResizeObserver(() => {
      if (first) {
        first = false
        return
      }
      clearTimeout(t)
      t = setTimeout(() => {
        // The sidebar or side panel is gliding: one refit when it settles, never per frame.
        if (isLayoutMoving()) {
          pending = true
          return
        }
        void flowRef.current?.fitView({ padding: 0.3, maxZoom: 1, duration: refitMs() })
      }, 100)
    })
    const unsettled = onLayoutSettled(() => {
      if (!pending) return
      pending = false
      void flowRef.current?.fitView({ padding: 0.3, maxZoom: 1, duration: refitMs() })
    })
    ro.observe(el)
    return () => {
      clearTimeout(t)
      unsettled()
      ro.disconnect()
    }
  }, [])
  // The tray opening, closing or changing phase resizes the stage without resizing the frame: refit when the stage
  // height moves by more than 24 px, so a user's own pan and zoom survive small layout shifts.
  useEffect(() => {
    const stage = frameRef.current?.querySelector<HTMLElement>('.frame-stage')
    if (!stage || typeof ResizeObserver === 'undefined') return undefined
    let t: ReturnType<typeof setTimeout> | undefined
    let last = -1
    let pendingOff: (() => void) | undefined
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height ?? stage.clientHeight
      if (last < 0) {
        last = h
        return
      }
      if (Math.abs(h - last) <= 24) return
      clearTimeout(t)
      t = setTimeout(() => {
        last = stage.clientHeight
        if (isLayoutMoving()) {
          // The tray is gliding: wait for it to settle, then fit once.
          // One pending listener at most; the effect cleanup removes it.
          if (pendingOff) return
          pendingOff = onLayoutSettled(() => {
            pendingOff?.()
            pendingOff = undefined
            void flowRef.current?.fitView({ padding: 0.3, maxZoom: 1, duration: refitMs() })
          })
          return
        }
        void flowRef.current?.fitView({ padding: 0.3, maxZoom: 1, duration: refitMs() })
      }, 150)
    })
    ro.observe(stage)
    return () => {
      clearTimeout(t)
      pendingOff?.()
      ro.disconnect()
    }
  }, [])
  const selectedRoleId = useAppStore((s) => s.selectedRoleId)
  const selectRole = useAppStore((s) => s.selectRole)
  const updateRoles = useAppStore((s) => s.updateRoles)
  const connectionInfos = useAppStore((s) => s.connections)
  const modelCatalogs = useAppStore((s) => s.models)
  const { confirm, dialog } = useConfirm()
  const faintColor = useCssVar('--text-tertiary')
  const labelBg = useCssVar('--surface-1')
  const groupEdgeColor = useCssVar('--canvas-edge-group')
  const edgeMix = useCssVar('--canvas-edge-role-mix')
  const edgeInk = useCssVar('--canvas-edge-ink')
  const options = useCanvasOptions()
  useEffect(() => {
    if (options.presentation === 'pocket-office') flowRef.current = null
  }, [options.presentation])
  const reducedMotion = useReducedMotion()
  const nodeDims = useNodeDims()
  const radial = options.layout === 'radial'
  const edgeType = radial ? 'radial' : EDGE_TYPE[options.edges]
  const roleSize = useMemo(() => roleNodeSize(options.nodeStyle, options.layout), [options.nodeStyle, options.layout])
  const station = options.nodeStyle === 'station'
  const roundedCorners = useMemo(() => (station && options.edges === 'orthogonal' && !radial ? { pathOptions: { borderRadius: STATION_CORNER_RADIUS } } : {}), [station, options.edges, radial])

  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ roleId: string; text: string } | null>(null)
  const [undo, setUndo] = useState<{ removed: RemovedRole; name: string; note: string | null } | null>(null)
  // Why a dragged reporting line was refused (a cycle, the root): a polite status in the toolbar for a few seconds.
  const [dropNote, setDropNote] = useState<string | null>(null)
  // A role rename's cleanup that failed after the user switched role: shown here, whatever is selected (review L).
  const [renameNote, setRenameNote] = useState<string | null>(null)
  useEffect(() => {
    if (!dropNote) return undefined
    const t = window.setTimeout(() => setDropNote(null), DROP_NOTE_MS)
    return () => window.clearTimeout(t)
  }, [dropNote])
  const [focusTick, setFocusTick] = useState(0)
  const [panelOpen, setPanelOpen] = useState(true)
  // Role | Catalog. A role gets selected -> Role; the user's explicit choice sticks until the selection goes from nothing to something.
  const [panelTab, setPanelTab] = useState<PanelTab>(() => (useAppStore.getState().selectedRoleId ? 'role' : 'catalog'))
  const [assistant, setAssistant] = useState<TeamAssistantMode>('recommend')
  const hadSelection = useRef(!!selectedRoleId)
  useEffect(() => {
    if (selectedRoleId && !hadSelection.current) setPanelTab('role')
    hadSelection.current = !!selectedRoleId
  }, [selectedRoleId])
  // A deep link to a connection (openProjectMcp) opens the Catalog tab; the connections section then scrolls to and focuses its row.
  const mcpFocus = useAppStore((s) => s.mcpFocus)
  useEffect(() => {
    if (mcpFocus?.kind !== 'server' || mcpFocus.projectId !== project.id) return
    setPanelTab('catalog')
    setPanelOpen(true)
  }, [mcpFocus, project.id])
  const [importDialog, setImportDialog] = useState<{ fresh: boolean } | null>(null)
  const [scan, setScan] = useState<AgentImportScan | null>(null)
  const [memory, setMemory] = useState<BannerMemory | null>(() => readBannerMemory(window.localStorage, project.id))
  // Team files (spec docs/design/team-files.md): the status line, the approval card and the applied-at-once notice.
  const filesStatus = useAppStore((s) => s.teamFilesByProject[project.id])
  const filesActions = useTeamFilesActions(project.id)
  const filesFocus = useAppStore((s) => s.teamFilesFocus)
  const [cardFocusN, setCardFocusN] = useState(0)
  const [assistantShown, setAssistantShown] = useState(false)
  const lineRef = useRef<HTMLDivElement>(null)
  const filesOn = !!filesStatus && filesStatus.state !== 'off'
  const showCard = cardVisible(filesStatus)
  const importRequest = useAppStore((s) => s.importRequest)
  const importNotice = useAppStore((s) => s.importNotices[project.id])
  const dismissImportNotice = useAppStore((s) => s.dismissImportNotice)
  const undoImport = useAppStore((s) => s.undoImport)
  const focusWanted = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const templates = useAppStore((s) => s.templates)
  const [templateDialog, setTemplateDialog] = useState<'save' | 'apply' | null>(null)
  const [savedTemplate, setSavedTemplate] = useState<string | null>(null)
  useEffect(() => {
    void useAppStore.getState().loadTemplates()
  }, [])
  // The chart notice is shared: an agent import (default) or a team template, whichever is newer.
  const templateNotice = importNotice?.source === 'template' ? importNotice : undefined
  const importOnly = importNotice?.source === 'template' ? undefined : importNotice
  const focusTemplatesButton = (): void => {
    window.requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>('[data-testid=team-templates]')?.focus())
  }
  const closeTemplateDialog = (): void => {
    setTemplateDialog(null)
    focusTemplatesButton()
  }

  // The files may have changed since the last push (a checkout, an edit): ask when the tab opens for this project.
  useEffect(() => {
    void useAppStore.getState().refreshTeamFiles(project.id)
  }, [project.id])
  // A request from the Needs-you list lands focus on the approval card once the status is known.
  useEffect(() => {
    if (!filesFocus || filesFocus.projectId !== project.id || !filesStatus) return
    if (showCard) setCardFocusN(filesFocus.n)
    else window.requestAnimationFrame(() => lineRef.current?.focus())
    useAppStore.getState().clearTeamFilesFocus()
  }, [filesFocus, filesStatus, project.id, showCard])
  useEffect(() => {
    if (!showCard) setAssistantShown(false)
  }, [showCard])
  // The agent files the chart has not taken in. `.orgai` agents are the team files' own while those are on.
  const foundSources = useMemo(() => importSourcesFor(scan?.sources ?? [], filesOn), [scan, filesOn])

  const decide = async (kind: 'approve' | 'reject'): Promise<void> => {
    const digest = filesStatus?.digest
    if (!digest) return
    if (kind === 'approve' && filesStatus && approveBlockedReason(filesStatus)) return
    const ok = await (kind === 'approve' ? filesActions.approve(digest) : filesActions.reject(digest))
    // The card is gone after a decision, so focus goes to the status line; a refusal keeps focus on the card's own
    // buttons unless the re-fetch removed the card too (a stale digest).
    if (ok) window.requestAnimationFrame(() => lineRef.current?.focus())
    else settleFocus()
  }
  /** Focus to the status line when the element that had it was removed (focus fell to the body). */
  const settleFocus = (): void => {
    window.requestAnimationFrame(() => {
      const a = document.activeElement
      if (!a || a === document.body) lineRef.current?.focus()
    })
  }

  const root = project.roles.find((r) => r.reportsTo === null)
  const selectedRole = project.roles.find((r) => r.id === selectedRoleId)

  // Agent files in the folder that the chart has not taken in: re-read when the project or its import state changes.
  useEffect(() => {
    let live = true
    setMemory(readBannerMemory(window.localStorage, project.id))
    window.orgai.projects
      .scanAgents(project.path)
      .then((r) => live && setScan(r))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [project.id, project.path, importDialog])

  // After the dialog closes, keep focus on the page's own controls even when its opener (the New project form) is gone.
  const closeImport = (): void => {
    setImportDialog(null)
    window.requestAnimationFrame(() => {
      const a = document.activeElement
      if (!a || a === document.body) rootRef.current?.querySelector<HTMLElement>('[data-testid=import-agents]')?.focus()
    })
  }

  // Show the whole chart after an import or an Undo.
  const importState = importNotice?.state
  useEffect(() => {
    if (importState !== 'available' && importState !== 'reverted') return undefined
    const t = window.setTimeout(() => {
      void flowRef.current?.fitView({ padding: 0.3, maxZoom: 1, duration: refitMs() })
    }, 120)
    if (importState === 'reverted') {
      const button = importNotice?.source === 'template' ? 'team-templates' : 'import-agents'
      rootRef.current?.querySelector<HTMLElement>(`[data-testid=${button}]`)?.focus()
    }
    return () => window.clearTimeout(t)
  }, [importState])

  // The New project form asks for the review on a fresh chart.
  useEffect(() => {
    if (importRequest && importRequest.projectId === project.id) {
      setImportDialog({ fresh: importRequest.fresh })
      useAppStore.getState().requestImport(null)
    }
  }, [importRequest, project.id])

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

  // New roles pop in once (motion.md 3.12); the roles present when the editor opens never do.
  const roleIds = useMemo(() => project.roles.map((r) => r.id), [project.roles])
  const arrival = useNodeArrival(roleIds, project.id)
  const nodes: RoleFlowNode[] = useMemo(
    () =>
      project.roles.map((role) => {
        const capabilities = capabilityCounts(project, role)
        return {
          id: role.id,
          type: 'role',
          position: role.position,
          selected: role.id === selectedRoleId,
          deletable: role.reportsTo !== null,
          initialWidth: roleSize.width,
          initialHeight: roleSize.height,
          ...(nodeDims.dims[role.id] ? { measured: nodeDims.dims[role.id] } : {}),
          ariaLabel: `${role.name}, ${role.reportsTo === null ? 'root role' : 'role'}. ${capabilityLabel(capabilities)}. Press Enter to edit${role.reportsTo === null ? '' : ', Delete to remove'}.`,
          // "leads N" counts the direct reports this role may actually delegate to, not every report.
          data: { role, delegateCount: role.canSpawn ? project.roles.filter((r) => r.reportsTo === role.id && role.spawnable.includes(r.id)).length : 0, capabilities, ...(arrival.isNew(role.id) ? { arrived: true } : {}) }
        }
      }),
    [project, selectedRoleId, roleSize, nodeDims.dims, arrival.arrivedKey]
  )

  const edges: Edge[] = useMemo(
    () =>
      project.roles
        .filter((r) => r.reportsTo && project.roles.some((x) => x.id === r.reportsTo))
        .map((r) => {
          const parent = project.roles.find((x) => x.id === r.reportsTo)!
          const allowed = parent.canSpawn && parent.spawnable.includes(r.id)
          const id = `e-${parent.id}-${r.id}`
          const color = edgeStroke(reportingLineRole(options.nodeStyle, parent.color, r.color), edgeMix, edgeInk)
          const subway = station && allowed
          return {
            id,
            source: parent.id,
            target: r.id,
            type: edgeType,
            ...(subway ? roundedCorners : {}),
            selected: id === selectedEdgeId,
            ariaLabel:
              parent.id === root?.id
                ? `${parent.name} manages ${r.name}.`
                : `${parent.name} manages ${r.name}. Press Delete to make ${r.name} report to ${root?.name ?? 'the root'} instead.`,
            style: subway
              ? { stroke: color, strokeWidth: STATION_LINE_WIDTH, strokeLinecap: 'round', strokeLinejoin: 'round' }
              : allowed
                ? { stroke: color, strokeWidth: 1.6 }
                : { stroke: groupEdgeColor, strokeWidth: 1.4, strokeDasharray: '4 4' },
            // The "cannot delegate" line has no arrow (section 5); subway lines have none either.
            markerEnd: allowed && !station ? { type: MarkerType.ArrowClosed, color } : undefined,
            label: allowed ? undefined : 'not delegable',
            labelStyle: { fill: faintColor, fontSize: 11 },
            labelBgStyle: { fill: labelBg }
          }
        }),
    [project.roles, selectedEdgeId, root, faintColor, labelBg, edgeType, edgeMix, edgeInk, groupEdgeColor, station, roundedCorners, options.nodeStyle]
  )

  const reparentToRoot = useCallback(
    (childId: string) => {
      if (!root) return
      const child = project.roles.find((r) => r.id === childId)
      if (!child || child.reportsTo === root.id) return
      const before = storedRoles(project.id, project.roles)
      const spawn = moveNotice(before, setReportsTo(before, childId, root.id), childId)
      updateRoles(project.id, (roles) => setReportsTo(roles, childId, root.id))
      setSelectedEdgeId(null)
      selectRole(childId)
      setNotice({ roleId: childId, text: spawn ? `Now reports to ${root.name}. ${spawn}` : `Now reports to ${root.name}.` })
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
      const current = storedRoles(project.id, project.roles)
      const { removed, roles: after } = removeRole(current, roleId)
      if (!removed) return
      // A manager left with nobody to delegate to loses its spawn right: say so beside Undo.
      const lost = spawnNotice(current, after, role.name)
      updateRoles(project.id, (roles) => removeRole(roles, roleId).roles)
      selectRole(null)
      setNotice(null)
      setUndo({ removed, name: role.name, note: lost })
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
      nodeDims.apply(changes as NodeChange[])
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
    [project.id, updateRoles, selectRole, nodeDims.apply]
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
      const before = storedRoles(project.id, project.roles)
      if (wouldCycle(before, target, source)) return
      // Review L1: a drop on the manager it already reports to changes nothing (setReportsTo would still strip the
      // role from every other role's delegation list).
      if (before.find((r) => r.id === target)?.reportsTo === source) {
        setDropNote(null)
        return
      }
      const after = setReportsTo(before, target, source)
      updateRoles(project.id, (roles) => (wouldCycle(roles, target, source) ? roles : setReportsTo(roles, target, source)))
      setDropNote(null)
      // The banner for the moved role: who no longer delegates to it, and a manager that gained or lost spawn rights.
      // A drag with no such change clears a stale one.
      const text = moveNotice(before, after, target)
      setNotice(text ? { roleId: target, text } : null)
    },
    [project.id, project.roles, updateRoles]
  )

  // A line may not close a loop or end on its own role (cycles are refused while dragging: the node under the pointer
  // shows the refusal, and onConnectEnd says why).
  const isValidConnection = useCallback(
    (c: { source: string; target: string }): boolean => c.source !== c.target && !wouldCycle(storedRoles(project.id, project.roles), c.target, c.source),
    [project.id, project.roles]
  )

  // A drag that ended on a role it cannot report to says why; the line itself is already gone (React Flow cancels it on release).
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, state) => {
      if (state.isValid) return
      const roles = storedRoles(project.id, project.roles)
      const from = state.fromNode?.id
      const to = state.toNode?.id ?? nodeIdAt(event)
      if (!from || !to || from === to) return
      const manager = roles.find((r) => r.id === from)
      const report = roles.find((r) => r.id === to)
      if (!manager || !report) return
      if (report.reportsTo === null) setDropNote(`${report.name} is the root and cannot report to anyone.`)
      else if (wouldCycle(roles, to, from)) setDropNote(`${report.name} cannot report to ${manager.name}: ${manager.name} already reports to ${report.name}.`)
    },
    [project.id, project.roles]
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
      setPanelTab('role')
      selectRole(node.id)
    },
    [selectRole]
  )

  const roleMenu = useContextMenu<string>()
  const roleMenuOpts = (roleId: string): { fallbackFocus: () => HTMLElement | null } => ({
    // After Remove the node is gone (and the Delete path moves focus to the first node): do the same.
    fallbackFocus: () => rootRef.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(roleId)}"]`) ?? rootRef.current?.querySelector<HTMLElement>('.react-flow__node') ?? null
  })
  const onNodeContextMenu: NodeMouseHandler<RoleFlowNode> = (e, node) => {
    // Never preventDefault here: the primitive decides (fields and selections keep the platform menu).
    roleMenu.onContextMenu(e as unknown as MouseEvent<HTMLElement>, node.id, roleMenuOpts(node.id))
  }
  const roleMenuItems = (roleId: string): MenuEntry[] => {
    const role = project.roles.find((r) => r.id === roleId)
    if (!role) return []
    const isRoot = role.reportsTo === null
    return [
      {
        id: 'edit',
        label: 'Edit role',
        icon: Pencil,
        testId: 'role-menu-edit',
        onSelect: () => {
          setSelectedEdgeId(null)
          focusWanted.current = true
          setPanelOpen(true)
          setPanelTab('role')
          setFocusTick((t) => t + 1)
          selectRole(roleId)
        }
      },
      { id: 'add-report', label: 'Add a report', icon: UserPlus, testId: 'role-menu-add-report', onSelect: () => addRole(role) },
      'separator',
      {
        id: 'remove',
        label: 'Remove role',
        icon: Trash2,
        destructive: true,
        disabled: isRoot,
        disabledReason: isRoot ? 'The root role cannot be removed.' : undefined,
        testId: 'role-menu-remove',
        onSelect: () => void requestRemove(roleId)
      }
    ]
  }

  const onRootKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>): void => {
    const el = e.target as HTMLElement
    if (el.classList.contains('react-flow__node') && el.dataset.id) {
      if (roleMenu.onKeyDown(e, el.dataset.id, { anchor: el, invoker: el, ...roleMenuOpts(el.dataset.id) })) return
    }
    if ((e.key === 'Enter' || e.key === ' ') && (el.classList.contains('react-flow__node') || el.hasAttribute('data-office-agent-id') || el.hasAttribute('data-office-worker-id'))) {
      focusWanted.current = true
      setPanelOpen(true)
      setPanelTab('role')
      setFocusTick((t) => t + 1)
    }
  }

  const returnToNode = useCallback((roleId: string) => {
    const target = rootRef.current?.querySelector<HTMLElement>(`[data-office-worker-id="${CSS.escape(roleId)}"], .react-flow__node[data-id="${CSS.escape(roleId)}"]`)
    if (target) { target.focus(); return }
    const directoryTarget = rootRef.current?.querySelector<HTMLElement>(`[data-office-agent-id="${CSS.escape(roleId)}"]`)
    const directory = directoryTarget?.closest('details')
    if (directory) directory.open = true
    directoryTarget?.focus()
  }, [])

  /** Pan (never zoom) so a role at `pos` is fully inside the stage, clear of the zoom controls and minimap. */
  const revealRole = (roleId: string, pos: { x: number; y: number }, size: { width: number; height: number }): void => {
    window.setTimeout(() => {
      const flow = flowRef.current
      const stage = frameRef.current?.querySelector<HTMLElement>('.frame-stage')
      if (!flow || !stage) return
      const vp = flow.getViewport()
      const view = stage.getBoundingClientRect()
      const inStage = (el: Element | null): StageRect | null => {
        if (!el) return null
        const b = el.getBoundingClientRect()
        return b.width > 0 && b.height > 0 ? { x: b.left - view.left, y: b.top - view.top, w: b.width, h: b.height } : null
      }
      // The rendered box when the node is already drawn (graph styles differ in size), else the computed one.
      const node =
        inStage(stage.querySelector(`.react-flow__node[data-id="${CSS.escape(roleId)}"]`)) ??
        { x: pos.x * vp.zoom + vp.x, y: pos.y * vp.zoom + vp.y, w: size.width * vp.zoom, h: size.height * vp.zoom }
      // QA S1: the zoom controls and the minimap float over the stage's bottom corners; the new node must clear both.
      const obstacles = [stage.querySelector('.react-flow__controls'), stage.querySelector('.react-flow__minimap')]
        .map(inStage)
        .filter((r): r is StageRect => r !== null)
      const { dx, dy } = revealShift(node, { w: view.width, h: view.height }, REVEAL_MARGIN, obstacles)
      if (dx !== 0 || dy !== 0) void flow.setViewport({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom }, { duration: fitMs(reducedMotion) })
    }, 60)
  }

  /** Add a role under `managerOverride` (the context menu and the inspector) or, with none, under the root: never under the selection. */
  const addRole = (managerOverride?: Role): void => {
    const current = storedRoles(project.id, project.roles)
    const manager = managerOverride ? (current.find((r) => r.id === managerOverride.id) ?? root) : current.find((r) => r.reportsTo === null)
    const name = nextRoleName(current)
    const conn = projectConnection(project)
    const everyday = modelForTier('everyday', {
      connection: conn,
      tierModels: connectionInfos?.find((c) => c.connection.id === conn)?.connection.tierModels ?? {},
      catalog: modelCatalogs[conn]
    })
    const position = placeNewRole(current, manager?.id ?? null, roleSize, { layout: options.layout, sizeOf: (id) => nodeDims.dims[id] })
    const role: Role = {
      id: newId('role'),
      slug: slugify(name),
      name,
      description: 'Describe when a manager should delegate to this role.',
      responsibilities: [],
      prompt: 'You are a specialist. Complete the assigned task and report back concisely.',
      tools: ['Read', 'Glob', 'Grep'],
      model: everyday?.model ?? 'inherit',
      tier: everyday ? everyday.tier : undefined,
      canSpawn: false,
      spawnable: [],
      reportsTo: manager?.id ?? null,
      position,
      color: ROLE_COLORS[current.length % ROLE_COLORS.length]
    }
    const text = spawnNotice(current, addRoleUnder(current, role), name)
    updateRoles(project.id, (roles) => addRoleUnder(roles, role))
    setNotice(text ? { roleId: role.id, text } : null)
    setDropNote(null)
    setUndo(null)
    setSelectedEdgeId(null)
    focusWanted.current = true
    setPanelOpen(true)
    setPanelTab('role')
    setFocusTick((t) => t + 1)
    selectRole(role.id)
    if (options.presentation !== 'pocket-office') revealRole(role.id, position, roleSize)
  }

  // The assistant lives in the tray under the chart, so the role inspector stays in the side panel. "Ask the Team
  // assistant" from a role opens Recommend (scoped to that role) and focuses its primary button.
  const openAssistant = (): void => {
    setAssistant('recommend')
    window.requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>('[data-testid=team-recommend]')?.focus())
  }

  const autoLayout = (): void => {
    const { positions: pos } = layoutCanvas(
      options.layout,
      project.roles.map((r) => ({ id: r.id, parentId: r.reportsTo, width: roleSize.width, height: roleSize.height })),
      { nodesep: 60, ranksep: 110, ringStep: ringStepFor(options.nodeStyle), ...(options.nodeStyle === 'hex' ? { honeycomb: { width: HEX_TILE.width, height: HEX_TILE.height, gap: HEX_GAP } } : {}) }
    )
    // The nodes glide to their new places (up to 60 of them), then one fit.
    const glide = beginCanvasGlide(frameRef.current, project.roles.length)
    updateRoles(project.id, (roles) => roles.map((r) => ({ ...r, position: pos[r.id] ?? r.position })))
    window.setTimeout(() => {
      void flowRef.current?.fitView({ padding: radial ? 0.12 : 0.3, maxZoom: 1, duration: fitMs(reducedMotion) })
    }, glide > 0 ? glide + 10 : 80)
  }

  return (
    <div className="editor" ref={rootRef} onKeyDownCapture={onRootKeyDownCapture}>
      <a
        href="#team-panel"
        className="skip-link"
        data-testid="skip-to-role-panel"
        onClick={(e) => {
          e.preventDefault()
          setPanelOpen(true)
          window.requestAnimationFrame(() => {
            const tab = rootRef.current?.querySelector<HTMLElement>('.team-panel-tabs [role=tab][aria-selected=true]')
            // Railed or collapsed (no room at this width): the tabs are hidden, so land on the panel itself.
            if (tab && tab.getClientRects().length > 0) {
              tab.focus()
              return
            }
            const panel = rootRef.current?.querySelector<HTMLElement>('aside.side-panel')
            if (!panel) return
            panel.tabIndex = -1
            panel.focus()
          })
        }}
      >
        Skip to role panel
      </a>
      <CanvasFrame frameRef={frameRef}>
        <div className="frame-top">
          <FrameToolbar label="Team actions">
            <Button size="sm" icon={Plus} onClick={() => addRole()}>
              Add role
            </Button>
            <Button size="sm" icon={Download} onClick={() => setImportDialog({ fresh: false })} testId="import-agents">
              Import from other tools
            </Button>
            <Popover
              label="Templates"
              role="menu"
              placement="bottom-start"
              triggerClassName="btn sm"
              triggerTestId="team-templates"
              testId="team-templates-menu"
              trigger={
                <>
                  <span className="team-templates-icon" aria-hidden="true">
                    <Icon icon={LayoutTemplate} size="sm" />
                  </span>
                  Templates
                  <span className="team-templates-icon" aria-hidden="true">
                    <Icon icon={ChevronDown} size="sm" />
                  </span>
                </>
              }
            >
              {({ close }) => (
                <div className="team-menu" role="presentation" onKeyDown={onTemplateMenuKey}>
                  <button
                    type="button"
                    role="menuitem"
                    className="team-menu-item"
                    data-testid="team-template-save"
                    onClick={() => {
                      close()
                      setTemplateDialog('save')
                    }}
                  >
                    Save this team as a template...
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="team-menu-item"
                    data-testid="team-template-apply"
                    aria-disabled={!templates || templates.length === 0 ? 'true' : undefined}
                    aria-describedby={!templates || templates.length === 0 ? 'team-template-apply-reason' : undefined}
                    onClick={() => {
                      if (!templates || templates.length === 0) return
                      close()
                      setTemplateDialog('apply')
                    }}
                  >
                    Replace the team with a template...
                    {(!templates || templates.length === 0) && (
                      <span id="team-template-apply-reason" className="team-menu-reason">
                        No templates yet
                      </span>
                    )}
                  </button>
                </div>
              )}
            </Popover>
            {options.presentation !== 'pocket-office' && <Button size="sm" icon={LayoutGrid} onClick={autoLayout}>
              Auto-layout
            </Button>}
            {/* Beside Auto-layout, in the button row: on the wrapped row with the note a 28 px button grew the toolbar
                at 1024x640 and took that height from the Team assistant tray. */}
            <CanvasStyleButton testId="canvas-style-button" />
            <TeamFilesLine
              status={filesStatus}
              busy={filesActions.busy}
              message={filesActions.message}
              lineRef={lineRef}
              onCommit={() => void filesActions.commit().then(settleFocus)}
              onEnable={() => void filesActions.enable().then(settleFocus)}
              onReview={() => setCardFocusN((n) => n + 1)}
            >
              {filesStatus && <TeamFilesAppliedNotice status={filesStatus} busy={filesActions.busy} onUndo={() => void filesActions.undo().then(settleFocus)} />}
            </TeamFilesLine>
            {dropNote && (
              <span className="toolbar-status" role="status" data-testid="team-drop-note">
                {dropNote}
              </span>
            )}
            {undo && (
              <span className="toolbar-undo" role="status" data-testid="team-undo-row">
                Role removed.{undo.note ? ` ${undo.note}` : ''}
                <Button size="sm" variant="ghost" icon={Undo2} onClick={undoRemove}>
                  Undo
                </Button>
              </span>
            )}
          </FrameToolbar>
        <div className="import-notices">
          {renameNote && (
            <Banner tone="warning" testId="team-rename-note" onDismiss={() => setRenameNote(null)}>
              {renameNote}
            </Banner>
          )}
          {savedTemplate && (
            <Banner
              tone="success"
              title={`Saved the template ${savedTemplate}.`}
              testId="template-saved-notice"
              onDismiss={() => {
                setSavedTemplate(null)
                focusTemplatesButton()
              }}
              actions={
                <Button
                  size="sm"
                  onClick={() => {
                    requestAppSettingsSection(APP_SETTINGS_SECTIONS.templates)
                    useAppStore.getState().setView('appSettings')
                  }}
                >
                  Manage templates
                </Button>
              }
            />
          )}
          {templateNotice && templateNotice.state !== 'reverted' && (
            <Banner
              tone={templateNotice.state === 'error' ? 'danger' : templateNotice.state === 'expired' ? 'info' : 'success'}
              title={templateNotice.summary}
              label={templateNotice.state === 'error' ? undefined : 'Team template'}
              testId="template-notice"
              onDismiss={() => dismissImportNotice(project.id)}
              actions={
                templateNotice.state === 'expired' ? undefined : (
                  <Button size="sm" loading={templateNotice.state === 'busy'} onClick={() => void undoImport(project.id)} testId="template-undo">
                    {templateNotice.state === 'error' ? 'Retry undo' : 'Undo'}
                  </Button>
                )
              }
            >
              {templateNotice.state === 'error'
                ? templateNotice.error
                : templateNotice.state === 'expired'
                  ? 'Undo ended because you edited the chart.'
                  : 'You can undo until you edit the chart.'}
            </Banner>
          )}
          {templateNotice?.state === 'reverted' && (
            <Banner
              tone="info"
              title="Undo done. The previous team is back."
              label="Team template"
              testId="template-undone"
              onDismiss={() => dismissImportNotice(project.id)}
            />
          )}
          {importOnly && importOnly.state !== 'reverted' && (
            <Banner
              tone={importOnly.state === 'error' ? 'danger' : importOnly.state === 'expired' ? 'info' : 'success'}
              title={importOnly.summary}
              // A labelled region would replace the alert role an error needs.
              label={importOnly.state === 'error' ? undefined : 'Agent import'}
              testId="import-notice"
              onDismiss={() => dismissImportNotice(project.id)}
              actions={
                importOnly.state === 'expired' ? undefined : (
                  <Button size="sm" loading={importOnly.state === 'busy'} onClick={() => void undoImport(project.id)} testId="import-undo">
                    {importOnly.state === 'error' ? 'Retry undo' : 'Undo'}
                  </Button>
                )
              }
            >
              {importOnly.state === 'error'
                ? importOnly.error
                : importOnly.state === 'expired'
                  ? 'Undo ended because you edited the chart.'
                  : 'You can undo until you edit the chart.'}
            </Banner>
          )}
          {importOnly?.state === 'reverted' && (
            <Banner
              tone="info"
              title="Import undone. The previous chart is back."
              label="Agent import"
              testId="import-undone"
              onDismiss={() => dismissImportNotice(project.id)}
              actions={
                <Button size="sm" onClick={() => setImportDialog({ fresh: false })}>
                  Review import
                </Button>
              }
            />
          )}
          {!importNotice && scan && importBannerVisible(foundSources.reduce((n, x) => n + x.agentCount, 0), memory) && (
            <Banner
              tone="info"
              label="Agents found"
              testId="import-found"
              title={notImportedLine(foundSources.reduce((n, x) => n + x.agentCount, 0), foundSources)}
              onDismiss={() => {
                writeBannerMemory(window.localStorage, project.id, 'dismissed')
                setMemory('dismissed')
              }}
              actions={
                <Button size="sm" variant="primary" onClick={() => setImportDialog({ fresh: false })}>
                  Review import
                </Button>
              }
            />
          )}
        </div>
        </div>
        <FrameStage>
          {options.presentation === 'pocket-office' ? (
            <OfficeScene mode="team" palette={options.scenePalette} agents={withOfficeDepartments(project.roles.map((role) => ({ id: role.id, name: role.name, parentId: role.reportsTo, status: 'Role' })))} messages={[]} selectedId={selectedRoleId ?? undefined} onSelect={(id) => { setSelectedEdgeId(null); selectRole(id); setPanelOpen(true); setPanelTab('role') }} onRemove={(id) => void requestRemove(id)} />
          ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={CANVAS_EDGE_TYPES}
            data-layout={options.layout}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectStart={() => setDropNote(null)}
            onConnectEnd={onConnectEnd}
            isValidConnection={isValidConnection}
            onNodeClick={onNodeClick}
            onNodeContextMenu={onNodeContextMenu}
            onPaneClick={() => {
              selectRole(null)
              setSelectedEdgeId(null)
              // QA P6: the reason for a refused drop goes with the next drag or a click on the chart.
              setDropNote(null)
            }}
            onBeforeDelete={onBeforeDelete}
            onInit={(inst) => {
              flowRef.current = inst
            }}
            aria-label="Org chart"
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={['Delete', 'Backspace']}
            elementsSelectable
            edgesFocusable={false}
          >
            <CanvasBackdrop />
            <Controls showInteractive={false} position="bottom-right" />
            <CanvasMinimap ariaLabel="Org chart minimap" />
          </ReactFlow>
          )}
          <LiveChangeNote surface="orgChart" projectId={project.id} />
        </FrameStage>
        <FrameTray label={showCard ? 'Team files approval' : 'Team assistant'}>
          {showCard && filesStatus && (
            <TeamFilesCard
              status={filesStatus}
              busy={filesActions.busy}
              error={filesActions.error}
              focusSignal={cardFocusN}
              assistantOpen={assistantShown}
              onToggleAssistant={() => setAssistantShown((v) => !v)}
              onApprove={() => void decide('approve')}
              onReject={() => void decide('reject')}
            />
          )}
          {/* Mounted while the card is open (a search keeps running); shown under the card only when asked for. */}
          <div className="team-assistant-slot" hidden={showCard && !assistantShown}>
            <TeamAssistantTray
              project={project}
              scope={selectedRole ? { kind: 'role', roleId: selectedRole.id } : { kind: 'team' }}
              mode={assistant}
              onModeChange={setAssistant}
            />
          </div>
        </FrameTray>
        <FrameFooter>
          <span>
            {options.presentation === 'pocket-office' ? 'Select a role to edit it. With a role focused, Enter edits it and Delete removes it.' : <>{options.layout === 'left-right' ? "Drag from a node's right handle" : options.layout === 'radial' ? "Point at a node and drag from its handle" : "Drag from a node's bottom handle"} to another node to make it a report. With a node focused, Enter edits it, Delete removes it and Shift+F10 or a right click shows more.</>}
          </span>
        </FrameFooter>
      </CanvasFrame>
      <SidePanel label="team panel" open={panelOpen} onOpenChange={setPanelOpen}>
        <div className="team-panel">
          <div className="team-panel-tabs" data-testid="team-panel-tabs">
            <Tabs
              tabs={PANEL_TABS}
              value={panelTab}
              onChange={(id) => setPanelTab(id as PanelTab)}
              label="Team panel"
              idPrefix="team-panel"
              compact
            />
          </div>
          <div
            className="team-panel-pane"
            role="tabpanel"
            id={panelDomId('team-panel', panelTab)}
            aria-labelledby={tabDomId('team-panel', panelTab)}
          >
            {panelTab === 'catalog' ? (
              <TeamCatalog
                project={project}
                onSelectRole={(id) => {
                  selectRole(id)
                  setPanelTab('role')
                }}
              />
            ) : selectedRole ? (
              <div className={options.presentation === 'pocket-office' ? 'office-inspector' : undefined} data-office-palette={options.scenePalette}>
              {options.presentation === 'pocket-office' && <div className="office-inspector-action"><Button size="sm" testId="office-role-back" onClick={() => { const id = selectedRole.id; selectRole(null); setPanelTab('catalog'); returnToNode(id) }}>Back to office</Button></div>}
              <RoleInspector
                project={project}
                role={selectedRole}
                onReportsToChanged={(id, before) => {
                  const text = moveNotice(before, setReportsTo(before, id, before.find((r) => r.id === id)?.reportsTo ?? null), id)
                  setNotice(text ? { roleId: id, text } : null)
                }}
                onSettleError={setRenameNote}
                onRemove={() => void requestRemove(selectedRole.id)}
                onAddReport={() => addRole(selectedRole)}
                onEscape={() => { const id = selectedRole.id; if (options.presentation === 'pocket-office') { selectRole(null); setPanelTab('catalog') } returnToNode(id) }}
                onAskAssistant={() => openAssistant()}
              />
              </div>
            ) : (
              <EmptyState compact icon={MousePointerClick} title="No role selected" description="Select a role on the chart to edit what it can use." testId="team-no-role" />
            )}
          </div>
        </div>
      </SidePanel>
      <ContextMenu control={roleMenu} label={(id) => `Actions for ${project.roles.find((r) => r.id === id)?.name ?? 'role'}`} items={roleMenuItems} testId="role-node-menu" />
      {templateDialog === 'save' && (
        <SaveTemplateDialog
          project={project}
          onClose={closeTemplateDialog}
          onSaved={(name) => {
            setSavedTemplate(name)
            closeTemplateDialog()
          }}
        />
      )}
      {templateDialog === 'apply' && <ApplyTemplateDialog project={project} onClose={closeTemplateDialog} onApplied={closeTemplateDialog} />}
      {importDialog && (
        <ImportAgentsDialog project={project} defaultMode={importDialog.fresh ? 'replace' : 'merge'} fresh={importDialog.fresh} onClose={closeImport} />
      )}
      {dialog}
    </div>
  )
}
