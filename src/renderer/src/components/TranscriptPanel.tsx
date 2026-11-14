import type { ReactElement, ReactNode } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Files,
  Bot,
  CheckCircle2,
  Database,
  ExternalLink,
  FileText,
  HelpCircle,
  BookOpen,
  Info,
  ArrowDown,
  ListChecks,
  MessageSquare,
  Search,
  ShieldQuestion,
  Sparkles,
  SquareTerminal,
  Wrench,
  XCircle,
  type LucideIcon
} from 'lucide-react'
import type { AgentInstance, TranscriptEntry, TranscriptMedia, TranscriptContentPart } from '@shared/types'
import { isRunWindow } from '../lib/runKnowledge'
import '../styles/knowledge-run.css'
import { useAppStore, useRunIndexes, type LogLine, type SideTab } from '../store/useAppStore'
import { runTag } from '../lib/runLabels'
import { parsePeerNote, type PeerNote } from '../lib/peerNotes'
import { formatElapsed, formatTokens } from '../lib/layout'
import { agentStaffingView, assignmentOf } from '../lib/runStaffing'
import { Cost } from './ui/Cost'
import { agentCostInput } from '../lib/cost'
import { connectionTag, connectionTagTitle } from '../lib/roleConnection'
import { RunTabBody, useRunTabs } from './RunDetailTabs'
import { Markdown } from './Markdown'
import { TranscriptImages } from './ImageAttachments'
import { usableTranscriptImage } from '../lib/transcriptMedia'
import FinishedList, { type FinishedGroup } from './FinishedList'
import { Button } from './ui/Button'
import { Checkbox } from './ui/Checkbox'
import { Icon } from './ui/Icon'
import { TabPanel, Tabs } from './ui/Tabs'
import { bareToolName, humanizeToolResult, humanizeToolUse, omittedLabel, type FeedItem, type ToolKind } from '../lib/transcriptRows'
import { arriveClass } from '../lib/transcriptFollow'
import { useTranscriptFollow } from '../lib/useTranscriptFollow'
import { useArrival } from '../lib/useArrival'
import { useReducedMotion } from '../lib/canvas'
import { collapseSelfHelp, type SelfHelpRow } from '../lib/selfHelpRows'
import { collapseKnowledgeWrites, readRowText, recallOutputText, type KnowledgeRow } from '../lib/knowledgeRun'
import { revealOutputsTab } from './outputs/revealOutputsTab'
import ReviseDialog from './outputs/ReviseDialog'
import { canRevise } from '../lib/outputRevise'
import { collapseOutputCalls, matchOutputId, producedSentence, registeredSentence, type OutputWriteRow } from '../lib/outputsRun'

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
  /** Held by the caller when the "Show thinking" control sits outside this component (the assistant stage strip). */
  showThinking?: boolean
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
  knowledge: Database,
  other: Wrench
}

/**
 * A cross-run note. Peer text is untrusted: it is shown as plain text (never Markdown) and the row is styled so it
 * cannot be mistaken for something the user typed.
 */
function PeerNoteRow({ note, at, arrive }: { note: PeerNote; at: number; arrive?: boolean }): ReactElement {
  const index = useRunIndexes().get(note.runId)
  const incoming = note.direction === 'in'
  return (
    <div className={`entry peer ${incoming ? 'peer-in' : 'peer-out'}${arriveClass(arrive)}`}>
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

function ToolUseRow({ name, input, label, arrive }: { name: string; input: unknown; arrive?: boolean; /** A sentence that needed the result (lib/knowledgeRun.ts labels). */ label?: string }): ReactElement {
  const row = humanizeToolUse(name, input)
  return (
    <div className={`entry tool_use${arriveClass(arrive)}`}>
      <Icon icon={TOOL_ICONS[row.kind]} size="sm" />
      <div className="tool-main">
        <div className="tool-label">{label ?? row.label}</div>
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

function MediaView({ media }: { media: TranscriptMedia }): ReactElement {
  return <div data-testid="transcript-media">{media.kind === 'image' && usableTranscriptImage(media.image)
    ? <TranscriptImages images={[media.image]} />
    : <span data-testid="transcript-image-unavailable">{media.kind === 'unsupported' ? `${media.reason || 'Media unavailable'}${media.name ? `: ${media.name}` : ''}${media.mediaType ? ` (${media.mediaType})` : ''}` : 'Image unavailable'}</span>}</div>
}

function ToolResultRow({ toolName, content, parts, isError, arrive }: { toolName?: string; content: string; parts?: TranscriptContentPart[]; isError: boolean; arrive?: boolean }): ReactElement | null {
  const row = humanizeToolResult(toolName, content, isError)
  if (!row && !parts) return null
  const failed = isError || !!row?.failed
  const mediaCount = parts?.filter((part) => part.type === 'media').length ?? 0
  const unavailableCount = parts?.filter((part) => part.type === 'media' && (part.media.kind === 'unsupported' || !usableTranscriptImage(part.media.image))).length ?? 0
  return (
    <div className={`entry tool_result${failed ? ' error' : ''}${arriveClass(arrive)}`}>
      <Icon icon={failed ? XCircle : CheckCircle2} size="sm" />
      <div className="tool-main">
        <div className="tool-label">{parts ? (failed ? 'Tool failed' : 'Tool completed') : row?.label}</div>
        {parts ? (
          <details className="entry-detail">
            <summary>Show output{mediaCount > 0 ? ` (${mediaCount} ${mediaCount === 1 ? 'media item' : 'media items'}${unavailableCount === mediaCount ? ' unavailable' : unavailableCount ? `, ${unavailableCount} unavailable` : ''})` : ''}</summary>
            <div>{parts.map((part, i) => part.type === 'text' ? <pre key={i}>{part.text}</pre> : <MediaView key={i} media={part.media} />)}</div>
          </details>
        ) : row?.full && (
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

/**
 * The harness row that stands for a knowledge write (section 7): the humanised headline, an "Open" link to the item on
 * the Knowledge tab and the tool's result behind "Show output".
 */
function KnowledgeWriteRow({ row, body, projectId, runId, arrive }: { arrive?: boolean; row: KnowledgeRow; body: string | undefined; projectId: string | undefined; runId: string }): ReactElement {
  const open = (): void => {
    if (!projectId || !row.focus) return
    // A run window cannot reach the project's Knowledge tab: its side tab shows the item instead (spec 3.3).
    if (isRunWindow() && runId) useAppStore.getState().openRunKnowledge(runId, row.focus)
    else useAppStore.getState().openKnowledgeItem({ projectId, ...row.focus })
  }
  return (
    <div className={`entry system harness knowledge-write-row${arriveClass(arrive)}`} data-testid="knowledge-write-row">
      <Icon icon={Database} size="sm" />
      <div className="tool-main">
        <span className="entry-plain">{row.text}</span>
        {row.focus && projectId && (
          <>
            {' '}
            <button type="button" className="link-btn knowledge-row-open" data-testid="knowledge-row-open" aria-label={`Open ${row.name || 'this item'} in Knowledge`} onClick={open}>
              Open
            </button>
          </>
        )}
        {body && (
          <details className="entry-detail">
            <summary>Show output</summary>
            <pre>{body}</pre>
          </details>
        )}
      </div>
    </div>
  )
}

/**
 * The harness row that stands for a produce_output / register_output call (docs/design/outputs.md section 7): the
 * sentence, a "Show" link to the item in the Outputs tab when the index has it, and the tool result behind "Show details".
 */
function OutputWriteRowView({ row, body, runId, tabRunId, arrive }: { arrive?: boolean; row: OutputWriteRow; body: string | undefined; runId: string; tabRunId: string }): ReactElement {
  const outputs = useAppStore((s) => {
    const pid = s.runs[runId]?.summary.projectId
    return pid ? s.outputsByProject[pid] : undefined
  })
  const id = row.state === 'refused' ? undefined : matchOutputId(outputs, runId, row.title, row.relPath)
  const matched = id ? outputs?.find((o) => o.id === id) : undefined
  // Main's result text no longer names the kind, so the matched index entry supplies it for the sentence.
  const text = matched && row.state === 'produced' ? producedSentence(matched.kind, row.title) : matched && row.state === 'registered' ? registeredSentence(matched.kind, row.title) : row.text
  const revisable = matched !== undefined && canRevise(matched).ok
  const [revising, setRevising] = useState(false)
  const reviseBtn = useRef<HTMLButtonElement>(null)
  return (
    <div className={`entry system harness output-write-row${arriveClass(arrive)}`} data-testid="output-write-row" data-state={row.state}>
      <Icon icon={row.state === 'refused' ? AlertTriangle : Files} size="sm" />
      <div className="tool-main">
        <span className="entry-plain">{text}</span>
        {id && (
          <>
            {' '}
            <button type="button" className="link-btn output-write-show" data-testid="output-write-show" aria-label={`Show ${row.title} in Outputs`} onClick={() => {
                useAppStore.getState().openRunOutput(tabRunId, id)
                revealOutputsTab()
              }}
            >
              Show
            </button>
          </>
        )}
        {revisable && matched && (
          <>
            {' '}
            <button ref={reviseBtn} type="button" className="link-btn output-write-revise" data-testid="output-write-revise" aria-label={`Ask the team to revise ${row.title}`} onClick={() => setRevising(true)}>
              Revise
            </button>
            {revising && (
              <ReviseDialog
                output={matched}
                onClose={() => {
                  setRevising(false)
                  requestAnimationFrame(() => reviseBtn.current?.focus())
                }}
              />
            )}
          </>
        )}
        {body && row.state !== 'refused' && (
          <details className="entry-detail">
            <summary>Show details</summary>
            <pre>{body}</pre>
          </details>
        )}
      </div>
    </div>
  )
}

/**
 * A knowledge read (spec 3.4): "Recalled N items about <query>" with the tool's answer under "Show output", or the quiet
 * "Added N known items: ..." row. The look of a write row, no Open link.
 */
function KnowledgeReadRow({ text, body, arrive }: { text: string; body: string | undefined; arrive?: boolean }): ReactElement {
  return (
    <div className={`entry system harness knowledge-write-row knowledge-read-row${arriveClass(arrive)}`} data-testid="knowledge-read-row">
      <Icon icon={Database} size="sm" />
      <div className="tool-main">
        <span className="entry-plain">{text}</span>
        {body && (
          <details className="entry-detail">
            <summary>Show output</summary>
            <pre>{recallOutputText(body)}</pre>
          </details>
        )}
      </div>
    </div>
  )
}

/** An app_reference lookup or an open_in_app, as one quiet row; the tool's answer sits under "Show output". */
function SelfHelpRowView({ row, arrive }: { row: SelfHelpRow; arrive?: boolean }): ReactElement {
  return (
    <div className={`entry system harness self-help-row${arriveClass(arrive)}`} data-testid="self-help-row" data-tool={row.tool}>
      <Icon icon={row.tool === 'open_in_app' ? ExternalLink : BookOpen} size="sm" />
      <div className="tool-main">
        <span className="entry-plain">{row.text}</span>
        {row.body && (
          <details className="entry-detail">
            <summary>Show output</summary>
            <pre>{row.body}</pre>
          </details>
        )}
      </div>
    </div>
  )
}

export default function TranscriptPanel({ runId, agent, entries: ownEntries, feed, logs, finished, variant = 'panel', tagRunId, lead, showThinking: heldThinking }: Props): ReactElement {
  const projectId = useAppStore((s) => s.runs[runId]?.summary.projectId)
  const [ownThinking, setShowThinking] = useState(false)
  const showThinking = heldThinking ?? ownThinking
  const bottom = useRef<HTMLDivElement>(null)
  const partial = useAppStore((s) => (agent ? s.runs[runId]?.partial[agent.id] : undefined))
  const agentAssignment = useAppStore((s) => (agent ? assignmentOf(s.runs[runId]?.staffing, agent.id) : undefined))
  const agentStaffing = agentStaffingView(agentAssignment)
  const runConnection = useAppStore((s) => s.runs[runId]?.summary.connection)
  const index = useRunIndexes().get(tagRunId ?? runId)
  // The tab list and the fallback for a stored tab this run does not have: lib/runTabs.ts (shared with RunStageTabs).
  const { tabs, tab, setTab } = useRunTabs(runId, logs, { label: 'Transcript', testId: 'side-tab-transcript' })

  // One list for both shapes: the merged feed, or this run's entries as feed items.
  const items = useMemo<FeedItem[]>(() => feed ?? ownEntries.map((entry) => ({ kind: 'entry' as const, runId, entry })), [feed, ownEntries, runId])
  const entries = useMemo(() => items.flatMap((i) => (i.kind === 'entry' ? [i.entry] : [])), [items])
  const lastEntryId = entries[entries.length - 1]?.id

  // Both shapes follow their end through one hook (docs/design/motion.md 3.11): opens at the end, releases on any user
  // scroll, resumes after a quiet spell. It scrolls only the list itself (the sentinel's parent in the panel);
  // scrollIntoView would also scroll every ancestor. Keyed by the last entry, not the count: entries prepended by
  // "Load earlier sessions" must not jump to the end.
  const listRef = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  const panelListShown = tab === 'transcript' && !(finished && !agent)
  const follow = useTranscriptFollow({
    find: () => (variant === 'conversation' ? listRef.current : bottom.current?.parentElement ?? null),
    attachKey: `${variant}:${variant === 'conversation' || panelListShown ? 'on' : 'off'}`,
    resetKey: `${runId}|${variant}|${agent?.id ?? ''}|${finished ? 'finished' : ''}`,
    contentKey: `${lastEntryId ?? ''}|${partial?.length ?? 0}`,
    reducedMotion: reduced
  })
  const firstEntryId = entries[0]?.id
  const ends = useRef({ first: firstEntryId, last: lastEntryId, runId })
  useLayoutEffect(() => {
    const before = ends.current
    ends.current = { first: firstEntryId, last: lastEntryId, runId }
    // Rows prepended above the reading position ("Load earlier sessions") keep it, and count as the user's scroll.
    if (before.runId === runId && before.first !== undefined && before.first !== firstEntryId && before.last === lastEntryId) follow.holdHere()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstEntryId, lastEntryId, runId])

  const toolNames = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of entries) if (e.block.kind === 'tool_use') m.set(e.block.id, e.block.name)
    return m
  }, [entries])
  // One skill load is one row: the harness "Loaded skill <name>" row stands for the load_skill call and its result, and
  // carries SKILL.md under "Show instructions". Calls without a matching row (refused, resource files) stay visible.
  const skillLoads = useMemo(() => collapseSkillLoads(entries), [entries])
  // One knowledge write is one row too: the harness "Recorded <kind> <name>" row stands for the engagement_knowledge /
  // engagement_context call and its result (docs/design/knowledge.md section 7).
  const knowledge = useMemo(() => collapseKnowledgeWrites(entries), [entries])
  // Self-help tools (app_reference, open_in_app, propose_*): one quiet row or a sentence each (lib/selfHelpRows.ts).
  const projects = useAppStore((s) => s.projects)
  const selfHelp = useMemo(() => collapseSelfHelp(entries, (id) => projects.find((p) => p.id === id)?.name), [entries, projects])
  const outputCalls = useMemo(() => collapseOutputCalls(entries), [entries])
  const shown = (e: TranscriptEntry): boolean =>
    (e.block.kind === 'tool_result' && !!e.block.parts?.some((part) => part.type === 'media')) || ((showThinking || e.block.kind !== 'thinking') && !skillLoads.hidden.has(e.id) && !knowledge.hidden.has(e.id) && !selfHelp.hidden.has(e.id) && !outputCalls.hidden.has(e.id))
  const visible = entries.filter(shown)

  // Arrival (motion.md 2.2, 3.11): only rows appended to the newest session while the user follows the end fade in; bursts of more than 6, chain loads, run switches and the first paint never do.
  const newestStart = items.findIndex((i) => i.kind === 'divider' && i.divider.runId === runId)
  const arrivalIds = useMemo(() => items.slice(Math.max(newestStart, 0)).flatMap((i) => (i.kind === 'entry' ? [i.entry.id] : [])), [items, newestStart])
  const isNew = useArrival(arrivalIds, `${runId}:${arrivalIds.length > 0}`, { maxPerBatch: 6 })
  const arrive = (id: string): boolean => follow.isFollowing() && isNew(id)

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
          <div key={e.id} className={`entry user${arriveClass(arrive(e.id))}`}>
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
          <div key={e.id} className={`entry text${arriveClass(arrive(e.id))}`}>
            <Markdown text={b.text} />
          </div>
        )
      case 'media':
        return <div key={e.id} className={`entry text${arriveClass(arrive(e.id))}`}><MediaView media={b.media} /></div>
      case 'thinking':
        return (
          <div key={e.id} className={`entry thinking${arriveClass(arrive(e.id))}`}>
            {b.text}
          </div>
        )
      case 'tool_use': {
        const sRow = selfHelp.rows.get(e.id)
        if (sRow) return <SelfHelpRowView key={e.id} row={sRow} arrive={arrive(e.id)} />
        return <ToolUseRow key={e.id} arrive={arrive(e.id)} name={b.name} input={b.input} label={knowledge.labels.get(e.id) ?? selfHelp.labels.get(e.id)} />
      }
      case 'tool_result': {
        if (b.parts?.some((part) => part.type === 'media')) return <ToolResultRow key={e.id} arrive={arrive(e.id)} toolName={toolNames.get(b.toolUseId)} content={b.content} parts={b.parts} isError={b.isError} />
        const oRow = outputCalls.rows.get(e.id)
        if (oRow) return <OutputWriteRowView key={e.id} arrive={arrive(e.id)} row={oRow} body={outputCalls.body.get(e.id)} runId={item.runId} tabRunId={runId} />
        return <ToolResultRow key={e.id} arrive={arrive(e.id)} toolName={toolNames.get(b.toolUseId)} content={b.content} parts={b.parts} isError={b.isError} />
      }
      case 'system': {
        const peer = parsePeerNote(b.text)
        if (peer) return <PeerNoteRow key={e.id} arrive={arrive(e.id)} note={peer} at={e.at} />
        const oRow = e.source === 'harness' ? outputCalls.rows.get(e.id) : undefined
        if (oRow) return <OutputWriteRowView key={e.id} arrive={arrive(e.id)} row={oRow} body={outputCalls.body.get(e.id)} runId={item.runId} tabRunId={runId} />
        const harness = e.source === 'harness'
        const sRow = harness ? selfHelp.rows.get(e.id) : undefined
        if (sRow) return <SelfHelpRowView key={e.id} row={sRow} arrive={arrive(e.id)} />
        const kRow = harness ? knowledge.rows.get(e.id) : undefined
        if (kRow) return <KnowledgeWriteRow key={e.id} arrive={arrive(e.id)} row={kRow} body={knowledge.body.get(e.id)} projectId={projectId} runId={runId} />
        if (harness && knowledge.reads.has(e.id)) return <KnowledgeReadRow key={e.id} arrive={arrive(e.id)} text={readRowText(b.text, knowledge.repeats.get(e.id))} body={knowledge.body.get(e.id)} />
        const skillName = harness ? b.text.match(/^Loaded skill (.+)$/)?.[1] : undefined
        const skillBody = skillName ? skillLoads.body.get(e.id) : undefined
        // Harness lines (nudges, hand-offs, limit notices) and in-run agent messages are quiet rows; the full text sits behind a disclosure.
        return (
          <div key={e.id} className={`entry system${harness ? ' harness' : ''}${arriveClass(arrive(e.id))}`}>
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
    body.scrollTop = target ? target.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop : 0
    // A position the app chose counts as the user's scroll: nothing moves it for FOLLOW_RESUME_IDLE_MS.
    follow.holdHere()
    useAppStore.setState({ chainFocusRun: null })
  }, [focusRun, items, variant, tab])

  if (variant === 'conversation') {
    return (
      <div className="conversation-body" data-testid="conversation-transcript">
        <div
          ref={listRef}
          className="transcript conversation-list"
          role="region"
          tabIndex={0}
          aria-label="Conversation scroll area"
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
        {follow.away && (
          <div className="conversation-jump motion-enter">
            <Button size="sm" variant="secondary" onClick={follow.jumpToEnd} testId="conversation-jump">
              <Icon icon={ArrowDown} size="sm" /> Jump to latest
            </Button>
          </div>
        )}
      </div>
    )
  }

  const headerTitle = agent ? agent.name : finished ? 'Finished reports' : 'Transcript'
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
      <RunTabBody runId={runId} tab={tab} idPrefix={idPrefix} agent={agent} logs={logs} />
      {tab === 'transcript' && finished && !agent && (
        <TabPanel idPrefix={idPrefix} id="transcript" value={tab}>
          <FinishedList group={finished} />
        </TabPanel>
      )}
      {agent && tab === 'transcript' && (
        <div className="agent-meta" aria-label="Agent details">
          <span>{agent.model ?? 'model unknown'}</span>
          {connectionTag(agent.connection, runConnection) && (
            <span data-testid="agent-connection" data-connection={agent.connection} title={connectionTagTitle(agent.connection!, runConnection!, 'run')}>
              Runs on {connectionTag(agent.connection, runConnection)}
            </span>
          )}
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
      {agent && tab === 'transcript' && agentStaffing && (
        <details className="agent-staffing" data-testid="agent-staffing-detail">
          <summary data-testid="agent-staffing-summary" title={agentStaffing.reason}>
            {agentStaffing.label}
          </summary>
          <div className="agent-staffing-body">
            <div data-testid="agent-staffing-reason">{agentStaffing.reason}</div>
            <div data-testid="agent-staffing-model">Model: {agentStaffing.model}</div>
          </div>
        </details>
      )}
      {agent && tab === 'transcript' && (
        <div className="transcript-bar">
          <Checkbox checked={showThinking} onChange={setShowThinking} label="Show thinking" />
        </div>
      )}
      {tab === 'transcript' && !(finished && !agent) && (
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
      )}
    </div>
  )
}
