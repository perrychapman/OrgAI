import type { ProjectKind, ProposalKind } from '@shared/types'
import { waitingItems, type WaitingKind, type WaitRun } from './needsYou'
import { sinceLastSeen, errorFirstLine, type EndedRunLike } from './dashboard'
import type { TeamAttentionItem } from './teamFiles'

/**
 * The Inbox's list (docs/design/ui-overhaul/project/Inbox.dc.html), built from the same data the sidebar badge, the
 * Needs-you popover and the Dashboard count: `waitingItems` per open run plus the team-files items. Pure: no store, no
 * clock, no storage handle except the small read/write helpers that take one.
 */

/** The chips. One per kind of ask, plus Finished. Only kinds present in the data are drawn. */
export type InboxFilter = 'permission' | 'question' | 'review' | 'proposal' | 'other' | 'finished'
export const INBOX_FILTERS: readonly InboxFilter[] = ['permission', 'question', 'review', 'proposal', 'other', 'finished']
export const FILTER_LABEL: Record<InboxFilter, string> = {
  permission: 'Permissions',
  question: 'Questions',
  review: 'Reviews',
  proposal: 'Proposals',
  other: 'Other',
  finished: 'Finished'
}

export type InboxKind = WaitingKind | 'team' | 'finished' | 'failed'
export const KIND_LABEL: Record<InboxKind, string> = {
  permission: 'Permission',
  question: 'Question',
  rules: 'Rule',
  proposal: 'Proposal',
  merge: 'Review',
  install: 'New tool',
  plan: 'Plan',
  team: 'Team files',
  finished: 'Finished',
  failed: 'Failed'
}

const FILTER_OF: Record<InboxKind, InboxFilter> = {
  permission: 'permission',
  rules: 'permission',
  question: 'question',
  merge: 'review',
  proposal: 'proposal',
  team: 'proposal',
  install: 'other',
  plan: 'other',
  finished: 'finished',
  failed: 'finished'
}

export interface InboxItem {
  /** Stable across renders: `w:<runId>/<key>`, `t:<team key>` or `f:<runId>`. */
  id: string
  group: 'waiting' | 'finished'
  filter: InboxFilter
  kind: InboxKind
  kindLabel: string
  /** The ask, in words (the row's title). Untrusted text: render as plain text only. */
  title: string
  /** Who asks (an agent's name), or how a finished run ended. */
  who: string
  projectId: string
  projectName: string
  runId?: string
  /** The decision's key inside its run (a team item's `team:<projectId>`). */
  key?: string
  /** Waiting: when the decision was raised ('decision') or, when the card carries no time, when its run started ('run'). Finished: when it ended. Epoch ms. */
  at: number
  /** Where `at` comes from. 'none' = no time at all (a team-files item): it sorts last and shows no age. */
  atSource: 'decision' | 'run' | 'ended' | 'none'
}

/** What the builder reads of a live run: a WaitRun plus the summary fields the Inbox names it by. */
export interface InboxRunIn extends WaitRun {
  summary: WaitRun['summary'] & { projectId: string; kind?: string }
  agents: Record<string, { name: string }>
  // The time each decision was raised: requestedAt on a permission card, createdAt on the others. Absent on cards that
  // predate those fields; the row then falls back to the run's start.
  permissions?: readonly { id: string; agentId: string; toolName: string; input?: unknown; requestedAt?: number }[]
  proposals?: readonly { id: string; title?: string; kind?: ProposalKind; createdAt?: number }[]
  questions?: readonly { id: string; agentId: string; question: string; createdAt?: number }[]
  ruleRequests?: readonly { id: string; agentId: string; createdAt?: number }[]
  mergeReviews?: readonly { id: string; agentName: string; createdAt?: number }[]
  mcpInstalls?: readonly { id: string; agentId: string; createdAt?: number }[]
}

/** When one decision was raised, epoch ms; undefined when the card carries no usable time. */
function raisedAt(run: InboxRunIn, kind: WaitingKind, key: string): number | undefined {
  let t: unknown
  switch (kind) {
    case 'permission':
      t = run.permissions?.find((p) => p.id === key)?.requestedAt
      break
    case 'question':
      t = run.questions?.find((q) => q.id === key)?.createdAt
      break
    case 'rules':
      t = run.ruleRequests?.find((r) => r.id === key)?.createdAt
      break
    case 'install':
      t = run.mcpInstalls?.find((i) => i.id === key)?.createdAt
      break
    case 'merge':
      t = run.mergeReviews?.find((m) => m.id === key)?.createdAt
      break
    case 'proposal':
      t = run.proposals?.find((p) => p.id === key)?.createdAt
      break
    default:
      t = undefined
  }
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : undefined
}

export interface InboxFinishedIn extends EndedRunLike {
  projectId: string
  totalCostUsd?: number
  error?: string
  scheduleName?: string
}

/** The agent behind one decision, by the lists the cards come from. */
function whoOf(run: InboxRunIn, kind: WaitingKind, key: string): string {
  const named = (agentId: string | undefined): string => (agentId ? (run.agents[agentId]?.name ?? 'An agent') : 'An agent')
  const architect = (run.summary as { kind?: string }).kind === 'setup' ? 'The Architect' : undefined
  switch (kind) {
    case 'permission':
      return named(run.permissions?.find((p) => p.id === key)?.agentId)
    case 'question':
      return architect ?? named(run.questions?.find((q) => q.id === key)?.agentId)
    case 'rules':
      return named(run.ruleRequests?.find((r) => r.id === key)?.agentId)
    case 'install':
      return named(run.mcpInstalls?.find((i) => i.id === key)?.agentId)
    case 'merge':
      return run.mergeReviews?.find((m) => m.id === key)?.agentName ?? 'An agent'
    case 'proposal':
      return architect ?? 'The team'
    default:
      return 'The orchestrator'
  }
}

/** The label without its kind prefix, where the kind is already the pill ("Allow: Run npm test" reads "Run npm test"). */
export function askTitle(kind: WaitingKind, label: string): string {
  const prefix = kind === 'permission' ? 'Allow: ' : kind === 'question' ? 'Question: ' : ''
  return prefix && label.startsWith(prefix) ? label.slice(prefix.length) : label
}

export interface BuildWaitingInput {
  /** Runs with at least one open decision, in any order. */
  runs: readonly InboxRunIn[]
  teamItems: readonly TeamAttentionItem[]
  /** Name shown for a run's project. */
  projectName: (run: InboxRunIn) => string
  projectKind?: (projectId: string) => ProjectKind | undefined
}

/**
 * Every open decision, longest-waiting first: by when the decision was raised (the run's start when the card carries no
 * time), then the run's start, then the order its cards show; team-files items last (they have no run and no time). The
 * length is the number the sidebar badge and the Needs-you popover show.
 */
export function buildWaiting({ runs, teamItems, projectName, projectKind }: BuildWaitingInput): InboxItem[] {
  const ordered = [...runs].sort((a, b) => a.summary.startedAt - b.summary.startedAt || a.summary.id.localeCompare(b.summary.id))
  const out: InboxItem[] = []
  for (const run of ordered) {
    const name = projectName(run)
    for (const it of waitingItems(run, projectKind?.(run.summary.projectId))) {
      const raised = raisedAt(run, it.kind, it.key)
      out.push({
        id: `w:${it.runId}/${it.key}`,
        group: 'waiting',
        filter: FILTER_OF[it.kind],
        kind: it.kind,
        kindLabel: KIND_LABEL[it.kind],
        title: askTitle(it.kind, it.label),
        who: whoOf(run, it.kind, it.key),
        projectId: run.summary.projectId,
        projectName: name,
        runId: it.runId,
        key: it.key,
        at: raised ?? run.summary.startedAt,
        atSource: raised !== undefined ? 'decision' : 'run'
      })
    }
  }
  // Stable: equal times keep the run order and card order built above.
  out.sort((a, b) => a.at - b.at)
  for (const t of teamItems) {
    out.push({
      id: `t:${t.key}`,
      group: 'waiting',
      filter: FILTER_OF.team,
      kind: 'team',
      kindLabel: KIND_LABEL.team,
      title: t.label,
      who: 'Team files',
      projectId: t.projectId,
      projectName: t.projectName,
      key: t.key,
      at: Number.MAX_SAFE_INTEGER,
      atSource: 'none'
    })
  }
  return out
}

export interface BuildFinishedInput<T extends InboxFinishedIn> {
  summaries: readonly T[]
  /** The user's last "mark all read" (or first visit), epoch ms. */
  seenAt: number
  /** Run ids the user opened or cleared since. */
  read: ReadonlySet<string>
  now: number
  projectName: (summary: T) => string
  runName: (summary: T) => string
  /** At most this many (newest first). */
  cap?: number
}

/**
 * Runs that ended (finished or failed, one row per chain) after `seenAt`, newest first, minus the ones already read.
 * User-stopped runs, runs cut by a quit and paused runs are not news: the user did those or sees them elsewhere.
 */
export function buildFinished<T extends InboxFinishedIn>({ summaries, seenAt, read, now, projectName, runName, cap = 50 }: BuildFinishedInput<T>): InboxItem[] {
  const { items } = sinceLastSeen(summaries, seenAt, now, { cap: Number.MAX_SAFE_INTEGER })
  const out: InboxItem[] = []
  for (const e of items) {
    if (e.kind !== 'finished' && e.kind !== 'failed') continue
    if (read.has(e.run.id)) continue
    const failed = e.kind === 'failed'
    out.push({
      id: `f:${e.run.id}`,
      group: 'finished',
      filter: 'finished',
      kind: failed ? 'failed' : 'finished',
      kindLabel: failed ? KIND_LABEL.failed : KIND_LABEL.finished,
      title: runName(e.run),
      who: e.run.scheduleName ? `Scheduled: ${e.run.scheduleName}` : failed ? (errorFirstLine(e.run.error, 80) || 'The run failed') : 'The run finished',
      projectId: e.run.projectId,
      projectName: projectName(e.run),
      runId: e.run.id,
      at: e.endedAt,
      atSource: 'ended'
    })
  }
  return out.slice(0, cap)
}

export interface InboxFilters {
  filter: InboxFilter | 'all'
  /** A project id, or 'all'. */
  project: string
}
export const NO_FILTERS: InboxFilters = { filter: 'all', project: 'all' }

export function applyFilters(items: readonly InboxItem[], f: InboxFilters): InboxItem[] {
  return items.filter((it) => (f.project === 'all' || it.projectId === f.project) && (f.filter === 'all' || it.filter === f.filter))
}

/** Chip counts under the project filter. `all` and every kind that has at least one item; zero-count kinds are absent. */
export function filterCounts(items: readonly InboxItem[], project: string): { all: number; kinds: { filter: InboxFilter; count: number }[] } {
  const scoped = project === 'all' ? items : items.filter((it) => it.projectId === project)
  const kinds = INBOX_FILTERS.map((filter) => ({ filter, count: scoped.filter((it) => it.filter === filter).length })).filter((k) => k.count > 0)
  return { all: scoped.length, kinds }
}

/** Projects that have items, by name, with their counts. */
export function projectOptions(items: readonly InboxItem[]): { id: string; name: string; count: number }[] {
  const by = new Map<string, { id: string; name: string; count: number }>()
  for (const it of items) {
    const at = by.get(it.projectId)
    if (at) at.count += 1
    else by.set(it.projectId, { id: it.projectId, name: it.projectName, count: 1 })
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/**
 * The selection after the list changed. Kept when still present; else the nearest item that followed it in the old
 * list, else the nearest one before it, else null. Answering an item therefore lands on the next one.
 */
export function nextSelection(prevIds: readonly string[], prevSelected: string | null, nextIds: readonly string[]): string | null {
  if (nextIds.length === 0) return null
  if (prevSelected !== null && nextIds.includes(prevSelected)) return prevSelected
  const at = prevSelected === null ? -1 : prevIds.indexOf(prevSelected)
  if (at < 0) return nextIds[0]
  const alive = new Set(nextIds)
  for (let i = at + 1; i < prevIds.length; i++) if (alive.has(prevIds[i])) return prevIds[i]
  for (let i = at - 1; i >= 0; i--) if (alive.has(prevIds[i])) return prevIds[i]
  return nextIds[0]
}

/** J / K: one step, stopping at the ends (no wrap, so the user always knows where the list ends). */
export function stepSelection(ids: readonly string[], selected: string | null, delta: 1 | -1 | 'first' | 'last'): string | null {
  if (ids.length === 0) return null
  if (delta === 'first') return ids[0]
  if (delta === 'last') return ids[ids.length - 1]
  const at = selected === null ? -1 : ids.indexOf(selected)
  if (at < 0) return delta === 1 ? ids[0] : ids[ids.length - 1]
  return ids[Math.min(ids.length - 1, Math.max(0, at + delta))]
}

/** "N waiting on you · M finished". */
export function summaryText(waiting: number, finished: number): string {
  return `${waiting} waiting on you · ${finished} finished`
}

/** "just now", "5 min", "3 h", "2 d". */
export function relativeAgo(at: number, now: number): string {
  if (!Number.isFinite(at) || at >= Number.MAX_SAFE_INTEGER) return ''
  const ms = Math.max(0, now - at)
  const MIN = 60_000
  if (ms < MIN) return 'just now'
  if (ms < 60 * MIN) return `${Math.floor(ms / MIN)} min`
  if (ms < 24 * 60 * MIN) return `${Math.floor(ms / (60 * MIN))} h`
  return `${Math.floor(ms / (24 * 60 * MIN))} d`
}

// ---------------------------------------------------------------- the activation guard (pure)

/**
 * The keys that press a card's button. A card's action must never be pressed by a key event that began before that
 * action had focus (a held or doubled Enter that moved focus there, or that is still repeating after the previous
 * card was answered). The guard is a small value the Inbox keeps in a ref:
 *  - `held`: guarded keys currently down (from the Inbox's own capture-phase key tracking);
 *  - `blocked`: the keys that were down when focus arrived in the detail pane, swallowed until each is released;
 *  - `until`: epoch ms before which a fresh press is also swallowed (a short dwell after Enter moved focus there, so a
 *    rapid second tap cannot answer the card the user has not yet seen).
 * A repeating keydown (`repeat`) is never allowed to press anything.
 */
export interface KeyGuard {
  held: readonly string[]
  blocked: readonly string[]
  until: number
}
export const GUARDED_KEYS: readonly string[] = ['Enter', ' ']
/** How long a fresh Enter / Space stays swallowed after Enter on a row moved focus to the card's action. */
export const ENTER_DWELL_MS = 400
export const FRESH_GUARD: KeyGuard = { held: [], blocked: [], until: 0 }

/** A key went down (only a non-repeating keydown counts as a press). */
export function guardPress(g: KeyGuard, key: string, repeat: boolean): KeyGuard {
  if (repeat || !GUARDED_KEYS.includes(key) || g.held.includes(key)) return g
  return { ...g, held: [...g.held, key] }
}

/** A key went up: it is no longer held and no longer blocked. */
export function guardRelease(g: KeyGuard, key: string): KeyGuard {
  if (!g.held.includes(key) && !g.blocked.includes(key)) return g
  return { ...g, held: g.held.filter((k) => k !== key), blocked: g.blocked.filter((k) => k !== key) }
}

/** Focus arrived in the detail pane from outside it: every key down right now is blocked until it is released. `dwellMs` adds a short fresh-press hold. */
export function guardArrive(g: KeyGuard, now: number, dwellMs = 0): KeyGuard {
  return { ...g, blocked: [...g.held], until: dwellMs > 0 ? now + dwellMs : g.until }
}

/** The window lost focus: a keyup may never arrive, so nothing is tracked as held and nothing stays blocked. */
export function guardReset(): KeyGuard {
  return FRESH_GUARD
}

/** True when this keydown must not reach the card (it would press its action). */
export function guardSwallows(g: KeyGuard, key: string, repeat: boolean, now: number): boolean {
  if (!GUARDED_KEYS.includes(key)) return false
  return repeat || g.blocked.includes(key) || now < g.until
}

/** Spoken when the selection moves by itself (the answered item left). */
export function afterAnswerText(next: InboxItem | null, index: number, total: number, remaining: number, verb: 'Answered' | 'Cleared' = 'Answered'): string {
  if (!next) return remaining === 0 ? `${verb}. Nothing is waiting on you.` : `${verb}.`
  return `${verb}. Next: ${next.title}, ${next.projectName}. ${index + 1} of ${total}.`
}

/** Spoken for a moved selection (J / K). */
export function selectionText(item: InboxItem, index: number, total: number): string {
  return `${item.kindLabel}: ${item.title}, ${item.projectName}. ${index + 1} of ${total}.`
}

/** The accessible name of a list row: everything the row shows, in reading order. */
export function rowName(item: InboxItem, when: string): string {
  const who = item.who ? `, ${item.who}` : ''
  const ago = when === 'just now' ? when : `${when} ago`
  const at = !when
    ? ''
    : item.group !== 'waiting'
      ? `, ended ${ago}`
      : item.atSource === 'decision'
        ? `, waiting ${when}`
        : `, run started ${ago}`
  return `${item.kindLabel}: ${item.title}${who}, ${item.projectName}${at}`
}

// ---------------------------------------------------------------- what the user has already seen (localStorage, renderer only)

export const INBOX_SEEN_KEY = 'orgai.inboxSeenAt'
export const INBOX_READ_KEY = 'orgai.inboxRead'
/** Read ids kept; the oldest go first. The 7 day window means older runs are never listed anyway. */
export const INBOX_READ_CAP = 200

type Reader = Pick<Storage, 'getItem'> | null | undefined
type Writer = Pick<Storage, 'setItem'> | null | undefined

export function readSeenAt(storage: Reader): number | null {
  try {
    const raw = storage?.getItem(INBOX_SEEN_KEY)
    if (raw === null || raw === undefined || raw.trim() === '') return null
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}
export function writeSeenAt(storage: Writer, ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return
  try {
    storage?.setItem(INBOX_SEEN_KEY, String(Math.floor(ms)))
  } catch {
    /* storage unavailable */
  }
}
export function readReadIds(storage: Reader): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(INBOX_READ_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').slice(-INBOX_READ_CAP) : []
  } catch {
    return []
  }
}
export function writeReadIds(storage: Writer, ids: readonly string[]): void {
  try {
    storage?.setItem(INBOX_READ_KEY, JSON.stringify(ids.slice(-INBOX_READ_CAP)))
  } catch {
    /* storage unavailable */
  }
}
