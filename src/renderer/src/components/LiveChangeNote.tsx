import type { CSSProperties, ReactElement } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, CircleCheck } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { trackRoles, useLiveChangeStore, type LiveChangePart, type LiveChangeSurface } from '../store/liveChangeStore'
import { summarizeLines, type LiveChangeLine } from '../lib/liveRunChange'
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

function Details({ rows, label = 'Details' }: { rows: string[]; label?: string }): ReactElement | null {
  if (rows.length === 0) return null
  return (
    <ul className="live-change-details" aria-label={label} data-testid="live-change-details">
      {rows.map((d, i) => (
        <li key={i}>{d}</li>
      ))}
    </ul>
  )
}

/** One run alone: its whole line, then its caveats as plain text under it. */
function SingleLine({ line }: { line: LiveChangeLine }): ReactElement {
  return (
    <ul className="live-change-list">
      <li className="live-change-line" title={line.full} data-testid="live-change-line" data-run-id={line.runId} data-availability={line.availability}>
        <span className="live-change-icon">
          <Icon icon={CircleCheck} size="sm" />
        </span>
        <span className="live-change-text">{line.text}</span>
        <Details rows={line.details} />
      </li>
    </ul>
  )
}

/**
 * Several runs: one summary line that always fits, and a native disclosure with the run by run list. A caveat every run
 * shares (the rename sentence) is said once above the list; each row starts with the run, so a narrow row never hides
 * which run it is (the effect wraps instead of truncating).
 */
function ManyLines({ lines, action }: { lines: LiveChangeLine[]; action: Parameters<typeof summarizeLines>[1] }): ReactElement {
  const { summary, shared, own } = summarizeLines(lines, action)
  return (
    <details className="live-change-more" data-testid="live-change-more">
      {/* The org chart's React Flow takes Space (pan) on the whole window and cancels it; the disclosure keeps its own Space. */}
      <summary className="live-change-summary" data-testid="live-change-summary" onKeyDown={(e) => { if (e.key === ' ') e.stopPropagation() }}>
        <span className="live-change-icon">
          <Icon icon={CircleCheck} size="sm" />
        </span>
        <span className="live-change-text" data-testid="live-change-summary-text">
          {summary}
        </span>
        <span className="live-change-toggle">
          <span>Runs</span>
          <Icon icon={ChevronDown} size="sm" />
        </span>
      </summary>
      <div className="live-change-panel">
        <Details rows={shared} />
        <ul className="live-change-list" aria-label="Live runs">
          {lines.map((l, i) => (
            <li key={l.runId} className="live-change-line live-change-run-line" title={l.full} data-testid="live-change-line" data-run-id={l.runId} data-availability={l.availability}>
              <span className="live-change-run" data-testid="live-change-run">
                “{l.title}”
              </span>
              <span className="live-change-effect" data-testid="live-change-effect">
                {l.effect}
              </span>
              <Details rows={own[i]} />
            </li>
          ))}
        </ul>
      </div>
    </details>
  )
}

/**
 * What a saved change did in each live team run of the project (mcp / skills mutations on the desktop app). Each save
 * belongs to the surface that made it: only that surface draws and announces the line, so a screen reader hears it once.
 *
 * - One run: its line. Several: one summary and a disclosure with the per-run rows, so the note has a bounded height.
 * - The org chart note is an overlay in the canvas stage (a region the layout already reserves, never hidden by the team
 *   files card), top right near the inspector: it takes no room, so nothing moves when it appears or clears.
 * - The status region is always mounted so the line is announced politely. aria-atomic is set because the whole summary
 *   is one short sentence and a changed run count or a pending answer replaced by its final one must be read in full.
 */
export function LiveChangeNote({ projectId, surface, part }: { projectId: string; surface: LiveChangeSurface; part?: LiveChangePart }): ReactElement {
  const note = useLiveChangeStore((s) => s.notes[projectId])
  const live = useAppStore(liveRunCount(projectId))
  const order = useAppStore((s) => Object.keys(s.runs).join('|'))
  const roles = useAppStore((s) => (surface === 'orgChart' ? s.projects.find((p) => p.id === projectId)?.roles : undefined))
  useEffect(() => {
    if (roles) trackRoles(projectId, roles)
  }, [projectId, roles])
  const mine = !!note && note.surface === surface && note.part === part
  // The lines keep the order of the run tabs, so an answer arriving late never reshuffles them.
  const lines = useMemo(() => {
    if (!mine || !note) return []
    const rank = new Map(order.split('|').map((id, i) => [id, i]))
    return note.lines.map((l, i) => ({ l, i })).sort((a, b) => (rank.get(a.l.runId) ?? 1e6 + a.i) - (rank.get(b.l.runId) ?? 1e6 + b.i)).map((x) => x.l)
  }, [mine, note, order])
  // The role inspector keeps one row once a save has shown there, so the clear after 20 s moves nothing; the catalog keeps
  // one row while a run is live. The org chart note is an overlay and keeps nothing.
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (lines.length > 0) setShown(true)
  }, [lines.length])
  const reserve = surface === 'orgChart' ? 0 : surface.startsWith('role:') ? (shown ? 1 : 0) : live > 0 ? 1 : 0
  return (
    <div
      className="live-change-note"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="live-change-note"
      data-surface={surface}
      {...(part ? { 'data-part': part } : {})}
      style={reserve > 0 ? ({ '--live-rows': reserve } as CSSProperties) : undefined}
    >
      {lines.length > 0 && <div className="live-change-body">{lines.length === 1 ? <SingleLine line={lines[0]} /> : <ManyLines lines={lines} action={note?.action} />}</div>}
    </div>
  )
}
