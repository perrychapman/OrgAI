/**
 * Pure helpers for the run side tab "Knowledge" (docs/design/knowledge-graph-2.md section 3): the recalled list built
 * from `knowledge.recalled` events, the usage rows, the Back stack and the run-window test. No I/O.
 */

import type { KnowledgeServedUsage } from '@shared/types'
import { parseRunWindowHash } from '@shared/types'
import { KNOWLEDGE_ID_RE } from './knowledgeRun'

/** Most rows the Recalled list shows. */
export const RECALLED_MAX = 200
/** Most events kept per run in the store (older ones are dropped; counts then start from what is kept). */
export const RECALLED_EVENTS_MAX = 500
/** Most steps the compact detail's Back stack keeps. */
export const RUN_KNOWLEDGE_STACK_MAX = 20
/** Most results the side tab's search shows. */
export const RUN_KNOWLEDGE_RESULT_LIMIT = 20

/** What the renderer keeps of a `knowledge.recalled` event: the ids and when (agent and `via` are not shown). */
export interface RecalledEvent {
  nodeIds: string[]
  at: number
}

/** The event reduced to ids that look like node ids and a finite time; null when nothing usable is left. */
export function cleanRecalledEvent(e: { nodeIds?: unknown; at?: unknown }): RecalledEvent | null {
  if (!Array.isArray(e.nodeIds)) return null
  const seen = new Set<string>()
  for (const id of e.nodeIds) if (typeof id === 'string' && /^kn_/.test(id) && KNOWLEDGE_ID_RE.test(id)) seen.add(id)
  if (seen.size === 0) return null
  const at = typeof e.at === 'number' && Number.isFinite(e.at) ? e.at : 0
  return { nodeIds: [...seen], at }
}

/** A run's event list with one more event, the oldest dropped past the cap. */
export function addRecalled(list: readonly RecalledEvent[] | undefined, ev: RecalledEvent): RecalledEvent[] {
  const next = [...(list ?? []), ev]
  return next.length > RECALLED_EVENTS_MAX ? next.slice(next.length - RECALLED_EVENTS_MAX) : next
}

/** One Recalled row: an item, how many events gave it, and when last. */
export interface RecalledRow {
  id: string
  count: number
  lastAt: number
}

/**
 * Section 3.1 item 3: one row per item over a chain's events (an item counts once per event), newest first (ties: the
 * later event, then the id's place inside it), ids not in `liveIds` dropped, at most `max`.
 */
export function recalledRows(events: readonly RecalledEvent[], liveIds: ReadonlySet<string>, max: number = RECALLED_MAX): RecalledRow[] {
  const ordered = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.at - b.e.at || a.i - b.i)
  const rows = new Map<string, RecalledRow & { seq: number }>()
  let seq = 0
  for (const { e } of ordered) {
    // Reverse, so the event's first id (its best match) ends up the newest of its ties.
    for (let k = e.nodeIds.length - 1; k >= 0; k--) {
      const id = e.nodeIds[k]
      if (!liveIds.has(id)) continue
      const cur = rows.get(id)
      rows.set(id, { id, count: (cur?.count ?? 0) + 1, lastAt: e.at, seq: seq++ })
    }
  }
  return [...rows.values()]
    .sort((a, b) => b.lastAt - a.lastAt || b.seq - a.seq)
    .slice(0, max)
    .map(({ id, count, lastAt }) => ({ id, count, lastAt }))
}

/** "Given once" / "Given 3 times". */
export const givenText = (count: number): string => (count === 1 ? 'Given once' : `Given ${count} times`)

/** The search box's status after a settled query: "3 items found." / "Nothing recorded matches Acme." */
export function resultsStatus(count: number, query: string): string {
  if (count === 0) return `Nothing recorded matches ${query.trim()}.`
  return `${count} ${count === 1 ? 'item' : 'items'} found.`
}

/** "1 time" / "5 times". */
const times = (n: number): string => `${n.toLocaleString('en-US')} ${n === 1 ? 'time' : 'times'}`

/** One row of the usage panel's Knowledge list. */
export interface KnowledgeUsageRow {
  id: 'recalls' | 'auto' | 'items' | 'chars'
  label: string
  text: string
}

/** Section 3.5. Never worded as savings. */
export function knowledgeUsageRows(k: KnowledgeServedUsage): KnowledgeUsageRow[] {
  const whole = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)
  const chars = whole(k.charsServed)
  return [
    { id: 'recalls', label: 'Looked up by agents', text: times(whole(k.recalls)) },
    { id: 'auto', label: 'Added automatically', text: times(whole(k.autoContexts)) },
    { id: 'items', label: 'Items given to agents', text: whole(k.itemsServed).toLocaleString('en-US') },
    { id: 'chars', label: 'Text given to agents', text: `${chars.toLocaleString('en-US')} ${chars === 1 ? 'character' : 'characters'}` }
  ]
}

/** The Back stack after opening `next` from `current` (null = the list): pushes the step, drops the oldest past the cap. */
export function pushStep(stack: readonly string[], current: string | null): string[] {
  if (current === null) return []
  const next = [...stack, current]
  return next.length > RUN_KNOWLEDGE_STACK_MAX ? next.slice(next.length - RUN_KNOWLEDGE_STACK_MAX) : next
}

/** One Back: the item to show (null = the list), the stack left and the id we leave (focus returns to its row or link). */
export function popStep(stack: readonly string[], current: string | null): { openId: string | null; stack: string[]; left: string | null } {
  if (stack.length === 0) return { openId: null, stack: [], left: current }
  return { openId: stack[stack.length - 1], stack: stack.slice(0, -1), left: current }
}

/** True in a window scoped to one run (`#/run/<projectId>/<runId>`): the project's Knowledge tab cannot be reached there. */
export const isRunWindow = (hash: string = typeof window === 'undefined' ? '' : window.location.hash): boolean => parseRunWindowHash(hash) !== null

/**
 * Opens the run side panel when it is a rail (the "Show run panel" button) and moves focus to the Knowledge tab once it is
 * there. The panel's own state lives in SidePanel; this is the only way in from RunMeta.
 */
export function revealKnowledgeTab(): void {
  document.querySelector<HTMLElement>('aside.side-panel[data-collapsed="true"] .side-rail button')?.click()
  requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid=side-tab-knowledge]')?.focus()))
}

/** The wording of the line that stands in for "Open in Knowledge" in a run window. */
export const RUN_WINDOW_NOTE = 'To edit this item, open Knowledge in the main OrgAI window.'
export const RECALLED_OLD_NOTE = 'Item names here are kept only while OrgAI is open.'
