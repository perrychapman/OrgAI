import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { AgentInstance, RunSummary, TranscriptEntry } from '@shared/types'
import { activeRun, useAppStore, type LogLine } from '../store/useAppStore'
import { formatCost, formatElapsed, formatTokens } from '../lib/layout'
import { Markdown } from './Markdown'

interface Props {
  agent: AgentInstance | undefined
  entries: TranscriptEntry[]
  logs: LogLine[]
}

function RunHistory(): ReactElement {
  const history = useAppStore((s) => s.history)
  const openRun = useAppStore((s) => s.openRun)
  const current = useAppStore(activeRun)
  if (history.length === 0) return <div className="entry system">No runs yet for this project.</div>
  return (
    <div className="run-history">
      {history.map((r: RunSummary) => (
        <button key={r.id} className={`run-row ${current?.summary.id === r.id ? 'active' : ''}`} onClick={() => void openRun(r.id)}>
          <div className="row" style={{ gap: 6 }}>
            <span className={`chip ${r.kind === 'setup' ? 'setup' : ''}`}>{r.kind}</span>
            <span className={`pill ${r.status === 'error' ? 'danger' : r.status === 'finished' ? '' : 'live'}`} style={{ padding: '1px 7px' }}>
              <span className="dot" /> {r.status}
            </span>
            <span style={{ marginLeft: 'auto', color: 'var(--text-faint)', fontSize: 11 }}>{formatCost(r.totalCostUsd)}</span>
          </div>
          <div className="prompt">{r.prompt || '(no prompt)'}</div>
          <div className="when">{new Date(r.startedAt).toLocaleString()}</div>
        </button>
      ))}
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

export default function TranscriptPanel({ agent, entries, logs }: Props): ReactElement {
  const [tab, setTab] = useState<'transcript' | 'logs' | 'runs'>('transcript')
  const [showThinking, setShowThinking] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [entries.length, logs.length, tab])

  const visible = showThinking ? entries : entries.filter((e) => e.block.kind !== 'thinking')

  return (
    <>
      <div className="side-header">
        <h2>{agent ? agent.name : 'Transcript'}</h2>
        <div style={{ flex: 1 }} />
        <div className="tabs">
          <button className={tab === 'transcript' ? 'active' : ''} onClick={() => setTab('transcript')}>
            Transcript
          </button>
          <button className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>
            Logs {logs.some((l) => l.level === 'error') ? '!' : ''}
          </button>
          <button className={tab === 'runs' ? 'active' : ''} onClick={() => setTab('runs')}>
            Runs
          </button>
        </div>
      </div>
      {tab === 'runs' && <RunHistory />}
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
              <span className="v">{formatCost(agent.costUsd)}</span>
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
      {tab === 'runs' ? null : tab === 'transcript' ? (
        <div className="transcript">
          {!agent && <div className="entry system">Select an agent on the chart to read its transcript.</div>}
          {agent && (
            <label className={`check ${showThinking ? 'on' : ''}`} style={{ alignSelf: 'flex-start' }}>
              <input type="checkbox" checked={showThinking} onChange={(e) => setShowThinking(e.target.checked)} /> Show thinking
            </label>
          )}
          {agent && visible.length === 0 && <div className="entry system">Nothing yet.</div>}
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
                    <Markdown text={b.text} />
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
              case 'system':
                return (
                  <div key={e.id} className="entry system">
                    <Markdown text={b.text} />
                  </div>
                )
            }
          })}
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
