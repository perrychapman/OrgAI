import type { KeyboardEvent, ReactElement, ReactNode } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { agentLabel } from '../../lib/agentTree'
import { agentCostInput, costView } from '../../lib/cost'
import { waitingAgentIds } from '../../lib/canvasAgents'
import {
  FOCUS_STATE_LABEL,
  agentInitials,
  agentSiblings,
  entriesOfAgent,
  extractBrief,
  focusState,
  positionLabel,
  whereItSits
} from '../../lib/agentFocus'
import { runRoleColor } from '../../lib/runRoster'
import { assignmentOf, agentStaffingView } from '../../lib/runStaffing'
import { modelDisplayName } from '../../lib/assistantModels'
import { connectionLabel } from '../../lib/connectionLabel'
import { formatElapsed, formatTokens } from '../../lib/layout'
import { worktreeLabel } from '../../lib/agentActivity'
import { useCssVar } from '../../lib/useCssVar'
import { Cost } from '../ui/Cost'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { TabPanel, Tabs, type TabItem } from '../ui/Tabs'
import TranscriptPanel from '../TranscriptPanel'
import PermissionCard from '../PermissionCard'
import QuestionCard from '../QuestionCard'
import RuleRequestCard from '../RuleRequestCard'
import MergeReviewCard from '../MergeReviewCard'
import McpInstallCard from '../McpInstallCard'
import '../../styles/agent-focus.css'

/** Per-file changes of the agent's worktree. The runtime does not provide them yet; the lead wires this later. */
export interface AgentFocusDiff {
  files: { path: string; added: number; removed: number; /** Unified-diff lines, "+", "-" or " " first. */ lines?: string[] }[]
}

const ID_PREFIX = 'agent-focus'

export interface AgentFocusProps {
  runId: string
  agentId: string
  /** "Back to chart"; Escape calls it too. */
  onClose: () => void
  /** Open another agent (previous, next, a link in "Where it sits"). */
  onSelect: (agentId: string) => void
  /** Per-file diffs, once the runtime provides them. Left undefined, the Changes tab says so. */
  diff?: AgentFocusDiff
}

/** One agent on its own: header, Activity / Changes / Details, and the right column. All from the run's store state. */
export default function AgentFocus({ runId, agentId, onClose, onSelect, diff }: AgentFocusProps): ReactElement {
  const run = useAppStore((s) => s.runs[runId])
  const project = useAppStore((s) => s.projects.find((p) => p.id === s.runs[runId]?.summary.projectId))
  const isActiveRun = useAppStore((s) => {
    const pid = s.runs[runId]?.summary.projectId
    return !!pid && s.selectedProjectId === pid && s.activeRunByProject[pid] === runId && !s.draftPage[pid]
  })
  const sendMessage = useAppStore((s) => s.sendMessage)
  const decide = useAppStore((s) => s.decide)
  const answerQuestion = useAppStore((s) => s.answerQuestion)
  const decideRules = useAppStore((s) => s.decideRules)
  const decideMerge = useAppStore((s) => s.decideMerge)
  const neutral = useCssVar('--text-tertiary')

  const agents = run?.agents
  const agent = agents?.[agentId]
  const [tab, setTab] = useState('activity')
  const headingRef = useRef<HTMLHeadingElement>(null)
  const rootRef = useRef<HTMLElement>(null)

  // Focus lands on the name when the view opens or another agent is picked, so a screen reader hears who this is.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
  }, [agentId])
  useEffect(() => setTab('activity'), [agentId])

  const waiting = useMemo(() => waitingAgentIds(run ?? {}), [run])
  const siblings = useMemo(() => (agents ? agentSiblings(agents, agentId) : undefined), [agents, agentId])
  const chain = useMemo(() => (agents ? whereItSits(agents, agentId) : []), [agents, agentId])
  const transcript = run?.transcript
  const entries = useMemo(() => entriesOfAgent(transcript ?? [], agentId), [transcript, agentId])
  const brief = useMemo(() => (agent && transcript ? extractBrief(transcript, agent) : undefined), [agent, transcript])

  const color = (roleId: string | null, slug: string): string => runRoleColor(run?.roster, project?.roles, roleId, slug, neutral)

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    // A popover or dialog inside (a card's menu) takes Escape first.
    const t = e.target as HTMLElement
    if (t.closest('[role="dialog"], [role="menu"], [role="listbox"]') || t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') return
    e.preventDefault()
    onClose()
  }

  if (!run || !agent || !siblings) {
    return (
      <section className="agent-focus" aria-label="Agent" ref={rootRef} onKeyDown={onKeyDown}>
        <div className="agent-focus-bar">
          <Button variant="secondary" size="sm" icon={ChevronLeft} onClick={onClose} testId="agent-focus-back">
            Back to chart
          </Button>
        </div>
        <p className="agent-focus-empty" role="status">
          This agent is no longer in the run.
        </p>
      </section>
    )
  }

  const state = focusState(agent, waiting)
  const isRoot = agent.id === 'root' || !agent.parentId
  const parent = agent.parentId ? agents?.[agent.parentId] : undefined
  const roleName = project?.roles.find((r) => (agent.roleId ? r.id === agent.roleId : r.slug === agent.roleSlug))?.name ?? agent.roleSlug
  const assignment = assignmentOf(run.staffing, agent.id)
  const staffing = agentStaffingView(assignment)
  const model = agent.model ? modelDisplayName(agent.model) : undefined
  const agentConn = agent.connection ?? run.summary.connection
  const ended = agent.endedAt !== undefined
  const label = agentLabel(agent)

  const open = {
    permissions: run.permissions.filter((p) => p.agentId === agentId),
    questions: (run.questions ?? []).filter((q) => q.agentId === agentId),
    rules: (run.ruleRequests ?? []).filter((r) => r.agentId === agentId),
    merges: (run.mergeReviews ?? []).filter((m) => m.agentId === agentId),
    installs: (run.mcpInstalls ?? []).filter((m) => m.agentId === agentId)
  }
  const openCount = open.permissions.length + open.questions.length + open.rules.length + open.merges.length + open.installs.length

  const tabs: TabItem[] = [
    { id: 'activity', label: 'Activity', count: openCount, countLabel: `${openCount} waiting on you`, testId: 'agent-focus-tab-activity' },
    ...(agent.worktree ? [{ id: 'changes', label: 'Changes', count: agent.worktree.changedFiles?.length, countLabel: `${agent.worktree.changedFiles?.length ?? 0} changed files`, testId: 'agent-focus-tab-changes' }] : []),
    { id: 'details', label: 'Details', testId: 'agent-focus-tab-details' }
  ]
  const shownTab = tabs.some((t) => t.id === tab) ? tab : 'activity'

  const who = label
  const meta: ReactNode[] = [roleName]
  if (parent) meta.push(`reports to ${agentLabel(parent)}`)
  if (model) meta.push(model)
  meta.push(formatElapsed(agent.startedAt, agent.endedAt))
  const costKind = costView(agentCostInput(agent)).kind
  const showCost = costKind === 'known' || costKind === 'partial'

  return (
    <section className="agent-focus" aria-label={`Agent ${label}`} ref={rootRef} onKeyDown={onKeyDown} data-testid="agent-focus" data-state={state}>
      <div className="agent-focus-bar">
        <Button variant="secondary" size="sm" icon={ChevronLeft} onClick={onClose} testId="agent-focus-back" title="Back to chart (Escape)">
          Back to chart
        </Button>
        <nav className="agent-focus-trail" aria-label="Where this agent is">
          {chain.map((c, i) => (
            <span key={c.id} className="agent-focus-trail-item">
              {i > 0 && <span aria-hidden="true" className="agent-focus-sep">›</span>}
              {c.self ? <span aria-current="page" className="agent-focus-here">{c.label}</span> : <span>{c.label}</span>}
            </span>
          ))}
        </nav>
        <span className="agent-focus-grow" />
        {siblings.total > 1 && (
          <span className="agent-focus-pos" data-testid="agent-focus-position">
            {positionLabel(siblings)}
          </span>
        )}
        <button
          type="button"
          className="agent-focus-step"
          aria-label="Previous agent"
          disabled={!siblings.prevId}
          onClick={() => siblings.prevId && onSelect(siblings.prevId)}
          data-testid="agent-focus-prev"
        >
          <Icon icon={ChevronLeft} size="sm" />
        </button>
        <button
          type="button"
          className="agent-focus-step"
          aria-label="Next agent"
          disabled={!siblings.nextId}
          onClick={() => siblings.nextId && onSelect(siblings.nextId)}
          data-testid="agent-focus-next"
        >
          <Icon icon={ChevronRight} size="sm" />
        </button>
      </div>

      <div className="agent-focus-body">
        <div className="agent-focus-main">
          <header className={`agent-focus-head glass${state === 'waiting' ? ' is-waiting' : ''}`}>
            <span className="agent-focus-avatar" aria-hidden="true" style={{ background: color(agent.roleId, agent.roleSlug) }}>
              {agentInitials(agent.name)}
            </span>
            <div className="agent-focus-id">
              <div className="agent-focus-title">
                <h1 ref={headingRef} tabIndex={-1} className="agent-focus-name">
                  {label}
                </h1>
                <span className={`agent-focus-pill is-${state}`} data-testid="agent-focus-state">
                  <span aria-hidden="true" className={`agent-focus-dot${state === 'working' ? ' motion-pulse' : state === 'waiting' ? ' motion-breathe' : ''}`} />
                  {FOCUS_STATE_LABEL[state]}
                </span>
              </div>
              <p className="agent-focus-meta">
                {meta.map((m, i) => (
                  <span key={i}>{i > 0 && <span aria-hidden="true"> · </span>}{m}</span>
                ))}
                {showCost && (
                  <span>
                    <span aria-hidden="true"> · </span>
                    <Cost value={agentCostInput(agent)} />
                  </span>
                )}
              </p>
              {agent.activity && !ended && <p className="agent-focus-activity">{agent.activity}</p>}
            </div>
          </header>

          <Tabs tabs={tabs} value={shownTab} onChange={setTab} label={`${who} detail`} idPrefix={ID_PREFIX} compact />

          <TabPanel idPrefix={ID_PREFIX} id="activity" value={shownTab} className="agent-focus-panel">
            <div className="agent-focus-transcript">
              <TranscriptPanel runId={runId} agent={agent} entries={entries} logs={[]} variant="conversation" />
            </div>
            {openCount > 0 && (
              <div className="agent-focus-cards" role="group" aria-label="Waiting on you">
                <p className="agent-focus-cards-head">Waiting on you</p>
                {open.rules.map((r) => (
                  <RuleRequestCard key={r.id} runId={runId} request={r} who={who} onDecide={(d) => decideRules(r.id, d)} />
                ))}
                {open.questions.map((q) => (
                  <QuestionCard key={q.id} runId={runId} question={q} who={who} onAnswer={(a) => answerQuestion(q.id, a)} />
                ))}
                {open.merges.map((m) => (
                  <MergeReviewCard key={m.id} runId={runId} review={m} onDecide={(d) => decideMerge(m.id, d)} />
                ))}
                {open.permissions.map((p) => (
                  <PermissionCard key={p.id} runId={runId} request={p} who={who} onDecide={(d) => decide(p.id, d)} />
                ))}
                {open.installs.map((r) => (
                  <McpInstallCard key={r.id} runId={runId} request={r} agentName={who} onDismiss={() => undefined} />
                ))}
              </div>
            )}
          </TabPanel>

          <TabPanel idPrefix={ID_PREFIX} id="changes" value={shownTab} className="agent-focus-panel">
            {agent.worktree && (
              <>
                <div className="agent-focus-card glass">
                  <dl className="agent-focus-facts">
                    <dt>Branch</dt>
                    <dd className="agent-focus-mono">{agent.worktree.branch}</dd>
                    <dt>Status</dt>
                    <dd>{worktreeLabel(agent.worktree)}</dd>
                    {agent.worktree.mergeTarget === 'parent' && agent.worktree.parentBranch && (
                      <>
                        <dt>Merges into</dt>
                        <dd className="agent-focus-mono">{agent.worktree.parentBranch}</dd>
                      </>
                    )}
                  </dl>
                </div>
                {diff ? (
                  <div className="agent-focus-diffs">
                    {diff.files.map((f) => (
                      <div key={f.path} className="agent-focus-diff glass">
                        <div className="agent-focus-diff-head">
                          <span className="agent-focus-mono agent-focus-diff-path">{f.path}</span>
                          <span className="agent-focus-add">+{f.added}</span>
                          <span className="agent-focus-del">−{f.removed}</span>
                        </div>
                        {f.lines && (
                          <pre className="agent-focus-diff-lines">
                            {f.lines.map((l, i) => (
                              <span key={i} className={`agent-focus-line${l[0] === '+' ? ' is-add' : l[0] === '-' ? ' is-del' : ''}`}>
                                {l}
                                {'\n'}
                              </span>
                            ))}
                          </pre>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <>
                    {agent.worktree.changedFiles && agent.worktree.changedFiles.length > 0 && (
                      <div className="agent-focus-card glass">
                        <h2 className="agent-focus-label">Changed files</h2>
                        <ul className="agent-focus-files">
                          {agent.worktree.changedFiles.map((f) => (
                            <li key={f} className="agent-focus-mono">
                              {f}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <p className="agent-focus-note">Changes appear here when the runtime provides them.</p>
                  </>
                )}
              </>
            )}
          </TabPanel>

          <TabPanel idPrefix={ID_PREFIX} id="details" value={shownTab} className="agent-focus-panel">
            <div className="agent-focus-card glass">
              <dl className="agent-focus-facts" data-testid="agent-focus-details">
                {model && (
                  <>
                    <dt>Model</dt>
                    <dd title={agent.model}>{model}</dd>
                  </>
                )}
                {agentConn && (
                  <>
                    <dt>Connection</dt>
                    <dd>{connectionLabel(agentConn)}</dd>
                  </>
                )}
                <dt>Tokens in</dt>
                <dd>{formatTokens(agent.usage ? agent.usage.tokens.input + agent.usage.tokens.cacheRead + agent.usage.tokens.cacheWrite : agent.inputTokens)}</dd>
                <dt>Tokens out</dt>
                <dd>{formatTokens(agent.usage ? agent.usage.tokens.output : agent.outputTokens)}</dd>
                <dt>Cost</dt>
                <dd>
                  <Cost value={agentCostInput(agent)} labelled />
                </dd>
                {agent.usage && (
                  <>
                    <dt>Steps</dt>
                    <dd>{agent.usage.toolCalls} tool calls, {agent.usage.turns} turns</dd>
                  </>
                )}
                <dt>Time</dt>
                <dd>{formatElapsed(agent.startedAt, agent.endedAt)}{ended ? '' : ' so far'}</dd>
                {staffing && (
                  <>
                    <dt>Staffing</dt>
                    <dd>
                      {staffing.label}
                      {staffing.reason && <span className="agent-focus-quiet"> · {staffing.reason}</span>}
                    </dd>
                  </>
                )}
              </dl>
            </div>
            {agent.result && (
              <div className="agent-focus-card glass">
                <h2 className="agent-focus-label">Its result</h2>
                <p className="agent-focus-text">{agent.result}</p>
              </div>
            )}
          </TabPanel>
        </div>

        <aside className="agent-focus-side" aria-label="About this agent">
          {brief && (
            <section className="agent-focus-card glass" aria-labelledby={`${ID_PREFIX}-brief`}>
              <h2 id={`${ID_PREFIX}-brief`} className="agent-focus-label">
                Its brief, from {agents?.[brief.fromId] ? agentLabel(agents[brief.fromId]) : 'its lead'}
              </h2>
              <p className="agent-focus-text agent-focus-brief" data-testid="agent-focus-brief">{brief.text}</p>
            </section>
          )}
          <section className="agent-focus-card glass" aria-labelledby={`${ID_PREFIX}-sits`}>
            <h2 id={`${ID_PREFIX}-sits`} className="agent-focus-label">
              Where it sits
            </h2>
            <ol className="agent-focus-chain" data-testid="agent-focus-chain">
              {chain.map((c, i) => (
                <li key={c.id} style={{ marginInlineStart: `calc(var(--space-3) * ${i})` }}>
                  <button
                    type="button"
                    className={`agent-focus-link${c.self ? ' is-self' : ''}`}
                    aria-current={c.self ? 'true' : undefined}
                    onClick={() => !c.self && onSelect(c.id)}
                  >
                    <span aria-hidden="true" className="agent-focus-swatch" style={{ background: color(c.roleId, c.roleSlug) }} />
                    <span className="agent-focus-link-name">{c.label}</span>
                    {c.self && <span className="agent-focus-quiet">this agent</span>}
                  </button>
                </li>
              ))}
            </ol>
          </section>
          <section className="agent-focus-card glass" aria-labelledby={`${ID_PREFIX}-in`}>
            <h2 id={`${ID_PREFIX}-in`} className="agent-focus-label">
              Working in
            </h2>
            {agent.worktree ? (
              <p className="agent-focus-text">
                Its own copy of the code, on branch <span className="agent-focus-mono">{agent.worktree.branch}</span>
              </p>
            ) : (
              <p className="agent-focus-text">The project folder{project ? `: ${project.name}` : ''}</p>
            )}
          </section>
          {isActiveRun && !ended && <MessageBox agentName={label} onSend={sendMessage} direct={isRoot} />}
        </aside>
      </div>
    </section>
  )
}

/**
 * Per-agent messaging does not exist yet: a note to a report goes to the orchestrator through the same reply path as
 * the composer, prefixed "@<name>: ". The root gets its message as typed.
 */
function MessageBox({ agentName, onSend, direct }: { agentName: string; onSend: (text: string) => Promise<void>; direct?: boolean }): ReactElement {
  const id = useId()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const send = async (): Promise<void> => {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    setError('')
    try {
      await onSend(direct ? body : `@${agentName}: ${body}`)
      setText('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="agent-focus-card glass-strong agent-focus-compose">
      <label htmlFor={id} className="sr-only">
        Message about {agentName}
      </label>
      <textarea
        id={id}
        className="agent-focus-textarea"
        rows={2}
        value={text}
        placeholder={direct ? 'Message the orchestrator' : `Ask the orchestrator about ${agentName}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void send()
          }
        }}
        data-testid="agent-focus-message"
      />
      <div className="agent-focus-compose-row">
        <span className="agent-focus-quiet agent-focus-grow">{direct ? 'Ctrl+Enter sends' : `Goes to the orchestrator, marked for ${agentName}`}</span>
        <Button variant="primary" size="sm" loading={busy} disabled={!text.trim()} onClick={() => void send()} testId="agent-focus-send">
          Send
        </Button>
      </div>
      {error && (
        <p className="agent-focus-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
