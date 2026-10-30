import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  useReactFlow,
  ReactFlowProvider,
  type Edge,
  type NodeMouseHandler
} from '@xyflow/react'
import type { AgentInstance, McpInstallOutcome, McpInstallRequest, Project } from '@shared/types'
import McpInstallCard from '../components/McpInstallCard'
import { Badge } from '../components/ui/Badge'
import { activeRun, isRunLive, useAppStore, useProjectSummaries } from '../store/useAppStore'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { Button } from '../components/ui/Button'
import { canContinue as chainCanContinue, continuedBy, relativeTime, sessionOpenRunId } from '../lib/runChains'
import { AgentNode, MSG_IN, MSG_OUT, type AgentFlowNode } from '../components/AgentNode'
import { DoneGroupNode, GROUP_H, GROUP_W, groupId, type DoneGroupFlowNode } from '../components/DoneGroupNode'
import type { FinishedGroup } from '../components/FinishedList'
import TranscriptPanel from '../components/TranscriptPanel'
import ProposalCard from '../components/ProposalCard'
import QuestionCard from '../components/QuestionCard'
import RuleRequestCard from '../components/RuleRequestCard'
import MergeReviewCard from '../components/MergeReviewCard'
import { SidePanel } from '../components/layout/SidePanel'
import { CanvasFrame, FrameFooter, FrameStage, FrameTray } from '../components/layout/CanvasFrame'
import RunTabs from '../components/RunTabs'
import RunHeader from '../components/RunHeader'
import NewRunPage from '../components/NewRunPage'
import Composer from '../components/Composer'
import { Decision } from '../components/RunLabel'
import { formatUntil, treeLayout } from '../lib/layout'
import { ancestorsOf, hasLiveDescendant, normalizeParents } from '../lib/agentTree'

const nodeTypes = { agent: AgentNode, 'done-group': DoneGroupNode }
const NODE_W = 240
const NODE_H = 112
const LIVE_STATES = new Set(['starting', 'thinking', 'tool', 'delegating', 'waiting'])
/** A finished report keeps its own node this long before folding into its parent's "done" group. */
const COLLAPSE_GRACE_MS = 6000
const SETTLED_WORKTREE = new Set(['merged', 'empty', 'removed', 'held', 'conflict'])
const COLLAPSE_KEY = 'orgai.collapseFinished'
/** An agent-to-agent message stays drawn this long. */
const MESSAGE_EDGE_MS = 12_000
/** Message edges reuse the accent text token until the design system names a message color. */
const MESSAGE_COLOR = 'var(--accent-text)'
const NEUTRAL_ROLE_COLOR = 'var(--text-tertiary)'

type CanvasNode = AgentFlowNode | DoneGroupFlowNode

/** True once a report has reported back and nothing is still happening to its branch. */
function isSettled(a: AgentInstance, now: number): boolean {
  if (a.state !== 'done' && a.state !== 'error') return false
  if (a.worktree && !SETTLED_WORKTREE.has(a.worktree.status)) return false
  return now - (a.endedAt ?? now) >= COLLAPSE_GRACE_MS
}

function readCollapsePref(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) !== 'off'
  } catch {
    return true
  }
}

/**
 * The project's run workspace: run tabs on top, then either one run (header, decisions, canvas, composer, side
 * panel) or the blank New run page. Each run is keyed, so its local state (images, folded groups, picked installs,
 * the session block) never leaks into another run.
 */
export default function LiveRunView({ project }: { project: Project }): ReactElement {
  const runId = useAppStore((s) => activeRun(s)?.summary.id)
  const hasWorkspace = useAppStore((s) => !!s.draftPage[project.id] || !!s.activeRunByProject[project.id])
  const ensureWorkspace = useAppStore((s) => s.ensureWorkspace)

  // A project opened without a workspace (e.g. straight after creation) picks its newest run or the New run page.
  useEffect(() => {
    if (!hasWorkspace) void ensureWorkspace()
  }, [project.id, hasWorkspace, ensureWorkspace])

  return (
    <div className="run-workspace">
      <RunTabs project={project} />
      <div className="run-panel" id="run-panel" role="tabpanel" aria-labelledby={`run-tab-${runId ?? 'new'}`}>
        {runId ? (
          <ReactFlowProvider key={`${project.id}:${runId}`}>
            <RunView project={project} runId={runId} />
          </ReactFlowProvider>
        ) : (
          <NewRunPage key={`new:${project.id}`} project={project} />
        )}
      </div>
    </div>
  )
}

function RunView({ project, runId }: { project: Project; runId: string }): ReactElement {
  const run = useAppStore((s) => s.runs[runId])
  const selectedAgentId = useAppStore((s) => s.selectedAgentId)
  const selectAgent = useAppStore((s) => s.selectAgent)
  const startRun = useAppStore((s) => s.startRun)
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
  const pendingFocus = useAppStore((s) => s.pendingDecisionFocus === runId)
  const clearDecisionFocus = useAppStore((s) => s.clearDecisionFocus)
  const { fitView } = useReactFlow()

  /** The runtime refused a Continue because the session is open in another live run. */
  const [sessionBlock, setSessionBlock] = useState<{ message: string; runId: string } | null>(null)
  /** What Send does on a finished run: a new run (default) or the explicit Continue. */
  const continueIntent = useAppStore((s) => s.continueIntent === runId)
  const [finishedChoice, setFinishedChoice] = useState<'new' | 'continue'>(continueIntent ? 'continue' : 'new')
  useEffect(() => {
    // History's Continue sets the intent just before the view mounts; it is consumed once.
    if (!continueIntent) return
    setFinishedChoice('continue')
    useAppStore.setState({ continueIntent: null })
  }, [continueIntent])
  const summaries = useProjectSummaries()
  const otherOpenRuns = useAppStore((s) => Object.values(s.runs).filter((r) => r.summary.projectId === project.id && r.summary.id !== runId && isRunLive(r)).length)
  const [collapseFinished, setCollapseFinished] = useState(readCollapsePref)
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const [now, setNow] = useState(() => Date.now())
  const [msgNow, setMsgNow] = useState(() => Date.now())
  const [pickedInstall, setPickedInstall] = useState<string | null>(null)
  const [dismissedInstalls, setDismissedInstalls] = useState<Record<string, boolean>>({})
  const bodyRef = useRef<HTMLDivElement>(null)

  const toggleCollapse = (): void => {
    setCollapseFinished((v) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, v ? 'off' : 'on')
      } catch {
        /* storage unavailable */
      }
      return !v
    })
  }
  const toggleGroup = useCallback((parentId: string) => setExpandedGroups((g) => ({ ...g, [parentId]: !g[parentId] })), [])

  const isSetupRun = run.summary.kind === 'setup'
  const rootName = project.roles.find((r) => r.reportsTo === null)?.name ?? 'the orchestrator'

  const agentsById = run.agents
  const agents = useMemo(() => normalizeParents(Object.values(agentsById)), [agentsById])
  const roleColor = useCallback(
    (roleId: string | null, slug: string): string =>
      project.roles.find((r) => r.id === roleId)?.color ?? project.roles.find((r) => r.slug === slug)?.color ?? NEUTRAL_ROLE_COLOR,
    [project.roles]
  )

  // Finished reports fold into one "done" node per parent after a short grace period. A ticker keeps
  // the grace period honest while anything recently finished is still shown.
  useEffect(() => {
    const pending = agents.some((a) => (a.state === 'done' || a.state === 'error') && !isSettled(a, Date.now()))
    if (!collapseFinished || !pending) return undefined
    const t = setInterval(() => setNow(Date.now()), 1500)
    return () => clearInterval(t)
  }, [agents, collapseFinished])

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

  const { visibleAgents, groups } = useMemo(() => {
    if (!collapseFinished) return { visibleAgents: agents, groups: new Map<string, AgentInstance[]>() }
    const byId = new Map(agents.map((a) => [a.id, a]))
    const settledNow = (c: AgentInstance): boolean => isSettled(c, now)
    const groups = new Map<string, AgentInstance[]>()
    const visibleAgents: AgentInstance[] = []
    for (const a of agents) {
      const parentVisible = !a.parentId || byId.has(a.parentId)
      const foldable =
        a.parentId !== null && parentVisible && isSettled(a, now) && !hasLiveDescendant(agents, a.id, settledNow) && !expandedGroups[a.parentId as string]
      if (foldable) groups.set(a.parentId as string, [...(groups.get(a.parentId as string) ?? []), a])
      else visibleAgents.push(a)
    }
    // Hide the subtree under a folded report too; the list in the side panel still reaches them.
    const folded = new Set([...groups.values()].flat().map((a) => a.id))
    const hiddenUnder = (a: AgentInstance): boolean => ancestorsOf(byId, a.id).some((p) => folded.has(p))
    return { visibleAgents: visibleAgents.filter((a) => !hiddenUnder(a)), groups }
  }, [agents, collapseFinished, expandedGroups, now])

  // Recompute the tree layout only when the set of shown nodes or their parent links change.
  const topologyKey = [
    ...visibleAgents.map((a) => `${a.id}>${a.parentId ?? ''}`),
    ...[...groups.keys()].map((p) => `${groupId(p)}>${p}`)
  ]
    .sort()
    .join('|')
  const positions = useMemo(
    () =>
      treeLayout([
        ...visibleAgents.map((a) => ({ id: a.id, parentId: a.parentId, width: NODE_W, height: NODE_H })),
        ...[...groups.keys()].map((p) => ({ id: groupId(p), parentId: p, width: GROUP_W, height: GROUP_H }))
      ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [topologyKey]
  )

  const lastTopology = useRef('')
  useEffect(() => {
    if (topologyKey && topologyKey !== lastTopology.current) {
      lastTopology.current = topologyKey
      const t = setTimeout(() => fitView({ padding: 0.25, duration: 500, maxZoom: 1 }), 60)
      return () => clearTimeout(t)
    }
    return undefined
  }, [topologyKey, fitView])

  const nodes: CanvasNode[] = useMemo(() => {
    const agentNodes: CanvasNode[] = visibleAgents.map((agent) => ({
      id: agent.id,
      type: 'agent' as const,
      position: positions[agent.id] ?? { x: 0, y: 0 },
      selected: agent.id === selectedAgentId,
      draggable: false,
      data: { agent, color: roleColor(agent.roleId, agent.roleSlug), isRoot: agent.parentId === null }
    }))
    const groupNodes: CanvasNode[] = [...groups.entries()].map(([parentId, members]) => {
      const parent = run.agents[parentId]
      return {
        id: groupId(parentId),
        type: 'done-group' as const,
        position: positions[groupId(parentId)] ?? { x: 0, y: 0 },
        selected: selectedAgentId === groupId(parentId) || members.some((m) => m.id === selectedAgentId),
        draggable: false,
        data: { parentId, agents: members, color: parent ? roleColor(parent.roleId, parent.roleSlug) : NEUTRAL_ROLE_COLOR, onToggle: toggleGroup }
      }
    })
    return [...agentNodes, ...groupNodes]
  }, [visibleAgents, groups, positions, selectedAgentId, roleColor, run, toggleGroup])

  const edges: Edge[] = useMemo(() => {
    const shown = new Set(visibleAgents.map((a) => a.id))
    const agentEdges: Edge[] = visibleAgents
      .filter((a) => a.parentId && shown.has(a.parentId))
      .map((a) => {
        const color = roleColor(a.roleId, a.roleSlug)
        const live = LIVE_STATES.has(a.state)
        return {
          id: `e-${a.parentId}-${a.id}`,
          source: a.parentId as string,
          target: a.id,
          animated: live,
          style: { stroke: color, strokeWidth: live ? 2.2 : 1.4, opacity: a.state === 'done' ? 0.45 : 1 },
          markerEnd: { type: MarkerType.ArrowClosed, color }
        }
      })
    const groupEdges: Edge[] = [...groups.keys()]
      .filter((p) => shown.has(p))
      .map((p) => ({
        id: `e-${p}-${groupId(p)}`,
        source: p,
        target: groupId(p),
        style: { stroke: 'var(--border-strong)', strokeWidth: 1.2, strokeDasharray: '4 4' }
      }))
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
    for (const m of messages ?? []) {
      if (msgNow - m.at > MESSAGE_EDGE_MS) continue
      const source = onCanvas(m.from)
      const target = onCanvas(m.to)
      if (!source || !target || source === target) continue
      const id = `msg-${source}-${target}`
      messageEdges.set(id, {
        id,
        source,
        target,
        sourceHandle: MSG_OUT,
        targetHandle: MSG_IN,
        animated: true,
        className: 'msg-edge',
        label: 'msg',
        labelStyle: { fill: MESSAGE_COLOR, fontSize: 'var(--text-caption)' },
        labelBgStyle: { fill: 'var(--surface-0)' },
        style: { stroke: MESSAGE_COLOR, strokeWidth: 1.8, strokeDasharray: '6 4' },
        markerEnd: { type: MarkerType.ArrowClosed, color: MESSAGE_COLOR },
        zIndex: 10
      })
    }
    return [...agentEdges, ...groupEdges, ...messageEdges.values()]
  }, [visibleAgents, groups, roleColor, messages, msgNow, agentsById])

  const onNodeClick: NodeMouseHandler<CanvasNode> = useCallback((_e, node) => selectAgent(node.id), [selectAgent])

  // A selected "done" group lists its reports in the side panel.
  const finishedGroup: FinishedGroup | undefined = useMemo(() => {
    if (!selectedAgentId?.startsWith('group:')) return undefined
    const parentId = selectedAgentId.slice('group:'.length)
    const members = groups.get(parentId)
    if (!members) return undefined
    return {
      parentName: run.agents[parentId]?.name ?? 'its parent',
      agents: members,
      onPick: (id) => selectAgent(id),
      onExpand: () => toggleGroup(parentId)
    }
  }, [run, selectedAgentId, groups, selectAgent, toggleGroup])
  const finishedCount = [...groups.values()].reduce((n, g) => n + g.length, 0)

  const status = run.summary.status
  const sessionOpen = status === 'running' || status === 'idle' || status === 'starting'
  // A stopped run with a provider session can be continued with its memory intact, but only the newest run of its
  // session chain: an older member says who continued it.
  const canContinue = chainCanContinue(summaries, runId)
  const successor = !sessionOpen ? continuedBy(summaries, runId) : undefined
  // What Send does. On a finished run the default is a NEW run; Continue is the explicit second choice.
  const sendMode: 'reply' | 'continue' | 'new' = sessionOpen ? 'reply' : canContinue && finishedChoice === 'continue' ? 'continue' : 'new'
  const modeLabel =
    sendMode === 'reply'
      ? isSetupRun
        ? 'Answering the Architect'
        : `Replying to ${rootName}`
      : sendMode === 'continue'
        ? run.summary.endedWithApp
          ? 'Continuing this run (it ended when OrgAI closed)'
          : `Continuing this run (from ${relativeTime(run.summary.startedAt)})`
        : otherOpenRuns > 0
          ? `New run: ${otherOpenRuns} other run${otherOpenRuns === 1 ? '' : 's'} keep${otherOpenRuns === 1 ? 's' : ''} going`
          : 'New run'
  const primaryLabel = sendMode === 'reply' ? 'Send' : sendMode === 'continue' ? 'Continue' : 'Start'
  const placeholder =
    sendMode === 'reply'
      ? isSetupRun
        ? 'Your answer'
        : 'Your reply'
      : sendMode === 'continue'
        ? run.summary.endedWithApp
          ? 'Pick up where it was cut off'
          : 'What next?'
        : 'Describe the task'

  // Install approval cards: open ones first (one expanded, the rest collapsed), answered ones until dismissed.
  const openInstalls = run.mcpInstalls ?? []
  const resolvedInstalls = Object.values(run.mcpResolved ?? {}).filter((r) => !dismissedInstalls[r.request.id])
  const cardItems: { request: McpInstallRequest; outcome?: McpInstallOutcome }[] = [
    ...openInstalls.map((request) => ({ request })),
    ...resolvedInstalls.map((r) => ({ request: r.request, outcome: r.outcome }))
  ]
  const expandedInstallId = openInstalls.some((r) => r.id === pickedInstall) ? pickedInstall : (openInstalls[0]?.id ?? null)

  // The decisions region resizes the canvas; re-fit once it settles.
  const cardsKey =
    cardItems.map((c) => `${c.request.id}:${c.outcome ? 'r' : c.request.id === expandedInstallId ? 'e' : 'c'}`).join('|') +
    `/${run.permissions.length}.${run.proposals.length}.${run.questions?.length ?? 0}.${run.ruleRequests?.length ?? 0}.${run.mergeReviews?.length ?? 0}.${status === 'paused' ? 'p' : ''}`
  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.25, duration: 200, maxZoom: 1 }), 80)
    return () => clearTimeout(t)
  }, [cardsKey, fitView])

  // A jump from the sidebar's "Needs you" list asks the first decision of this run to take focus.
  useEffect(() => {
    if (!pendingFocus) return
    const region = bodyRef.current?.querySelector<HTMLElement>('.frame-tray')
    const target = region?.querySelector<HTMLElement>('button:not([disabled]), textarea, input, select') ?? region
    target?.focus()
    target?.scrollIntoView?.({ block: 'nearest' })
    clearDecisionFocus()
  }, [pendingFocus, clearDecisionFocus])

  // Re-fit when the canvas container itself changes size (window resize, side panel, decisions region).
  const canvasRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = canvasRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
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
        void fitView({ padding: 0.25, maxZoom: 1, duration: reduced ? 0 : 150 })
      }, 100)
    })
    ro.observe(el)
    return () => {
      clearTimeout(t)
      ro.disconnect()
    }
  }, [fitView])

  const selectedAgent = selectedAgentId ? run.agents[selectedAgentId] : undefined
  const entries = useMemo(
    () => (selectedAgentId ? run.transcript.filter((e) => e.agentId === selectedAgentId) : []),
    [run, selectedAgentId]
  )

  return (
    <div className="run-view">
      <RunHeader run={run} project={project} agentCount={agents.length} collapseFinished={collapseFinished} finishedCount={finishedCount} onToggleCollapse={toggleCollapse} />
      <div className="run-body" ref={bodyRef}>
        <FrameTray label="Waiting for you">
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
              <div className="row" style={{ gap: 'var(--space-2)' }}>
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

          {(run.ruleRequests ?? []).map((r) => (
            <Decision key={r.id} runId={runId}>
              <RuleRequestCard request={r} who={run.agents[r.agentId]?.name ?? r.agentId} onDecide={(d) => void decideRules(r.id, d)} />
            </Decision>
          ))}
          {(run.questions ?? []).map((q) => (
            <Decision key={q.id} runId={runId}>
              <QuestionCard question={q} onAnswer={(a) => void answerQuestion(q.id, a)} />
            </Decision>
          ))}
          {run.proposals.map((p) => (
            <Decision key={p.id} runId={runId}>
              <ProposalCard proposal={p} onDecide={(d) => void decideProposal(p.id, d)} />
            </Decision>
          ))}
          {(run.mergeReviews ?? []).map((m) => (
            <Decision key={m.id} runId={runId}>
              <MergeReviewCard review={m} onDecide={(d) => void decideMerge(m.id, d)} />
            </Decision>
          ))}
          {run.permissions.map((p) => (
            <Decision key={p.id} runId={runId}>
              <div className="permission">
                <div className="who">
                  {run.agents[p.agentId]?.name ?? p.agentId} wants to use {p.toolName}
                </div>
                <div className="what">{p.summary}</div>
                {p.ruleLabels && p.ruleLabels.length > 0 && (
                  <div className="rules" title="What “Allow for session” and “Always allow” approve">
                    {p.ruleLabels.map((r) => (
                      <code key={r}>{r}</code>
                    ))}
                  </div>
                )}
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <Button variant="primary" size="sm" onClick={() => void decide(p.id, { behavior: 'allow', scope: 'once' })}>
                    Allow once
                  </Button>
                  {p.suggestions && p.suggestions.length > 0 && (
                    <>
                      <Button size="sm" onClick={() => void decide(p.id, { behavior: 'allow', scope: 'session' })}>
                        Allow for session
                      </Button>
                      <Button size="sm" onClick={() => void decide(p.id, { behavior: 'allow', scope: 'project' })}>
                        Always allow (project)
                      </Button>
                    </>
                  )}
                  <Button size="sm" onClick={() => void decide(p.id, { behavior: 'deny', message: 'The user declined this action. Find another way or ask.' })}>
                    Deny
                  </Button>
                </div>
              </div>
            </Decision>
          ))}

          {cardItems.length > 0 && (
            <>
              <span className="sr-only">
                {openInstalls.length > 0
                  ? `${run.agents[openInstalls[0].agentId]?.name ?? 'An agent'} is asking to install an MCP server`
                  : 'MCP install request answered'}
              </span>
              {openInstalls.length > 1 && (
                <Badge tone="warning" testId="mcp-install-count">
                  {openInstalls.length} install requests waiting
                </Badge>
              )}
              {cardItems.map((it) => (
                <Decision key={it.request.id} runId={runId}>
                  <McpInstallCard
                    runId={runId}
                    request={it.request}
                    agentName={run.agents[it.request.agentId]?.name ?? 'An agent'}
                    resolved={it.outcome}
                    collapsed={!it.outcome && it.request.id !== expandedInstallId}
                    onExpand={() => setPickedInstall(it.request.id)}
                    onDismiss={() => setDismissedInstalls((d) => ({ ...d, [it.request.id]: true }))}
                  />
                </Decision>
              ))}
            </>
          )}
        </FrameTray>

        <CanvasFrame frameRef={canvasRef}>
          <FrameStage>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodeClick={onNodeClick}
              onPaneClick={() => selectAgent(null)}
              nodesConnectable={false}
              elementsSelectable
              fitView
              fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
              proOptions={{ hideAttribution: true }}
              deleteKeyCode={null}
              minZoom={0.3}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </FrameStage>
          <FrameFooter>
            <span>
              <i style={{ background: 'var(--accent)' }} />
              working
            </span>
            <span>
              <i style={{ background: 'var(--warning)' }} />
              needs approval
            </span>
            <span>
              <i style={{ background: 'var(--success)' }} />
              done
            </span>
            <span>
              <i style={{ background: 'var(--danger)' }} />
              error
            </span>
            <span>
              <i style={{ background: MESSAGE_COLOR }} />
              message
            </span>
          </FrameFooter>
        </CanvasFrame>

        <Composer
          draftKey={runId}
          modeLabel={modeLabel}
          primaryLabel={primaryLabel}
          placeholder={placeholder}
          focusToken={composerFocusToken}
          modeSwitch={
            !sessionOpen && canContinue ? (
              <SegmentedControl
                label="What Send does"
                value={sendMode === 'continue' ? 'continue' : 'new'}
                options={[
                  { value: 'new', label: 'New run', title: 'Start a fresh run of this project' },
                  { value: 'continue', label: 'Continue this run', title: 'Resume this run’s session with its memory' }
                ]}
                onChange={(v) => setFinishedChoice(v)}
              />
            ) : undefined
          }
          notices={
            <>
              {successor && (
                <div className="composer-notice info" role="status">
                  This run was continued by a later run.
                  <button type="button" className="link-btn" onClick={() => void openRun(successor.id)}>
                    Open it
                  </button>
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
            else await startRun(text, images ? { images } : undefined)
          }}
          onFail={(err) => {
            const message = err instanceof Error ? err.message : ''
            const liveId = sessionOpenRunId(message)
            if (!liveId) return false
            setSessionBlock({ message: message.replace(/^(Error invoking remote method '[^']*': )?(Error: )?/, ''), runId: liveId })
            return true
          }}
        />

        <SidePanel label="run panel">
          <div className="live-panel">
            <TranscriptPanel runId={runId} agent={selectedAgent} entries={entries} logs={run.logs ?? []} finished={finishedGroup} />
          </div>
        </SidePanel>
      </div>
    </div>
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
      <div className="row" style={{ gap: 'var(--space-2)' }}>
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
