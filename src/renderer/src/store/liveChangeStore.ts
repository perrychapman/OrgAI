import { create } from 'zustand'
import type { LiveRunChange } from '@shared/types'
import { liveChangeLines, type LiveChangeLine } from '../lib/liveRunChange'

/** How long the line stays after a save. A later save of the same project replaces it. */
export const LIVE_CHANGE_NOTE_MS = 20_000

interface LiveChangeState {
  /** The newest note per project id; absent when the last save reached no live run. */
  notes: Record<string, LiveChangeLine[]>
}

export const useLiveChangeStore = create<LiveChangeState>(() => ({ notes: {} }))

const timers = new Map<string, number>()

/** Call with every mcp / skills mutation result of a project: shows the lines, or clears the old ones. */
export function reportLiveRuns(projectId: string, liveRuns: LiveRunChange[] | undefined): void {
  const lines = liveChangeLines(liveRuns)
  const prev = timers.get(projectId)
  if (prev !== undefined) window.clearTimeout(prev)
  timers.delete(projectId)
  useLiveChangeStore.setState((s) => {
    const notes = { ...s.notes }
    if (lines.length) notes[projectId] = lines
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
