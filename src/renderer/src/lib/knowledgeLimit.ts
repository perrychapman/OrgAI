import type { KnowledgeGraph, KnowledgeNode } from '@shared/types'

/**
 * The Graph view's "most connected" limit (UI overhaul Knowledge board). A view option only: the graph in the store,
 * the list, search, filters and the detail pane always keep every item. A big graph opens showing its best connected
 * items; "Show all" draws everything, and the choice is kept as a per-project view preference (knowledgePrefs).
 * Pure: no I/O, no React.
 */

/** How many items a limited graph draws. */
export const CONNECTED_LIMIT = 60
/** The limit only applies above this many drawn items, so a graph a little over the limit just draws everything. */
export const CONNECTED_LIMIT_ABOVE = 75

/** What the Graph draws and what it says about it. */
export interface ConnectedView {
  /** True when some drawn items are left out. */
  limited: boolean
  /** True when the graph is big enough for the limit to apply (so "Show the N most connected" can be offered). */
  eligible: boolean
  /** The ids drawn, or null when everything is drawn. */
  ids: ReadonlySet<string> | null
  /** How many items the graph draws, and how many it could. */
  shown: number
  total: number
  /** Items drawn beyond the limit because the user opened them. */
  extra: number
}

/** Live connections per node: the recorded relations that are not retired and whose both ends are live (every end when `showRetired`). */
export function connectionDegrees(graph: Pick<KnowledgeGraph, 'nodes' | 'edges'>, showRetired: boolean): Map<string, number> {
  const byId = new Map<string, KnowledgeNode>()
  for (const n of graph.nodes) if (showRetired || !n.retired) byId.set(n.id, n)
  const degree = new Map<string, number>()
  for (const id of byId.keys()) degree.set(id, 0)
  for (const e of graph.edges) {
    if (e.from === e.to || !byId.has(e.from) || !byId.has(e.to)) continue
    if (e.retired && !showRetired) continue
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1)
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1)
  }
  return degree
}

/**
 * The items a limited graph draws: the `limit` best connected ones, ties broken by creation order, then name, then id
 * (never updatedAt: an agent's write must not reshuffle the choice), plus every id in `keep` that is a drawn item (the
 * selection and the items the user opened). Returns `ids: null` when the limit does not apply: `all` is set, a search
 * or filter is active (the user is looking for something specific), or the graph is not above `above`.
 */
export function mostConnected(
  graph: Pick<KnowledgeGraph, 'nodes' | 'edges'>,
  opts: { showRetired: boolean; all: boolean; filtering: boolean; keep?: Iterable<string | null | undefined>; limit?: number; above?: number }
): ConnectedView {
  const limit = opts.limit ?? CONNECTED_LIMIT
  const above = opts.above ?? CONNECTED_LIMIT_ABOVE
  const degree = connectionDegrees(graph, opts.showRetired)
  const total = degree.size
  const eligible = total > Math.max(above, limit)
  if (!eligible || opts.all || opts.filtering) return { limited: false, eligible, ids: null, shown: total, total, extra: 0 }
  const live = graph.nodes.filter((n) => degree.has(n.id))
  live.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.createdAt - b.createdAt || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const ids = new Set(live.slice(0, limit).map((n) => n.id))
  for (const k of opts.keep ?? []) if (k && degree.has(k)) ids.add(k)
  return { limited: true, eligible, ids, shown: ids.size, total, extra: Math.max(0, ids.size - limit) }
}

/** The graph reduced to the drawn ids: their nodes and the relations between them. Same object when nothing is left out. */
export function restrictGraph<G extends Pick<KnowledgeGraph, 'nodes' | 'edges'>>(graph: G, ids: ReadonlySet<string> | null): G {
  if (!ids) return graph
  return { ...graph, nodes: graph.nodes.filter((n) => ids.has(n.id)), edges: graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) }
}

/** The note beside the graph: "Showing the 60 most connected of 212", "Showing all 212 items". Null when the graph is small. */
export function limitNote(v: ConnectedView, limit: number = CONNECTED_LIMIT): string | null {
  if (v.limited) return `Showing the ${limit} most connected of ${v.total}${v.extra > 0 ? `, and ${v.extra} you opened` : ''}`
  return v.eligible ? `Showing all ${v.total} items` : null
}
