import type { ReactElement } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { RunStatus } from '@shared/types'
import { isRunLive, projectRuns, useAppStore, type RunState } from '../store/useAppStore'
import { formatCost } from '../lib/layout'

function dotClass(status: RunStatus): string {
  if (status === 'running' || status === 'starting') return 'live'
  if (status === 'idle' || status === 'stopping') return 'idle'
  if (status === 'error') return 'danger'
  return 'ok'
}

/** Runs of this project that the strip shows: everything not dismissed, plus the viewed run. */
export function useStripRuns(): RunState[] {
  return useAppStore(
    useShallow((s) => {
      const viewed = s.selectedProjectId ? s.activeRunByProject[s.selectedProjectId] : undefined
      return projectRuns(s).filter((r) => r.summary.id === viewed || !s.dismissedRuns[r.summary.id])
    })
  )
}

/** One chip per run of the selected project, plus "+ New run". Sits at the top of the live canvas. */
export default function RunStrip({ runs }: { runs: RunState[] }): ReactElement {
  const viewedRunId = useAppStore((s) => (s.selectedProjectId ? s.activeRunByProject[s.selectedProjectId] : undefined))
  const composerMode = useAppStore((s) => s.composerMode)
  const setComposerMode = useAppStore((s) => s.setComposerMode)
  const openRun = useAppStore((s) => s.openRun)
  const dismissRun = useAppStore((s) => s.dismissRun)

  return (
    <div className="run-strip">
      {runs.map((r) => {
        const live = isRunLive(r)
        const waiting = r.permissions.length + r.proposals.length > 0
        const active = r.summary.id === viewedRunId && composerMode === 'reply'
        return (
          <div
            key={r.summary.id}
            className={`run-chip ${active ? 'active' : ''}`}
            title={`${r.summary.prompt || r.summary.id} · ${r.summary.status}`}
            onClick={() => void openRun(r.summary.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') void openRun(r.summary.id)
            }}
          >
            <span className={`run-dot ${waiting ? 'warn' : dotClass(r.summary.status)}`} />
            <span className="run-kind">{r.summary.kind === 'setup' ? 'Setup' : 'Work'}</span>
            <span className="run-prompt">{r.summary.prompt || 'run'}</span>
            <span className="run-cost">{formatCost(r.summary.totalCostUsd)}</span>
            {!live && (
              <button
                className="run-close"
                title="Hide this run from the strip"
                onClick={(e) => {
                  e.stopPropagation()
                  dismissRun(r.summary.id)
                }}
              >
                ×
              </button>
            )}
          </div>
        )
      })}
      <button
        className={`run-chip new ${composerMode === 'new' ? 'active' : ''}`}
        title="Start another run of this project; open sessions keep running"
        onClick={() => setComposerMode(composerMode === 'new' ? 'reply' : 'new')}
      >
        + New run
      </button>
    </div>
  )
}
