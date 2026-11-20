/**
 * The Team tab's notice row (docs/design/team-tab-overhaul.md 1.5): a pure priority queue plus the words of the
 * messages the Team view says. The row shows exactly one message, the highest priority; the rest wait and are counted
 * (`+N`). Nothing here touches the DOM, timers or the store: the view feeds in what it knows and asks what to show.
 */

/** Priority high to low: an error, an undoable edit, an open Architect session, a saved confirmation, the first-visit hint. */
export type NoticeKind = 'error' | 'edit' | 'session' | 'saved' | 'hint'

export const NOTICE_PRIORITY: Record<NoticeKind, number> = { error: 1, edit: 2, session: 3, saved: 4, hint: 5 }

/** How long an undoable edit offers Undo. */
export const EDIT_NOTICE_MS = 12_000
/** How long a refused reporting line explains itself, and how long a "saved" confirmation stays. */
export const SHORT_NOTICE_MS = 8_000
/** Most waiting messages kept; the oldest of the lowest priority are dropped first. */
export const NOTICE_LIMIT = 12

export interface NoticeAction {
  /** Stable id the view maps to a handler (`undo`, `open-session`, `manage-templates`, `got-it`...). */
  id: string
  label: string
  testId?: string
  /** Shows the spinner and ignores clicks (an undo in flight). */
  busy?: boolean
}

export interface TeamNotice {
  /** One message per key: posting the same key again replaces the older one (an edit supersedes the previous edit). */
  key: string
  kind: NoticeKind
  text: string
  /** When it was posted or last changed (ms); the newer wins between equal priorities. */
  at: number
  /** Absolute time (ms) after which it is gone. Undefined: stays until dismissed or resolved. */
  expiresAt?: number
  /** Testid of the message element (kept so older e2e selectors still find import and template messages). */
  testId?: string
  actions?: NoticeAction[]
  /** Shows a Dismiss button. */
  dismissible?: boolean
  /** Longer text for the tooltip when the visible one is clamped; defaults to `text`. */
  title?: string
}

/** Posts `notice`: replaces the same key, else appends, then trims to NOTICE_LIMIT (lowest priority, oldest first). */
export function postNotice(list: readonly TeamNotice[], notice: TeamNotice): TeamNotice[] {
  const next = [...list.filter((n) => n.key !== notice.key), notice]
  if (next.length <= NOTICE_LIMIT) return next
  const order = [...next].sort(compareNotices)
  const keep = new Set(order.slice(0, NOTICE_LIMIT).map((n) => n.key))
  return next.filter((n) => keep.has(n.key))
}

export function clearNotice(list: readonly TeamNotice[], key: string): TeamNotice[] {
  return list.some((n) => n.key === key) ? list.filter((n) => n.key !== key) : (list as TeamNotice[])
}

/** Drops what has expired at `now`. Returns the same array when nothing did, so a state setter can skip the render. */
export function pruneNotices(list: readonly TeamNotice[], now: number): TeamNotice[] {
  return list.some((n) => n.expiresAt !== undefined && n.expiresAt <= now) ? list.filter((n) => n.expiresAt === undefined || n.expiresAt > now) : (list as TeamNotice[])
}

/** The soonest expiry still ahead of `now`, for scheduling one timer; null when nothing expires. */
export function nextExpiry(list: readonly TeamNotice[], now: number): number | null {
  let soonest: number | null = null
  for (const n of list) if (n.expiresAt !== undefined && n.expiresAt > now && (soonest === null || n.expiresAt < soonest)) soonest = n.expiresAt
  return soonest
}

/** Priority first (error before hint), then the newest. */
export function compareNotices(a: TeamNotice, b: TeamNotice): number {
  return NOTICE_PRIORITY[a.kind] - NOTICE_PRIORITY[b.kind] || b.at - a.at
}

/** What the row shows now and what waits behind it, in the order they would come up. Expired notices are ignored. */
export function rankNotices(list: readonly TeamNotice[], now: number): { current: TeamNotice | null; waiting: TeamNotice[] } {
  const live = list.filter((n) => n.expiresAt === undefined || n.expiresAt > now).sort(compareNotices)
  return { current: live[0] ?? null, waiting: live.slice(1) }
}

// ---------- Words (vocabulary of spec 0.1: delegate, hand work to, reports to) ----------

export const HINT_TEXT = 'Click a role to edit it. Drag from its bottom handle onto another role to change who it reports to. Right-click a role for more.'
export const UNDO_UNTIL_CHANGE = 'You can undo until you change a role.'

/** "1 report" / "3 reports". */
export const reportCount = (n: number): string => (n === 1 ? '1 report' : `${n} reports`)

/** `Added {name} under {Parent}.`; the first role of an empty team is the top. */
export function addedText(name: string, parentName: string | null): string {
  return parentName ? `Added ${name} under ${parentName}.` : `Added ${name} as the top of the team.`
}

/** `Removed {name}.` plus, with reports, where they went. */
export function removedText(name: string, reports: number, parentName: string | null): string {
  if (reports === 0 || !parentName) return `Removed ${name}.`
  return `Removed ${name}. Its ${reports === 1 ? '1 report now reports' : `${reports} reports now report`} to ${parentName}.`
}

/** The confirm shown only when the role has reports (the effect is not obvious). */
export function removeConfirmText(name: string, reports: number, parentName: string): { title: string; body: string; confirmLabel: string } {
  return {
    title: `Remove ${name}?`,
    body: `Its ${reports === 1 ? '1 report moves' : `${reports} reports move`} up to ${parentName}.`,
    confirmLabel: 'Remove role'
  }
}

/** `{Role} now reports to {Manager}.`, then an optional sentence about delegation that changed with it. */
export function reparentedText(name: string, managerName: string, delegation?: string | null): string {
  return delegation ? `${name} now reports to ${managerName}. ${delegation}` : `${name} now reports to ${managerName}.`
}

/** The Add role popover's line under "Reports to": true before the action, so nothing needs saying after it. */
export function addHelperText(parentName: string, parentCanDelegate: boolean): string {
  return parentCanDelegate
    ? `${parentName} will be able to delegate to it.`
    : `${parentName} will be able to hand work to other roles. You can change that on ${parentName}.`
}

export function duplicateNameText(name: string): string {
  return `There is already a role called ${name}. Pick another name.`
}

/** Case-insensitive, trimmed: is `name` the name of one of `roles`? */
export function nameTaken(roles: readonly { name: string }[], name: string): boolean {
  const wanted = name.trim().toLowerCase()
  return wanted !== '' && roles.some((r) => r.name.trim().toLowerCase() === wanted)
}
