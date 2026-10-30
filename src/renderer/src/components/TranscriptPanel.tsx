import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { AgentInstance, PlanStep, RunPlan, TranscriptEntry } from '@shared/types'
import { DEFAULT_MAX_AUTO_CONTINUES } from '@shared/types'
import { selectedProject, useAppStore, useRunIndexes, type LogLine } from '../store/useAppStore'
import { runTag } from '../lib/runLabels'
import { parsePeerNote, type PeerNote } from '../lib/peerNotes'
import { COST_ESTIMATE_HINT, formatCost, formatElapsed, formatTokens, planProgress } from '../lib/layout'
import { Markdown } from './Markdown'
import { TranscriptImages } from './ImageAttachments'
import FinishedList, { type FinishedGroup } from './FinishedList'

interface Props {
  /** The run this panel shows. */
  runId: string
  agent: AgentInstance | undefined
  entries: TranscriptEntry[]
  logs: LogLine[]
  /** When a folded "done" group is selected on the chart, list its reports instead of a transcript. */
  finished?: FinishedGroup
}

const STEP_ICONS: Record<PlanStep['status'], string> = {
  pending: '○',
  in_progress: '●',
  done: '✓',
  blocked: '!',
  skipped: '–'
}

const STEP_LABELS: Record<PlanStep['status'], string> = {
  pending: 'pending',
  in_progress: 'in progress',
  done: 'done',
  blocked: 'blocked',
  skipped: 'skipped'
}

/** The orchestrator's plan: goal, steps with status, and how the automatic continuation stands. */
function PlanView({ plan }: { plan: RunPlan | undefined }): ReactElement {
  const project = useAppStore(selectedProject)
  if (!plan) {
    return (
      <div className="plan-view">
        <div className="entry system">
          No plan yet. On work runs the orchestrator starts by calling set_plan; the harness then keeps it going until every step is done.
        </div>
      </div>
    )
  }
  const { done, total } = planProgress(plan)
  const max = project?.maxAutoContinues ?? DEFAULT_MAX_AUTO_CONTINUES
  const auto = project?.autoContinue !== false
  return (
    <div className="plan-view">
      <div className="plan-head">
        <div className="plan-goal">{plan.goal}</div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <span className={`pill ${plan.status === 'done' ? 'ok' : plan.status === 'blocked' ? 'warn' : 'is-running'}`}>
            <span className="dot" /> {plan.status === 'active' ? 'in progress' : plan.status}
          </span>
          <span className="pill">
            {done}/{total} steps
          </span>
          <span className="pill" title={auto ? 'Times the harness re-engaged the orchestrator automatically in this run' : 'Automatic continue is off for this project'}>
            {auto ? `auto-continued ${plan.autoContinues} of ${max}` : 'auto-continue off'}
          </span>
        </div>
      </div>
      {plan.status === 'blocked' && plan.blockedReason && <div className="plan-blocked">Blocked: {plan.blockedReason}</div>}
      <ol className="plan-steps">
        {plan.steps.map((s) => (
          <li key={s.id} className={`plan-step ${s.status}`}>
            <span className="plan-icon" title={STEP_LABELS[s.status]} aria-label={STEP_LABELS[s.status]}>
              {STEP_ICONS[s.status]}
            </span>
            <div className="plan-body">
              <div className="plan-title">
                <span className="plan-id">{s.id}</span> {s.title}
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

function describeInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const i = input as Record<string, unknown>
    const key = ['command', 'file_path', 'pattern', 'query', 'url', 'prompt', 'description'].find((k) => typeof i[k] === 'string')
    if (key) return `${key}: ${String(i[key]).slice(0, 400)}`
  }
  const s = JSON.stringify(input)
  return s.length > 400 ? s.slice(0, 400) + '…' : s
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

  const visible = showThinking ? entries : entries.filter((e) => e.block.kind !== 'thinking')

  const headerTitle = agent ? agent.name : finished ? 'Finished reports' : 'Transcript'
  return (
    <>
      <div className="side-header">
        <span className="run-index" title="The run this panel belongs to">
          {runTag(index)}
        </span>
        <h2 title={headerTitle}>{headerTitle}</h2>
        <div className="side-spacer" />
        <div className="tabs">
          <button className={tab === 'transcript' ? 'active' : ''} onClick={() => setTab('transcript')}>
            Transcript
          </button>
          {(isWork || plan) && (
            <button className={tab === 'plan' ? 'active' : ''} onClick={() => setTab('plan')} title={plan ? `Plan: ${plan.status}` : 'No plan yet'}>
              Plan {plan?.status === 'blocked' ? '!' : ''}
            </button>
          )}
          <button className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>
            Logs {logs.some((l) => l.level === 'error') ? '!' : ''}
          </button>
        </div>
      </div>
      {tab === 'plan' && <PlanView plan={plan} />}
      {tab === 'transcript' && finished && !agent && <FinishedList group={finished} />}
      {agent && tab === 'transcript' && (
        <div className="agent-summary">
          <span className="k">Role</span>
          <span className="v">{agent.roleSlug}</span>
          <span className="k">Model</span>
          <span className="v">{agent.model ?? '—'}</span>
          <span className="k">State</span>
          <span className="v">{agent.state}</span>
          <span className="k">Elapsed</span>
          <span className="v">{formatElapsed(agent.startedAt, agent.endedAt)}</span>
          <span className="k">Tokens</span>
          <span className="v">
            {formatTokens(agent.inputTokens)} in / {formatTokens(agent.outputTokens)} out
          </span>
          {agent.costUsd > 0 && (
            <>
              <span className="k">Cost</span>
              <span className="v" title={COST_ESTIMATE_HINT}>
                {formatCost(agent.costUsd)} (API-equivalent estimate)
              </span>
            </>
          )}
          {agent.worktree && (
            <>
              <span className="k">Worktree</span>
              <span className="v" title={agent.worktree.path}>
                {agent.worktree.branch} · {agent.worktree.status}
              </span>
            </>
          )}
        </div>
      )}
      {tab === 'plan' || (tab === 'transcript' && finished && !agent) ? null : tab === 'transcript' ? (
        <div className="transcript">
          {!agent && <div className="entry system">Select an agent on the chart to read its transcript.</div>}
          {agent && (
            <label className={`check ${showThinking ? 'on' : ''}`} style={{ alignSelf: 'flex-start' }}>
              <input type="checkbox" checked={showThinking} onChange={(e) => setShowThinking(e.target.checked)} /> Show thinking
            </label>
          )}
          {agent && visible.length === 0 && !partial && <div className="entry system">Nothing yet.</div>}
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
                return (
                  <div key={e.id} className="entry tool_use">
                    <div className="tag">
                      <span>{b.name}</span>
                    </div>
                    {describeInput(b.input)}
                  </div>
                )
              case 'tool_result':
                return (
                  <div key={e.id} className={`entry tool_result ${b.isError ? 'error' : ''}`}>
                    <div className="tag">
                      <span>{b.isError ? 'tool error' : 'tool result'}</span>
                    </div>
                    {b.content || '(empty)'}
                  </div>
                )
              case 'system': {
                const peer = parsePeerNote(b.text)
                if (peer) return <PeerNoteRow key={e.id} note={peer} at={e.at} />
                // Harness lines (nudges, hand-offs, limit notices) are system rows with the full text behind a disclosure.
                return (
                  <div key={e.id} className={`entry system${e.source === 'harness' ? ' harness' : ''}`}>
                    <Markdown text={b.text} />
                    {b.detail && (
                      <details className="entry-detail">
                        <summary>Full text sent to the agent</summary>
                        <pre>{b.detail}</pre>
                      </details>
                    )}
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
        </div>
      ) : (
        <div className="logs">
          {logs.length === 0 && <span>No log lines yet.</span>}
          {logs.map((l, i) => (
            <div key={i} className={l.level}>
              <span style={{ opacity: 0.6 }}>{new Date(l.at).toLocaleTimeString()} </span>
              {l.message}
            </div>
          ))}
          <div ref={bottom} />
        </div>
      )}
    </>
  )
}
