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
import type { Project } from '@shared/types'
import { setupPending } from '@shared/setup'
import { activeRun, useAppStore } from '../store/useAppStore'
import { AgentNode, type AgentFlowNode } from '../components/AgentNode'
import TranscriptPanel from '../components/TranscriptPanel'
import ProposalCard from '../components/ProposalCard'
import { formatCost, treeLayout } from '../lib/layout'

const SCAFFOLD_PROMPT =
  'The project folder is empty or nearly empty. If it is not a git repository yet, run git init and make an initial commit before delegating, so reports can work in isolated worktrees. Then scaffold the project according to .orgai/ARCHITECTURE.md: create the structure, tooling, build and test commands, and a minimal end-to-end slice that runs. Keep every decision consistent with the architecture document, and report what you created.'

const nodeTypes = { agent: AgentNode }
const NODE_W = 240
const NODE_H = 112
const LIVE_STATES = new Set(['starting', 'thinking', 'tool', 'delegating', 'waiting'])

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
  const sendMessage = useAppStore((s) => s.sendMessage)
  const interrupt = useAppStore((s) => s.interrupt)
  const stopRun = useAppStore((s) => s.stopRun)
  const decide = useAppStore((s) => s.decide)
  const decideProposal = useAppStore((s) => s.decideProposal)
  const { fitView } = useReactFlow()

  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [setupBusy, setSetupBusy] = useState(false)

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

  const agents = useMemo(() => (run ? Object.values(run.agents) : []), [run])
  const roleColor = useCallback(
    (roleId: string | null, slug: string): string =>
      project.roles.find((r) => r.id === roleId)?.color ?? project.roles.find((r) => r.slug === slug)?.color ?? '#646d84',
    [project.roles]
  )

  // Recompute the tree layout only when the set of agents or their parent links change.
  const topologyKey = agents.map((a) => `${a.id}>${a.parentId ?? ''}`).sort().join('|')
  const positions = useMemo(
    () => treeLayout(agents.map((a) => ({ id: a.id, parentId: a.parentId, width: NODE_W, height: NODE_H }))),
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

  const nodes: AgentFlowNode[] = useMemo(
    () =>
      agents.map((agent) => ({
        id: agent.id,
        type: 'agent',
        position: positions[agent.id] ?? { x: 0, y: 0 },
        selected: agent.id === selectedAgentId,
        draggable: false,
        data: { agent, color: roleColor(agent.roleId, agent.roleSlug), isRoot: agent.parentId === null }
      })),
    [agents, positions, selectedAgentId, roleColor]
  )

  const edges: Edge[] = useMemo(
    () =>
      agents
        .filter((a) => a.parentId && run?.agents[a.parentId])
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
        }),
    [agents, roleColor, run]
  )

  const onNodeClick: NodeMouseHandler<AgentFlowNode> = useCallback((_e, node) => selectAgent(node.id), [selectAgent])

  const status = run?.summary.status
  const sessionOpen = status === 'running' || status === 'idle' || status === 'starting'
  const canSend = text.trim().length > 0 && !busy

  const submit = async (): Promise<void> => {
    if (!canSend) return
    const prompt = text.trim()
    setText('')
    setBusy(true)
    try {
      if (sessionOpen) await sendMessage(prompt)
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
        {run && (
          <div className="canvas-toolbar">
            {isSetupRun && <span className="pill warn"><span className="dot" /> Setup session</span>}
            <span className="pill">{formatCost(run.summary.totalCostUsd)}</span>
            <span className="pill">
              {agents.length} agent{agents.length === 1 ? '' : 's'}
            </span>
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
          </div>
        )}

        {run && run.proposals.length > 0 && (
          <div className="proposals">
            {run.proposals.map((p) => (
              <ProposalCard key={p.id} proposal={p} onDecide={(d) => void decideProposal(p.id, d)} />
            ))}
          </div>
        )}

        {run && run.permissions.length > 0 && (
          <div className="permissions" style={run.proposals.length ? { right: 'auto', left: 12, top: 56 } : undefined}>
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
                      architecture document. Edits are auto-accepted; shell commands still ask.
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
        </div>
      </div>

      <div className="composer">
        <textarea
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
            sessionOpen
              ? isSetupRun
                ? 'Answer the Architect… (Enter to send, Shift+Enter for a new line)'
                : 'Reply to the orchestrator… (Enter to send, Shift+Enter for a new line)'
              : needsSetup
                ? 'Setup is not finished. You can still start a work run with the current roles…'
                : 'Describe the task for this project…'
          }
        />
        <button className="btn primary" disabled={!canSend} onClick={() => void submit()}>
          {sessionOpen ? 'Send' : 'Start'}
        </button>
      </div>

      <div className="side">
        <TranscriptPanel agent={selectedAgent} entries={entries} logs={run?.logs ?? []} />
      </div>
    </div>
  )
}
