import type { ReactElement, ReactNode } from 'react'
import { useAppStore, useRunIndexes } from '../store/useAppStore'
import { promptLine, runName, runTag } from '../lib/runLabels'

/** "Run R2: Add caching". Names the run a decision belongs to; the index matches the run's tab and header. */
export function RunLabel({ runId, prefix = true }: { runId: string; prefix?: boolean }): ReactElement {
  const index = useRunIndexes().get(runId)
  const prompt = useAppStore((s) => s.runs[runId]?.summary.prompt)
  const title = useAppStore((s) => s.runs[runId]?.summary.title)
  const full = promptLine(prompt)
  return (
    <span className="run-label" title={`${runTag(index)}: ${full}`}>
      {prefix && <span className="run-label-word">Run </span>}
      <span className="run-index">{runTag(index)}</span>
      <span className="run-label-prompt">: {runName({ title, prompt: prompt ?? '' })}</span>
    </span>
  )
}

/** A decision card with the run it belongs to named above it. */
export function Decision({ runId, children }: { runId: string; children: ReactNode }): ReactElement {
  return (
    <div className="decision">
      <RunLabel runId={runId} />
      {children}
    </div>
  )
}
