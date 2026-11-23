import type { KeyboardEvent, ReactElement, ReactNode, RefObject } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, MessageSquare, Square } from 'lucide-react'
import { AGENT_MESSAGE_MAX_CHARS } from '@shared/types'
import { isRunLive, useAppStore } from '../../store/useAppStore'
import { cleanIpcError } from '../../lib/ipcError'
import { useConfirm } from '../ui/ConfirmDialog'
import { agentLabel } from '../../lib/agentTree'
import { agentCostInput, costView } from '../../lib/cost'
import { waitingAgentIds } from '../../lib/canvasAgents'
import {
  FOCUS_STATE_LABEL,
  agentInitials,
  DIFF_LINE_CAP,
  agentSiblings,
  entriesOfAgent,
  extractBrief,
  focusState,
  parseUnifiedDiff,
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

const ID_PREFIX = 'agent-focus'

export interface AgentFocusProps {
  runId: string
  agentId: string
  /** "Back to chart"; Escape calls it too. */
  onClose: () => void
  /** Open another agent (previous, next, a link in "Where it sits"). */
  onSelect: (agentId: string) => void
}

/**
 * One agent on its own: header, Activity / Changes / Details, and the right column. From the run's store state, plus
 * the agent's worktree diff (maintenance.diffWorktree, when Changes opens) and the project's saved allow rules.
 * There is no per-agent Pause: the runtime has none, so the header offers Message and Stop only.
 */
export default function AgentFocus({ runId, agentId, onClose, onSelect }: AgentFocusProps): ReactElement {
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
  const { confirm, dialog: confirmDialog } = useConfirm()

  const agents = run?.agents
  const agent = agents?.[agentId]
  const [tab, setTab] = useState('activity')
  const [stopBusy, setStopBusy] = useState(false)
  const [stopNote, setStopNote] = useState('')
  const headingRef = useRef<HTMLHeadingElement>(null)
  const rootRef = useRef<HTMLElement>(null)
  const messageRef = useRef<HTMLTextAreaElement>(null)

  // Focus lands on the name when the view opens or another agent is picked, so a screen reader hears who this is.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
  }, [agentId])
  useEffect(() => {
    setTab('activity')
    setStopNote('')
  }, [agentId])

  const waiting = useMemo(() => waitingAgentIds(run ?? {}), [run])
  const siblings = useMemo(() => (agents ? agentSiblings(agents, agentId) : undefined), [agents, agentId])
  const chain = useMemo(() => (agents ? whereItSits(agents, agentId) : []), [agents, agentId])
  const transcript = run?.transcript
  const entries = useMemo(() => entriesOfAgent(transcript ?? [], agentId), [transcript, agentId])
  // The runtime's brief wins; the transcript's spawn call is the fallback for older records and adapters without one.
  const brief = useMemo(() => {
    if (!agent) return undefined
    const fromTranscript = transcript ? extractBrief(transcript, agent) : undefined
    if (agent.brief?.trim()) return { text: agent.brief.trim(), fromId: fromTranscript?.fromId ?? agent.parentId ?? '', at: fromTranscript?.at ?? agent.startedAt }
    return fromTranscript
  }, [agent, transcript])

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
  const live = isRunLive(run)
  const canMessage = live && !ended
  const canStop = canMessage && !isRoot

  const stop = async (): Promise<void> => {
    if (stopBusy) return
    const ok = await confirm({
      title: `Stop ${label}?`,
      body: <p>Its work so far is kept.</p>,
      confirmLabel: 'Stop agent',
      danger: true,
      confirmTestId: 'agent-focus-stop-confirm'
    })
    if (!ok) return
    setStopBusy(true)
    setStopNote('')
    try {
      const res = await window.orgai.runActions.stopAgent({ runId, agentId })
      if (!res.stopped) setStopNote(res.reason ?? 'It could not be stopped.')
    } catch (e) {
      setStopNote(cleanIpcError(e, 'It could not be stopped.'))
    } finally {
      setStopBusy(false)
    }
  }

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
  const elapsed = formatElapsed(agent.startedAt, agent.endedAt)
  if (elapsed) meta.push(elapsed)
  const costKind = costView(agentCostInput(agent)).kind
  const showCost = costKind === 'known' || costKind === 'partial'

  return (
    <section className="agent-focus" aria-label={`Agent ${label}`} ref={rootRef} onKeyDown={onKeyDown} tabIndex={-1} data-testid="agent-focus" data-state={state}>
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
              {stopNote && (
                <p className="agent-focus-error" role="alert" data-testid="agent-focus-stop-note">
                  {stopNote}
                </p>
              )}
            </div>
            {canMessage && (
              <div className="agent-focus-actions">
                <Button variant="secondary" size="sm" icon={MessageSquare} onClick={() => messageRef.current?.focus()} testId="agent-focus-message-btn">
                  Message
                </Button>
                {canStop && (
                  <Button variant="danger" size="sm" icon={Square} loading={stopBusy} onClick={() => void stop()} testId="agent-focus-stop">
                    Stop
                  </Button>
                )}
              </div>
            )}
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
                {shownTab === 'changes' && <ChangesPanel projectId={run.summary.projectId} branch={agent.worktree.branch} />}
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
                {elapsed && (
                  <>
                    <dt>Time</dt>
                    <dd>{elapsed}{ended ? '' : ' so far'}</dd>
                  </>
                )}
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
            {shownTab === 'details' && <AllowedList projectId={run.summary.projectId} />}
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
          {canMessage && (
            <MessageBox
              key={agentId}
              runId={runId}
              agentId={agentId}
              agentName={label}
              direct={isRoot}
              // The root keeps the normal reply path while this is the project's open run.
              viaReply={isRoot && isActiveRun ? sendMessage : undefined}
              inputRef={messageRef}
            />
          )}
        </aside>
      </div>
      {confirmDialog}
    </section>
  )
}

/** The agent's worktree diff, fetched when the tab opens. Answers for another branch or after unmount are dropped. */
function ChangesPanel({ projectId, branch }: { projectId: string; branch: string }): ReactElement {
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; files: ReturnType<typeof parseUnifiedDiff> }>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let stale = false
    setState({ kind: 'loading' })
    window.orgai.maintenance
      .diffWorktree({ projectId, branch })
      .then((d) => {
        if (!stale) setState({ kind: 'ready', files: parseUnifiedDiff(d.patch) })
      })
      .catch((e: unknown) => {
        if (!stale) setState({ kind: 'error', message: cleanIpcError(e, 'The changes could not be read.') })
      })
    return () => {
      stale = true
    }
  }, [projectId, branch, attempt])

  if (state.kind === 'loading')
    return (
      <p className="agent-focus-note" role="status" data-testid="agent-focus-diff-loading">
        Reading its changes…
      </p>
    )
  if (state.kind === 'error')
    return (
      <div className="agent-focus-card glass">
        <p className="agent-focus-error" role="alert">
          {state.message}
        </p>
        <div>
          <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </div>
      </div>
    )
  if (state.files.length === 0)
    return (
      <p className="agent-focus-note" data-testid="agent-focus-diff-empty">
        No changes yet
      </p>
    )
  return (
    <div className="agent-focus-diffs" data-testid="agent-focus-diffs">
      {state.files.map((f) => (
        <DiffBlock key={f.path} file={f} />
      ))}
    </div>
  )
}

function DiffBlock({ file }: { file: ReturnType<typeof parseUnifiedDiff>[number] }): ReactElement {
  const [all, setAll] = useState(false)
  const id = useId()
  const capped = file.lines.length > DIFF_LINE_CAP
  const shown = capped && !all ? file.lines.slice(0, DIFF_LINE_CAP) : file.lines
  return (
    <section className="agent-focus-diff glass" aria-labelledby={id}>
      <div className="agent-focus-diff-head">
        <span id={id} className="agent-focus-mono agent-focus-diff-path">
          {file.path}
        </span>
        <span className="agent-focus-add">
          <span className="sr-only">{file.added} added</span>
          <span aria-hidden="true">+{file.added}</span>
        </span>
        <span className="agent-focus-del">
          <span className="sr-only">{file.removed} removed</span>
          <span aria-hidden="true">−{file.removed}</span>
        </span>
      </div>
      <pre className="agent-focus-diff-lines" tabIndex={0} aria-label={`Changes in ${file.path}`}>
        {shown.map((l, i) => {
          const sign = l[0] === '+' || l[0] === '-' ? l[0] : l[0] === '@' ? '' : ' '
          const kind = l[0] === '+' ? ' is-add' : l[0] === '-' ? ' is-del' : l[0] === '@' ? ' is-hunk' : ''
          return (
            <span key={i} className={`agent-focus-line${kind}`}>
              <span className="agent-focus-sign" aria-hidden="true">
                {sign}
              </span>
              {l[0] === '@' ? l : l.slice(1)}
              {'\n'}
            </span>
          )
        })}
      </pre>
      {capped && (
        <button type="button" className="agent-focus-more" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer lines' : `Show all ${file.lines.length} lines`}
        </button>
      )}
    </section>
  )
}

/** Saved project allow rules. The runtime has no per-agent list, so the title says it is the project's. */
function AllowedList({ projectId }: { projectId: string }): ReactElement | null {
  const changed = useAppStore((s) => s.rulesChangedByProject[projectId] ?? 0)
  const [rules, setRules] = useState<string[] | null>(null)
  const [showAll, setShowAll] = useState(false)
  useEffect(() => {
    let stale = false
    window.orgai.permissions
      .list(projectId)
      .then((r) => {
        if (!stale) setRules(r)
      })
      .catch(() => {
        if (!stale) setRules(null)
      })
    return () => {
      stale = true
    }
  }, [projectId, changed])
  if (!rules || rules.length === 0) return null
  const shown = showAll ? rules : rules.slice(0, 8)
  return (
    <section className="agent-focus-card glass" aria-labelledby={`${ID_PREFIX}-allow`} data-testid="agent-focus-allowed">
      <h2 id={`${ID_PREFIX}-allow`} className="agent-focus-label">
        This project allows without asking
      </h2>
      <ul className="agent-focus-files">
        {shown.map((r) => (
          <li key={r} className="agent-focus-mono">
            {r}
          </li>
        ))}
      </ul>
      {rules.length > shown.length && (
        <button type="button" className="agent-focus-more" onClick={() => setShowAll(true)}>
          Show all {rules.length} rules
        </button>
      )}
    </section>
  )
}

/**
 * A note for one agent: runActions.messageAgent hands it to the orchestrator, which relays it (the runtime refuses when
 * the run is not working). The root, while this is the project's open run, uses the normal reply path instead.
 */
function MessageBox({
  runId,
  agentId,
  agentName,
  direct,
  viaReply,
  inputRef
}: {
  runId: string
  agentId: string
  agentName: string
  direct?: boolean
  viaReply?: (text: string) => Promise<void>
  inputRef: RefObject<HTMLTextAreaElement | null>
}): ReactElement {
  const id = useId()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const left = AGENT_MESSAGE_MAX_CHARS - text.length
  const send = async (): Promise<void> => {
    const body = text.trim()
    if (!body || busy || left < 0) return
    setBusy(true)
    setError('')
    try {
      if (viaReply) await viaReply(body)
      else await window.orgai.runActions.messageAgent({ runId, agentId, text: body })
      setText('')
    } catch (e) {
      setError(cleanIpcError(e, 'The message could not be sent.'))
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
        ref={inputRef}
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
        <span className="agent-focus-quiet agent-focus-grow">
          {direct ? 'Ctrl+Enter sends' : 'Ctrl+Enter sends. The orchestrator is told too'}
          {left <= AGENT_MESSAGE_MAX_CHARS * 0.1 && (
            <span className={left < 0 ? 'agent-focus-over' : undefined} data-testid="agent-focus-count">
              {' · '}
              {left < 0 ? `${-left} over the limit` : `${left} left`}
            </span>
          )}
        </span>
        <Button variant="primary" size="sm" loading={busy} disabled={!text.trim() || left < 0} onClick={() => void send()} testId="agent-focus-send">
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
