import type { ReactElement, ReactNode } from 'react'
import { useAppStore, useRunIndexes } from '../store/useAppStore'
import { promptLine, runName, runTag } from '../lib/runLabels'
import { isTeamSurfaceRun } from '../lib/runSurface'
import { runKindLabel } from '../lib/assistants'

/** "Run R2: Add caching". Names the run a decision belongs to; the index matches the run's tab and header. */
export function RunLabel({ runId, prefix = true }: { runId: string; prefix?: boolean }): ReactElement {
  const index = useRunIndexes().get(runId)
  const prompt = useAppStore((s) => s.runs[runId]?.summary.prompt)
  const title = useAppStore((s) => s.runs[runId]?.summary.title)
  const full = promptLine(prompt)
  const team = useAppStore((s) => isTeamSurfaceRun(s.runs[runId]?.summary))
  // "Run R2" for work runs; an assistant run names its kind ("Chat R1", "MCP assistant R1").
  const kindWord = useAppStore((s) => {
    const sum = s.runs[runId]?.summary
    return sum && (sum.quick || sum.kind === 'mcp-assist' || sum.kind === 'skill-assist' || sum.team === 'single') ? runKindLabel(sum) : 'Run'
  })
  // A Team-tab Architect session has no run tab, so it has no R-index: name it for what it is.
  if (team) {
    return (
      <span className="run-label" title={full}>
        <span className="run-label-prompt">Architect session{title ? `: ${runName({ title, prompt: prompt ?? '' })}` : ''}</span>
      </span>
    )
  }
  return (
    <span className="run-label" title={`${runTag(index)}: ${full}`}>
      {prefix && <span className="run-label-word">{kindWord} </span>}
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
