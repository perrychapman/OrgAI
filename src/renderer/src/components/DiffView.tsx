import type { ReactElement } from 'react'
import { useMemo } from 'react'

/** Classify one unified-diff line for tinting. */
function lineKind(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-file'
  if (line.startsWith('diff --git') || line.startsWith('index ')) return 'diff-meta'
  if (line.startsWith('@@')) return 'diff-hunk'
  if (line.startsWith('+')) return 'diff-add'
  if (line.startsWith('-')) return 'diff-del'
  return ''
}

/** A git diff --stat summary plus the patch, with added and removed lines tinted. */
export default function DiffView({ stat, patch }: { stat?: string; patch: string }): ReactElement {
  const lines = useMemo(() => patch.split(/\r?\n/), [patch])
  return (
    <div className="diff-view">
      {stat && <pre className="diff-stat">{stat}</pre>}
      {patch ? (
        <pre className="diff-patch">
          {lines.map((l, i) => (
            <span key={i} className={lineKind(l)}>
              {l}
              {'\n'}
            </span>
          ))}
        </pre>
      ) : (
        <div className="mono-dim">No committed changes.</div>
      )}
    </div>
  )
}
