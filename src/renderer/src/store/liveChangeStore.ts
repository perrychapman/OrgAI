import { create } from 'zustand'
import type { LiveRunChange } from '@shared/types'
import { liveChangeLines, type LiveChangeAction, type LiveChangeLine } from '../lib/liveRunChange'

/** How long the line stays after a save. A later save of the same project replaces it. */
export const LIVE_CHANGE_NOTE_MS = 20_000

/**
 * The surface that made a save, so only that place shows (and announces) the line: the Connections section, the Skills
 * section, or the role inspector of one role.
 */
export type LiveChangeSurface = 'mcp' | 'skills' | `role:${string}`

export interface LiveChangeNoteState {
  surface: LiveChangeSurface
  lines: LiveChangeLine[]
}

interface LiveChangeState {
  /** The newest note per project id (one at a time); absent when the last save reached no live run. */
  notes: Record<string, LiveChangeNoteState>
}

export const useLiveChangeStore = create<LiveChangeState>(() => ({ notes: {} }))

const timers = new Map<string, number>()

/**
 * Call with every mcp / skills mutation result of a project: shows the lines on the surface that saved, or clears the
 * old ones. `action` says what the user did so the line can say what changed.
 */
export function reportLiveRuns(
  projectId: string,
  surface: LiveChangeSurface,
  liveRuns: LiveRunChange[] | undefined,
  action?: LiveChangeAction
): void {
  const lines = liveChangeLines(liveRuns, action)
  const prev = timers.get(projectId)
  if (prev !== undefined) window.clearTimeout(prev)
  timers.delete(projectId)
  useLiveChangeStore.setState((s) => {
    const notes = { ...s.notes }
    if (lines.length) notes[projectId] = { surface, lines }
    else delete notes[projectId]
    return { notes }
  })
  if (!lines.length) return
  timers.set(
    projectId,
    window.setTimeout(() => {
      timers.delete(projectId)
      useLiveChangeStore.setState((s) => {
        const notes = { ...s.notes }
        delete notes[projectId]
        return { notes }
      })
    }, LIVE_CHANGE_NOTE_MS)
  )
}
