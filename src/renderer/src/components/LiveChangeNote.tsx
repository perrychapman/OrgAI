import type { CSSProperties, ReactElement } from 'react'
import { CircleCheck } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useLiveChangeStore, type LiveChangeSurface } from '../store/liveChangeStore'
import { Icon } from './ui/Icon'

/** Work runs of the project that can still take a change (not finished, failed or stopped). */
function liveRunCount(projectId: string): (s: ReturnType<typeof useAppStore.getState>) => number {
  return (s) => {
    let n = 0
    for (const r of Object.values(s.runs)) {
      const sum = r.summary
      if (sum.projectId === projectId && sum.kind === 'work' && sum.status !== 'finished' && sum.status !== 'error') n++
    }
    return n
  }
}

/**
 * What a saved change did in each live team run of the project (mcp / skills mutations on the desktop app). Each save
 * belongs to the surface that made it: only that surface draws and announces the line, so a screen reader hears it once.
 * The status region is always mounted so the line is announced politely, and while the project has a live run it reserves
 * the room of its lines, so the content below never moves when a line appears or clears.
 */
export function LiveChangeNote({ projectId, surface }: { projectId: string; surface: LiveChangeSurface }): ReactElement {
  const note = useLiveChangeStore((s) => s.notes[projectId])
  const live = useAppStore(liveRunCount(projectId))
  const lines = note && note.surface === surface ? note.lines : []
  // The org chart line lives in the footer hint row and reserves nothing; the others keep the room of their rows.
  const rows = surface === 'orgChart' ? 0 : Math.max(live, lines.length)
  return (
    <div
      className="live-change-note"
      role="status"
      aria-live="polite"
      data-testid="live-change-note"
      data-surface={surface}
      style={rows > 0 ? ({ '--live-rows': rows } as CSSProperties) : undefined}
    >
      {lines.length > 0 && (
        <ul className="live-change-list">
          {lines.map((l) => (
            <li key={l.runId} className="live-change-line" title={l.full} data-testid="live-change-line" data-run-id={l.runId} data-availability={l.availability}>
              <span className="live-change-icon">
                <Icon icon={CircleCheck} size="sm" />
              </span>
              <span className="live-change-text">{l.text}</span>
              {l.details.length > 0 && (
                <ul className="live-change-details" aria-label="Details" data-testid="live-change-details">
                  {l.details.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
