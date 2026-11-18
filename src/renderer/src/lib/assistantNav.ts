/**
 * Which run a virtual project (an assistant) opens on when the user returns to it (sidebar row, relaunch). Pure.
 * A run tab and its session's lifetime are independent: the last viewed tab comes back whether its session ended or
 * not. No answer means the start page.
 */
import { isOpenStatus, needsYou } from './runChains'
import type { WaitRun } from './needsYou'

export interface AssistantOpenOptions {
  /** Persisted rows of the assistant: a last viewed run that is not loaded yet still counts (openRun loads it). */
  history?: readonly { id: string }[]
  /** The user left the assistant on its start page: stay there unless a run needs them. */
  startPage?: boolean
}

/**
 * The open run that needs the user first (oldest), else the start page when the user left it there, else the last
 * viewed run whatever its status, else the newest open run, else undefined (the start page).
 */
export function assistantRunToOpen(runs: readonly WaitRun[], lastViewedId?: string, opts: AssistantOpenOptions = {}): string | undefined {
  const open = runs.filter((r) => isOpenStatus(r.summary.status))
  const waiting = [...open].sort((a, b) => a.summary.startedAt - b.summary.startedAt).find((r) => needsYou(r))
  if (waiting) return waiting.summary.id
  if (opts.startPage) return undefined
  if (lastViewedId && (runs.some((r) => r.summary.id === lastViewedId) || opts.history?.some((h) => h.id === lastViewedId))) return lastViewedId
  return [...open].sort((a, b) => b.summary.startedAt - a.summary.startedAt)[0]?.summary.id
}
