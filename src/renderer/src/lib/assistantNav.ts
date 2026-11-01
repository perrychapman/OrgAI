/**
 * Which run a virtual project (an assistant) opens on when the user clicks its sidebar row. Pure.
 * Never an ended run: those stay reachable through the run tabs and History. No answer means the start page.
 */
import { isOpenStatus, needsYou } from './runChains'
import type { WaitRun } from './needsYou'

export function assistantRunToOpen(live: readonly WaitRun[], lastViewedId?: string): string | undefined {
  const open = live.filter((r) => isOpenStatus(r.summary.status))
  const waiting = [...open].sort((a, b) => a.summary.startedAt - b.summary.startedAt).find((r) => needsYou(r))
  if (waiting) return waiting.summary.id
  if (lastViewedId && open.some((r) => r.summary.id === lastViewedId)) return lastViewedId
  return [...open].sort((a, b) => b.summary.startedAt - a.summary.startedAt)[0]?.summary.id
}
