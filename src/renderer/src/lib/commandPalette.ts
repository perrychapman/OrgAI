import type { VirtualProjectId } from '@shared/types'

/**
 * The command palette's pure side (Ctrl/Cmd+K, the sidebar's "Search or jump to"): the list of things it can open,
 * built from data the renderer already has, and the ranking of that list against what the user typed. No React, no store.
 * The component (components/layout/CommandPalette.tsx) turns a chosen item's `target` into the same store calls the
 * sidebar rows make, so the palette never opens anything the sidebar could not.
 */

export type PaletteView = 'projects' | 'inbox' | 'usage' | 'schedules' | 'appSettings'

export type PaletteTarget =
  | { type: 'view'; view: PaletteView }
  | { type: 'assistant'; id: VirtualProjectId }
  | { type: 'project'; projectId: string }
  /** A tab of the project that is open (the store view id: run, history, ...). */
  | { type: 'tab'; view: string }
  | { type: 'run'; projectId: string; runId: string }
  | { type: 'new-project' }
  | { type: 'new-chat' }

/** Group headings, in the order they show when nothing is typed. */
export const PALETTE_GROUPS = ['This project', 'Open runs', 'Go to', 'Projects', 'Create'] as const
export type PaletteGroup = (typeof PALETTE_GROUPS)[number]

export interface PaletteItem {
  /** Stable across renders; also the option's DOM id suffix. */
  id: string
  label: string
  /** A second, quieter line of context: the project a run belongs to, the client of an engagement. */
  hint?: string
  group: PaletteGroup
  /** Extra words that find the item (not shown). */
  keywords?: string[]
  target: PaletteTarget
  /** The item needs the user (a run waiting on a decision): shown with the attention mark. */
  attention?: boolean
  /** Which icon the row carries; the component maps it. */
  icon: 'home' | 'inbox' | 'chat' | 'helper' | 'usage' | 'schedules' | 'settings' | 'code' | 'engagement' | 'run' | 'tab' | 'plus'
}

export interface PaletteProject {
  id: string
  name: string
  kind: 'code' | 'engagement'
  client?: string
}

export interface PaletteRun {
  runId: string
  projectId: string
  /** The run's tag and name ("R2: Add caching"). */
  label: string
  needsYou: boolean
}

export interface PaletteInput {
  projects: readonly PaletteProject[]
  /** Open (live) runs, the ones that need the user first. */
  runs: readonly PaletteRun[]
  /** Names of the project rows, for a run's hint. */
  projectNames: ReadonlyMap<string, string>
  /** The open project (or assistant) and the tabs it has; null on an app-level screen. */
  current: { name: string; tabs: readonly { view: string; label: string }[]; activeView?: string } | null
  helpers: readonly { id: VirtualProjectId; label: string }[]
  /** How many decisions wait on the user (the Inbox hint). */
  waiting: number
}

/** Everything the palette can open, in default display order. */
export function buildPaletteItems(input: PaletteInput): PaletteItem[] {
  const out: PaletteItem[] = []
  if (input.current) {
    const { name, tabs, activeView } = input.current
    for (const t of tabs) {
      if (t.view === activeView) continue
      out.push({ id: `tab:${t.view}`, label: t.label, hint: name, group: 'This project', keywords: [name, 'tab'], target: { type: 'tab', view: t.view }, icon: 'tab' })
    }
  }
  for (const r of input.runs) {
    out.push({
      id: `run:${r.runId}`,
      label: r.label,
      hint: input.projectNames.get(r.projectId),
      group: 'Open runs',
      keywords: ['run'],
      target: { type: 'run', projectId: r.projectId, runId: r.runId },
      attention: r.needsYou,
      icon: 'run'
    })
  }
  out.push({ id: 'view:projects', label: 'Home', group: 'Go to', keywords: ['dashboard', 'start'], target: { type: 'view', view: 'projects' }, icon: 'home' })
  out.push({
    id: 'view:inbox',
    label: 'Inbox',
    hint: input.waiting > 0 ? `${input.waiting} waiting on you` : undefined,
    group: 'Go to',
    keywords: ['decisions', 'needs you', 'waiting', 'approvals'],
    target: { type: 'view', view: 'inbox' },
    attention: input.waiting > 0,
    icon: 'inbox'
  })
  for (const h of input.helpers) {
    out.push({
      id: `assistant:${h.id}`,
      label: h.label,
      group: 'Go to',
      keywords: h.id === 'quick' ? ['chat', 'ask', 'assistant'] : ['helper', 'assistant'],
      target: { type: 'assistant', id: h.id },
      icon: h.id === 'quick' ? 'chat' : 'helper'
    })
  }
  out.push({ id: 'view:usage', label: 'Usage', group: 'Go to', keywords: ['cost', 'spend', 'plan limit'], target: { type: 'view', view: 'usage' }, icon: 'usage' })
  out.push({ id: 'view:schedules', label: 'Schedules', group: 'Go to', keywords: ['recurring', 'calendar'], target: { type: 'view', view: 'schedules' }, icon: 'schedules' })
  out.push({ id: 'view:appSettings', label: 'App settings', group: 'Go to', keywords: ['settings', 'preferences', 'connections', 'appearance', 'theme'], target: { type: 'view', view: 'appSettings' }, icon: 'settings' })
  for (const p of input.projects) {
    out.push({
      id: `project:${p.id}`,
      label: p.name,
      hint: p.kind === 'engagement' ? (p.client ? `Engagement · ${p.client}` : 'Engagement') : 'Code project',
      group: 'Projects',
      keywords: p.client ? [p.client, p.kind] : [p.kind],
      target: { type: 'project', projectId: p.id },
      icon: p.kind === 'engagement' ? 'engagement' : 'code'
    })
  }
  out.push({ id: 'new:project', label: 'New project or engagement', group: 'Create', keywords: ['create', 'add', 'start', 'folder'], target: { type: 'new-project' }, icon: 'plus' })
  out.push({ id: 'new:chat', label: 'New chat', group: 'Create', keywords: ['create', 'ask', 'conversation'], target: { type: 'new-chat' }, icon: 'plus' })
  return out
}

const WORD_BREAK = /[^\p{L}\p{N}]/u

/** How well one query word matches one text: 0 none, up to 100 for an exact match. */
export function wordScore(word: string, text: string): number {
  if (!word || !text) return 0
  const t = text.toLowerCase()
  if (t === word) return 100
  if (t.startsWith(word)) return 90
  let at = t.indexOf(word)
  while (at > 0) {
    if (WORD_BREAK.test(t[at - 1])) return 75
    at = t.indexOf(word, at + 1)
  }
  if (t.includes(word)) return 55
  // Letters in order ("cch" finds "caching"), only for words of three letters or more and when the letters sit close.
  if (word.length >= 3) {
    let from = 0
    let first = -1
    let last = -1
    for (const ch of word) {
      const i = t.indexOf(ch, from)
      if (i < 0) return 0
      if (first < 0) first = i
      last = i
      from = i + 1
    }
    if (last - first + 1 <= word.length * 2) return 20
  }
  return 0
}

/** Score of one item for a query (0 = no match). Every word of the query must match the label, the hint or a keyword. */
export function scoreItem(query: string, item: Pick<PaletteItem, 'label' | 'hint' | 'keywords'>): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 1
  let total = 0
  for (const w of words) {
    const best = Math.max(wordScore(w, item.label), wordScore(w, item.hint ?? '') * 0.5, ...(item.keywords ?? []).map((k) => wordScore(w, k) * 0.6))
    if (best <= 0) return 0
    total += best
  }
  return total
}

/** The items that match, best first (ties keep the default order). An empty query keeps the whole list in default order. */
export function rankItems(items: readonly PaletteItem[], query: string, limit = 40): PaletteItem[] {
  if (!query.trim()) return [...items]
  return items
    .map((item, index) => ({ item, index, score: scoreItem(query, item) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((r) => r.item)
}

export interface PaletteSection {
  group: PaletteGroup | null
  items: PaletteItem[]
}

/** Rows per group while nothing is typed (typing reaches the rest). */
export const PER_GROUP_IDLE = 8

/** The list as it is drawn: grouped by heading (each capped) when nothing is typed, one flat ranked list when something is. */
export function sectionsFor(items: readonly PaletteItem[], query: string, limit = 40): PaletteSection[] {
  const ranked = rankItems(items, query, limit)
  if (query.trim()) return ranked.length > 0 ? [{ group: null, items: ranked }] : []
  const sections: PaletteSection[] = []
  for (const g of PALETTE_GROUPS) {
    const inGroup = ranked.filter((i) => i.group === g).slice(0, PER_GROUP_IDLE)
    if (inGroup.length > 0) sections.push({ group: g, items: inGroup })
  }
  return sections
}

/** Draw order flattened: what Arrow keys walk. */
export function flatten(sections: readonly PaletteSection[]): PaletteItem[] {
  return sections.flatMap((s) => s.items)
}

export interface PaletteFields {
  query: string
  active: number
}

/**
 * What the palette shows the moment it opens: an empty search and the first row. Closing keeps the fields (the exit
 * fades the same content). The component applies this while rendering the change of `open`, so the first committed frame
 * of an opened palette is already clean: resetting in an effect left a frame (a task) where the dialog was visible with
 * the last search in it, and a fast typist's first keys were appended to that old text ("usage2e palette"), found no
 * result, and Enter did nothing.
 */
export function fieldsOnToggle(prev: PaletteFields, wasOpen: boolean, open: boolean): PaletteFields {
  return open && !wasOpen ? { query: '', active: 0 } : prev
}

/** The highlighted row for the list as it is now: a stale index (the list shrank) never points at nothing. */
export function clampActive(active: number, length: number): number {
  if (length <= 0) return -1
  return active < 0 ? 0 : Math.min(active, length - 1)
}

/** Move the active index by one with wrap-around; -1 when the list is empty. */
export function stepIndex(current: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return -1
  if (current < 0) return delta > 0 ? 0 : length - 1
  return (current + delta + length) % length
}

/** "3 results" / "1 result" / "No results", for the polite status line. */
export function resultsPhrase(n: number): string {
  return n === 0 ? 'No results' : n === 1 ? '1 result' : `${n} results`
}
