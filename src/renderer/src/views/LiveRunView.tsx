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
import type { AgentInstance, Project } from '@shared/types'
import { setupPending } from '@shared/setup'
import { activeRun, useAppStore } from '../store/useAppStore'
import { AgentNode, MSG_IN, MSG_OUT, type AgentFlowNode } from '../components/AgentNode'
import { DoneGroupNode, GROUP_H, GROUP_W, groupId, type DoneGroupFlowNode } from '../components/DoneGroupNode'
import type { FinishedGroup } from '../components/FinishedList'
import TranscriptPanel from '../components/TranscriptPanel'
import ProposalCard from '../components/ProposalCard'
import QuestionCard from '../components/QuestionCard'
import RunStrip, { useStripRuns } from '../components/RunStrip'
import MergeReviewCard from '../components/MergeReviewCard'
import { costLabel, formatUntil, treeLayout } from '../lib/layout'

const SCAFFOLD_PROMPT =
  'The project folder is empty or nearly empty. If it is not a git repository yet, run git init and make an initial commit before delegating, so reports can work in isolated worktrees. Then scaffold the project according to .orgai/ARCHITECTURE.md: create the structure, tooling, build and test commands, and a minimal end-to-end slice that runs. Keep every decision consistent with the architecture document, and report what you created.'

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
const MESSAGE_COLOR = '#e879f9'

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

export default function LiveRunView({ project }: { project: Project }): ReactElement {
  return (
    <ReactFlowProvider>
      <LiveRunInner project={project} />
    </ReactFlowProvider>
  )
}

function LiveRunInner({ project }: { project: Project }): ReactElement {
  const run = useAppStore(activeRun)
  const selectedAgentId = useAppStore((s) => s.selectedAgentId)
  const selectAgent = useAppStore((s) => s.selectAgent)
  const startRun = useAppStore((s) => s.startRun)
  const startSetup = useAppStore((s) => s.startSetup)
  const startRetro = useAppStore((s) => s.startRetro)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const interrupt = useAppStore((s) => s.interrupt)
  const stopRun = useAppStore((s) => s.stopRun)
  const decide = useAppStore((s) => s.decide)
  const decideProposal = useAppStore((s) => s.decideProposal)
  const continueRun = useAppStore((s) => s.continueRun)
  const composerFocusToken = useAppStore((s) => s.composerFocusToken)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const answerQuestion = useAppStore((s) => s.answerQuestion)
  const composerMode = useAppStore((s) => s.composerMode)
  const stripRuns = useStripRuns()
  const showStrip = stripRuns.length > 0
  const decideMerge = useAppStore((s) => s.decideMerge)
  const authMode = useAppStore((s) => s.usage?.authMode ?? 'unknown')
  const { fitView } = useReactFlow()

  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [setupBusy, setSetupBusy] = useState(false)
  const [collapseFinished, setCollapseFinished] = useState(readCollapsePref)
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const [now, setNow] = useState(() => Date.now())
  const [msgNow, setMsgNow] = useState(() => Date.now())

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

  const isSetupRun = run?.summary.kind === 'setup'
  const needsSetup = setupPending(project)
  const rootName = project.roles.find((r) => r.reportsTo === null)?.name ?? 'the orchestrator'

  const beginSetup = async (): Promise<void> => {
    setSetupBusy(true)
    try {
      await startSetup()
    } finally {
      setSetupBusy(false)
    }
  }

  const agentsById = run?.agents
  const agents = useMemo(() => (agentsById ? Object.values(agentsById) : []), [agentsById])
  const roleColor = useCallback(
    (roleId: string | null, slug: string): string =>
      project.roles.find((r) => r.id === roleId)?.color ?? project.roles.find((r) => r.slug === slug)?.color ?? '#646d84',
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
  const messages = run?.messages
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
    const hasLiveDescendant = (id: string): boolean =>
      agents.some((c) => c.parentId === id && (!isSettled(c, now) || hasLiveDescendant(c.id)))
    const groups = new Map<string, AgentInstance[]>()
    const visibleAgents: AgentInstance[] = []
    for (const a of agents) {
      const parentVisible = !a.parentId || byId.has(a.parentId)
      const foldable =
        a.parentId !== null && parentVisible && isSettled(a, now) && !hasLiveDescendant(a.id) && !expandedGroups[a.parentId as string]
      if (foldable) groups.set(a.parentId as string, [...(groups.get(a.parentId as string) ?? []), a])
      else visibleAgents.push(a)
    }
    // Hide the subtree under a folded report too; the list in the side panel still reaches them.
    const folded = new Set([...groups.values()].flat().map((a) => a.id))
    const hiddenUnder = (a: AgentInstance): boolean => {
      let p = a.parentId
      while (p) {
        if (folded.has(p)) return true
        p = byId.get(p)?.parentId ?? null
      }
      return false
    }
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
      const parent = run?.agents[parentId]
      return {
        id: groupId(parentId),
        type: 'done-group' as const,
        position: positions[groupId(parentId)] ?? { x: 0, y: 0 },
        selected: selectedAgentId === groupId(parentId) || members.some((m) => m.id === selectedAgentId),
        draggable: false,
        data: { parentId, agents: members, color: parent ? roleColor(parent.roleId, parent.roleSlug) : '#646d84', onToggle: toggleGroup }
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
        cur = agentsById?.[cur]?.parentId ?? null
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
        labelStyle: { fill: MESSAGE_COLOR, fontSize: 10 },
        labelBgStyle: { fill: '#11141c' },
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
    if (!run || !selectedAgentId?.startsWith('group:')) return undefined
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

  const status = run?.summary.status
  const sessionOpen = status === 'running' || status === 'idle' || status === 'starting'
  // "+ New run" starts another run even while this session stays open.
  const replying = sessionOpen && composerMode !== 'new'
  const canSend = text.trim().length > 0 && !busy
  // A finished run with a provider session can be continued with its memory intact.
  const canContinue = !!run && (status === 'finished' || status === 'error' || status === 'paused') && !!run.summary.sessionId

  useEffect(() => {
    if (composerFocusToken) composerRef.current?.focus()
  }, [composerFocusToken])

  const submit = async (fresh = false): Promise<void> => {
    if (!canSend) return
    const prompt = text.trim()
    setText('')
    setBusy(true)
    try {
      if (replying) await sendMessage(prompt)
      else if (canContinue && !fresh && run && composerMode !== 'new') await continueRun(run.summary.id, prompt)
      else await startRun(prompt)
    } finally {
      setBusy(false)
    }
  }

  const scaffold = async (): Promise<void> => {
    setBusy(true)
    try {
      await startRun(SCAFFOLD_PROMPT, { scaffold: true })
    } finally {
      setBusy(false)
    }
  }

  const selectedAgent = run && selectedAgentId ? run.agents[selectedAgentId] : undefined
  const entries = useMemo(
    () => (run && selectedAgentId ? run.transcript.filter((e) => e.agentId === selectedAgentId) : []),
    [run, selectedAgentId]
  )

  return (
    <div className="live">
      <div className="canvas">
        {showStrip && <RunStrip runs={stripRuns} />}
        {run && (
          <div className="canvas-toolbar" style={showStrip ? { top: 52 } : undefined}>
            {isSetupRun && <span className="pill warn"><span className="dot" /> Setup session</span>}
            {project.permissionMode === 'auto' && (
              <span className="pill unattended" title="Permission mode is auto: Claude approves or denies each call and asks only when unsure. Saved rules never ask.">
                unattended
              </span>
            )}
            {run.summary.resumedFrom && (
              <span className="pill" title={`Continued from run ${run.summary.resumedFrom}`}>
                continued
              </span>
            )}
            <span className="pill" title={costLabel(run.summary.totalCostUsd, authMode).title}>
              {costLabel(run.summary.totalCostUsd, authMode).text}
            </span>
            <span className="pill">
              {agents.length} agent{agents.length === 1 ? '' : 's'}
            </span>
            {agents.length > 1 && (
              <button
                className={`btn sm ${collapseFinished ? '' : 'ghost'}`}
                onClick={toggleCollapse}
                title={collapseFinished ? 'Finished reports fold into one node per parent. Click to show them all.' : 'Click to fold finished reports into one node per parent.'}
              >
                {collapseFinished ? `Folding finished${finishedCount ? ` (${finishedCount})` : ''}` : 'Showing all'}
              </button>
            )}
            {sessionOpen && (
              <>
                <button className="btn sm" onClick={() => void interrupt()} disabled={status !== 'running'}>
                  Interrupt turn
                </button>
                <button className="btn sm danger" onClick={() => void stopRun()}>
                  End session
                </button>
              </>
            )}
            {!sessionOpen && status && (
              <span className="pill">
                Session {status}
                {run.summary.error ? `: ${run.summary.error.slice(0, 60)}` : ''}
              </span>
            )}
            {!sessionOpen && run.summary.kind === 'work' && (status === 'finished' || status === 'error') && (
              <button
                className="btn sm"
                title="Have the Architect review this run and revise the org chart where roles struggled"
                onClick={() => void startRetro(run.summary.id)}
              >
                Org retrospective
              </button>
            )}
          </div>
        )}

        {run && status === 'paused' && <PauseBanner runId={run.summary.id} />}

        {run && (run.proposals.length > 0 || (run.questions?.length ?? 0) > 0) && (
          <div className="proposals" style={{ top: showStrip ? 96 : 56 }}>
            {(run.questions ?? []).map((q) => (
              <QuestionCard key={q.id} question={q} onAnswer={(a) => void answerQuestion(q.id, a)} />
            ))}
            {run.proposals.map((p) => (
              <ProposalCard key={p.id} proposal={p} onDecide={(d) => void decideProposal(p.id, d)} />
            ))}
          </div>
        )}

        {run && run.mergeReviews?.length > 0 && (
          <div className="proposals merge-reviews" style={{ top: showStrip ? 96 : 56 }}>
            {run.mergeReviews.map((m) => (
              <MergeReviewCard key={m.id} review={m} onDecide={(d) => void decideMerge(m.id, d)} />
            ))}
          </div>
        )}

        {run && run.permissions.length > 0 && (
          <div className="permissions" style={run.proposals.length || run.questions?.length || run.mergeReviews?.length ? { right: 'auto', left: 12, top: showStrip ? 96 : 56 } : { top: showStrip ? 96 : 56 }}>
            {run.permissions.map((p) => (
              <div key={p.id} className="permission">
                <div className="who">{run.agents[p.agentId]?.name ?? p.agentId} wants to use {p.toolName}</div>
                <div className="what">{p.summary}</div>
                {p.ruleLabels && p.ruleLabels.length > 0 && (
                  <div className="rules" title="What “Allow for session” and “Always allow” approve">
                    {p.ruleLabels.map((r) => (
                      <code key={r}>{r}</code>
                    ))}
                  </div>
                )}
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <button className="btn primary sm" onClick={() => void decide(p.id, { behavior: 'allow', scope: 'once' })}>
                    Allow once
                  </button>
                  {p.suggestions && p.suggestions.length > 0 && (
                    <>
                      <button className="btn sm" onClick={() => void decide(p.id, { behavior: 'allow', scope: 'session' })}>
                        Allow for session
                      </button>
                      <button className="btn sm" onClick={() => void decide(p.id, { behavior: 'allow', scope: 'project' })}>
                        Always allow (project)
                      </button>
                    </>
                  )}
                  <button
                    className="btn sm"
                    onClick={() => void decide(p.id, { behavior: 'deny', message: 'The user declined this action. Find another way or ask.' })}
                  >
                    Deny
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {!run ? (
          <div className="empty">
            {needsSetup ? (
              <div>
                <h2>{project.setup?.state === 'pending' ? 'Set this project up with the Architect' : 'Setup is not finished'}</h2>
                <p>
                  {project.setup?.kind === 'new'
                    ? 'The Architect asks a few questions about your idea, then proposes the architecture, the org chart, and the run settings. You approve each one.'
                    : 'The Architect scans the repository, reads the code, and proposes an architecture document, an org chart that fits the work already done, and run settings. You approve each one.'}
                </p>
                <div className="row" style={{ justifyContent: 'center' }}>
                  <button className="btn primary" onClick={() => void beginSetup()} disabled={setupBusy}>
                    {setupBusy ? (
                      <>
                        <span className="spinner" /> Scanning…
                      </>
                    ) : project.setup?.state === 'pending' ? (
                      'Start setup'
                    ) : (
                      'Resume setup'
                    )}
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <h2>Give {rootName} something to do</h2>
                <p>
                  Type a task below. The orchestrator plans it and delegates to its reports. Every subagent appears here the moment it
                  is created, attached to the agent that spawned it.
                </p>
                <div className="row" style={{ justifyContent: 'center', gap: 6 }}>
                  {project.roles.map((r) => (
                    <span key={r.id} className="chip" style={{ borderColor: r.color, color: r.color }}>
                      {r.name}
                    </span>
                  ))}
                </div>
                {project.setup?.kind === 'new' && project.setup.state === 'complete' && !project.setup.scaffoldedAt && (
                  <div style={{ marginTop: 18 }}>
                    <p style={{ margin: '0 auto 10px' }}>
                      Setup is complete and the folder is still empty. The org chart can build the initial structure from the approved
                      architecture document.{' '}
                      {project.permissionMode === 'auto'
                        ? 'It runs unattended: Claude approves each call and asks only when unsure.'
                        : project.permissionMode === 'acceptEdits'
                          ? 'Edits are auto-accepted; shell commands still ask.'
                          : 'Approvals follow the project permission mode.'}
                    </p>
                    <button className="btn primary" disabled={busy} onClick={() => void scaffold()}>
                      {busy ? (
                        <>
                          <span className="spinner" /> Starting…
                        </>
                      ) : (
                        'Scaffold the project'
                      )}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
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
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#1f2432" />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}

        <div className="legend">
          <span>
            <i style={{ background: 'var(--accent)' }} />
            working
          </span>
          <span>
            <i style={{ background: 'var(--warn)' }} />
            needs approval
          </span>
          <span>
            <i style={{ background: 'var(--ok)' }} />
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
        </div>
      </div>

      <div className="composer">
        <textarea
          ref={composerRef}
          className="textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder={
            sessionOpen && composerMode === 'new'
              ? 'Describe the task for a new run. The open session keeps running… (Enter to start)'
              : sessionOpen
              ? isSetupRun
                ? 'Answer the Architect… (Enter to send, Shift+Enter for a new line)'
                : 'Reply to the orchestrator… (Enter to send, Shift+Enter for a new line)'
              : canContinue
                ? 'Continue this session with its memory… (Enter to continue, or New run for a fresh start)'
                : needsSetup
                  ? 'Setup is not finished. You can still start a work run with the current roles…'
                  : 'Describe the task for this project…'
          }
        />
        {canContinue && !sessionOpen && (
          <button className="btn" disabled={!canSend} onClick={() => void submit(true)} title="Start a fresh run with no memory of this one">
            New run
          </button>
        )}
        <button className="btn primary" disabled={!canSend} onClick={() => void submit()}>
          {replying ? 'Send' : canContinue && composerMode !== 'new' ? 'Continue' : 'Start'}
        </button>
      </div>

      <div className="side">
        <TranscriptPanel agent={selectedAgent} entries={entries} logs={run?.logs ?? []} finished={finishedGroup} />
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
      <div className="pause-reason">{summary.pauseReason ?? 'The plan usage limit was reached.'}</div>
      <div className="pause-when">
        {summary.autoResume && until
          ? `Auto-resume at ${new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (in ${formatUntil(until, now)})`
          : `Auto-resume is off.${until ? ` The window resets at ${new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : ''} Continue it from the composer when you are ready.`}
      </div>
      {error && <div className="pause-error">{error}</div>}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary sm" disabled={busy} onClick={() => void act(() => resumeNow(runId))}>
          Resume now
        </button>
        {summary.autoResume && (
          <button className="btn sm" disabled={busy} onClick={() => void act(() => cancelAutoResume(runId))}>
            Cancel auto-resume
          </button>
        )}
      </div>
    </div>
  )
}
