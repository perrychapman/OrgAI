import type { ReactElement } from 'react'
import { useLiveChangeStore } from '../store/liveChangeStore'

/**
 * What a saved change did in each live team run of the project (mcp / skills mutations on the desktop app). The status
 * region is always mounted so the line is announced politely; nothing is drawn when the save reached no live run.
 */
export function LiveChangeNote({ projectId }: { projectId: string }): ReactElement {
  const lines = useLiveChangeStore((s) => s.notes[projectId])
  return (
    <div className="live-change-note" role="status" aria-live="polite" data-testid="live-change-note">
      {lines && lines.length > 0 && (
        <ul className="live-change-list">
          {lines.map((l) => (
            <li key={l.runId} className="live-change-line" title={`${l.title}: ${l.outcome}`} data-testid="live-change-line" data-run-id={l.runId}>
              {l.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
