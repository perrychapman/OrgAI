import type { KeyboardEvent, MouseEvent, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MousePointerClick, Pencil, Trash2, UserPlus } from 'lucide-react'
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
import type { AgentImportScan, Project, Role } from '@shared/types'
import { ROLE_COLORS, modelForTier, newId, projectConnection, slugify } from '@shared/defaults'
import { useAppStore } from '../store/useAppStore'
import { CanvasFrame, FrameFooter, FrameStage, FrameToolbar, FrameTray } from '../components/layout/CanvasFrame'
import { SidePanel } from '../components/layout/SidePanel'
import { EmptyState } from '../components/ui/EmptyState'
import SaveTemplateDialog from '../components/templates/SaveTemplateDialog'
import ApplyTemplateDialog from '../components/templates/ApplyTemplateDialog'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../lib/settingsTarget'
import { Tabs, panelDomId, tabDomId } from '../components/ui/Tabs'
import TeamAssistantTray from '../components/team/TeamAssistantTray'
import TeamCatalog from '../components/team/TeamCatalog'
import { capabilityCounts, capabilityLabel } from '../lib/teamView'
import ImportAgentsDialog from '../components/import/ImportAgentsDialog'
import { importBannerVisible, readBannerMemory, writeBannerMemory, type BannerMemory } from '../lib/agentImport'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { ContextMenu, useContextMenu, type MenuEntry } from '../components/ui/ContextMenu'
import { RoleNode, type RoleFlowNode } from '../components/RoleNode'
import RoleInspector from '../components/RoleInspector'
import { layoutCanvas } from '../lib/layout'
import { CanvasBackdrop } from '../components/canvas/CanvasBackdrop'
import { CanvasMinimap } from '../components/canvas/CanvasMinimap'
import { CANVAS_EDGE_TYPES } from '../components/canvas/RadialEdge'
import { DEFAULT_STYLE, EDGE_TYPE, beginCanvasGlide, edgeStroke, fitMs, refitMs, reportingLineRole, useNodeArrival, useNodeDims, useReducedMotion } from '../lib/canvas'
import { isLayoutMoving, onLayoutSettled } from '../lib/layoutMotion'
import { addRoleUnder, moveNotice, nextRoleName, removeRole, restoreRole, setReportsTo, wouldCycle, type RemovedRole } from '../lib/roleOps'
import { placeNewRole, revealShift, type StageRect } from '../lib/rolePlacement'
import TeamFilesChip from '../components/team/TeamFilesChip'
import ArchitectDialog from '../components/team/ArchitectDialog'
import TeamHeader from '../components/team/TeamHeader'
import AddRolePopover, { type AddRoleRequest } from '../components/team/AddRolePopover'
import TeamNoticeRow from '../components/team/TeamNoticeRow'
import TeamFilesCard from '../components/team/TeamFilesCard'
import TeamFilesAppliedNotice from '../components/team/TeamFilesAppliedNotice'
import { useTeamFilesActions } from '../components/team/useTeamFilesActions'
import { useOrgChange } from '../components/team/useOrgChange'
import { approveBlockedReason, cardVisible, importSourcesFor } from '../lib/teamFiles'
import { useCssVar } from '../lib/useCssVar'
import { LiveChangeNote } from '../components/LiveChangeNote'
import { displayRunName } from '../lib/orgChange'
import { statusOfRun, statusText } from '../lib/runStatus'
import { needsYou } from '../lib/runChains'
import { readTeamHintSeen, readTeamLayout, writeTeamHintSeen, writeTeamLayout, type TeamLayoutDirection } from '../lib/teamPrefs'
import { snapshotAdd, snapshotReparent, undoAdd, undoReparent } from '../lib/teamEdits'
import {
  EDIT_NOTICE_MS,
  HINT_TEXT,
  SHORT_NOTICE_MS,
  UNDO_UNTIL_CHANGE,
  addedText,
  clearNotice,
  nextExpiry,
  postNotice,
  pruneNotices,
  rankNotices,
  removeConfirmText,
  removedText,
  reparentedText,
  type TeamNotice
} from '../lib/teamNotices'
import type { ImportNotice } from '../store/useAppStore'

const nodeTypes = { role: RoleNode }

type PanelTab = 'role' | 'catalog'
const PANEL_TABS = [
  { id: 'role', label: 'Role', testId: 'team-panel-tab-role' },
  { id: 'catalog', label: 'Catalog', testId: 'team-panel-tab-catalog' }
]

/**
 * The Team chart is one fixed look (team-tab overhaul 1.1 and 4.4): card nodes, the Default style's reporting lines and
 * the graph presentation, whatever the canvas settings say. Only the layout direction is the Team's own control.
 * Phase 2 keeps the card box at 220 x 96; the extra row of the redesigned card is phase 5.
 */
const ROLE_SIZE = { width: 220, height: 96 } as const
const TEAM_EDGE_TYPE = EDGE_TYPE[DEFAULT_STYLE.canvas.edges]
const NOTICE_ROLE_EDIT = 'edit'

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

/** The one message the store's import or template notice says in the notice row (their testids stay for e2e). */
function storeNotice(n: ImportNotice, at: number): TeamNotice {
  const t = n.source === 'template' ? 'template' : 'import'
  const base = { key: `store:${t}`, at, dismissible: true }
  if (n.state === 'reverted') {
    return {
      ...base,
      kind: 'edit',
      text: t === 'template' ? 'Undo done. The previous team is back.' : 'Import undone. The previous chart is back.',
      testId: `${t}-undone`,
      actions: t === 'import' ? [{ id: 'review-import', label: 'Review import' }] : undefined
    }
  }
  if (n.state === 'error') {
    return { ...base, kind: 'error', text: n.error ?? 'Undo did not work.', testId: `${t}-notice`, actions: [{ id: 'undo', label: 'Retry undo', testId: `${t}-undo` }] }
  }
  if (n.state === 'expired') return { ...base, kind: 'edit', text: 'Undo ended because you changed a role.', testId: `${t}-notice` }
  return {
    ...base,
    kind: 'edit',
    text: `${n.summary} ${UNDO_UNTIL_CHANGE}`,
    testId: `${t}-notice`,
    actions: [{ id: 'undo', label: 'Undo', testId: `${t}-undo`, busy: n.state === 'busy' }]
  }
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
  const faintColor = useCssVar('--text-secondary')
  const labelBg = useCssVar('--surface-1')
  const groupEdgeColor = useCssVar('--canvas-edge-group')
  const edgeMix = useCssVar('--canvas-edge-role-mix')
  const edgeInk = useCssVar('--canvas-edge-ink')
  // The Team's own layout direction (localStorage orgai.teamLayout), independent of Live and App settings.
  const [layoutDir, setLayoutDir] = useState<TeamLayoutDirection>(() => readTeamLayout(window.localStorage))
  const reducedMotion = useReducedMotion()
  const nodeDims = useNodeDims()

  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)

  // ---------- The notice row (docs/design/team-tab-overhaul.md 1.5) ----------
  // Messages the view posts (an edit with Undo, an error, a saved line); the store-driven import and template notices,
  // the open Architect session and the first-visit hint are derived below and ranked with them.
  const [queue, setQueue] = useState<TeamNotice[]>([])
  const [hintSeen, setHintSeen] = useState(() => readTeamHintSeen(window.localStorage))
  /** What Undo does for the current edit notice (one slot: a new edit supersedes the last). */
  const editUndo = useRef<(() => void) | null>(null)
  const post = useCallback((notice: Omit<TeamNotice, 'at' | 'expiresAt'>, ttl?: number): void => {
    const now = Date.now()
    setQueue((q) => postNotice(q, { ...notice, at: now, ...(ttl ? { expiresAt: now + ttl } : {}) }))
  }, [])
  const clear = useCallback((key: string): void => setQueue((q) => clearNotice(q, key)), [])
  // One timer for the soonest expiry.
  const expiry = nextExpiry(queue, Date.now())
  useEffect(() => {
    if (expiry === null) return undefined
    const t = window.setTimeout(() => setQueue((q) => pruneNotices(q, Date.now())), Math.max(0, expiry - Date.now()) + 20)
    return () => window.clearTimeout(t)
  }, [expiry])
  // A reason or an edit belongs to the project it was made in.
  useEffect(() => {
    setQueue([])
    editUndo.current = null
  }, [project.id])

  const [focusTick, setFocusTick] = useState(0)
  const [panelOpen, setPanelOpen] = useState(true)
  // Role | Catalog. A role gets selected -> Role; the user's explicit choice sticks until the selection goes from nothing to something.
  const [panelTab, setPanelTab] = useState<PanelTab>(() => (useAppStore.getState().selectedRoleId ? 'role' : 'catalog'))
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
  // Team files (spec docs/design/team-files.md): the header chip, the approval card and the applied-at-once notice.
  const filesStatus = useAppStore((s) => s.teamFilesByProject[project.id])
  const filesActions = useTeamFilesActions(project.id)
  const filesFocus = useAppStore((s) => s.teamFilesFocus)
  const [cardFocusN, setCardFocusN] = useState(0)
  const [assistantShown, setAssistantShown] = useState(false)
  const chipRef = useRef<HTMLButtonElement>(null)
  const [architectOpen, setArchitectOpen] = useState(false)
  const filesOn = !!filesStatus && filesStatus.state !== 'off'
  const showCard = cardVisible(filesStatus)
  const importRequest = useAppStore((s) => s.importRequest)
  const importNotice = useAppStore((s) => s.importNotices[project.id])
  const dismissImportNotice = useAppStore((s) => s.dismissImportNotice)
  const undoImport = useAppStore((s) => s.undoImport)
  /** The Add role popover asked to open with a manager (node menu, editor). */
  const [addRequest, setAddRequest] = useState<AddRoleRequest | null>(null)
  /** Which inspector field takes focus once the new selection's editor is mounted. */
  const focusTarget = useRef<'role-name-input' | 'role-description' | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const templates = useAppStore((s) => s.templates)
  const [templateDialog, setTemplateDialog] = useState<'save' | 'apply' | null>(null)
  useEffect(() => {
    void useAppStore.getState().loadTemplates()
  }, [])
  const startFromTrigger = (): HTMLElement | null => rootRef.current?.querySelector<HTMLElement>('[data-testid=team-start-from]') ?? null
  const focusStartFrom = (): void => {
    window.requestAnimationFrame(() => startFromTrigger()?.focus())
  }
  const closeTemplateDialog = (): void => {
    setTemplateDialog(null)
    focusStartFrom()
  }

  // The files may have changed since the last push (a checkout, an edit): ask when the tab opens for this project.
  useEffect(() => {
    void useAppStore.getState().refreshTeamFiles(project.id)
  }, [project.id])
  // A request from the Needs-you list lands focus on the approval card once the status is known.
  useEffect(() => {
    if (!filesFocus || filesFocus.projectId !== project.id || !filesStatus) return
    if (showCard) setCardFocusN(filesFocus.n)
    else window.requestAnimationFrame(() => chipRef.current?.focus())
    useAppStore.getState().clearTeamFilesFocus()
  }, [filesFocus, filesStatus, project.id, showCard])
  useEffect(() => {
    if (!showCard) setAssistantShown(false)
  }, [showCard])
  // The agent files the chart has not taken in. `.orgai` agents are the team files' own while those are on.
  const foundSources = useMemo(() => importSourcesFor(scan?.sources ?? [], filesOn), [scan, filesOn])
  // The Start from menu's import count: null while the scan runs, 'error' when it failed.
  const [scanFailed, setScanFailed] = useState(false)
  const scanFound: number | null | 'error' = scanFailed ? 'error' : scan ? foundSources.reduce((n, x) => n + x.agentCount, 0) : null

  /** Focus to the Team files chip when the element that had it was removed (focus fell to the body). */
  const settleFocus = (): void => {
    window.requestAnimationFrame(() => {
      const a = document.activeElement
      if (!a || a === document.body) chipRef.current?.focus()
    })
  }
  const decide = async (kind: 'approve' | 'reject'): Promise<void> => {
    const digest = filesStatus?.digest
    if (!digest) return
    if (kind === 'approve' && filesStatus && approveBlockedReason(filesStatus)) return
    const ok = await (kind === 'approve' ? filesActions.approve(digest) : filesActions.reject(digest))
    // The card is gone after a decision, so focus goes to the chip; a refusal keeps focus on the card's own
    // buttons unless the re-fetch removed the card too (a stale digest).
    if (ok) window.requestAnimationFrame(() => chipRef.current?.focus())
    else settleFocus()
  }
  const commitFiles = (): void => {
    void filesActions.commit().then(({ ok, count }) => {
      if (ok && count > 0) post({ key: 'saved:files', kind: 'saved', text: `Committed ${count} team ${count === 1 ? 'file' : 'files'}.` }, SHORT_NOTICE_MS)
      // The popover that held the button is closed: focus returns to the chip that opened it.
      window.requestAnimationFrame(() => chipRef.current?.focus())
    })
  }

  const root = project.roles.find((r) => r.reportsTo === null)
  const selectedRole = project.roles.find((r) => r.id === selectedRoleId)

  // Agent files in the folder that the chart has not taken in: re-read when the project or its import state changes.
  useEffect(() => {
    let live = true
    setMemory(readBannerMemory(window.localStorage, project.id))
    setScanFailed(false)
    window.orgai.projects
      .scanAgents(project.path)
      .then((r) => live && setScan(r))
      .catch(() => live && setScanFailed(true))
    return () => {
      live = false
    }
  }, [project.id, project.path, importDialog])

  // After the dialog closes, keep focus on the page's own controls even when its opener (the New project form) is gone.
  const closeImport = (): void => {
    setImportDialog(null)
    window.requestAnimationFrame(() => {
      const a = document.activeElement
      if (!a || a === document.body) startFromTrigger()?.focus()
    })
  }

  // Show the whole chart after an import or an Undo.
  const importState = importNotice?.state
  useEffect(() => {
    if (importState !== 'available' && importState !== 'reverted') return undefined
    const t = window.setTimeout(() => {
      void flowRef.current?.fitView({ padding: 0.3, maxZoom: 1, duration: refitMs() })
    }, 120)
    if (importState === 'reverted') startFromTrigger()?.focus()
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importState])

  // The New project form asks for the review on a fresh chart.
  useEffect(() => {
    if (importRequest && importRequest.projectId === project.id) {
      setImportDialog({ fresh: importRequest.fresh })
      useAppStore.getState().requestImport(null)
    }
  }, [importRequest, project.id])

  // Move focus into the inspector once it is mounted, after a keyboard open or an add: the name field after an open, the
  // Description after an add (the name is known; what the role is for is what a new role needs). A field that is not
  // there yet (the panel is still mounting it) is waited for a few frames, then the name field takes it.
  useEffect(() => {
    const want = focusTarget.current
    if (!want || !selectedRole) return undefined
    focusTarget.current = null
    let frame = 0
    let tries = 0
    const land = (): void => {
      const field = document.getElementById(want) as HTMLInputElement | HTMLTextAreaElement | null
      if (field) {
        field.focus()
        if (want === 'role-name-input') field.select()
        return
      }
      if (tries++ < 12) frame = window.requestAnimationFrame(land)
      else (document.getElementById('role-name-input') as HTMLInputElement | null)?.focus()
    }
    frame = window.requestAnimationFrame(land)
    return () => window.cancelAnimationFrame(frame)
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
          initialWidth: ROLE_SIZE.width,
          initialHeight: ROLE_SIZE.height,
          ...(nodeDims.dims[role.id] ? { measured: nodeDims.dims[role.id] } : {}),
          ariaLabel: `${role.name}, ${role.reportsTo === null ? 'root role' : 'role'}. ${capabilityLabel(capabilities)}. Press Enter to edit${role.reportsTo === null ? '' : ', Delete to remove'}.`,
          // The chip counts the direct reports this role may actually delegate to, not every report.
          data: {
            role,
            delegateCount: role.canSpawn ? project.roles.filter((r) => r.reportsTo === role.id && role.spawnable.includes(r.id)).length : 0,
            capabilities,
            team: true,
            layout: layoutDir,
            ...(arrival.isNew(role.id) ? { arrived: true } : {})
          }
        }
      }),
    [project, selectedRoleId, nodeDims.dims, arrival.arrivedKey, layoutDir]
  )

  const edges: Edge[] = useMemo(
    () =>
      project.roles
        .filter((r) => r.reportsTo && project.roles.some((x) => x.id === r.reportsTo))
        .map((r) => {
          const parent = project.roles.find((x) => x.id === r.reportsTo)!
          const allowed = parent.canSpawn && parent.spawnable.includes(r.id)
          const id = `e-${parent.id}-${r.id}`
          const color = edgeStroke(reportingLineRole('card', parent.color, r.color), edgeMix, edgeInk)
          return {
            id,
            source: parent.id,
            target: r.id,
            type: TEAM_EDGE_TYPE,
            selected: id === selectedEdgeId,
            // The Delete-key sentence lives in the chart's description (below), not in every line's name.
            ariaLabel: allowed ? `${r.name} reports to ${parent.name}.` : `${r.name} reports to ${parent.name}, which cannot delegate to it.`,
            style: allowed ? { stroke: color, strokeWidth: 1.6 } : { stroke: groupEdgeColor, strokeWidth: 1.4, strokeDasharray: '4 4' },
            // The line of a role its manager cannot delegate to has no arrow.
            markerEnd: allowed ? { type: MarkerType.ArrowClosed, color } : undefined,
            label: allowed ? undefined : 'Cannot delegate',
            labelStyle: { fill: faintColor, fontSize: 11 },
            labelBgStyle: { fill: labelBg }
          }
        }),
    [project.roles, selectedEdgeId, faintColor, labelBg, edgeMix, edgeInk, groupEdgeColor]
  )

  /** Focus a chart node (keyboard focus never rests on a control that went away). */
  const focusNode = useCallback((roleId?: string | null): void => {
    window.requestAnimationFrame(() => {
      const el = rootRef.current
      const target = (roleId ? el?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(roleId)}"]`) : null) ?? el?.querySelector<HTMLElement>('.react-flow__node')
      target?.focus()
    })
  }, [])

  /** Posts the undoable "{Role} now reports to {Manager}." for a change of reporting line that already happened. */
  const postReparented = useCallback(
    (before: Role[], after: Role[], roleId: string): void => {
      const moved = after.find((r) => r.id === roleId)
      const manager = moved?.reportsTo ? after.find((r) => r.id === moved.reportsTo) : undefined
      if (!moved || !manager) return
      const edit = snapshotReparent(before, after, roleId)
      editUndo.current = () => {
        updateRoles(project.id, (roles) => undoReparent(roles, edit))
        selectRole(roleId)
        focusNode(roleId)
      }
      post(
        {
          key: NOTICE_ROLE_EDIT,
          kind: 'edit',
          text: reparentedText(moved.name, manager.name, moveNotice(before, after, roleId)),
          actions: [{ id: 'undo', label: 'Undo', testId: 'team-notice-undo' }]
        },
        EDIT_NOTICE_MS
      )
    },
    [post, project.id, updateRoles, selectRole, focusNode]
  )

  const reparentToRoot = useCallback(
    (childId: string) => {
      if (!root) return
      const child = project.roles.find((r) => r.id === childId)
      if (!child || child.reportsTo === root.id) return
      const before = storedRoles(project.id, project.roles)
      const after = setReportsTo(before, childId, root.id)
      updateRoles(project.id, (roles) => setReportsTo(roles, childId, root.id))
      setSelectedEdgeId(null)
      selectRole(childId)
      postReparented(before, after, childId)
    },
    [project.id, project.roles, root, updateRoles, selectRole, postReparented]
  )

  const requestRemove = useCallback(
    async (roleId: string): Promise<void> => {
      const role = project.roles.find((r) => r.id === roleId)
      if (!role || role.reportsTo === null) return
      const reports = project.roles.filter((r) => r.reportsTo === roleId).length
      const parent = project.roles.find((r) => r.id === role.reportsTo)
      // A role with no reports goes at once (Undo is the safety net); with reports the effect is not obvious, so ask.
      if (reports > 0 && parent) {
        const ok = await confirm({ ...removeConfirmText(role.name, reports, parent.name), danger: true })
        if (!ok) return
      }
      const current = storedRoles(project.id, project.roles)
      const { removed } = removeRole(current, roleId)
      if (!removed) return
      updateRoles(project.id, (roles) => removeRole(roles, roleId).roles)
      selectRole(null)
      setSelectedEdgeId(null)
      editUndo.current = () => {
        updateRoles(project.id, (roles) => restoreRole(roles, removed as RemovedRole))
        selectRole(removed.role.id)
        focusNode(removed.role.id)
      }
      post(
        { key: NOTICE_ROLE_EDIT, kind: 'edit', text: removedText(role.name, reports, parent?.name ?? null), actions: [{ id: 'undo', label: 'Undo', testId: 'team-notice-undo' }] },
        EDIT_NOTICE_MS
      )
      // The node is gone: focus goes to the nearest one, the role it reported to.
      focusNode(role.reportsTo)
    },
    [project.id, project.roles, confirm, updateRoles, selectRole, post, focusNode]
  )

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

  /** Why a dragged reporting line was refused: an error message for a few seconds (replaced by the next one). */
  const postDropNote = useCallback((text: string): void => post({ key: 'error:drop', kind: 'error', text, testId: 'team-drop-note' }, SHORT_NOTICE_MS), [post])

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
        clear('error:drop')
        return
      }
      const after = setReportsTo(before, target, source)
      updateRoles(project.id, (roles) => (wouldCycle(roles, target, source) ? roles : setReportsTo(roles, target, source)))
      clear('error:drop')
      postReparented(before, after, target)
    },
    [project.id, project.roles, updateRoles, clear, postReparented]
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
      if (report.reportsTo === null) postDropNote(`${report.name} is the root and cannot report to anyone.`)
      else if (wouldCycle(roles, to, from)) postDropNote(`${report.name} cannot report to ${manager.name}: ${manager.name} already reports to ${report.name}.`)
    },
    [project.id, project.roles, postDropNote]
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

  /** Opens the Add role popover on the header button, with `parentId` as "Reports to" when given. */
  const openAddRole = (parentId?: string): void => {
    const trigger = rootRef.current?.querySelector<HTMLButtonElement>('[data-testid=team-add-role]')
    if (!trigger) return
    if (parentId) setAddRequest((r) => ({ parentId, n: (r?.n ?? 0) + 1 }))
    if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click()
  }

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
          focusTarget.current = 'role-name-input'
          setPanelOpen(true)
          setPanelTab('role')
          setFocusTick((t) => t + 1)
          selectRole(roleId)
        }
      },
      { id: 'add-report', label: 'Add a report', icon: UserPlus, testId: 'role-menu-add-report', onSelect: () => openAddRole(role.id) },
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
    if ((e.key === 'Enter' || e.key === ' ') && el.classList.contains('react-flow__node')) {
      focusTarget.current = 'role-name-input'
      setPanelOpen(true)
      setPanelTab('role')
      setFocusTick((t) => t + 1)
    }
  }

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
      // The rendered box when the node is already drawn, else the computed one.
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

  /**
   * Adds a role named `name` under `parentId` (null: the first role of an empty team) with the phase 1 defaults, selects
   * it, pans to it and sends focus to its Description. Posts "Added {name} under {Parent}." with Undo.
   */
  const addRole = (name: string, parentId: string | null): void => {
    const current = storedRoles(project.id, project.roles)
    const manager = parentId ? current.find((r) => r.id === parentId) : undefined
    if (parentId && !manager) throw new Error('That role is gone. Pick another to report to.')
    const conn = projectConnection(project)
    const everyday = modelForTier('everyday', {
      connection: conn,
      tierModels: connectionInfos?.find((c) => c.connection.id === conn)?.connection.tierModels ?? {},
      catalog: modelCatalogs[conn]
    })
    const position = placeNewRole(current, manager?.id ?? null, ROLE_SIZE, { layout: layoutDir, sizeOf: (id) => nodeDims.dims[id] })
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
    const after = addRoleUnder(current, role)
    const edit = snapshotAdd(current, after, role.id)
    updateRoles(project.id, (roles) => addRoleUnder(roles, role))
    editUndo.current = () => {
      updateRoles(project.id, (roles) => undoAdd(roles, edit))
      if (useAppStore.getState().selectedRoleId === role.id) selectRole(null)
      focusNode(edit.managerId)
    }
    post({ key: NOTICE_ROLE_EDIT, kind: 'edit', text: addedText(name, manager?.name ?? null), actions: [{ id: 'undo', label: 'Undo', testId: 'team-notice-undo' }] }, EDIT_NOTICE_MS)
    clear('error:drop')
    setSelectedEdgeId(null)
    focusTarget.current = 'role-description'
    setPanelOpen(true)
    setPanelTab('role')
    setFocusTick((t) => t + 1)
    selectRole(role.id)
    revealRole(role.id, position, ROLE_SIZE)
  }

  // The assistant lives in the tray under the chart, so the role inspector stays in the side panel. "Ask the Team
  // assistant" from a role opens Recommend (scoped to that role) and focuses its primary button.
  const openAssistant = (): void => {
    window.requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>('[data-testid=team-recommend]')?.focus())
  }

  /** Lay every role out in `dir`: the nodes glide to their places (up to 60 of them), then one fit. */
  const arrange = (dir: TeamLayoutDirection): void => {
    const { positions: pos } = layoutCanvas(
      dir,
      project.roles.map((r) => ({ id: r.id, parentId: r.reportsTo, width: ROLE_SIZE.width, height: ROLE_SIZE.height })),
      { nodesep: 60, ranksep: 110 }
    )
    const glide = beginCanvasGlide(frameRef.current, project.roles.length)
    updateRoles(project.id, (roles) => roles.map((r) => ({ ...r, position: pos[r.id] ?? r.position })))
    window.setTimeout(() => {
      void flowRef.current?.fitView({ padding: 0.3, maxZoom: 1, duration: fitMs(reducedMotion) })
    }, glide > 0 ? glide + 10 : 80)
  }
  /** A direction change re-lays out everything for the new direction, then fits. */
  const changeLayout = (dir: TeamLayoutDirection): void => {
    setLayoutDir(dir)
    writeTeamLayout(window.localStorage, dir)
    arrange(dir)
  }

  // ---------- Derived messages: the store's import and template notices, the open Architect session, the hint ----------
  const seen = useRef(new Map<string, number>())
  const stamp = (key: string): number => {
    if (!seen.current.has(key)) seen.current.set(key, Date.now())
    return seen.current.get(key) as number
  }
  const { liveRunId, open: openSession } = useOrgChange(project)
  const sessionRun = useAppStore((s) => (liveRunId ? s.runs[liveRunId] : undefined))
  const derived: TeamNotice[] = []
  if (importNotice) derived.push(storeNotice(importNotice, stamp(`store:${importNotice.source ?? 'import'}:${importNotice.state}:${importNotice.summary}`)))
  if (sessionRun) {
    const word = statusText(statusOfRun(sessionRun, project, needsYou(sessionRun)))
    derived.push({
      key: 'session',
      kind: 'session',
      text: `${displayRunName(sessionRun.summary)} is open. ${word}.`,
      at: stamp(`session:${sessionRun.summary.id}`),
      testId: 'team-notice-session',
      actions: [{ id: 'open-session', label: 'Open session', testId: 'team-notice-session-open' }]
    })
  }
  if (!hintSeen) derived.push({ key: 'hint', kind: 'hint', text: HINT_TEXT, at: 0, testId: 'team-hint', actions: [{ id: 'got-it', label: 'Got it', testId: 'team-hint-dismiss' }] })
  const ranked = rankNotices([...queue, ...derived], Date.now())

  const onNoticeAction = (n: TeamNotice, action: string): void => {
    if (action === 'undo' && n.key === NOTICE_ROLE_EDIT) {
      const run = editUndo.current
      editUndo.current = null
      clear(NOTICE_ROLE_EDIT)
      run?.()
    } else if (action === 'undo') void undoImport(project.id)
    else if (action === 'review-import') setImportDialog({ fresh: false })
    else if (action === 'open-session') void openSession()
    else if (action === 'manage-templates') {
      requestAppSettingsSection(APP_SETTINGS_SECTIONS.templates)
      useAppStore.getState().setView('appSettings')
    } else if (action === 'got-it') {
      writeTeamHintSeen(window.localStorage)
      setHintSeen(true)
    }
  }
  const onNoticeDismiss = (n: TeamNotice): void => {
    if (n.key.startsWith('store:')) dismissImportNotice(project.id)
    else clear(n.key)
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
        <FrameToolbar label="Team actions">
          <TeamHeader
            roleCount={project.roles.length}
            layout={layoutDir}
            onLayoutChange={changeLayout}
            onArrange={() => arrange(layoutDir)}
            startFrom={{
              project,
              found: scanFound,
              dot: typeof scanFound === 'number' && importBannerVisible(scanFound, memory),
              onOpened: () => {
                if (typeof scanFound !== 'number' || scanFound === 0) return
                writeBannerMemory(window.localStorage, project.id, 'dismissed')
                setMemory('dismissed')
              },
              templateCount: templates?.length,
              roleCount: project.roles.length,
              onTemplate: () => setTemplateDialog('apply'),
              onImport: () => setImportDialog({ fresh: false }),
              onArchitect: () => setArchitectOpen(true),
              onSave: () => setTemplateDialog('save')
            }}
            files={{
              status: filesStatus,
              busy: filesActions.busy,
              message: filesActions.message,
              chipRef,
              onCommit: commitFiles,
              onEnable: () => void filesActions.enable().then(settleFocus),
              onReview: () => setCardFocusN((n) => n + 1),
              applied: filesStatus && <TeamFilesAppliedNotice status={filesStatus} busy={filesActions.busy} onUndo={() => void filesActions.undo().then(settleFocus)} />
            }}
            addRole={<AddRolePopover roles={project.roles} selectedRoleId={selectedRoleId} request={addRequest} onSubmit={addRole} />}
          />
        </FrameToolbar>
        <FrameStage>
          {/* The chart's description: how to draw a reporting line and the keys (the footer hint sentence moved here). */}
          <p id="team-chart-desc" className="sr-only">
            {`Drag from a role's ${layoutDir === 'left-right' ? 'right' : 'bottom'} handle onto another role to change who it reports to. With a role focused, Enter edits it, Delete removes it and Shift+F10 opens its menu. With a reporting line selected, Delete makes its role report to ${root?.name ?? 'the root'} instead.`}
          </p>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={CANVAS_EDGE_TYPES}
            data-layout={layoutDir}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectStart={() => clear('error:drop')}
            onConnectEnd={onConnectEnd}
            isValidConnection={isValidConnection}
            onNodeClick={onNodeClick}
            onNodeContextMenu={onNodeContextMenu}
            onPaneClick={() => {
              selectRole(null)
              setSelectedEdgeId(null)
              // QA P6: the reason for a refused drop goes with the next drag or a click on the chart.
              clear('error:drop')
            }}
            onBeforeDelete={onBeforeDelete}
            onInit={(inst) => {
              flowRef.current = inst
            }}
            aria-label="Org chart"
            aria-describedby="team-chart-desc"
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={['Delete', 'Backspace']}
            // React Flow's default pan key (Space) is swallowed on every button and <summary> inside the flow area;
            // dragging the pane still pans.
            panActivationKeyCode={null}
            elementsSelectable
            edgesFocusable={false}
          >
            <CanvasBackdrop />
            <Controls showInteractive={false} position="bottom-right" />
            <CanvasMinimap ariaLabel="Org chart minimap" />
          </ReactFlow>
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
              onOpenArchitect={() => setArchitectOpen(true)}
            />
          </div>
        </FrameTray>
        <FrameFooter>
          <TeamNoticeRow
            current={ranked.current}
            waiting={ranked.waiting}
            onAction={onNoticeAction}
            onDismiss={onNoticeDismiss}
            onFocusLost={() => focusNode(useAppStore.getState().selectedRoleId)}
          />
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
              <RoleInspector
                project={project}
                role={selectedRole}
                onReportsToChanged={(id, before) => postReparented(before, storedRoles(project.id, project.roles), id)}
                onSettleError={(text) => post({ key: 'error:rename', kind: 'error', text, testId: 'team-rename-note', dismissible: true })}
                onRemove={() => void requestRemove(selectedRole.id)}
                onAddReport={() => openAddRole(selectedRole.id)}
                onEscape={() => focusNode(selectedRole.id)}
                onAskAssistant={() => openAssistant()}
              />
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
            post(
              { key: 'saved:template', kind: 'saved', text: `Saved the template ${name}.`, testId: 'template-saved-notice', dismissible: true, actions: [{ id: 'manage-templates', label: 'Manage templates', testId: 'template-manage' }] },
              SHORT_NOTICE_MS
            )
            closeTemplateDialog()
          }}
        />
      )}
      {templateDialog === 'apply' && <ApplyTemplateDialog project={project} onClose={closeTemplateDialog} onApplied={closeTemplateDialog} />}
      {architectOpen && (
        <ArchitectDialog
          project={project}
          onClose={() => {
            setArchitectOpen(false)
            focusStartFrom()
          }}
        />
      )}
      {importDialog && (
        <ImportAgentsDialog project={project} defaultMode={importDialog.fresh ? 'replace' : 'merge'} fresh={importDialog.fresh} onClose={closeImport} />
      )}
      {dialog}
    </div>
  )
}
