import type { ReactElement, ReactNode } from 'react'
import { useAppStore, useRunIndexes } from '../store/useAppStore'
import { promptLine, runTag } from '../lib/runLabels'
import { displayRunName } from '../lib/orgChange'
import { runKindLabel } from '../lib/assistants'

/** "Run R2: Add caching". Names the run a decision belongs to; the index matches the run's tab and header. */
export function RunLabel({ runId, prefix = true }: { runId: string; prefix?: boolean }): ReactElement {
  const index = useRunIndexes().get(runId)
  const prompt = useAppStore((s) => s.runs[runId]?.summary.prompt)
  const title = useAppStore((s) => s.runs[runId]?.summary.title)
  const kind = useAppStore((s) => s.runs[runId]?.summary.kind)
  const full = promptLine(prompt)
  // "Run R2" for work runs; an assistant run names its kind ("Chat R1", "MCP assistant R1").
  const kindWord = useAppStore((s) => {
    const sum = s.runs[runId]?.summary
    return sum && (sum.quick || sum.kind === 'mcp-assist' || sum.kind === 'skill-assist' || sum.team === 'single') ? runKindLabel(sum) : 'Run'
  })
  const name = displayRunName({ kind: kind ?? 'work', title, prompt: prompt ?? '' })
  // A run not indexed yet (its project's history still loading) has no R number: never show "R?", only its name.
  if (!index) {
    return (
      <span className="run-label" title={full}>
        <span className="run-label-prompt">{name}</span>
      </span>
    )
  }
  return (
    <span className="run-label" title={`${runTag(index)}: ${full}`}>
      {prefix && <span className="run-label-word">{kindWord} </span>}
      <span className="run-index">{runTag(index)}</span>
      <span className="run-label-prompt">: {name}</span>
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
