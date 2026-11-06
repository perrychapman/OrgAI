import type { EngagementDocumentInfo, EngagementNote } from '@shared/types'
import { formatDate, formatFullDateTime } from './dates'

/** Pure copy helpers for Project settings > Engagement plan and Context notes (engagement-2 spec 5). */

/** Dates go through lib/dates.ts (one format app-wide: "4 Nov 2026"). */
const dateOf = formatDate

/** "Approved in the setup interview, 3 Nov 2026" / "Edited by you, 4 Nov 2026"; null without a write time. `title` has the full time. */
export function planRevisedLine(info: Pick<EngagementDocumentInfo, 'updatedAt' | 'updatedBy'>): { text: string; title: string } | null {
  if (typeof info.updatedAt !== 'number' || !Number.isFinite(info.updatedAt) || info.updatedAt <= 0) return null
  const when = dateOf(info.updatedAt)
  const title = formatFullDateTime(info.updatedAt)
  return { text: info.updatedBy === 'user' ? `Edited by you, ${when}` : `Approved in the setup interview, ${when}`, title }
}

/** "4 Nov 2026" for a write time; '' when it is not a usable time. */
export function planDateLabel(ms: number | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? dateOf(ms) : ''
}

/**
 * True while a setup run is actively proposing: starting, running or stopping, or holding an open proposal card.
 * A setup run that sits idle (or ended) without a card does not block editing the plan.
 */
export function setupBlocksPlan(runs: readonly { status: string; proposals: number }[]): boolean {
  return runs.some((r) => r.proposals > 0 || r.status === 'starting' || r.status === 'running' || r.status === 'stopping')
}

/** Notes newest edit first (ties by title, then id). */
export function sortNotes<T extends Pick<EngagementNote, 'id' | 'title' | 'updatedAt'>>(notes: readonly T[]): T[] {
  return [...notes].sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
}

/** "3,200 characters" / "1 character". */
export function noteSizeLabel(chars: number): string {
  const n = Math.max(0, Math.floor(chars))
  return `${n.toLocaleString()} ${n === 1 ? 'character' : 'characters'}`
}

/** "Edited 4 Nov 2026". */
export function noteEditedLabel(updatedAt: number): string {
  return `Edited ${dateOf(updatedAt)}`
}

/** "12 of 50 notes". */
export function notesCountLine(count: number, max: number): string {
  return `${count} of ${max} notes`
}

/** The id to focus after removing `removedId`: the next row's id, else the previous one, else null (focus "Add a note"). */
export function idAfterNoteRemoval(ids: readonly string[], removedId: string): string | null {
  const at = ids.indexOf(removedId)
  if (at < 0) return null
  return ids[at + 1] ?? ids[at - 1] ?? null
}
