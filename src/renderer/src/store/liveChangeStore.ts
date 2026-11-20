import { create } from 'zustand'
import type { LiveRunChange, RunEvent } from '@shared/types'
import { isOrgChartChange, liveChangeLines, type LiveChangeAction, type LiveChangeLine } from '../lib/liveRunChange'

/** How long the line stays after a save. A later save of the same project replaces it. */
export const LIVE_CHANGE_NOTE_MS = 20_000

/** Events of one org chart save for different runs arrive within this window; they share one note. */
const SAME_SAVE_MS = 5_000

/**
 * The surface that made a save, so only that place shows (and announces) the line: the Connections section, the Skills
 * section, the role inspector of one role, or the org chart editor (its saves return nothing, so the line comes from the
 * run.liveChange event).
 */
export type LiveChangeSurface = 'mcp' | 'skills' | 'orgChart' | `role:${string}`

export interface LiveChangeNoteState {
  surface: LiveChangeSurface
  lines: LiveChangeLine[]
  /** What the save did, kept so a 'pending' line can be worded again when its final answer arrives. */
  action: LiveChangeAction
  at: number
}

interface LiveChangeState {
  /** The newest note per project id (one at a time); absent when the last save reached no live run. */
  notes: Record<string, LiveChangeNoteState>
}

export const useLiveChangeStore = create<LiveChangeState>(() => ({ notes: {} }))

const timers = new Map<string, number>()

function clearTimer(projectId: string): void {
  const prev = timers.get(projectId)
  if (prev !== undefined) window.clearTimeout(prev)
  timers.delete(projectId)
}

function drop(projectId: string): void {
  clearTimer(projectId)
  useLiveChangeStore.setState((s) => {
    if (!s.notes[projectId]) return s
    const notes = { ...s.notes }
    delete notes[projectId]
    return { notes }
  })
}

/** Shows `note` (or nothing) for the project and restarts its expiry. */
function show(projectId: string, note: LiveChangeNoteState | null): void {
  clearTimer(projectId)
  useLiveChangeStore.setState((s) => {
    const notes = { ...s.notes }
    if (note && note.lines.length) notes[projectId] = note
    else delete notes[projectId]
    return { notes }
  })
  if (!note || !note.lines.length) return
  timers.set(projectId, window.setTimeout(() => drop(projectId), LIVE_CHANGE_NOTE_MS))
}

/**
 * Call with every mcp / skills mutation result of a project: shows the lines on the surface that saved, or clears the
 * old ones. `action` says what the user did so the line can say what changed.
 */
export function reportLiveRuns(
  projectId: string,
  surface: LiveChangeSurface,
  liveRuns: LiveRunChange[] | undefined,
  action: LiveChangeAction = { kind: 'changed' }
): void {
  show(projectId, { surface, lines: liveChangeLines(liveRuns, action), action, at: Date.now() })
}

/**
 * A run.liveChange event (main sends one per live run per applied change, and a second one when a 'pending' answer
 * resolves). Each save shows once, on the surface that made it:
 * - an org chart save returns nothing, so the event makes the line on the 'orgChart' surface (events of one save for
 *   several runs share one note; a pending line is replaced by its final one);
 * - an mcp / skills save already shows the line from its result, so the event only replaces that save's 'pending' line
 *   with the final answer and never adds a second line.
 */
export function reportLiveEvent(e: Extract<RunEvent, { type: 'run.liveChange' }>): void {
  const prev = useLiveChangeStore.getState().notes[e.projectId]
  const orgChart = isOrgChartChange(e.what)
  if (!orgChart) {
    if (!prev || e.change.availability === 'pending') return
    const idx = prev.lines.findIndex((l) => l.runId === e.runId && l.availability === 'pending')
    if (idx < 0) return
    const [line] = liveChangeLines([e.change], prev.action)
    const lines = prev.lines.slice()
    lines[idx] = line
    show(e.projectId, { ...prev, lines })
    return
  }
  const action: LiveChangeAction = { kind: 'orgchart' }
  const [line] = liveChangeLines([e.change], action)
  const now = Date.now()
  const sameSave = !!prev && prev.surface === 'orgChart' && (now - prev.at < SAME_SAVE_MS || prev.lines.some((l) => l.runId === e.runId && l.availability === 'pending'))
  const kept = sameSave && prev ? prev.lines : []
  const at = kept.findIndex((l) => l.runId === e.runId)
  const lines = kept.slice()
  if (at >= 0) lines[at] = line
  else lines.push(line)
  show(e.projectId, { surface: 'orgChart', lines, action, at: sameSave && prev ? prev.at : now })
}
