import type { ReactElement } from 'react'
import type { RunSummary } from '@shared/types'
import { activeRun, useAppStore, useProjectSummaries } from '../store/useAppStore'
import { costLabel } from '../lib/layout'
import { canContinue, chainOf, continuedBy, isOpenStatus, needsYou, relativeTime, statusLabel } from '../lib/runChains'

function snippet(r: RunSummary | undefined): string {
  const text = (r?.prompt || 'Image prompt').replace(/\s+/g, ' ').trim()
  return text.length > 32 ? `${text.slice(0, 31)}…` : text
}

/** The Runs tab: every run of the project, with its session chain. Rows are containers; every action is a real button. */
export default function RunHistory(): ReactElement {
  const summaries = useProjectSummaries()
  const runs = useAppStore((s) => s.runs)
  const openRun = useAppStore((s) => s.openRun)
  const focusComposer = useAppStore((s) => s.focusComposer)
  const startRetro = useAppStore((s) => s.startRetro)
  const current = useAppStore(activeRun)
  const authMode = useAppStore((s) => s.usage?.authMode ?? 'unknown')
  if (summaries.length === 0) return <div className="entry system">No runs yet for this project.</div>
  const byId = new Map(summaries.map((r) => [r.id, r]))
  return (
    <ul className="run-history" aria-label="Runs of this project">
      {summaries.map((r) => {
        const live = runs[r.id]
        const waiting = !!live && needsYou(live)
        const open = isOpenStatus(r.status)
        const viewed = current?.summary.id === r.id
        const successor = continuedBy(summaries, r.id)
        const predecessor = r.resumedFrom ? byId.get(r.resumedFrom) : undefined
        const chainLength = chainOf(summaries, r.id).length
        const cost = costLabel(r.totalCostUsd, authMode)
        const started = new Date(r.startedAt)
        const tone = waiting || r.status === 'paused' ? 'warn' : r.status === 'error' ? 'danger' : open ? 'live' : ''
        return (
          <li key={r.id} className={`run-row ${viewed ? 'active' : ''}`}>
            <div className="run-row-head">
              <span className={`chip ${r.kind === 'setup' ? 'setup' : ''}`}>{r.kind}</span>
              <span className={`pill ${tone}`} title={r.pauseReason}>
                <span className="dot" aria-hidden="true" /> {statusLabel(r.status, waiting, !!r.endedWithApp)}
              </span>
              {r.pausedUntil !== undefined && r.status === 'finished' && !r.endedWithApp && (
                <span className="chip" title={r.pauseReason ?? 'Stopped at a usage limit'}>
                  usage limit
                </span>
              )}
              <span className="run-row-cost" title={cost.title}>
                {cost.text}
              </span>
            </div>
            <div className="prompt">{r.prompt || 'Image prompt'}</div>
            <div className="when" title={started.toLocaleString()}>
              Started {relativeTime(r.startedAt)}
              {chainLength > 1 && ` · session of ${chainLength} runs`}
            </div>
            {(predecessor || r.resumedFrom) && (
              <div className="run-chain">
                Continued from{' '}
                {predecessor ? (
                  <button type="button" className="link-btn" onClick={() => void openRun(predecessor.id)} title={predecessor.prompt}>
                    {snippet(predecessor)}
                  </button>
                ) : (
                  'an earlier run'
                )}
              </div>
            )}
            {successor && (
              <div className="run-chain">
                Continued by{' '}
                <button type="button" className="link-btn" onClick={() => void openRun(successor.id)} title={successor.prompt}>
                  {snippet(successor)}
                </button>
              </div>
            )}
            <div className="run-row-actions">
              <button
                type="button"
                className="btn sm run-open"
                title={viewed ? 'You are viewing this run' : open ? 'Open this live run' : 'Open this run'}
                onClick={() => void openRun(r.id)}
              >
                {viewed ? 'Viewing' : 'Open'}
              </button>
              {canContinue(summaries, r.id) && (
                <button
                  type="button"
                  className="btn sm run-continue"
                  title="Open this run and continue its session with its memory"
                  onClick={() => void openRun(r.id).then(() => focusComposer())}
                >
                  Continue
                </button>
              )}
              {r.kind === 'work' && (r.status === 'finished' || r.status === 'error') && (
                <button
                  type="button"
                  className="btn sm run-retro"
                  title="Have the Architect review this run and revise the org chart where roles struggled"
                  onClick={() => void startRetro(r.id)}
                >
                  Retrospective
                </button>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
