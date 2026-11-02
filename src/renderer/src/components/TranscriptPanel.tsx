import type { ReactElement, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Circle,
  CircleDot,
  FileText,
  HelpCircle,
  BookOpen,
  Info,
  ArrowDown,
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
import { formatElapsed, formatTokens, planProgress } from '../lib/layout'
import { Cost } from './ui/Cost'
import { agentCostInput } from '../lib/cost'
import UsagePanel from './UsagePanel'
import { Markdown } from './Markdown'
import { TranscriptImages } from './ImageAttachments'
import FinishedList, { type FinishedGroup } from './FinishedList'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { Checkbox } from './ui/Checkbox'
import { Icon } from './ui/Icon'
import { TabPanel, Tabs, type TabItem } from './ui/Tabs'
import { autoContinueLine, bareToolName, humanizeToolResult, humanizeToolUse, omittedLabel, type FeedItem, type ToolKind } from '../lib/transcriptRows'

/** Distance from the end of the conversation under which it still counts as scrolled to the end. */
const STICK_PX = 48

interface Props {
  /** The run this panel shows. */
  runId: string
  agent: AgentInstance | undefined
  entries: TranscriptEntry[]
  /** The chain's merged feed (entries of every member with dividers); replaces `entries` for the root agent. */
  feed?: FeedItem[]
  logs: LogLine[]
  /** When a folded "done" group is selected on the chart, list its reports instead of a transcript. */
  finished?: FinishedGroup
  /** 'conversation' renders only the entry list as the Live view's stage (no header or tabs, stick to the bottom). */
  variant?: 'panel' | 'conversation'
  /** The chain's first member: its index is the header tag (the conversation keeps one name). Defaults to `runId`. */
  tagRunId?: string
  /** Shown above the feed (the chain's "Load earlier sessions" row); only with `feed`. */
  lead?: ReactNode
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

/** Pairs each `load_skill` call (no file) with the harness "Loaded skill" row it caused. */
export function collapseSkillLoads(entries: TranscriptEntry[]): { hidden: Set<string>; body: Map<string, string> } {
  const hidden = new Set<string>()
  const body = new Map<string, string>()
  const results = new Map<string, TranscriptEntry>()
  for (const e of entries) if (e.block.kind === 'tool_result') results.set(e.block.toolUseId, e)
  const claimed = new Set<string>()
  entries.forEach((e, idx) => {
    const b = e.block
    if (b.kind !== 'tool_use' || bareToolName(b.name) !== 'load_skill') return
    const input = (b.input ?? {}) as { name?: unknown; file?: unknown }
    if (typeof input.name !== 'string' || (typeof input.file === 'string' && input.file.trim())) return
    const want = input.name.trim().replace(/^orgai:/i, '').toLowerCase()
    const row = entries.slice(idx + 1).find((x) => !claimed.has(x.id) && x.source === 'harness' && x.block.kind === 'system' && x.block.text.toLowerCase() === `loaded skill ${want}`)
    if (!row) return
    claimed.add(row.id)
    hidden.add(e.id)
    const res = results.get(b.id)
    if (res && res.block.kind === 'tool_result') {
      hidden.add(res.id)
      body.set(row.id, res.block.content.trim())
    }
  })
  return { hidden, body }
}

export default function TranscriptPanel({ runId, agent, entries: ownEntries, feed, logs, finished, variant = 'panel', tagRunId, lead }: Props): ReactElement {
  const selectedTab = useAppStore((s) => s.sideTabByRun[runId] ?? 'transcript')
  const setTab = useAppStore((s) => s.setSideTab)
  const [showThinking, setShowThinking] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)
  const partial = useAppStore((s) => (agent ? s.runs[runId]?.partial[agent.id] : undefined))
  const plan = useAppStore((s) => s.runs[runId]?.plan)
  const isWork = useAppStore((s) => s.runs[runId]?.summary.kind === 'work')
  const index = useRunIndexes().get(tagRunId ?? runId)
  // Setup runs have no plan tab; fall back to the transcript there.
  const planTab = selectedTab === 'plan' && !isWork && !plan ? 'transcript' : selectedTab
  const tab: SideTab = planTab

  // One list for both shapes: the merged feed, or this run's entries as feed items.
  const items = useMemo<FeedItem[]>(() => feed ?? ownEntries.map((entry) => ({ kind: 'entry' as const, runId, entry })), [feed, ownEntries, runId])
  const entries = useMemo(() => items.flatMap((i) => (i.kind === 'entry' ? [i.entry] : [])), [items])
  const lastEntryId = entries[entries.length - 1]?.id

  useEffect(() => {
    // Scroll only the tab panel body (the sentinel's parent); scrollIntoView would also scroll every ancestor.
    const body = bottom.current?.parentElement
    if (body) body.scrollTop = body.scrollHeight
    // Keyed by the last entry, not the count: entries prepended by "Load earlier sessions" must not jump to the end.
  }, [lastEntryId, logs.length, tab, partial])

  const toolNames = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of entries) if (e.block.kind === 'tool_use') m.set(e.block.id, e.block.name)
    return m
  }, [entries])
  // One skill load is one row: the harness "Loaded skill <name>" row stands for the load_skill call and its result, and
  // carries SKILL.md under "Show instructions". Calls without a matching row (refused, resource files) stay visible.
  const skillLoads = useMemo(() => collapseSkillLoads(entries), [entries])
  const shown = (e: TranscriptEntry): boolean => (showThinking || e.block.kind !== 'thinking') && !skillLoads.hidden.has(e.id)
  const visible = entries.filter(shown)

  const rows = items.map((item) => {
    if (item.kind === 'omitted') {
      return (
        <p key="feed-omitted" className="chain-omitted" data-testid="chain-omitted">
          {omittedLabel(item.count)}
        </p>
      )
    }
    if (item.kind === 'divider') {
      return (
        <div key={`divider-${item.divider.runId}`} className="chain-divider" data-testid="chain-divider" data-run={item.divider.runId} title={item.divider.title}>
          <span>{item.divider.label}</span>
          <span className="sr-only"> ({item.divider.title})</span>
        </div>
      )
    }
    const e = item.entry
    if (!shown(e)) return null
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
        const skillName = harness ? b.text.match(/^Loaded skill (.+)$/)?.[1] : undefined
        const skillBody = skillName ? skillLoads.body.get(e.id) : undefined
        // Harness lines (nudges, hand-offs, limit notices) and in-run agent messages are quiet rows; the full text sits behind a disclosure.
        return (
          <div key={e.id} className={`entry system${harness ? ' harness' : ''}`}>
            <Icon icon={skillName ? BookOpen : harness ? Info : MessageSquare} size="sm" />
            <div className="tool-main">
              {skillName ? <span className="entry-plain">{b.text}</span> : <Markdown text={b.text} />}
              {(b.detail || skillBody) && (
                <details className="entry-detail">
                  <summary>{skillBody ? 'Show instructions' : 'Show instruction'}</summary>
                  <pre>{skillBody ?? b.detail}</pre>
                </details>
              )}
            </div>
          </div>
        )
      }
    }
  })

  // The newest member's items are the live region; everything before its divider is history and must not be re-announced when a chain load inserts it.
  const newestAt = items.findIndex((i) => i.kind === 'divider' && i.divider.runId === runId)
  // The "N earlier entries not shown" row never sits in the live log, so its changing count is not re-announced.
  const splitAt = Math.max(newestAt < 0 ? 0 : newestAt, items[0]?.kind === 'omitted' ? 1 : 0)
  const earlierRows = rows.slice(0, splitAt)
  const newestRows = rows.slice(splitAt)

  // Conversation variant: keep the newest entry in view unless the user scrolled up (within STICK_PX of the end counts as at the end).
  const listRef = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  // The user asked to see a chain member (History, a link, after Send): put its divider at the top once, then let go.
  const focusRun = useAppStore((s) => s.chainFocusRun)
  useEffect(() => {
    if (!focusRun) return
    const body = variant === 'conversation' ? listRef.current : bottom.current?.parentElement
    if (!body) return
    const target = body.querySelector<HTMLElement>(`.chain-divider[data-run="${CSS.escape(focusRun)}"]`)
    // The chain's first member has no divider: its start is the top of the feed.
    const first = items[0]
    const startsWithFocus = first?.kind === 'entry' && first.runId === focusRun
    if (!target && !startsWithFocus) return
    stuck.current = false
    body.scrollTop = target ? target.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop : 0
    useAppStore.setState({ chainFocusRun: null })
  }, [focusRun, items, variant, tab])
  const [away, setAway] = useState(false)
  useEffect(() => {
    const el = listRef.current
    if (variant === 'conversation' && el && stuck.current) el.scrollTop = el.scrollHeight
  }, [variant, lastEntryId, partial, showThinking])

  if (variant === 'conversation') {
    const toEnd = (): void => {
      const el = listRef.current
      if (!el) return
      stuck.current = true
      setAway(false)
      el.scrollTop = el.scrollHeight
    }
    return (
      <div className="conversation-body" data-testid="conversation-transcript">
        <div
          ref={listRef}
          className="transcript conversation-list"
          role="region"
          tabIndex={0}
          aria-label="Conversation scroll area"
          onScroll={(e) => {
            const el = e.currentTarget
            const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX
            stuck.current = atEnd
            setAway(!atEnd)
          }}
        >
          {feed && lead}
          {splitAt > 0 && <div className="conversation-earlier">{earlierRows}</div>}
          <div className="conversation-newest" role="log" aria-label="Conversation">
            {visible.length === 0 && !partial && <p className="panel-note">Nothing yet.</p>}
            {newestRows}
            {partial && (
              <div className="entry text streaming">
                <Markdown text={partial} />
              </div>
            )}
          </div>
        </div>
        {away && (
          <div className="conversation-jump">
            <Button size="sm" variant="secondary" onClick={toEnd} testId="conversation-jump">
              <Icon icon={ArrowDown} size="sm" /> Jump to latest
            </Button>
          </div>
        )}
      </div>
    )
  }

  const headerTitle = agent ? agent.name : finished ? 'Finished reports' : 'Transcript'
  const errorCount = logs.filter((l) => l.level === 'error').length
  const showPlanTab = isWork || !!plan
  const tabs: TabItem[] = [
    { id: 'transcript', label: 'Transcript', testId: 'side-tab-transcript' },
    ...(showPlanTab ? [{ id: 'plan', label: 'Plan', icon: plan?.status === 'blocked' ? AlertTriangle : undefined, testId: 'side-tab-plan' }] : []),
    { id: 'usage', label: 'Usage', testId: 'side-tab-usage' },
    { id: 'logs', label: 'Logs', count: errorCount, testId: 'side-tab-logs' }
  ]
  const idPrefix = `side-${runId}`
  return (
    <div className="side-run">
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
      {tab === 'usage' && (
        <TabPanel idPrefix={idPrefix} id="usage" value={tab}>
          <UsagePanel runId={runId} agent={agent} />
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
          <Cost value={agentCostInput(agent)} hideEmpty labelled />
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
      {tab === 'plan' || tab === 'usage' || (tab === 'transcript' && finished && !agent) ? null : tab === 'transcript' ? (
        <TabPanel idPrefix={idPrefix} id="transcript" value={tab} className="transcript">
          {!agent && <p className="panel-note">Select an agent on the chart to read its transcript.</p>}
          {agent && visible.length === 0 && !partial && <p className="panel-note">Nothing yet.</p>}
          {feed && lead}
          {rows}
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
    </div>
  )
}
