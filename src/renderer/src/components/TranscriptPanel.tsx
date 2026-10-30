import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Circle,
  CircleDot,
  FileText,
  HelpCircle,
  Info,
  ListChecks,
  MessageSquare,
  MinusCircle,
  Search,
  ShieldQuestion,
  Sparkles,
  SquareTerminal,
  Wrench,
  XCircle,
  type LucideIcon
} from 'lucide-react'
import type { AgentInstance, PlanStep, RunPlan, TranscriptEntry } from '@shared/types'
import { DEFAULT_MAX_AUTO_CONTINUES } from '@shared/types'
import { selectedProject, useAppStore, useRunIndexes, type LogLine, type SideTab } from '../store/useAppStore'
import { runTag } from '../lib/runLabels'
import { parsePeerNote, type PeerNote } from '../lib/peerNotes'
import { COST_ESTIMATE_HINT, formatCost, formatElapsed, formatTokens, planProgress } from '../lib/layout'
import { Markdown } from './Markdown'
import { TranscriptImages } from './ImageAttachments'
import FinishedList, { type FinishedGroup } from './FinishedList'
import { Badge } from './ui/Badge'
import { Checkbox } from './ui/Checkbox'
import { Icon } from './ui/Icon'
import { TabPanel, Tabs, type TabItem } from './ui/Tabs'
import { autoContinueLine, humanizeToolResult, humanizeToolUse, type ToolKind } from '../lib/transcriptRows'

interface Props {
  /** The run this panel shows. */
  runId: string
  agent: AgentInstance | undefined
  entries: TranscriptEntry[]
  logs: LogLine[]
  /** When a folded "done" group is selected on the chart, list its reports instead of a transcript. */
  finished?: FinishedGroup
}

const STEP_ICONS: Record<PlanStep['status'], LucideIcon> = {
  pending: Circle,
  in_progress: CircleDot,
  done: CheckCircle2,
  blocked: AlertTriangle,
  skipped: MinusCircle
}

const TOOL_ICONS: Record<ToolKind, LucideIcon> = {
  ask: HelpCircle,
  plan: ListChecks,
  propose: Sparkles,
  permission: ShieldQuestion,
  edit: FileText,
  read: FileText,
  run: SquareTerminal,
  search: Search,
  agent: Bot,
  message: MessageSquare,
  other: Wrench
}

const STEP_LABELS: Record<PlanStep['status'], string> = {
  pending: 'Not started',
  in_progress: 'In progress',
  done: 'Done',
  blocked: 'Blocked',
  skipped: 'Skipped'
}

/** The orchestrator's plan: goal, steps with status, and how the automatic continuation stands. */
function PlanView({ plan }: { plan: RunPlan | undefined }): ReactElement {
  const project = useAppStore(selectedProject)
  if (!plan) {
    return (
      <div className="plan-view">
        <p className="panel-note">No plan yet. On work runs the orchestrator writes a plan first; it appears here, and OrgAI keeps the run going until every step is done.</p>
      </div>
    )
  }
  const { done, total } = planProgress(plan)
  const max = project?.maxAutoContinues ?? DEFAULT_MAX_AUTO_CONTINUES
  const auto = project?.autoContinue !== false
  const cont = autoContinueLine(auto, plan.autoContinues, max)
  const status = plan.status === 'active' ? 'In progress' : plan.status === 'done' ? 'Done' : 'Blocked'
  return (
    <div className="plan-view">
      <div className="plan-head">
        <div className="plan-goal">{plan.goal}</div>
        <div className="row plan-pills">
          <Badge tone={plan.status === 'done' ? 'success' : plan.status === 'blocked' ? 'attention' : 'info'}>{status}</Badge>
          <Badge>
            {done} of {total} steps done
          </Badge>
          <Badge title={cont.explain}>{cont.pill}</Badge>
        </div>
        <p className="panel-note">{cont.explain}</p>
      </div>
      {plan.status === 'blocked' && plan.blockedReason && <div className="plan-blocked">Blocked: {plan.blockedReason}</div>}
      <ol className="plan-steps">
        {plan.steps.map((s) => (
          <li key={s.id} className={`plan-step ${s.status}`}>
            <span className="plan-icon" title={STEP_LABELS[s.status]} role="img" aria-label={STEP_LABELS[s.status]}>
              <Icon icon={STEP_ICONS[s.status]} size="sm" />
            </span>
            <div className="plan-body">
              <div className="plan-title">
                {s.title}
                {s.owner && <span className="plan-owner">{s.owner}</span>}
              </div>
              {s.note && <div className="plan-note">{s.note}</div>}
            </div>
          </li>
        ))}
      </ol>
      {plan.summary && (
        <div className="plan-summary">
          <Markdown text={plan.summary} />
        </div>
      )}
    </div>
  )
}

/**
 * A cross-run note. Peer text is untrusted: it is shown as plain text (never Markdown) and the row is styled so it
 * cannot be mistaken for something the user typed.
 */
function PeerNoteRow({ note, at }: { note: PeerNote; at: number }): ReactElement {
  const index = useRunIndexes().get(note.runId)
  const incoming = note.direction === 'in'
  return (
    <div className={`entry peer ${incoming ? 'peer-in' : 'peer-out'}`}>
      <div className="tag">
        <span>
          {incoming ? 'Note from run' : 'To run'} <span className="run-index">{runTag(index)}</span> ({note.peer})
        </span>
        <span>{incoming ? new Date(at).toLocaleTimeString() : `Delivered ${new Date(at).toLocaleTimeString()}`}</span>
      </div>
      <div className="peer-body">{note.body}</div>
    </div>
  )
}

function ToolUseRow({ name, input }: { name: string; input: unknown }): ReactElement {
  const row = humanizeToolUse(name, input)
  return (
    <div className="entry tool_use">
      <Icon icon={TOOL_ICONS[row.kind]} size="sm" />
      <div className="tool-main">
        <div className="tool-label">{row.label}</div>
        {row.details && row.details !== '{}' && (
          <details className="entry-detail">
            <summary>Show details</summary>
            <pre>{row.details}</pre>
          </details>
        )}
      </div>
    </div>
  )
}

function ToolResultRow({ toolName, content, isError }: { toolName?: string; content: string; isError: boolean }): ReactElement | null {
  const row = humanizeToolResult(toolName, content, isError)
  if (!row) return null
  return (
    <div className={`entry tool_result${isError ? ' error' : ''}`}>
      <Icon icon={isError ? XCircle : CheckCircle2} size="sm" />
      <div className="tool-main">
        <div className="tool-label">{row.label}</div>
        {row.full && (
          <details className="entry-detail">
            <summary>Show output</summary>
            <pre>{row.full}</pre>
          </details>
        )}
      </div>
    </div>
  )
}

export default function TranscriptPanel({ runId, agent, entries, logs, finished }: Props): ReactElement {
  const selectedTab = useAppStore((s) => s.sideTabByRun[runId] ?? 'transcript')
  const setTab = useAppStore((s) => s.setSideTab)
  const [showThinking, setShowThinking] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)
  const partial = useAppStore((s) => (agent ? s.runs[runId]?.partial[agent.id] : undefined))
  const plan = useAppStore((s) => s.runs[runId]?.plan)
  const isWork = useAppStore((s) => s.runs[runId]?.summary.kind === 'work')
  const index = useRunIndexes().get(runId)
  // Setup runs have no plan tab; fall back to the transcript there.
  const tab = selectedTab === 'plan' && !isWork && !plan ? 'transcript' : selectedTab

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [entries.length, logs.length, tab, partial])

  const toolNames = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of entries) if (e.block.kind === 'tool_use') m.set(e.block.id, e.block.name)
    return m
  }, [entries])
  const visible = showThinking ? entries : entries.filter((e) => e.block.kind !== 'thinking')

  const headerTitle = agent ? agent.name : finished ? 'Finished reports' : 'Transcript'
  const errorCount = logs.filter((l) => l.level === 'error').length
  const showPlanTab = isWork || !!plan
  const tabs: TabItem[] = [
    { id: 'transcript', label: 'Transcript', testId: 'side-tab-transcript' },
    ...(showPlanTab ? [{ id: 'plan', label: 'Plan', icon: plan?.status === 'blocked' ? AlertTriangle : undefined, testId: 'side-tab-plan' }] : []),
    { id: 'logs', label: 'Logs', count: errorCount, testId: 'side-tab-logs' }
  ]
  const idPrefix = `side-${runId}`
  return (
    <>
      <div className="side-header side-header-col">
        <div className="side-title">
          <span className="run-index" title="The run this panel belongs to">
            {runTag(index)}
          </span>
          <h2 title={headerTitle}>{headerTitle}</h2>
          {agent && (
            <span className="side-role" title={`Role: ${agent.roleSlug}`}>
              {agent.roleSlug}
            </span>
          )}
        </div>
        <Tabs tabs={tabs} value={tab} onChange={(id) => setTab(id as SideTab)} label={`Run ${runTag(index)} details`} idPrefix={idPrefix} compact />
      </div>
      {tab === 'plan' && (
        <TabPanel idPrefix={idPrefix} id="plan" value={tab}>
          <PlanView plan={plan} />
        </TabPanel>
      )}
      {tab === 'transcript' && finished && !agent && (
        <TabPanel idPrefix={idPrefix} id="transcript" value={tab}>
          <FinishedList group={finished} />
        </TabPanel>
      )}
      {agent && tab === 'transcript' && (
        <div className="agent-meta" aria-label="Agent details">
          <span>{agent.model ?? 'model unknown'}</span>
          <span title="Input and output tokens">
            {formatTokens(agent.inputTokens)} in / {formatTokens(agent.outputTokens)} out
          </span>
          {agent.costUsd > 0 && <span title={COST_ESTIMATE_HINT}>{formatCost(agent.costUsd)} est.</span>}
          <span>{formatElapsed(agent.startedAt, agent.endedAt)}</span>
          <span>{agent.state}</span>
          {agent.worktree && (
            <span title={agent.worktree.path}>
              {agent.worktree.branch} · {agent.worktree.status}
            </span>
          )}
        </div>
      )}
      {agent && tab === 'transcript' && (
        <div className="transcript-bar">
          <Checkbox checked={showThinking} onChange={setShowThinking} label="Show thinking" />
        </div>
      )}
      {tab === 'plan' || (tab === 'transcript' && finished && !agent) ? null : tab === 'transcript' ? (
        <TabPanel idPrefix={idPrefix} id="transcript" value={tab} className="transcript">
          {!agent && <p className="panel-note">Select an agent on the chart to read its transcript.</p>}
          {agent && visible.length === 0 && !partial && <p className="panel-note">Nothing yet.</p>}
          {visible.map((e) => {
            const b = e.block
            switch (b.kind) {
              case 'user':
                return (
                  <div key={e.id} className="entry user">
                    <div className="tag">
                      <span>You</span>
                      <span>{new Date(e.at).toLocaleTimeString()}</span>
                    </div>
                    {b.text.trim() && <Markdown text={b.text} />}
                    {b.images && b.images.length > 0 && <TranscriptImages images={b.images} />}
                  </div>
                )
              case 'text':
                return (
                  <div key={e.id} className="entry text">
                    <Markdown text={b.text} />
                  </div>
                )
              case 'thinking':
                return (
                  <div key={e.id} className="entry thinking">
                    {b.text}
                  </div>
                )
              case 'tool_use':
                return <ToolUseRow key={e.id} name={b.name} input={b.input} />
              case 'tool_result':
                return <ToolResultRow key={e.id} toolName={toolNames.get(b.toolUseId)} content={b.content} isError={b.isError} />
              case 'system': {
                const peer = parsePeerNote(b.text)
                if (peer) return <PeerNoteRow key={e.id} note={peer} at={e.at} />
                const harness = e.source === 'harness'
                // Harness lines (nudges, hand-offs, limit notices) and in-run agent messages are quiet rows; the full text sits behind a disclosure.
                return (
                  <div key={e.id} className={`entry system${harness ? ' harness' : ''}`}>
                    <Icon icon={harness ? Info : MessageSquare} size="sm" />
                    <div className="tool-main">
                      <Markdown text={b.text} />
                      {b.detail && (
                        <details className="entry-detail">
                          <summary>Show instruction</summary>
                          <pre>{b.detail}</pre>
                        </details>
                      )}
                    </div>
                  </div>
                )
              }
            }
          })}
          {agent && partial && (
            <div className="entry text streaming">
              <Markdown text={partial} />
            </div>
          )}
          <div ref={bottom} />
        </TabPanel>
      ) : (
        <TabPanel idPrefix={idPrefix} id="logs" value={tab} className="logs">
          {logs.length === 0 && <span>No log lines yet.</span>}
          {logs.map((l, i) => (
            <div key={i} className={l.level}>
              <span className="log-time">{new Date(l.at).toLocaleTimeString()} </span>
              {l.message}
            </div>
          ))}
          <div ref={bottom} />
        </TabPanel>
      )}
    </>
  )
}
