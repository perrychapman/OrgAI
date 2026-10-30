import type { ReactElement } from 'react'
import { X, Plus } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { RunStatus } from '@shared/types'
import { isRunLive, projectRuns, useAppStore, type RunState } from '../store/useAppStore'
import { costLabel, planProgress } from '../lib/layout'
import { needsYou, statusLabel } from '../lib/runChains'
import { Icon } from './ui/Icon'

function dotClass(status: RunStatus): string {
  if (status === 'running' || status === 'starting') return 'live'
  if (status === 'idle' || status === 'stopping') return 'idle'
  if (status === 'error') return 'danger'
  if (status === 'paused') return 'paused'
  return 'ok'
}

/**
 * Runs of this project that the strip shows: open sessions first, then newest. One chip per session chain (a run
 * that was continued hides behind its continuation), nothing dismissed, plus the viewed run.
 */
export function useStripRuns(): RunState[] {
  return useAppStore(
    useShallow((s) => {
      const viewed = s.selectedProjectId ? s.activeRunByProject[s.selectedProjectId] : undefined
      const all = projectRuns(s)
      // One pass: runs that a later run continues hide behind that continuation.
      const continued = new Set<string>()
      for (const r of all) if (r.summary.resumedFrom) continued.add(r.summary.resumedFrom)
      const bySession = new Map<string, RunState>()
      for (const r of [...all].sort((a, b) => a.summary.startedAt - b.summary.startedAt)) {
        const sid = r.summary.sessionId
        if (!sid) continue
        const prev = bySession.get(sid)
        if (prev) continued.add(prev.summary.id)
        bySession.set(sid, r)
      }
      return all.filter((r) => {
        if (r.summary.id === viewed || isRunLive(r)) return true
        if (s.dismissedRuns[r.summary.id]) return false
        return !continued.has(r.summary.id)
      })
    })
  )
}

/** One chip per session of the selected project, plus "New run". Sits at the top of the live canvas. */
export default function RunStrip({ runs }: { runs: RunState[] }): ReactElement {
  const viewedRunId = useAppStore((s) => (s.selectedProjectId ? s.activeRunByProject[s.selectedProjectId] : undefined))
  const composerMode = useAppStore((s) => s.composerMode)
  const setComposerMode = useAppStore((s) => s.setComposerMode)
  const openRun = useAppStore((s) => s.openRun)
  const dismissRun = useAppStore((s) => s.dismissRun)
  const authMode = useAppStore((s) => s.usage?.authMode ?? 'unknown')
  const openCount = runs.filter(isRunLive).length

  return (
    <div className="run-strip" role="group" aria-label="Runs of this project">
      {runs.map((r) => {
        const live = isRunLive(r)
        const waiting = needsYou(r)
        const viewed = r.summary.id === viewedRunId
        const active = viewed && composerMode === 'reply'
        const cost = costLabel(r.summary.totalCostUsd, authMode)
        const status = statusLabel(r.summary.status, waiting, !!r.summary.endedWithApp)
        const prompt = r.summary.prompt || 'Image prompt'
        return (
          <div key={r.summary.id} className={`run-chip ${active ? 'active' : ''} ${waiting ? 'waiting' : ''}`}>
            <button
              type="button"
              className="run-chip-main"
              aria-current={viewed ? 'true' : undefined}
              title={`${status}: ${prompt}`}
              onClick={() => void openRun(r.summary.id)}
            >
              <span className={`run-dot ${waiting ? 'warn' : dotClass(r.summary.status)}`} aria-hidden="true" />
              <span className="run-status">{status}</span>
              {r.summary.kind === 'setup' && <span className="run-kind">Setup</span>}
              <span className="run-prompt">{prompt}</span>
              {r.plan && (
                <span className={`run-plan ${r.plan.status}`} title={`Plan ${r.plan.status === 'active' ? 'in progress' : r.plan.status}`}>
                  {planProgress(r.plan).done}/{planProgress(r.plan).total}
                </span>
              )}
              <span className="run-cost" title={cost.title}>
                {cost.text}
              </span>
            </button>
            {!live && (
              <button type="button" className="run-close" title="Hide this run from the strip" aria-label={`Hide run: ${prompt}`} onClick={() => dismissRun(r.summary.id)}>
                <Icon icon={X} size="xs" />
              </button>
            )}
          </div>
        )
      })}
      <button
        type="button"
        className={`run-chip new ${composerMode === 'new' ? 'active' : ''}`}
        aria-pressed={composerMode === 'new'}
        title={
          openCount > 0
            ? `Start another run of this project. The ${openCount} open run${openCount === 1 ? '' : 's'} keep going.`
            : 'Start another run of this project'
        }
        onClick={() => setComposerMode(composerMode === 'new' ? 'reply' : 'new')}
      >
        <Icon icon={Plus} size="xs" />
        New run
      </button>
    </div>
  )
}
