/**
 * The model behind the Waiting on you tiles (docs/design/dashboard-overhaul.md 7.2, board pass): one tile per run that
 * needs the person. Pure: no store, no DOM. The component feeds it what the store holds.
 *
 * Three kinds of tile:
 * - `decision`: a run with open decisions; its rows are the run's items (NeedsRow), the most urgent first.
 * - `team`: the team-files approvals of one project.
 * - `reply`: a live run that sits idle waiting for the person's reply and has no decision open (the rule the greeting and
 *   Working now use: `bandWorkFacts().awaitingReply`). Its body is a short plain-text summary of the root's last message.
 *
 * Order: decision and team tiles by the `waitingOrder` weights of their most urgent item, then reply tiles by how long
 * they waited, longest first. A tile that stays keeps its place (`waitingOrder`'s stabilisation).
 *
 * Run text is untrusted: `plainSummary` returns plain text only, never markup; the component renders it as React text.
 */

import type { AgentInstance, Project, RunPlan, RunSummary, TranscriptEntry } from '@shared/types'
import { bandWorkFacts, rootOf, type BandRunIn } from './dashboardBand'
import { showHidden } from './hiddenChars'
import { waitingOrder, type WaitingOrderFacts } from './waitingOrder'

export type TileKind = 'decision' | 'team' | 'reply'

/** How many of a decision tile's rows it shows before "+N more". */
export const TILE_ROW_CAP = 2

/** The longest summary kept: CSS clips it to two lines, this only bounds the work and the `title`. */
export const SUMMARY_MAX = 320

/** What a tile needs of an item: the same shape as `NeedsItem` (components/dashboard/NeedsInline.tsx), kept structural. */
export interface TileItem {
  kind: string
  key: string
  projectId: string
  runId?: string
}

export interface DecisionTile<I extends TileItem> {
  key: string
  kind: 'decision' | 'team'
  projectId: string
  runId?: string
  /** The run's open items, in the order they are shown (most urgent first). */
  items: I[]
  startedAt: number
  /** When the wait began, when known (epoch ms). */
  since?: number
}

export interface ReplyTile {
  key: string
  kind: 'reply'
  projectId: string
  runId: string
  title: string
  /** The root's last message as plain text; empty when the run has said nothing. */
  summary: string
  startedAt: number
  since?: number
}

export type AttentionTile<I extends TileItem> = DecisionTile<I> | ReplyTile

// ---------- Plain text ----------

const FENCE = /^\s*(```|~~~).*$/

/**
 * One line of plain text from model output: markdown marks removed (fences, headings, quotes, list bullets, emphasis, code
 * ticks, link and image syntax keeps its label), hidden characters shown as escapes, whitespace collapsed, clipped to
 * `max` characters. Never produces markup and finds no links: a URL stays the characters it was.
 */
export function plainSummary(text: string, max = SUMMARY_MAX): string {
  const lines = showHidden(text.slice(0, max * 8))
    .split(/\r?\n/)
    .filter((l) => !FENCE.test(l) && !/^\s*\|?[\s:|-]{3,}\|?\s*$/.test(l) && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(l))
    .map((l) =>
      l
        .replace(/^\s{0,3}(#{1,6}|>+)\s*/, '')
        .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?/, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/`+([^`]*)`+/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=$|[\s).,;:!?])/g, '$1$2')
        .replace(/~~([^~]+)~~/g, '$1')
        .replace(/\|/g, ' ')
    )
  const one = lines.join(' ').replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, Math.max(0, max - 1)).trimEnd()}…` : one
}

/** The root's newest message as text: the newest `text` block of the root agent that the harness did not write. */
export function lastAssistantText(transcript: readonly Pick<TranscriptEntry, 'agentId' | 'at' | 'block' | 'source'>[], rootId: string): { text: string; at: number } | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i]
    if (e.source === 'harness' || e.agentId !== rootId || e.block.kind !== 'text') continue
    const text = plainSummary(e.block.text)
    if (text) return { text, at: e.at }
  }
  return null
}

/** The time of the newest transcript entry, the nearest thing the store holds to "last activity". */
export function lastEntryAt(transcript: readonly Pick<TranscriptEntry, 'at'>[]): number | undefined {
  let at: number | undefined
  for (let i = transcript.length - 1; i >= 0 && i >= transcript.length - 40; i--) {
    const t = transcript[i].at
    if (typeof t === 'number' && Number.isFinite(t) && (at === undefined || t > at)) at = t
  }
  return at
}

// ---------- Waited ----------

/** "12m", "3h", "2d": the compact wait, mono caption. `short` is empty below a minute ("now" is not a number to read). */
export function waitedShort(since: number | undefined, now: number): string {
  if (since === undefined || !Number.isFinite(since)) return ''
  const s = Math.max(0, Math.round((now - since) / 1000))
  if (s < 60) return '<1m'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

/** The same wait in words, for a tooltip and the accessible name ("Waiting 12 minutes"). */
export function waitedLong(since: number | undefined, now: number): string {
  if (since === undefined || !Number.isFinite(since)) return ''
  const s = Math.max(0, Math.round((now - since) / 1000))
  if (s < 60) return 'Waiting less than a minute'
  const m = Math.round(s / 60)
  const unit = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
  if (m < 60) return `Waiting ${unit(m, 'minute')}`
  const h = Math.round(m / 60)
  if (h < 24) return `Waiting ${unit(h, 'hour')}`
  return `Waiting ${unit(Math.round(h / 24), 'day')}`
}

// ---------- Which runs wait for a reply ----------

/** The slice of a live run the reply rule reads (structural; the store's `RunState` satisfies it). */
export interface ReplyRunIn {
  summary: RunSummary
  agents: Record<string, AgentInstance>
  plan?: RunPlan
  decisions: number
  transcript: readonly TranscriptEntry[]
}

/**
 * True when the run is idle and waiting on the person's reply with no decision open: exactly what the greeting counts
 * (`bandWorkFacts().awaitingReply`), by calling it for this one run.
 */
export function isAwaitingReply(run: Pick<ReplyRunIn, 'summary' | 'agents' | 'plan' | 'decisions'>, projects: readonly Project[], virtualProjects: Partial<Record<string, Project>>): boolean {
  if (run.decisions > 0) return false
  const input: BandRunIn = { summary: run.summary, ...(run.plan ? { plan: run.plan } : {}), agents: run.agents, decisions: 0 }
  return bandWorkFacts([input], projects, virtualProjects).awaitingReply === 1
}

/** A reply tile's facts for one run that is awaiting a reply. */
export function replyFacts(run: ReplyRunIn, title: string): Omit<ReplyTile, 'kind' | 'key'> & { key: string } {
  const root = rootOf(Object.values(run.agents))
  const said = lastAssistantText(run.transcript, root?.id ?? 'root')
  const since = said?.at ?? lastEntryAt(run.transcript)
  return {
    key: since === undefined ? `reply:${run.summary.id}` : `reply:${run.summary.id}:${since}`,
    projectId: run.summary.projectId,
    runId: run.summary.id,
    title,
    summary: said?.text ?? '',
    startedAt: run.summary.startedAt,
    ...(since === undefined ? {} : { since })
  }
}

// ---------- Tiles ----------

/** The earliest known wait of a run's open cards (questions, rule requests, merges and installs carry `createdAt`). */
export function decisionSince(run: { questions?: readonly { createdAt?: number }[]; ruleRequests?: readonly { createdAt?: number }[]; mergeReviews?: readonly { createdAt?: number }[]; mcpInstalls?: readonly { createdAt?: number }[]; transcript?: readonly Pick<TranscriptEntry, 'at'>[] }): number | undefined {
  let min: number | undefined
  for (const list of [run.questions, run.ruleRequests, run.mergeReviews, run.mcpInstalls]) {
    for (const c of list ?? []) if (typeof c.createdAt === 'number' && Number.isFinite(c.createdAt) && (min === undefined || c.createdAt < min)) min = c.createdAt
  }
  // A permission card has no timestamp: the agent stopped at its last entry, which is the nearest thing the store holds.
  return min ?? (run.transcript ? lastEntryAt(run.transcript) : undefined)
}

/**
 * Groups the ordered items into tiles: one per run, one per project for team-files items. Tiles come out in the order of
 * their first item, so the order of `items` (already stabilised) carries over.
 */
export function groupDecisionTiles<I extends TileItem>(items: readonly I[], info: (item: I) => { startedAt: number; since?: number }): DecisionTile<I>[] {
  const byKey = new Map<string, DecisionTile<I>>()
  for (const it of items) {
    const team = it.kind === 'team' || !it.runId
    const key = team ? `team:${it.projectId}` : `decision:${it.runId}`
    let tile = byKey.get(key)
    if (!tile) {
      const i = info(it)
      tile = { key, kind: team ? 'team' : 'decision', projectId: it.projectId, ...(team ? {} : { runId: it.runId }), items: [], startedAt: i.startedAt, ...(i.since === undefined ? {} : { since: i.since }) }
      byKey.set(key, tile)
    }
    tile.items.push(it)
  }
  return [...byKey.values()]
}

/** What the order reads of a tile: the kind of its most urgent item (reply tiles weigh last), the wait or run start, the key. */
export function tileFacts(tile: AttentionTile<TileItem>): WaitingOrderFacts {
  if (tile.kind === 'reply') return { key: tile.key, kind: 'reply', start: tile.since ?? tile.startedAt }
  return { key: tile.key, kind: tile.items[0]?.kind ?? 'team', start: tile.kind === 'team' ? 0 : tile.startedAt }
}

/** The tiles in page order. `previous` is the keys last shown: a tile that stays keeps its place. */
export function orderTiles<T extends AttentionTile<TileItem>>(tiles: readonly T[], previous: readonly string[] = []): T[] {
  return waitingOrder(tiles, tileFacts, previous)
}

/** The accessible name of a tile's quick link ("Open {run}", "Reply to {run}"). */
export function tileActionName(kind: TileKind, name: string): string {
  const n = name.trim() || 'this run'
  return kind === 'reply' ? `Reply to ${n}` : `Open ${n}`
}
