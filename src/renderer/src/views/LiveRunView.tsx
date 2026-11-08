import type { ReactElement } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  MarkerType,
  useReactFlow,
  ReactFlowProvider,
  type Edge,
  type FitViewOptions,
  type NodeChange,
  type NodeMouseHandler
} from '@xyflow/react'
import { CanvasBackdrop } from '../components/canvas/CanvasBackdrop'
import { CanvasMinimap } from '../components/canvas/CanvasMinimap'
import { OfficeScene, type OfficeSceneHandle } from '../components/canvas/office/OfficeScene'
import { officeAgentView } from '../lib/office/agentView'
import { withOfficeDepartments } from '../lib/office/departments'
import { CanvasStyleButton } from '../components/canvas/CanvasStyleButton'
import { CANVAS_EDGE_TYPES } from '../components/canvas/RadialEdge'
import { STATION_CORNER_RADIUS, STATION_LINE_WIDTH } from '../lib/canvasShapes'
import { EDGE_TYPE, HEX_GAP, HEX_TILE, agentNodeSize, beginCanvasGlide, breatheIndex, edgeStroke, fitMs, groupNodeSize, handlesFor, reportingLineRole, ringStepFor, useCanvasOptions, useNodeArrival, useNodeDims, useReducedMotion } from '../lib/canvas'
import { isLayoutMoving, onLayoutSettled } from '../lib/layoutMotion'
import { isWorkingAgent } from '../lib/agentActivity'
import type { AgentInstance, CanvasNodeStyle, McpInstallOutcome, McpInstallRequest, Project, Proposal, ProposalDecision, ProposalKind } from '@shared/types'
import { isVirtualProjectId } from '@shared/types'
import type { VirtualProjectId } from '@shared/types'
import { ASSISTANT_REPLY_LABEL, assistantModeLabel, newSessionLabel, runLayoutFor, speaksAsAssistant } from '../lib/assistants'
import { chainCanvas, earlierLabel, isEarlierKey } from '../lib/chainView'
import { foldFinished, groupParentOf, isSettledAt, nextSettleAt, settleTimerDelay } from '../lib/foldFinished'
import { mergeChainFeed } from '../lib/transcriptRows'
import { displayRunName, isOrgChangeRun, orgChangeBannerTitle, setupBannerShows } from '../lib/orgChange'
import { registerMenuHandler, runMenuAction } from '../lib/menuRegistry'
import ChatStartPage from '../components/assistants/ChatStartPage'
import McpAssistantStartPage from '../components/assistants/McpAssistantStartPage'
import SkillAssistantStartPage from '../components/assistants/SkillAssistantStartPage'
import McpInstallCard from '../components/McpInstallCard'
import { Bell, CircleCheck, CircleHelp, Maximize, MessageSquare, Network, TriangleAlert, ZoomIn, ZoomOut } from 'lucide-react'
import { Banner } from '../components/ui/Banner'
import { IconButton } from '../components/ui/IconButton'
import PermissionCard from '../components/PermissionCard'
import DecisionTray, { type DecisionItem } from '../components/DecisionTray'
import { oneLine, permissionTitle, proposalKindLabel } from '../lib/decisionTitle'
import { projectKindOf } from '@shared/defaults'
import { defaultDecisionIndex } from '../lib/needsYou'
import { Icon } from '../components/ui/Icon'
import { Popover } from '../components/ui/Popover'
import { Switch } from '../components/ui/Switch'
import RunActions from '../components/RunActions'
import RunMeta from '../components/RunMeta'
import { useCssVar } from '../lib/useCssVar'
import { activeRun, useAppStore, useProjectSummaries, type RunState } from '../store/useAppStore'
import { Button } from '../components/ui/Button'
import { CHAIN_EAGER_MEMBERS, canContinueIn, chainKeyOf, chainOf, continuedByIn, earlierMembersToLoad, endedComposerCopy, sessionOpenRunId } from '../lib/runChains'
import { AgentNode, type AgentFlowNode } from '../components/AgentNode'
import { messageSides, msgHandleId, type PlacedBox } from '../lib/canvasShapes'
import { fitOptions } from '../lib/canvasFit'
import { DoneGroupNode, groupId, type DoneGroupFlowNode } from '../components/DoneGroupNode'
import type { FinishedGroup } from '../components/FinishedList'
import TranscriptPanel from '../components/TranscriptPanel'
import ProposalCard from '../components/ProposalCard'
import QuestionCard from '../components/QuestionCard'
import RuleRequestCard from '../components/RuleRequestCard'
import MergeReviewCard from '../components/MergeReviewCard'
import { SidePanel } from '../components/layout/SidePanel'
import { CanvasFrame, FrameStage, FrameToolbar, FrameTray } from '../components/layout/CanvasFrame'
import RunTabs from '../components/RunTabs'
import NewRunPage from '../components/NewRunPage'
import Composer from '../components/Composer'
import { LiveModelSwitch } from '../components/LiveModelSwitch'
import { formatUntil, layoutCanvas } from '../lib/layout'
import { agentLabel, normalizeParents } from '../lib/agentTree'

const nodeTypes = { agent: AgentNode, 'done-group': DoneGroupNode }
const LIVE_STATES = new Set(['starting', 'thinking', 'tool', 'delegating', 'waiting'])
/** A finished report keeps its own node this long before folding into its parent's "done" group. */
const COLLAPSE_KEY = 'orgai.collapseFinished'
/** An agent-to-agent message stays drawn this long. */
const MESSAGE_EDGE_MS = 12_000
/** Neutral role colour used when a role has none; resolved from a token at render time (React Flow cannot take var()). */
const NEUTRAL_ROLE_TOKEN = '--text-tertiary'

/**
 * Fit-to-view options. A stage under 300 px tall (1024x640 with several decisions) keeps nodes readable: zoom stays at
 * 0.8 or more and the chart pans. The radial layout fits with less padding (spec section 3).
 */
function fitOpts(o: { duration: number }): FitViewOptions {
  const style = document.querySelector('.frame-stage .agent-node[data-style]')?.getAttribute('data-style') as CanvasNodeStyle | null | undefined
  return fitOptions({
    stageHeight: document.querySelector('.frame-stage')?.clientHeight ?? 1000,
    radial: !!document.querySelector('.frame-stage .react-flow[data-layout="radial"]'),
    nodeStyle: style ?? undefined,
    duration: o.duration
  })
}

/** The canvas controls, shared by the toolbar buttons and the application menu handlers. */
const ZOOM_MS = 150
function zoomInCanvas(rf: { zoomIn: (o?: { duration: number }) => unknown }, reduced: boolean): void {
  void rf.zoomIn({ duration: reduced ? 0 : ZOOM_MS })
}
function zoomOutCanvas(rf: { zoomOut: (o?: { duration: number }) => unknown }, reduced: boolean): void {
  void rf.zoomOut({ duration: reduced ? 0 : ZOOM_MS })
}
function fitCanvas(rf: { fitView: (o?: FitViewOptions) => unknown }, reduced: boolean): void {
  void rf.fitView(fitOpts({ duration: fitMs(reduced) }))
}

/** A message edge glows (Starfield) and is marked fresh for this long. */
const MESSAGE_FRESH_MS = 1500

type CanvasNode = AgentFlowNode | DoneGroupFlowNode

/** The fold's name for an agent (handle first, as its node shows it), or undefined when it is not known. */
function lookupLabel(a: AgentInstance | undefined): string | undefined {
  return a ? agentLabel(a) : undefined
}

function readCollapsePref(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) !== 'off'
  } catch {
    return true
  }
}

/**
 * The project's run workspace: the run strip on top (tabs and the viewed run's actions), then either one run (canvas
 * toolbar, decisions, canvas, composer, side panel) or the blank New run page. The view is keyed by the run's session chain, so
 * a continue keeps it mounted; per-run local state (picked decision, the session block, approved kinds) resets when the viewed run changes.
 */
export default function LiveRunView({ project }: { project: Project }): ReactElement {
  const runId = useAppStore((s) => activeRun(s)?.summary.id)
  const hasWorkspace = useAppStore((s) => !!s.draftPage[project.id] || !!s.activeRunByProject[project.id])
  const ensureWorkspace = useAppStore((s) => s.ensureWorkspace)
  const summaries = useProjectSummaries()
  // One view per session chain: a continue keeps the same view mounted (layout, panel, focus).
  const chainKey = runId ? chainKeyOf(summaries, runId) : 'new'

  // A project opened without a workspace (e.g. straight after creation) picks its newest run or the New run page.
  useEffect(() => {
    if (!hasWorkspace) void ensureWorkspace()
  }, [project.id, hasWorkspace, ensureWorkspace])

  return (
    <div className="run-workspace">
      <div className="run-strip" data-testid="run-strip">
        <RunTabs project={project} />
        {runId && <RunActions runId={runId} />}
      </div>
      <div className="run-panel" id="run-panel" role="tabpanel" aria-labelledby={`run-tab-${runId ?? 'new'}`}>
        {runId ? (
          <ReactFlowProvider key={`${project.id}:${chainKey}`}>
            <RunView project={project} runId={runId} />
          </ReactFlowProvider>
        ) : isVirtualProjectId(project.id) ? (
          <AssistantStart key={`assistant:${project.id}`} id={project.id} project={project} />
        ) : (
          <NewRunPage key={`new:${project.id}`} project={project} />
        )}
      </div>
    </div>
  )
}

/** The start page of an assistant (virtual project): Chat, MCP assistant or Skill assistant. */
function AssistantStart({ id, project }: { id: VirtualProjectId; project: Project }): ReactElement {
  if (id === 'quick') return <ChatStartPage project={project} />
  if (id === 'harness') return <McpAssistantStartPage project={project} />
  return <SkillAssistantStartPage project={project} />
}

function RunView({ project, runId }: { project: Project; runId: string }): ReactElement {
  const run = useAppStore((s) => s.runs[runId])
  const selectedAgentId = useAppStore((s) => s.selectedAgentId)
  // Arriving from the Usage page in a window under 1100 px: the side panel opens wide so agent names are not clipped.
  const usageReturnRun = useAppStore((s) => s.usageReturn?.runId ?? null)
  const usageArrival = useMemo(() => (usageReturnRun === runId && window.innerWidth < 1100 ? runId : null), [usageReturnRun, runId])
  const selectAgent = useAppStore((s) => s.selectAgent)
  const startRun =useAppStore((s) => s.startRun)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const decide = useAppStore((s) => s.decide)
  const decideProposal = useAppStore((s) => s.decideProposal)
  const continueRun = useAppStore((s) => s.continueRun)
  const composerFocusToken = useAppStore((s) => s.composerFocusToken)
  const answerQuestion = useAppStore((s) => s.answerQuestion)
  const decideRules = useAppStore((s) => s.decideRules)
  const decideMerge = useAppStore((s) => s.decideMerge)
  const openRun = useAppStore((s) => s.openRun)
  const setSideTab = useAppStore((s) => s.setSideTab)
  const focusComposer = useAppStore((s) => s.focusComposer)
  const summaries = useProjectSummaries()
  // The pick is kept for the conversation: the newest member's own choice, else an earlier member's.
  // The chain is worked out once per render; newest / canContinue / successor / key all derive from it.
  const chainSummaries = useMemo(() => chainOf(summaries, runId), [summaries, runId])
  const chainIds = useMemo(() => {
    const ids = chainSummaries.map((r) => r.id).reverse()
    return ids.length > 0 ? ids : [runId]
  }, [chainSummaries, runId])
  const chosenLayout = useAppStore((s) => {
    for (const id of chainIds) if (s.runLayoutByRun[id]) return s.runLayoutByRun[id]
    return undefined
  })
  const setRunLayout = useAppStore((s) => s.setRunLayout)
  // The stage fades in on a user's toggle between conversation and agents, never on first show (motion.md 3.20).
  const [toggledTo, setToggledTo] = useState<string | null>(null)
  const toggleTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(toggleTimer.current), [])
  const pendingFocus = useAppStore((s) => s.pendingDecisionFocus === runId)
  const clearDecisionFocus = useAppStore((s) => s.clearDecisionFocus)
  const { fitView, zoomIn, zoomOut } = useReactFlow()
  const setView = useAppStore((s) => s.setView)
  const stopRun = useAppStore((s) => s.stopRun)
  const messageColor = useCssVar('--edge-message')
  const neutralRoleColor = useCssVar(NEUTRAL_ROLE_TOKEN)
  const edgeMix = useCssVar('--canvas-edge-role-mix')
  const edgeInk = useCssVar('--canvas-edge-ink')
  const edgeDoneOpacity = Number.parseFloat(useCssVar('--canvas-edge-done-opacity')) || 0.8
  const groupEdgeColor = useCssVar('--canvas-edge-group')
  const liveDash = useCssVar('--canvas-edge-live-dash') || '6 4'
  const messageDash = useCssVar('--canvas-edge-message-dash') || '2 5'
  const options = useCanvasOptions()
  const officeRef = useRef<OfficeSceneHandle>(null)
  const officeModeRef = useRef(false)
  officeModeRef.current = options.presentation === 'pocket-office'
  const reducedMotion = useReducedMotion()
  const nodeDims = useNodeDims()
  // The stage collapses to height 0 while an expanded proposal takes a compact frame: nothing to fit then.
  const stageHidden = (): boolean => officeModeRef.current || (canvasRef.current?.querySelector('.frame-stage')?.clientHeight ?? 1) < 8
  const radial = options.layout === 'radial'
  const edgeType = radial ? 'radial' : EDGE_TYPE[options.edges]
  const agentSize = useMemo(() => agentNodeSize(options.nodeStyle, options.layout), [options.nodeStyle, options.layout])
  const groupSize = useMemo(() => groupNodeSize(options.nodeStyle, options.layout), [options.nodeStyle, options.layout])
  const station = options.nodeStyle === 'station'
  // Right angle lines turn with a rounded corner on the subway map.
  const roundedCorners = useMemo(() => (station && options.edges === 'orthogonal' && !radial ? { pathOptions: { borderRadius: STATION_CORNER_RADIUS } } : {}), [station, options.edges, radial])

  /** The runtime refused a Continue because the session is open in another live run. */
  const [sessionBlock, setSessionBlock] = useState<{ message: string; runId: string } | null>(null)
  const allRuns = useAppStore((s) => s.runs)
  // Loaded members, oldest first (members whose records are not loaded yet are missing until loadChain fetches them).
  const members = useMemo(() => [...chainIds].reverse().map((id) => allRuns[id]).filter((r): r is RunState => !!r), [chainIds, allRuns])
  const historyLoaded = useAppStore((s) => s.historyByProject[project.id] !== undefined)
  const continueIntent = useAppStore((s) => s.continueIntent === chainIds[0])
  const loadChain = useAppStore((s) => s.loadChain)
  const loadEarlierSessions = useAppStore((s) => s.loadEarlierSessions)
  // M2: only the newest members load at first; the rest wait behind "Load earlier sessions" at the top of the feed.
  const chainLimit = useAppStore((s) => s.chainLoadLimit[chainIds[chainIds.length - 1]] ?? CHAIN_EAGER_MEMBERS)
  const earlierToLoad = useMemo(() => {
    // Count only members before the viewed run (the feed shows the chain up to it); the window counts from the newest.
    const at = chainSummaries.findIndex((m) => m.id === runId)
    const uptoViewed = at >= 0 ? chainSummaries.slice(0, at + 1) : chainSummaries
    return earlierMembersToLoad(uptoViewed, (id) => !!allRuns[id], Math.max(0, chainLimit - (chainSummaries.length - uptoViewed.length)))
  }, [chainSummaries, allRuns, chainLimit, runId])
  const loadEarlierRef = useRef<HTMLDivElement>(null)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const chainFocusRun = useAppStore((s) => s.chainFocusRun)
  const [collapseFinished, setCollapseFinished] = useState(readCollapsePref)
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean | number>>({})
  // The frame's one polite line: new decisions and "Showing N agents under X" after an expand.
  const [arrival, setArrival] = useState<{ text: string; n: number } | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  const [msgNow, setMsgNow] = useState(() => Date.now())
  const [pickedDecision, setPickedDecision] = useState<string | null>(null)
  const [dismissedInstalls, setDismissedInstalls] = useState<Record<string, boolean>>({})
  const [approvedKinds, setApprovedKinds] = useState<ProposalKind[]>([])
  const bodyRef = useRef<HTMLDivElement>(null)

  // Turning "Hide finished agents" back on folds every expanded group again (the way back after expanding).
  const toggleCollapse = (): void => {
    const next = !collapseFinished
    try {
      localStorage.setItem(COLLAPSE_KEY, next ? 'on' : 'off')
    } catch {
      /* storage unavailable */
    }
    setCollapseFinished(next)
    if (next) setExpandedGroups({})
  }

  // Earlier sessions of this conversation load lazily; the view stays mounted when a continue changes the viewed run.
  // It re-runs when the set of known members changes or the history arrives: a run opened before history loaded gets its earlier members then.
  const chainMemberKey = chainIds.join(',')
  useEffect(() => {
    void loadChain(runId)
  }, [runId, chainMemberKey, historyLoaded, loadChain])
  // History's Continue asks for the composer: it takes focus once (the Composer sees autoFocus on mount), then the request is cleared.
  useEffect(() => {
    if (continueIntent) useAppStore.setState({ continueIntent: null })
  }, [continueIntent])
  const prevRunId = useRef(runId)
  useEffect(() => {
    const prev = prevRunId.current
    if (prev === runId) return
    prevRunId.current = runId
    // Per-run local state starts clean; the collapse preference, folded groups and the side panel tab carry over.
    setSessionBlock(null)
    setPickedDecision(null)
    setDismissedInstalls({})
    setApprovedKinds([])
    const st = useAppStore.getState()
    const tab = st.sideTabByRun[prev]
    if (tab && !st.sideTabByRun[runId]) useAppStore.setState({ sideTabByRun: { ...st.sideTabByRun, [runId]: tab } })
  }, [runId])

  const isSetupRun = run.summary.kind === 'setup'
  const rootName = project.roles.find((r) => r.reportsTo === null)?.name ?? 'the orchestrator'
  const status = run.summary.status
  const sessionOpen = status === 'running' || status === 'idle' || status === 'starting'
  // A stopped run with a provider session can be continued with its memory intact, but only the newest run of its
  // session chain: an older member points to the newest.
  const canContinue = canContinueIn(chainSummaries, runId)
  const newestRun = chainSummaries[chainSummaries.length - 1]
  const successor = !sessionOpen ? continuedByIn(chainSummaries, runId) : undefined
  const virtualId = isVirtualProjectId(project.id) ? project.id : undefined
  // M6: an ended, continuable work run opened in a window under 1100 px starts as the conversation (decided once, at
  // open, so a live run that ends or a continue never flips the layout under the user). A saved choice always wins.
  const [endedNarrow] = useState(
    () => !sessionOpen && canContinue && run.summary.kind === 'work' && !virtualId && window.matchMedia('(max-width: 1099px)').matches
  )
  // Single-agent runs open as a conversation (the root agent's transcript is the stage); team runs open on the canvas.
  // Every run can switch, the choice is kept per conversation in the store.
  const layout = runLayoutFor(run.summary, chosenLayout, { endedNarrow })
  const conversation = layout === 'conversation'
  const asAssistant = speaksAsAssistant(run.summary)

  // The chain up to the viewed run, oldest first (the viewed run is the newest in practice).
  const upto = useMemo(() => {
    const at = members.findIndex((m) => m.summary.id === runId)
    return at >= 0 ? members.slice(0, at + 1) : [run]
    // Earlier members are ended records: they change only when loaded; the viewed run changes with every event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members.map((m) => `${m.summary.id}:${m.transcript.length}:${Object.keys(m.agents).length}`).join('|'), run.agents, run.transcript, run.summary])
  const chain = useMemo(() => chainCanvas(upto), [upto])
  const agentsById = run.agents
  const agents = useMemo(() => normalizeParents(chain.agents), [chain.agents])
  const agentLookup = useMemo(() => {
    const m = new Map<string, AgentInstance>()
    for (const a of agents) m.set(a.id, a)
    for (const g of chain.earlier) for (const a of g.agents) m.set(a.id, a)
    return m
  }, [agents, chain.earlier])
  const roleColor = useCallback(
    (roleId: string | null, slug: string): string =>
      project.roles.find((r) => r.id === roleId)?.color ?? project.roles.find((r) => r.slug === slug)?.color ?? neutralRoleColor,
    [project.roles, neutralRoleColor]
  )

  // Finished reports fold after a short grace period (lib/foldFinished.ts). One timeout waits for the next agent to
  // come out of its grace period. It is keyed on that moment only, never on the agents array, so a run streaming
  // events faster than the timer still folds its reports while it is Running (ux-review-fold.md H1).
  const settleDue = collapseFinished ? nextSettleAt(agents, now) : undefined
  useEffect(() => {
    if (settleDue === undefined) return undefined
    // Never below the moment waited for: a timer that fires early or a clock set back would otherwise leave `now`
    // short of it, give the same moment again and never re-arm (review M-A).
    const t = setTimeout(() => setNow(Math.max(Date.now(), settleDue)), settleTimerDelay(settleDue, Date.now()))
    return () => clearTimeout(t)
  }, [settleDue])

  // Message edges fade after MESSAGE_EDGE_MS; tick while the newest one is still showing.
  const messages = run.messages
  useEffect(() => {
    const latest = messages?.length ? messages[messages.length - 1].at : 0
    if (!latest || Date.now() - latest > MESSAGE_EDGE_MS) return undefined
    setMsgNow(Date.now())
    const t = setInterval(() => {
      const n = Date.now()
      setMsgNow(n)
      if (n - latest > MESSAGE_EDGE_MS) clearInterval(t)
    }, 1000)
    return () => clearInterval(t)
  }, [messages])

  // Finished agents fold into one group per visible ancestor (lib/foldFinished.ts): a settled subtree is one group
  // under the agent still shown above it. Earlier sessions are one dashed "Earlier: N agents" group each, under the root.
  // `expandedGroups` is keyed by the group's key: the visible ancestor's id, or an earlier-session key.
  const { visibleAgents, groups } = useMemo(
    () => foldFinished({ agents, isSettled: (a) => isSettledAt(a, now), expanded: expandedGroups, earlier: chain.earlier, collapse: collapseFinished }),
    [agents, chain.earlier, collapseFinished, expandedGroups, now]
  )

  // Pop-in only for nodes that arrive while the canvas is shown (motion.md 3.12, 2.2). A group is a node too (3.13).
  // The scope includes the loaded member count so earlier sessions loading in lazily are seen, not new.
  const arrivalIds = useMemo(() => [...visibleAgents.map((a) => a.id), ...[...groups.keys()].map((p) => groupId(p))], [visibleAgents, groups])
  const nodeArrival = useNodeArrival(arrivalIds, `${project.id}:${chainIds[0]}:${members.length}`)
  // Only the first 12 working nodes (node order) breathe; the rest keep their colour and word.
  const breathing = useMemo(() => breatheIndex(visibleAgents.map((a) => ({ id: a.id, working: isWorkingAgent(a.state) }))), [visibleAgents])

  // An expanded key whose agent has left the canvas (it finished and folded) is dropped, so expanding the group it is
  // now in shows that agent folded like its siblings (review L2). Earlier-session keys stay.
  useEffect(() => {
    const shown = new Set(visibleAgents.map((a) => a.id))
    const stale = Object.keys(expandedGroups).filter((k) => !isEarlierKey(k) && !shown.has(k))
    if (stale.length === 0) return
    setExpandedGroups((g) => {
      const next = { ...g }
      for (const k of stale) delete next[k]
      return next
    })
  }, [visibleAgents, expandedGroups])

  /** The agent a group node hangs under: the visible ancestor it is keyed by, or the root for an earlier session. */
  const groupParent = useCallback((key: string): string | null => groupParentOf(key, chain.rootId, isEarlierKey), [chain.rootId])
  const groupParentName = useCallback(
    (key: string): string => (isEarlierKey(key) ? 'an earlier session' : (lookupLabel(agentLookup.get(key)) ?? 'its parent')),
    [agentLookup]
  )

  // Expanding removes the group node (and the focused button in it): focus moves to the agent it hung under, a stale
  // group selection follows it, and the frame says what appeared (review M1).
  const expandGroup = useCallback(
    (key: string) => {
      const members = groups.get(key) ?? []
      const shownNow = isEarlierKey(key) ? members.length : members.filter((m) => m.parentId === key).length
      // The revealed reports pop (an expand is the user's own action; 3.13).
      nodeArrival.markArrived(isEarlierKey(key) ? members.map((m) => m.id) : members.filter((m) => m.parentId === key).map((m) => m.id))
      // A report group remembers when it was opened: reports that finish later fold again (ux-review-fold.md M1).
      setExpandedGroups((g) => ({ ...g, [key]: isEarlierKey(key) ? true : Date.now() }))
      const parent = groupParent(key)
      if (parent && useAppStore.getState().selectedAgentId === groupId(key)) selectAgent(parent)
      setArrival((a) => ({ text: `Showing ${shownNow} ${shownNow === 1 ? 'agent' : 'agents'} under ${groupParentName(key)}`, n: (a?.n ?? 0) + 1 }))
      if (parent) {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(parent)}"]`)
            el?.focus({ preventScroll: true })
          })
        )
      }
    },
    [groups, groupParent, groupParentName, selectAgent, nodeArrival.markArrived]
  )

  // Recompute the tree layout only when the set of shown nodes or their parent links change.
  const topologyKey = [
    ...visibleAgents.map((a) => `${a.id}>${a.parentId ?? ''}`),
    ...[...groups.keys()].map((p) => `${groupId(p)}>${p}`)
  ]
    .sort()
    .join('|')
  // The layout, node style and topology decide where nodes sit and when to refit.
  const layoutKey = `${topologyKey}#${options.layout}#${options.nodeStyle}`
  const placed = useMemo(
    () =>
      options.presentation === 'pocket-office' ? { positions: {} as Record<string, { x: number; y: number }>, rings: undefined } : layoutCanvas(
        options.layout,
        [
          ...visibleAgents.map((a) => ({ id: a.id, parentId: a.parentId, width: agentSize.width, height: agentSize.height })),
          ...[...groups.keys()].map((p) => ({ id: groupId(p), parentId: groupParent(p), width: groupSize.width, height: groupSize.height }))
        ],
        { ringStep: ringStepFor(options.nodeStyle), ...(options.nodeStyle === 'hex' ? { honeycomb: { width: HEX_TILE.width, height: HEX_TILE.height, gap: HEX_GAP } } : {}) }
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutKey, options.presentation]
  )
  const positions = placed.positions

  // Switching back to the canvas mounts a fresh React Flow: fit it once it has a size.
  const prevLayout = useRef(layout)
  useEffect(() => {
    if (prevLayout.current === layout) return undefined
    prevLayout.current = layout
    if (layout !== 'canvas') return undefined
    const t = setTimeout(() => {
      if (stageHidden()) return
      void fitView(fitOpts({ duration: 0 }))
    }, 80)
    return () => clearTimeout(t)
  }, [layout, fitView])

  // Glide (motion.md 3.12): a change of layout, node style or topology moves the nodes with a transform transition
  // while the canvas carries data-canvas-gliding. The first layout of a canvas never glides; above 60 nodes it snaps.
  const glideSeen = useRef<string | null>(null)
  const glideUntil = useRef(0)
  useLayoutEffect(() => {
    if (officeModeRef.current) { glideSeen.current = null; return }
    if (glideSeen.current === null) {
      glideSeen.current = layoutKey
      return
    }
    if (glideSeen.current === layoutKey) return
    glideSeen.current = layoutKey
    const total = beginCanvasGlide(canvasRef.current, arrivalIds.length)
    glideUntil.current = total ? Date.now() + total : 0
  }, [layoutKey, options.presentation])

  const lastTopology = useRef('')
  useEffect(() => {
    if (topologyKey && layoutKey !== lastTopology.current) {
      lastTopology.current = layoutKey
      // One refit, after the glide has ended (immediately when nothing glides).
      const left = glideUntil.current - Date.now()
      const t = setTimeout(() => {
        if (stageHidden()) return
        void fitView(fitOpts({ duration: fitMs(reducedMotion) }))
      }, left > 0 ? left + 10 : 60)
      return () => clearTimeout(t)
    }
    return undefined
  }, [layoutKey, fitView])

  const nodes: CanvasNode[] = useMemo(() => {
    const agentNodes: CanvasNode[] = visibleAgents.map((agent) => ({
      id: agent.id,
      type: 'agent' as const,
      position: positions[agent.id] ?? { x: 0, y: 0 },
      selected: agent.id === selectedAgentId,
      draggable: false,
      initialWidth: agentSize.width,
      initialHeight: agentSize.height,
      ...(nodeDims.dims[agent.id] ? { measured: nodeDims.dims[agent.id] } : {}),
      // Name tags, stations and hexes: the accessible name leads with the label the node shows (handle, then role name).
      ...(options.nodeStyle !== 'card' ? { ariaLabel: agentLabel(agent) === agent.name ? agent.name : `${agentLabel(agent)}, ${agent.name}` } : {}),
      data: { agent, color: roleColor(agent.roleId, agent.roleSlug), isRoot: agent.parentId === null, ...(nodeArrival.isNew(agent.id) ? { arrived: true } : {}), ...(breathing.has(agent.id) ? { breathe: breathing.get(agent.id) } : {}) }
    }))
    const groupNodes: CanvasNode[] = [...groups.entries()].map(([parentId, members]) => {
      const parent = agentLookup.get(groupParent(parentId) ?? '')
      const earlier = isEarlierKey(parentId)
      return {
        id: groupId(parentId),
        type: 'done-group' as const,
        position: positions[groupId(parentId)] ?? { x: 0, y: 0 },
        selected: selectedAgentId === groupId(parentId) || members.some((m) => m.id === selectedAgentId),
        draggable: false,
        initialWidth: groupSize.width,
        initialHeight: groupSize.height,
        ...(nodeDims.dims[groupId(parentId)] ? { measured: nodeDims.dims[groupId(parentId)] } : {}),
        data: { parentId, parentName: groupParentName(parentId), agents: members, color: parent ? roleColor(parent.roleId, parent.roleSlug) : neutralRoleColor, onToggle: expandGroup, ...(nodeArrival.isNew(groupId(parentId)) ? { arrived: true } : {}), ...(earlier ? { label: earlierLabel(members.length), earlier: true } : {}) }
      }
    })
    return [...agentNodes, ...groupNodes]
  }, [visibleAgents, groups, positions, selectedAgentId, roleColor, agentLookup, groupParent, groupParentName, expandGroup, neutralRoleColor, agentSize, groupSize, nodeDims.dims, options.nodeStyle, nodeArrival.arrivedKey, breathing])

  // Controlled nodes: keep React Flow's measured sizes so the minimap draws every node (H1).
  // Enter or Space on a focused node arrives as a 'select' change (React Flow's own key handler); it selects like a click.
  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      nodeDims.apply(changes as NodeChange[])
      const picked = changes.find((c) => c.type === 'select' && c.selected)
      if (picked && picked.type === 'select' && useAppStore.getState().selectedAgentId !== picked.id) selectAgent(picked.id)
    },
    [nodeDims.apply, selectAgent]
  )

  const edges: Edge[] = useMemo(() => {
    const shown = new Set(visibleAgents.map((a) => a.id))
    const agentEdges: Edge[] = visibleAgents
      .filter((a) => a.parentId && shown.has(a.parentId))
      .map((a) => {
        // Role colour mixed toward the ink; the marker takes the same literal colour (section 5).
        const parentAgent = agentLookup.get(a.parentId as string)
        const color = edgeStroke(reportingLineRole(options.nodeStyle, parentAgent ? roleColor(parentAgent.roleId, parentAgent.roleSlug) : roleColor(a.roleId, a.roleSlug), roleColor(a.roleId, a.roleSlug)), edgeMix, edgeInk)
        const live = LIVE_STATES.has(a.state)
        const finished = a.state === 'done'
        if (station) {
          // Subway: one thick coloured line per lead; working shows on the station, never on the line.
          return {
            id: `e-${a.parentId}-${a.id}`,
            source: a.parentId as string,
            target: a.id,
            type: edgeType,
            style: { stroke: color, strokeWidth: STATION_LINE_WIDTH, strokeLinecap: 'round', strokeLinejoin: 'round', opacity: finished ? edgeDoneOpacity : 1 },
            ...roundedCorners
          }
        }
        return {
          id: `e-${a.parentId}-${a.id}`,
          source: a.parentId as string,
          target: a.id,
          type: edgeType,
          animated: live && !reducedMotion,
          style: {
            stroke: color,
            strokeWidth: live ? 2.2 : finished ? 1.4 : 1.6,
            opacity: finished ? edgeDoneOpacity : 1,
            ...(live ? { strokeDasharray: liveDash } : {})
          },
          markerEnd: { type: MarkerType.ArrowClosed, color }
        }
      })
    const groupEdges: Edge[] = [...groups.keys()]
      .filter((p) => shown.has(groupParent(p) ?? ''))
      .map((p) => {
        const base = { id: `e-${p}-${groupId(p)}`, source: groupParent(p) as string, target: groupId(p), type: edgeType }
        if (!station) return { ...base, style: { stroke: groupEdgeColor, strokeWidth: 1.4, strokeDasharray: '4 4' } }
        const lead = agentLookup.get(groupParent(p) ?? '')
        const color = edgeStroke(lead ? roleColor(lead.roleId, lead.roleSlug) : neutralRoleColor, edgeMix, edgeInk)
        return { ...base, style: { stroke: color, strokeWidth: STATION_LINE_WIDTH, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, opacity: edgeDoneOpacity }, ...roundedCorners }
      })
    // Recent messages: a dashed, animated side-to-side edge. A folded agent's end attaches to its group node;
    // a message whose ends are not on the canvas (or land on the same node) is skipped.
    const groupOf = new Map<string, string>()
    for (const [parentId, members] of groups) for (const m of members) groupOf.set(m.id, parentId)
    const onCanvas = (id: string | null): string | null => {
      if (!id) return null
      if (shown.has(id)) return id
      const seen = new Set<string>()
      let cur: string | null = id
      while (cur && !seen.has(cur)) {
        seen.add(cur)
        const g = groupOf.get(cur)
        if (g !== undefined) return groupId(g)
        if (cur !== id && shown.has(cur)) return null
        cur = agentsById[cur]?.parentId ?? null
      }
      return null
    }
    const messageEdges = new Map<string, Edge>()
    const boxOf = (nodeId: string): PlacedBox | null => {
      const at = positions[nodeId]
      if (!at) return null
      const size = nodeId.startsWith('group:') ? groupSize : agentSize
      const m = nodeDims.dims[nodeId]
      return { x: at.x, y: at.y, width: m?.width ?? size.width, height: m?.height ?? size.height }
    }
    const parentOfNode = (nodeId: string): string | null => (nodeId.startsWith('group:') ? groupParent(nodeId.slice('group:'.length)) : (agentLookup.get(nodeId)?.parentId ?? null))
    for (const m of messages ?? []) {
      if (msgNow - m.at > MESSAGE_EDGE_MS) continue
      const source = onCanvas(m.from)
      const target = onCanvas(m.to)
      if (!source || !target || source === target) continue
      const id = `msg-${source}-${target}`
      // The side of each end that faces the other node, from the laid-out boxes; a parent and child take the axis
      // their reporting line does not use. Radial edges ignore handles (centre to centre, clipped at the shapes).
      const a = boxOf(source)
      const b = boxOf(target)
      const reportingAxis = parentOfNode(source) === target || parentOfNode(target) === source ? (handlesFor(options.layout).source === 'bottom' ? 'y' : 'x') : undefined
      const sides = a && b ? messageSides(a, b, reportingAxis) : null
      messageEdges.set(id, {
        id,
        source,
        target,
        sourceHandle: msgHandleId('out', sides?.out ?? 'right'),
        targetHandle: msgHandleId('in', sides?.in ?? 'left'),
        type: edgeType,
        data: { message: true },
        className: msgNow - m.at < MESSAGE_FRESH_MS ? 'msg-edge msg-fresh' : 'msg-edge',
        style: { stroke: messageColor, strokeWidth: 1.8, strokeDasharray: messageDash, strokeLinecap: 'round' },
        markerEnd: { type: MarkerType.ArrowClosed, color: messageColor }
      })
    }
    return [...agentEdges, ...groupEdges, ...messageEdges.values()]
  }, [visibleAgents, groups, groupParent, roleColor, messages, msgNow, agentsById, agentLookup, neutralRoleColor, edgeType, station, roundedCorners, options.nodeStyle, reducedMotion, groupEdgeColor, messageColor, edgeMix, edgeInk, edgeDoneOpacity, liveDash, messageDash, positions, agentSize, groupSize, nodeDims.dims, options.layout])

  const onNodeClick: NodeMouseHandler<CanvasNode> = useCallback((_e, node) => selectAgent(node.id), [selectAgent])

  // A selected "done" group lists its reports in the side panel.
  const finishedGroup: FinishedGroup | undefined = useMemo(() => {
    if (!selectedAgentId?.startsWith('group:')) return undefined
    const parentId = selectedAgentId.slice('group:'.length)
    const members = groups.get(parentId)
    if (!members) return undefined
    return {
      parentName: groupParentName(parentId),
      agents: members,
      // Members deeper than a direct report say which agent they ran under (earlier sessions: never).
      underOf: (a) => (isEarlierKey(parentId) || !a.parentId || a.parentId === parentId ? undefined : (lookupLabel(agentLookup.get(a.parentId)) ?? 'an earlier agent')),
      onPick: (id) => selectAgent(id),
      onExpand: () => expandGroup(parentId)
    }
  }, [selectedAgentId, groups, selectAgent, expandGroup, groupParentName, agentLookup])
  const finishedCount = [...groups.values()].reduce((n, g) => n + g.length, 0)

  // What Send does (model 3): reply while the session is open; on the chain's newest ended run it continues the
  // conversation; a run with no saved session can only start a new run. An assistant (virtual project) that cannot
  // continue is over and a new session starts from the start page.
  const sendMode: 'reply' | 'continue' | 'new' = sessionOpen ? 'reply' : canContinue ? 'continue' : 'new'
  // L4: the danger Banner names the error, so the mode line does not repeat it.
  const endedCopy = sendMode === 'reply' ? undefined : endedComposerCopy(run.summary, { continuable: canContinue, cutWhile: run.cutWhile, errorShown: !!run.summary.error })
  const openCardCount = (run.ruleRequests?.length ?? 0) + (run.questions?.length ?? 0) + run.proposals.length + (run.mergeReviews?.length ?? 0) + run.permissions.length + (run.mcpInstalls?.length ?? 0)
  const modeLabel =
    sendMode === 'reply'
      ? asAssistant && !isSetupRun
        ? assistantModeLabel({ status, openCards: openCardCount })
        : isSetupRun
        ? 'Answering the Architect'
        : `Replying to ${rootName}`
      : status === 'paused' && sendMode === 'continue'
        ? 'Paused at a usage limit. Send to continue with its memory.'
        : (endedCopy?.modeLabel ?? '')
  const primaryLabel = sendMode === 'new' ? 'Start' : 'Send'
  const placeholder =
    sendMode === 'reply'
      ? isSetupRun
        ? 'Your answer'
        : asAssistant
          ? ASSISTANT_REPLY_LABEL
          : 'Your reply'
      : (endedCopy?.placeholder ?? '')

  // Install approval cards: open ones first (one expanded, the rest collapsed), answered ones until dismissed.
  const openInstalls = run.mcpInstalls ?? []
  const resolvedInstalls = Object.values(run.mcpResolved ?? {}).filter((r) => !dismissedInstalls[r.request.id])
  const cardItems: { request: McpInstallRequest; outcome?: McpInstallOutcome }[] = [
    ...openInstalls.map((request) => ({ request })),
    ...resolvedInstalls.map((r) => ({ request: r.request, outcome: r.outcome }))
  ]

  // The decisions region resizes the canvas; re-fit once it settles.
  const cardsKey =
    cardItems.map((c) => `${c.request.id}:${c.outcome ? 'r' : 'o'}`).join('|') +
    `/${run.permissions.length}.${run.proposals.length}.${run.questions?.length ?? 0}.${run.ruleRequests?.length ?? 0}.${run.mergeReviews?.length ?? 0}.${status === 'paused' ? 'p' : ''}`
  useEffect(() => {
    const t = setTimeout(() => {
      // An expanded proposal in a compact frame takes the stage's room (height 0): nothing to fit then.
      if (stageHidden()) return
      // A tray or panel glide is still resizing the stage: refit once when it settles.
      if (isLayoutMoving()) {
        refitPending.current = true
        return
      }
      void fitView(fitOpts({ duration: fitMs(reducedMotion) }))
    }, 80)
    return () => clearTimeout(t)
  }, [cardsKey, fitView])

  // Focus the first decision button (the primary one when there is one); the tray itself is the fallback (tabIndex -1).
  const focusDecision = useCallback((): void => {
    const region = bodyRef.current?.querySelector<HTMLElement>('.frame-tray')
    if (!region) return
    // A folded proposal in a compact frame lands on Details: the user must see what Approve covers first.
    const details = region.querySelector<HTMLElement>('.decision-card[data-focus-details="true"] .decision-details')
    const foldedDetails = details && details.offsetParent !== null && details.getAttribute('aria-expanded') !== 'true' ? details : null
    const target =
      foldedDetails ??
      region.querySelector<HTMLElement>('.decision-footer .btn.primary:not([disabled])') ??
      region.querySelector<HTMLElement>('button:not([disabled]), textarea, input, select') ??
      region
    target.focus()
    target.scrollIntoView?.({ block: 'nearest' })
  }, [])

  // A jump from the sidebar's "Needs you" list asks the first decision of this run to take focus.
  useEffect(() => {
    if (!pendingFocus) return
    // A jump from the Needs-you list names the decision: show that card, then move focus into it.
    const request = useAppStore.getState().pendingDecisionRequest
    if (request) setPickedDecision(request)
    const t = setTimeout(
      () => {
        focusDecision()
        clearDecisionFocus()
      },
      request ? 60 : 0
    )
    return () => clearTimeout(t)
  }, [pendingFocus, clearDecisionFocus, focusDecision])

  // Ctrl+. or Alt+D jumps to the pending decision from anywhere on this run (spec 12.1, N4).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const jump = (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.key === '.') || (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && e.key.toLowerCase() === 'd')
      // No tray guard: with nothing waiting the registered handler answers "No decision is waiting on this run.".
      if (!jump) return
      e.preventDefault()
      runMenuAction('go-to-decision')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Application menu handlers (docs/design/ux-review-menu.md H2): the canvas actions only this view can run. The refs
  // carry the latest state so the registration happens once per mounted run view, not on every render.
  const menuRef = useRef({ conversation: false, hasDecision: false, toggleCollapse: () => {}, toggleLayout: () => {} })
  useEffect(() => {
    const NO_CANVAS = 'Open a run on Live to use the canvas.'
    const onCanvas = (run: () => void): string | void => {
      const m = menuRef.current
      if (m.conversation || (canvasRef.current?.querySelector('.frame-stage')?.clientHeight ?? 1) < 8) return NO_CANVAS
      run()
    }
    const offs = [
      registerMenuHandler('canvas-zoom-in', () => onCanvas(() => officeModeRef.current ? officeRef.current?.zoomIn() : zoomInCanvas({ zoomIn }, reducedRef.current))),
      registerMenuHandler('canvas-zoom-out', () => onCanvas(() => officeModeRef.current ? officeRef.current?.zoomOut() : zoomOutCanvas({ zoomOut }, reducedRef.current))),
      registerMenuHandler('canvas-fit', () => onCanvas(() => officeModeRef.current ? officeRef.current?.fit() : fitCanvas({ fitView }, reducedRef.current))),
      registerMenuHandler('toggle-hide-finished', () => officeModeRef.current ? 'All agents are shown in Pocket Office.' : onCanvas(() => menuRef.current.toggleCollapse())),
      registerMenuHandler('toggle-conversation', () => menuRef.current.toggleLayout()),
      registerMenuHandler('go-to-decision', () => {
        if (!menuRef.current.hasDecision || !bodyRef.current?.querySelector('.frame-tray')) return 'No decision is waiting on this run.'
        focusDecision()
      })
    ]
    return () => offs.forEach((off) => off())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomIn, zoomOut, fitView, focusDecision])

  // Re-fit when the canvas container itself changes size (window resize, side panel, decisions region).
  const canvasRef = useRef<HTMLDivElement>(null)
  const reducedRef = useRef(reducedMotion)
  const refitPending = useRef(false)
  reducedRef.current = reducedMotion
  useEffect(() => {
    const el = canvasRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let t: ReturnType<typeof setTimeout> | undefined
    let first = true
    const parent = el.closest('.run-body')
    let wide = parent?.getAttribute('data-side-wide') === 'true'
    const ro = new ResizeObserver(() => {
      if (first) {
        first = false
        return
      }
      // A wide/narrow panel layout switch moves the composer; it must not re-zoom the chart.
      const nowWide = parent?.getAttribute('data-side-wide') === 'true'
      if (nowWide !== wide) {
        wide = nowWide
        return
      }
      clearTimeout(t)
      t = setTimeout(() => {
        if (stageHidden()) return
        // The sidebar, side panel or tray is gliding: no refit per frame, one when it settles (lib/layoutMotion.ts).
        if (isLayoutMoving()) {
          refitPending.current = true
          return
        }
        void fitView(fitOpts({ duration: reducedRef.current ? 0 : 150 }))
      }, 100)
    })
    const unsettled = onLayoutSettled(() => {
      if (!refitPending.current) return
      refitPending.current = false
      if (stageHidden()) return
      void fitView(fitOpts({ duration: reducedRef.current ? 0 : 150 }))
    })
    ro.observe(el)
    // An expanded proposal in a compact frame collapses the stage to height 0 (the canvas stays mounted, nothing floats).
    // Refit only when the stage comes back; while it is collapsed there is nothing to fit.
    const stage = el.querySelector('.frame-stage')
    let stageShown = (stage?.clientHeight ?? 1) >= 8
    const so = stage ? new ResizeObserver(() => {
      const shown = stage.clientHeight >= 8
      if (shown === stageShown) return
      stageShown = shown
      if (!shown) return
      clearTimeout(t)
      t = setTimeout(() => { if (!stageHidden()) void fitView(fitOpts({ duration: 0 })) }, 100)
    }) : null
    if (stage) so?.observe(stage)
    return () => {
      clearTimeout(t)
      unsettled()
      ro.disconnect()
      so?.disconnect()
    }
  }, [fitView])

  // Keyboard zoom while the canvas has focus: + / - and 0 to fit (the toolbar buttons do the same).
  const onCanvasKey = (e: React.KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    // Enter / Space on a focused node select it even when it already looks selected (a done group holding the
    // selected agent): React Flow only emits a 'select' change for an unselected node. Buttons inside a node keep the key.
    const target = e.target as HTMLElement
    if ((e.key === 'Enter' || e.key === ' ') && target.classList.contains('react-flow__node')) {
      const nodeId = target.getAttribute('data-id')
      if (nodeId && useAppStore.getState().selectedAgentId !== nodeId) selectAgent(nodeId)
      return
    }
    if (e.key === '+' || e.key === '=') void zoomIn({ duration: reducedMotion ? 0 : 150 })
    else if (e.key === '-' || e.key === '_') void zoomOut({ duration: reducedMotion ? 0 : 150 })
    else if (e.key === '0' && !stageHidden()) void fitView(fitOpts({ duration: reducedMotion ? 0 : 150 }))
  }

  const selectedAgent = selectedAgentId ? agentLookup.get(selectedAgentId) : undefined
  const rootAgent = useMemo(() => agents.find((a) => a.parentId === null), [agents])
  // The root's transcript is the whole conversation: every session's root entries with a divider where each
  // continuation starts (model 2). Another agent's transcript is that one session's entries.
  const feed = useMemo(
    () =>
      mergeChainFeed(
        upto.map((m) => ({
          summary: m.summary,
          entries: m.transcript.filter((e) => e.agentId === (Object.values(m.agents).find((a) => a.parentId === null)?.id ?? 'root'))
        }))
      ),
    [upto]
  )
  const entries = useMemo(() => {
    if (!selectedAgentId) return []
    const from = chain.origin.get(selectedAgentId)
    if (from) return (upto.find((m) => m.summary.id === from.runId)?.transcript ?? []).filter((e) => e.agentId === from.agentId)
    return run.transcript.filter((e) => e.agentId === selectedAgentId)
  }, [run.transcript, upto, chain.origin, selectedAgentId])
  const rootSelected = !!selectedAgent && selectedAgent.parentId === null
  // M-3: a feed already at its cap would cut what an earlier load adds, so the button is not offered then.
  const loadEarlierRow =
    earlierToLoad > 0 && feed[0]?.kind !== 'omitted' ? (
      <div className="chain-load-earlier" ref={loadEarlierRef}>
        <Button
          variant="ghost"
          size="sm"
          testId="chain-load-earlier"
          onClick={() => {
            // Never disabled while loading: a disabled button would drop keyboard focus.
            if (loadingEarlier) return
            setLoadingEarlier(true)
            // The feed's scroll area: focus lands there when the button goes away (everything loaded).
            const host = loadEarlierRef.current?.closest<HTMLElement>('.conversation-list, .transcript')
            void loadEarlierSessions(runId).finally(() => {
              setLoadingEarlier(false)
              requestAnimationFrame(() => {
                if (!host?.isConnected || host.contains(document.activeElement)) return
                if (host.tabIndex < 0) host.tabIndex = -1
                host.focus({ preventScroll: true })
              })
            })
          }}
        >
          {loadingEarlier ? 'Loading earlier sessions…' : `Load earlier sessions (${earlierToLoad})`}
        </Button>
      </div>
    ) : null
  // A new chain member to show (after Send, End session, History): clear the request when it has no divider to scroll to.
  useEffect(() => {
    if (!chainFocusRun) return undefined
    const t = setTimeout(() => useAppStore.setState((st) => (st.chainFocusRun === chainFocusRun ? { chainFocusRun: null } : {})), 2500)
    return () => clearTimeout(t)
  }, [chainFocusRun])

  // Every open decision as one card; the tray lists them all and shows one at a time. The newest is selected.
  const who = (agentId: string): string => run.agents[agentId]?.name ?? 'An agent'
  const short = (t: string, n = 40): string => {
    const c = Array.from(oneLine(t, 10_000))
    return c.length > n ? `${c.slice(0, n - 1).join('')}…` : c.join('')
  }
  const decisionItems: DecisionItem[] = [
    ...(run.ruleRequests ?? []).map((r) => ({
      key: r.id,
      label: `Rules: ${short(r.rules.join(', '))}`,
      node: <RuleRequestCard runId={runId} request={r} who={who(r.agentId)} onDecide={(d) => decideRules(r.id, d)} />
    })),
    ...(run.questions ?? []).map((q) => ({
      key: q.id,
      label: `Question: ${short(q.question)}`,
      node: <QuestionCard runId={runId} question={q} who={isSetupRun ? 'The Architect' : who(q.agentId)} onAnswer={(a) => answerQuestion(q.id, a)} />
    })),
    ...run.proposals.map((p) => ({
      key: p.id,
      label: `${proposalKindLabel(p.kind, projectKindOf(project))}: ${short(p.title)}`,
      node: <ProposalCard runId={runId} who={isSetupRun ? 'The Architect' : who(p.agentId)} agentId={isSetupRun ? undefined : p.agentId} proposal={p} currentRoles={project.roles} onDecide={(d) => trackProposal(p, d)} />
    })),
    ...(run.mergeReviews ?? []).map((m) => ({
      key: m.id,
      label: `Merge ${short(m.agentName, 24)}`,
      node: <MergeReviewCard runId={runId} review={m} onDecide={(d) => decideMerge(m.id, d)} />
    })),
    ...run.permissions.map((p) => ({
      key: p.id,
      label: short(permissionTitle(p.toolName, p.input)),
      node: <PermissionCard runId={runId} request={p} who={who(p.agentId)} onDecide={(d) => decide(p.id, d)} />
    })),
    ...cardItems.map((it) => ({
      key: it.request.id,
      label: `Install ${short(it.request.spec.name, 28)}`,
      node: (
        <McpInstallCard
          runId={runId}
          request={it.request}
          agentName={who(it.request.agentId)}
          resolved={it.outcome}
          onDismiss={() => setDismissedInstalls((d) => ({ ...d, [it.request.id]: true }))}
        />
      )
    }))
  ]
  // Answered install records sit first so a real decision is never hidden behind one.
  const isRecord = (key: string): boolean => resolvedInstalls.some((r) => r.request.id === key)
  decisionItems.sort((a, b) => Number(isRecord(b.key)) - Number(isRecord(a.key)))
  const pickedAt = decisionItems.findIndex((d) => d.key === pickedDecision)
  // Until the user picks one, the tray shows the first open decision (blocking kinds first), not the newest arrival.
  const firstPending = defaultDecisionIndex(
    decisionItems.map((d) => d.key),
    isRecord
  )
  const selectedDecision = pickedAt >= 0 ? pickedAt : firstPending
  const shownKey = decisionItems[selectedDecision]?.key ?? null
  // The newest decision is shown until the user touches the tray; then that card stays put when later requests arrive.
  const pinShown = (): void => {
    if (shownKey && shownKey !== pickedDecision) setPickedDecision(shownKey)
  }

  // One short polite line when a new decision arrives. The tray itself is not a live region: expanding Details would
  // otherwise read a whole proposal body aloud.
  const seenDecisions = useRef<{ runId: string; keys: Set<string> } | null>(null)
  const decisionKeys = decisionItems.map((d) => d.key).join('|')
  const toggleRunLayout = (): void => {
    const next = conversation ? 'canvas' : 'conversation'
    setToggledTo(next)
    window.clearTimeout(toggleTimer.current)
    toggleTimer.current = window.setTimeout(() => setToggledTo(null), 400)
    setRunLayout(runId, next)
  }
  menuRef.current = { conversation, hasDecision: decisionItems.length > 0, toggleCollapse, toggleLayout: () => toggleRunLayout() }
  useEffect(() => {
    const prior = seenDecisions.current
    const now = new Set(decisionItems.filter((d) => !isRecord(d.key)).map((d) => d.key))
    seenDecisions.current = { runId, keys: now }
    // First look at a run (or a different run in this view): what is already open is not an arrival.
    if (!prior || prior.runId !== runId) {
      setArrival(undefined)
      return
    }
    const seen = prior.keys
    const fresh = decisionItems.find((d) => now.has(d.key) && !seen.has(d.key))
    if (fresh) setArrival((a) => ({ text: `New decision: ${fresh.label}`, n: (a?.n ?? 0) + 1 }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decisionKeys, runId])

  // What the user approved in this view; the setup banner only claims what was actually applied.
  const trackProposal = async (p: Proposal, d: ProposalDecision): Promise<void> => {
    await decideProposal(p.id, d)
    if (d.behavior === 'approve') setApprovedKinds((k) => (k.includes(p.kind) ? k : [...k, p.kind]))
  }

  // Walk M2 (ux-review-org-change-session-pre.md): never on a run cut off by a quit, and an org change needs an approval.
  const setupDone = setupBannerShows({ summary: run.summary,setupComplete: project.setup?.state === 'complete', cut: !!run.cutWhile, approved: approvedKinds })
  const orgChangeRun = isOrgChangeRun(run.summary)

  return (
    <div className="run-view">
      {!sessionOpen && run.summary.error && (
        <Banner tone="danger" testId="run-error" title="This run failed">
          {run.summary.error}
        </Banner>
      )}
      {setupDone && (
        <Banner
          tone="success"
          testId="setup-complete"
          title={orgChangeRun ? orgChangeBannerTitle(approvedKinds, projectKindOf(project)) : `Setup complete: ${[project.setup?.architecturePath ? 'architecture' : '', `${project.roles.length} role${project.roles.length === 1 ? '' : 's'}`, approvedKinds.includes('settings') ? 'settings applied' : ''].filter(Boolean).join(', ')}`}
          actions={
            <>
              <Button size="sm" variant="primary" onClick={() => setView('team')}>
                Open Team
              </Button>
              {sessionOpen && (
                <Button size="sm" onClick={() => void stopRun()} title="Ends the setup session.">
                  End session
                </Button>
              )}
            </>
          }
        >
          {orgChangeRun ? 'Review or adjust the changes on the Team tab.' : 'The Architect is done. Review or adjust what it set up on the Team tab.'}
        </Banner>
      )}
      <div className="run-body" ref={bodyRef} data-layout={layout}>

        <CanvasFrame frameRef={canvasRef} announcement={arrival}>
          <FrameToolbar dense label="Canvas toolbar">
            <RunMeta run={run} project={project} agentCount={agents.length + chain.earlier.reduce((n, g) => n + g.agents.length, 0)} />
            <div className="frame-toolbar-end">
              {!conversation && options.presentation !== 'pocket-office' && (agents.length > 1 || chain.earlier.length > 0) && (
                <span className="run-fold" title="Folds finished agents into one node under the agent still shown above them. Turn off to show every agent; turn on again to fold everything back.">
                  <Switch
                    checked={collapseFinished}
                    onChange={toggleCollapse}
                    label="Hide finished agents"
                    title={collapseFinished && finishedCount ? `Hide finished agents (${finishedCount} hidden)` : 'Hide finished agents'}
                  />
                  <span className="fold-label" aria-hidden="true">
                    <span className="fold-long">Hide finished agents</span>
                    <span className="fold-short">Hide finished</span>
                    {collapseFinished && finishedCount ? ` (${finishedCount})` : ''}
                  </span>
                </span>
              )}
              {!conversation && (options.presentation === 'pocket-office' ? <CanvasStyleButton testId="canvas-style-button" /> : <CanvasTools />)}
              {!conversation && options.presentation === 'pocket-office' && earlierToLoad > 0 && (
                <Button size="sm" loading={loadingEarlier} onClick={() => {
                  if (loadingEarlier) return
                  setLoadingEarlier(true)
                  void loadEarlierSessions(runId).finally(() => {
                    setLoadingEarlier(false)
                    requestAnimationFrame(() => bodyRef.current?.querySelector<HTMLElement>('[data-office-agent-id]')?.focus())
                  })
                }}>Load earlier sessions ({earlierToLoad})</Button>
              )}
              <IconButton
                icon={conversation ? Network : MessageSquare}
                label={conversation ? 'Show agents' : 'Show conversation'}
                size="sm"
                testId="run-layout-toggle"
                onClick={toggleRunLayout}
              />
            </div>
          </FrameToolbar>
          <FrameStage>
            {conversation ? (
              <div className={`conversation-stage${toggledTo === 'conversation' ? ' motion-view' : ''}`} data-testid="run-conversation">
                <TranscriptPanel variant="conversation" runId={runId} tagRunId={chainIds[chainIds.length - 1]} agent={rootAgent} entries={[]} feed={feed} lead={loadEarlierRow} logs={[]} />
              </div>
            ) : options.presentation === 'pocket-office' ? (
              <OfficeScene mode="live" runId={runId} palette={options.scenePalette} controlRef={officeRef} agents={withOfficeDepartments([...agentLookup.values()].map((agent) => ({ ...officeAgentView(agent), parentId: agent.parentId, departmentContext: chain.origin.has(agent.id) ? `Earlier session ${chainSummaries.findIndex((m) => m.id === chain.origin.get(agent.id)?.runId) + 1}` : undefined, context: [chain.origin.has(agent.id) ? `Earlier session ${chainSummaries.findIndex((m) => m.id === chain.origin.get(agent.id)?.runId) + 1}` : 'Current session', agent.parentId ? `Reports to ${agentLookup.get(agent.parentId) ? agentLabel(agentLookup.get(agent.parentId)!) : 'lead'}` : 'Lead'].join(' · ') })))} messages={messages ?? []} selectedId={selectedAgentId ?? undefined} onSelect={selectAgent} />
            ) : (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={CANVAS_EDGE_TYPES}
              data-layout={options.layout}
              className={toggledTo === 'canvas' ? 'motion-view' : undefined}
              onNodesChange={onNodesChange}
              onNodeClick={onNodeClick}
              onPaneClick={() => selectAgent(null)}
              nodesConnectable={false}
              elementsSelectable
              fitView
              fitViewOptions={{ padding: radial ? 0.12 : 0.25, maxZoom: 1 }}
              proOptions={{ hideAttribution: true }}
              deleteKeyCode={null}
              edgesFocusable={false}
              minZoom={0.3}
              onKeyDown={onCanvasKey}
            >
              <CanvasBackdrop rings={placed.rings} />
              <CanvasMinimap ariaLabel="Run minimap" />
            </ReactFlow>
            )}
          </FrameStage>
          <FrameTray label="Decisions" shortcutHint="Ctrl+. or Alt+D jumps to the first decision button" shortcutKeys="Control+Period Alt+D">
          {status === 'paused' && <PauseBanner runId={runId} />}

          {status !== 'paused' && run.plan?.status === 'blocked' && (
            <div className="pause-banner plan-blocked-banner">
              <div className="pause-title">
                <span className="dot" /> The orchestrator needs your decision
              </div>
              <div className="pause-reason">{run.plan.blockedReason ?? 'It marked the plan blocked.'}</div>
              <div className="pause-when">
                Automatic continues are stopped. {sessionOpen || canContinue ? 'Answer below; the orchestrator resumes the plan with your reply.' : ''}
              </div>
              <div className="row gap-2">
                {(sessionOpen || canContinue) && (
                  <Button variant="primary" size="sm" onClick={() => focusComposer()}>
                    Answer
                  </Button>
                )}
                <Button variant="secondary" size="sm" onClick={() => setSideTab('plan')}>
                  Show the plan
                </Button>
              </div>
            </div>
          )}

          <DecisionTray items={decisionItems} selected={selectedDecision} onSelect={(i) => setPickedDecision(decisionItems[i].key)} onPin={pinShown} />
        </FrameTray>
        </CanvasFrame>

        <div className="live-composer-region">
        {!successor && (
          <LiveModelSwitch
            key={runId}
            run={run.summary}
            onRunChanged={(summary) => {
              if (summary.id !== runId) {
                void openRun(summary.id).then(() => focusComposer())
                return
              }
              useAppStore.setState((state) => {
                const current = state.runs[summary.id]
                return current ? { runs: { ...state.runs, [summary.id]: { ...current, summary } } } : {}
              })
            }}
          />
        )}
        {successor && newestRun && newestRun.id !== runId ? (
          <div className="composer composer-ended" data-testid="composer-superseded">
            <div className="composer-notice info">
              This conversation continues in {displayRunName(newestRun)}.
            </div>
            <Button variant="secondary" size="sm" testId="go-to-latest" onClick={() => void openRun(newestRun.id).then(() => focusComposer())}>
              Go to latest
            </Button>
          </div>
        ) : virtualId && sendMode === 'new' ? (
          <div className="composer composer-ended" data-testid="assistant-ended">
            <p className="composer-ended-text">{virtualId === 'quick' ? 'This chat has ended.' : 'This session has ended.'}</p>
            <Button
              variant="secondary"
              size="sm"
              testId="assistant-new-session"
              onClick={() => {
                useAppStore.getState().openDraft()
              }}
            >
              {newSessionLabel(virtualId)}
            </Button>
          </div>
        ) : (
        <Composer
          draftKey={chainIds[chainIds.length - 1]}
          modeLabel={modeLabel}
          primaryLabel={primaryLabel}
          placeholder={placeholder}
          focusToken={composerFocusToken}
          autoFocus={continueIntent}
          notices={
            <>
              {endedCopy?.notice && (
                <div className="composer-notice cut" data-testid="composer-cut-notice">
                  {endedCopy.notice}
                </div>
              )}
              {sessionBlock && (
                <div className="composer-notice" role="alert">
                  {sessionBlock.message}
                  <button type="button" className="link-btn" onClick={() => void openRun(sessionBlock.runId)}>
                    Open that run
                  </button>
                </div>
              )}
            </>
          }
          onSubmit={async (text, images) => {
            setSessionBlock(null)
            if (sendMode === 'reply') await sendMessage(text, images)
            else if (sendMode === 'continue') await continueRun(runId, text, images)
            else if (!virtualId) await startRun(text, images ? { images } : undefined)
          }}
          onFail={(err) => {
            const message = err instanceof Error ? err.message : ''
            const liveId = sessionOpenRunId(message)
            if (!liveId) return false
            setSessionBlock({ message: message.replace(/^(Error invoking remote method '[^']*': )?(Error: )?/, ''), runId: liveId })
            return true
          }}
        />
        )}

        </div>
        <SidePanel label="run panel" autoCollapseBelow={1100} persistKey="run" revealOn={selectedAgentId} arrival={usageArrival}>
          <div className="live-panel">
            <TranscriptPanel
              runId={runId}
              tagRunId={chainIds[chainIds.length - 1]}
              agent={selectedAgent ?? (conversation ? rootAgent : undefined)}
              entries={selectedAgent && !rootSelected ? entries : []}
              feed={rootSelected || (!selectedAgent && conversation) ? feed : undefined}
              lead={conversation ? undefined : loadEarlierRow}
              logs={run.logs ?? []}
              finished={finishedGroup}
            />
          </div>
        </SidePanel>
      </div>
    </div>
  )
}

/** Zoom out, zoom in, fit and the legend: the canvas controls, in the toolbar so nothing sits on the canvas. */
function CanvasTools(): ReactElement {
  const { zoomIn, zoomOut, fitView } = useReactFlow()
  const reduced = useReducedMotion()
  const options = useCanvasOptions()
  const station = options.nodeStyle === 'station'
  const stageShown = (): boolean => (document.querySelector('.frame-stage')?.clientHeight ?? 1) >= 8
  return (
    <span className="canvas-tools">
      <span className="zoom-group" role="group" aria-label="Canvas zoom">
        <IconButton icon={ZoomOut} label="Zoom out" size="sm" onClick={() => zoomOutCanvas({ zoomOut }, reduced)} />
        <IconButton icon={ZoomIn} label="Zoom in" size="sm" onClick={() => zoomInCanvas({ zoomIn }, reduced)} />
        <IconButton icon={Maximize} label="Fit to view" size="sm" onClick={() => stageShown() && fitCanvas({ fitView }, reduced)} />
      </span>
      <CanvasStyleButton testId="canvas-style-button" />
      <Popover
        label="Canvas legend"
        placement="bottom-end"
        triggerClassName="icon-btn size-sm"
        triggerLabel="Canvas legend"
        trigger={<Icon icon={CircleHelp} size="sm" />}
        testId="canvas-legend"
        triggerTestId="canvas-legend-trigger"
      >
        <ul className="legend-list">
          <li>
            <span className="legend-shape">
              <span className="legend-ring" />
            </span>
            Working
          </li>
          <li>
            <span className="legend-shape legend-warn">
              <Icon icon={Bell} size="sm" />
            </span>
            Needs you
          </li>
          <li>
            <span className="legend-shape legend-ok">
              {station ? <span className="legend-dot" aria-hidden="true" /> : <Icon icon={CircleCheck} size="sm" />}
            </span>
            Finished
          </li>
          <li>
            <span className="legend-shape legend-bad">
              <Icon icon={TriangleAlert} size="sm" />
            </span>
            Failed
          </li>
          <li>
            <span className="legend-shape">
              <span className="legend-selected" />
            </span>
            Selected
          </li>
          <li>
            <span className="legend-shape legend-wide">
              <span className="legend-folded" data-style={options.nodeStyle} aria-hidden="true">3 done</span>
            </span>
            Folded finished agents
          </li>
          <li>
            <span className="legend-shape legend-wide">
              <span className={station ? 'legend-report legend-report-station' : 'legend-report'} />
            </span>
            {station ? "Reporting line (the lead's colour)" : 'Reporting line'}
          </li>
          <li>
            <span className="legend-shape legend-wide">
              <span className="legend-line" />
            </span>
            Message between agents
          </li>
        </ul>
      </Popover>
    </span>
  )
}

/** A run paused at a usage limit: why, when it continues, and the controls for that. */
function PauseBanner({ runId }: { runId: string }): ReactElement | null {
  const summary = useAppStore((s) => s.runs[runId]?.summary)
  const resumeNow = useAppStore((s) => s.resumeNow)
  const cancelAutoResume = useAppStore((s) => s.cancelAutoResume)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  if (!summary) return null
  const until = summary.pausedUntil
  const act = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pause-banner">
      <div className="pause-title">
        <span className="dot" /> Paused at a usage limit
      </div>
      <div className="pause-reason">{summary.pauseReason ?? 'The plan usage limit was reached.'} Only this run is paused; your other runs keep running unaffected.</div>
      <div className="pause-when">
        {summary.autoResume && until
          ? `Auto-resume at ${new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (in ${formatUntil(until, now)})`
          : `Auto-resume is off.${until ? ` The window resets at ${new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : ''} Continue it from the composer when you are ready.`}
      </div>
      {error && <div className="pause-error">{error}</div>}
      <div className="row gap-2">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void act(() => resumeNow(runId))}>
          Resume now
        </Button>
        {summary.autoResume && (
          <Button size="sm" disabled={busy} onClick={() => void act(() => cancelAutoResume(runId))}>
            Cancel auto-resume
          </Button>
        )}
      </div>
    </div>
  )
}
