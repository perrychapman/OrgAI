import type { CanvasLayout, CanvasNodeStyle, KnowledgeEdge, KnowledgeGraph, KnowledgeNode } from '@shared/types'
import { knowledgeEdgesOf } from '@shared/knowledge'
import { HEX_TILE, stationGeometry } from './canvas'
import { messageSides, msgHandleId, type PlacedBox } from './canvasShapes'
import { EMPTY_FILTER, applyFilter, itemsOf, keyWords, kindColor, kindLabel, kindOrder, orderItems, type KnowledgeFilter } from './knowledge'

/**
 * Pure helpers for the Knowledge tab's Graph view (docs/design/knowledge.md section 5): what is drawn (the selected
 * item's neighbourhood or everything, after the list's filter), retired items folded into one "N retired" group per
 * drawn node, the drawn order (the list's), the tree the layout needs, the spoken names, the legend, the edge-label
 * zoom threshold and the "Show all" warning. No I/O, no React.
 */

/** The Depth control's values; the default is 1. */
export const GRAPH_DEPTHS = [1, 2] as const
export type GraphDepth = (typeof GRAPH_DEPTHS)[number]
export const DEFAULT_GRAPH_DEPTH: GraphDepth = 1

/** Past this many drawn nodes "Show all" asks first (`knowledge-graph-warn`). */
export const SHOW_ALL_WARN_AT = 150

/** Edge labels (the relation words) show at this zoom and above; below it the relation sits in the edge's title. */
export const EDGE_LABEL_MIN_ZOOM = 1

/** Most relation texts a spoken name reads out before "and N more". */
const SPOKEN_RELATIONS_MAX = 6

export const edgeLabelsShown = (zoom: number): boolean => Number.isFinite(zoom) && zoom >= EDGE_LABEL_MIN_ZOOM

export const needsShowAllConfirm = (count: number): boolean => count > SHOW_ALL_WARN_AT

/** "Showing all 420 items may be slow and hard to read. Show them anyway?" */
export const showAllWarning = (count: number): string => `Showing all ${count} items may be slow and hard to read. Show them anyway?`

export const EMPTY_GRAPH_TEXT = 'Select an item in the list to see its relations.'

// ---- which nodes ----

/** The selected id when it names a graph node (a note or nothing gives no centre). */
export function graphCentreId(graph: Pick<KnowledgeGraph, 'nodes'>, selectedId: string | null): string | null {
  return selectedId !== null && graph.nodes.some((n) => n.id === selectedId) ? selectedId : null
}

/** Node ids the list's kind and origin filters keep (retired is decided separately by the caller). */
function keptByKindAndOrigin(graph: Pick<KnowledgeGraph, 'nodes'>, filter: KnowledgeFilter): Set<string> {
  return new Set(applyFilter(itemsOf(graph, []), { ...filter, showRetired: true }).map((i) => i.id))
}

/** Node ids `applyFilter` keeps (kinds, origins and the retired switch), i.e. what "Show all" draws. */
export function filteredNodeIds(graph: Pick<KnowledgeGraph, 'nodes'>, filter: KnowledgeFilter): string[] {
  return applyFilter(itemsOf(graph, []), filter).map((i) => i.id)
}

export interface Neighbourhood {
  /** The centre first, then the neighbours in the order they were reached. */
  ids: string[]
  /** The node each neighbour was reached from (the centre has none). */
  parents: Map<string, string>
  /** Edges with both ends in `ids` that the walk may use. */
  edges: KnowledgeEdge[]
}

/**
 * The centre, its neighbours within `depth` edges and the edges among them. Without `filter.showRetired` the walk
 * uses live edges and live nodes only (retired ones fold, see `foldRetired`); with it retired nodes and edges count
 * like live ones. A neighbour the kind or origin filter drops is not reached (nor anything behind it). The centre is
 * always included. Null when the centre is not a node of the graph.
 */
export function neighbourhood(graph: Pick<KnowledgeGraph, 'nodes' | 'edges'>, centreId: string, depth: number, filter: KnowledgeFilter = EMPTY_FILTER): Neighbourhood | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  if (!byId.has(centreId)) return null
  const kept = keptByKindAndOrigin(graph, filter)
  const usable = (id: string): boolean => {
    const n = byId.get(id)
    return !!n && kept.has(id) && (filter.showRetired || !n.retired)
  }
  const ids = [centreId]
  const seen = new Set(ids)
  const parents = new Map<string, string>()
  let frontier = [centreId]
  for (let d = 0; d < Math.max(0, Math.floor(depth)) && frontier.length > 0; d++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const e of graph.edges) {
        if (e.retired && !filter.showRetired) continue
        const other = e.from === id ? e.to : e.to === id ? e.from : null
        if (other === null || other === id || seen.has(other) || !usable(other)) continue
        seen.add(other)
        parents.set(other, id)
        ids.push(other)
        next.push(other)
      }
    }
    frontier = next
  }
  const edges = graph.edges.filter((e) => seen.has(e.from) && seen.has(e.to) && (filter.showRetired || !e.retired))
  return { ids, parents, edges }
}

export interface RetiredGroup {
  /** The drawn node the group hangs off. */
  parentId: string
  /** The retired items (and the far ends of retired relations) under it, in list order. */
  members: KnowledgeNode[]
  /** The edges between the parent and its members. */
  edges: KnowledgeEdge[]
}

/** Id of the group node drawn for a parent. */
export const retiredGroupId = (parentId: string): string => `retired:${parentId}`
export const isRetiredGroupId = (id: string): boolean => id.startsWith('retired:')

/**
 * Retired folding (rec 5c): for every drawn node, in order, the items hanging off it that are not drawn because they
 * are retired or joined by a retired relation fold into one "N retired" group. An item hanging off two drawn nodes
 * joins the first one's group only, so counts never double; one the kind or origin filter drops never folds (the
 * list would not show it either). With `filter.showRetired` nothing folds (retired items draw as nodes).
 */
export function foldRetired(graph: Pick<KnowledgeGraph, 'nodes' | 'edges'>, drawnIds: readonly string[], filter: KnowledgeFilter = EMPTY_FILTER): RetiredGroup[] {
  if (filter.showRetired) return []
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const drawn = new Set(drawnIds)
  const kept = keptByKindAndOrigin(graph, filter)
  const taken = new Set<string>()
  const groups: RetiredGroup[] = []
  for (const parentId of drawnIds) {
    if (!byId.has(parentId)) continue
    const memberIds = new Set<string>()
    const edges: KnowledgeEdge[] = []
    for (const e of graph.edges) {
      const other = e.from === parentId ? e.to : e.to === parentId ? e.from : null
      if (other === null || other === parentId || drawn.has(other)) continue
      const node = byId.get(other)
      if (!node || !kept.has(other)) continue
      if (!e.retired && !node.retired) continue
      if (taken.has(other) && !memberIds.has(other)) continue
      memberIds.add(other)
      edges.push(e)
    }
    if (memberIds.size === 0) continue
    for (const id of memberIds) taken.add(id)
    const members = orderItems(itemsOf({ nodes: [...memberIds].map((id) => byId.get(id)!) }, [])).map((i) => byId.get(i.id)!)
    groups.push({ parentId, members, edges })
  }
  return groups
}

export interface DrawnGraph {
  /** The nodes on the canvas in list order (`orderItems`), the Tab order. */
  nodes: KnowledgeNode[]
  /** The relations drawn between them. */
  edges: KnowledgeEdge[]
  /** One folded "N retired" group per drawn node that has retired items hanging off it (none while expanded). */
  groups: RetiredGroup[]
  /** The tree the layout follows: every drawn node and group to the node it hangs off (roots have none). */
  parents: Map<string, string>
  /** Ids of nodes drawn only because their group was expanded (they are retired, or joined by a retired relation). */
  expandedMembers: Set<string>
  /** The node at the centre (the selected item), when it is drawn. */
  centreId: string | null
}

export interface DrawnGraphInput {
  graph: Pick<KnowledgeGraph, 'nodes' | 'edges'>
  selectedId: string | null
  depth: number
  showAll: boolean
  filter: KnowledgeFilter
  /** Parent ids whose retired group the user expanded this session. */
  expanded?: ReadonlySet<string>
}

/**
 * What the canvas draws: "Show all" draws every node the list's filter keeps, else the selected node's neighbourhood
 * (nothing without a selected node). Retired items fold per drawn node unless their group was expanded, in which case
 * they draw as retired nodes with their relations. Nodes come back in list order; the layout tree hangs every node
 * off the node it was reached from (the centre first, then the first drawn neighbour in list order for "Show all").
 */
export function drawnGraph(input: DrawnGraphInput): DrawnGraph {
  const { graph, depth, showAll, filter } = input
  const expanded = input.expanded ?? new Set<string>()
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const centreId = graphCentreId(graph, input.selectedId)
  const empty: DrawnGraph = { nodes: [], edges: [], groups: [], parents: new Map(), expandedMembers: new Set(), centreId: null }

  let baseIds: string[]
  const parents = new Map<string, string>()
  if (showAll) {
    baseIds = filteredNodeIds(graph, filter)
    if (centreId && !baseIds.includes(centreId)) baseIds = [centreId, ...baseIds]
  } else {
    if (!centreId) return empty
    const nb = neighbourhood(graph, centreId, depth, filter)
    if (!nb) return empty
    baseIds = nb.ids
    for (const [id, p] of nb.parents) parents.set(id, p)
  }

  const drawnSet = new Set(baseIds)
  const allGroups = foldRetired(graph, baseIds, filter)
  const groups: RetiredGroup[] = []
  const expandedMembers = new Set<string>()
  for (const g of allGroups) {
    if (expanded.has(g.parentId)) {
      for (const m of g.members) {
        if (drawnSet.has(m.id)) continue
        drawnSet.add(m.id)
        expandedMembers.add(m.id)
        parents.set(m.id, g.parentId)
      }
    } else {
      groups.push(g)
      parents.set(retiredGroupId(g.parentId), g.parentId)
    }
  }

  const edges = graph.edges.filter(
    (e) => e.from !== e.to && drawnSet.has(e.from) && drawnSet.has(e.to) && (!e.retired || filter.showRetired || expandedMembers.has(e.from) || expandedMembers.has(e.to))
  )
  const nodes = orderItems(itemsOf({ nodes: [...drawnSet].map((id) => byId.get(id)!).filter(Boolean) }, [])).map((i) => byId.get(i.id)!)

  if (showAll) {
    // A forest over the drawn relations: the centre's component first, then the rest in list order.
    const adj = new Map<string, string[]>()
    for (const e of edges) {
      ;(adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to)
      ;(adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e.from)
    }
    const visited = new Set<string>()
    const starts = [...(centreId ? [centreId] : []), ...nodes.map((n) => n.id)]
    for (const start of starts) {
      if (visited.has(start)) continue
      visited.add(start)
      const queue = [start]
      while (queue.length > 0) {
        const id = queue.shift()!
        for (const next of adj.get(id) ?? []) {
          if (visited.has(next)) continue
          visited.add(next)
          parents.set(next, id)
          queue.push(next)
        }
      }
    }
  }

  return { nodes, edges, groups, parents, expandedMembers, centreId: centreId && drawnSet.has(centreId) ? centreId : null }
}

// ---- names ----

/** Live facts of a node (all of them with `showRetired`). */
export function factCount(node: Pick<KnowledgeNode, 'facts'>, showRetired = false): number {
  return node.facts.filter((f) => showRetired || !f.retired).length
}

/**
 * The relations of a node as read from its side ("works at Acme Corp", "Migrate billing to Stripe decided by"),
 * live ones unless `showRetired`; a far end that is gone reads "(removed)".
 */
export function relationTexts(graph: Pick<KnowledgeGraph, 'nodes' | 'edges'>, nodeId: string, showRetired = false): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const farEnd = (e: KnowledgeEdge): string => (e.from === nodeId ? e.to : e.from)
  return knowledgeEdgesOf(graph, nodeId, !showRetired)
    .filter((e) => showRetired || !byId.get(farEnd(e))?.retired)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((e) => (e.from === nodeId ? `${keyWords(e.relation)} ${byId.get(e.to)?.name ?? '(removed)'}` : `${byId.get(e.from)?.name ?? '(removed)'} ${keyWords(e.relation)}`))
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The node's spoken name (rec 17): "Jane Doe, person. 3 facts, 2 relations: works at Acme Corp, Migrate billing to
 * Stripe decided by. Press Enter to open." A retired node reads "Jane Doe, person, retired. …". The relations are
 * read out (edges are not focusable) up to six, then "and N more".
 */
export function nodeSpokenName(node: Pick<KnowledgeNode, 'name' | 'kind' | 'retired'>, facts: number, relations: readonly string[]): string {
  const head = `${node.name}, ${keyWords(node.kind)}${node.retired ? ', retired' : ''}`
  const shown = relations.slice(0, SPOKEN_RELATIONS_MAX)
  const more = relations.length - shown.length
  const rel = plural(relations.length, 'relation') + (shown.length ? `: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}` : '')
  return `${head}. ${plural(facts, 'fact')}, ${rel}. Press Enter to open.`
}

/** "3 retired items under Jane Doe. Press Enter to show them." */
export function groupSpokenName(count: number, parentName: string): string {
  return `${plural(count, 'retired item')} under ${parentName}. Press Enter to show them.`
}

/** The group node's text: "3 retired". */
export const retiredGroupLabel = (count: number): string => `${count} retired`

/** The short line under a card's name: "3 facts · 2 relations". */
export function nodeCountsLine(facts: number, relations: number): string {
  return `${plural(facts, 'fact')} · ${plural(relations, 'relation')}`
}

/** The polite line after the drawing changes: "Showing 3 items and 2 relations." (plus the folded groups). */
export function drawnAnnouncement(d: Pick<DrawnGraph, 'nodes' | 'edges' | 'groups'>): string {
  const folded = d.groups.reduce((n, g) => n + g.members.length, 0)
  return `Showing ${plural(d.nodes.length, 'item')} and ${plural(d.edges.length, 'relation')}${folded > 0 ? `, ${folded} retired folded` : ''}.`
}

// ---- legend ----

export interface LegendEntries {
  kinds: { kind: string; label: string; color: string }[]
  relations: { relation: string; label: string }[]
  /** A retired node or a retired relation is drawn (the dashed, muted entry applies). */
  retired: boolean
  /** A folded "N retired" group is drawn. */
  groups: boolean
}

/** What the legend lists for the drawing: kinds on the canvas with their colour, relation types on it, then the retired cues that apply. */
export function legendEntries(d: Pick<DrawnGraph, 'nodes' | 'edges' | 'groups'>, kindsInUse: Iterable<string>): LegendEntries {
  const inUse = [...kindsInUse]
  const kinds = kindOrder(new Set(d.nodes.map((n) => n.kind))).map((kind) => ({ kind, label: kindLabel(kind), color: kindColor(kind, inUse) }))
  const relations = [...new Set(d.edges.map((e) => e.relation))].map((relation) => ({ relation, label: keyWords(relation) })).sort((a, b) => a.label.localeCompare(b.label))
  return { kinds, relations, retired: d.nodes.some((n) => n.retired) || d.edges.some((e) => e.retired), groups: d.groups.length > 0 }
}

// ---- sizes and layout ----

/** Node box per style for layout and fit: cards 220 x 96, name tags 160 x 40, stations by layout, hex the tile. */
export function knowledgeNodeSize(style: CanvasNodeStyle, layout: CanvasLayout): { width: number; height: number } {
  if (style === 'station') {
    const g = stationGeometry(layout)
    return { width: g.width, height: g.height }
  }
  if (style === 'hex') return { width: HEX_TILE.width, height: HEX_TILE.height }
  return style === 'compact' ? { width: 160, height: 40 } : { width: 220, height: 96 }
}

/** The "N retired" group box per style (the done-group look at the knowledge card's width). */
export function retiredGroupSize(style: CanvasNodeStyle, layout: CanvasLayout): { width: number; height: number } {
  if (style === 'station' || style === 'hex') return knowledgeNodeSize(style, layout)
  return style === 'compact' ? { width: 160, height: 40 } : { width: 220, height: 56 }
}

/**
 * The handle ids a relation edge leaves and enters by (M3): the sides of the two laid-out boxes that face each other,
 * so an edge against the layout runs through open space instead of looping behind the nodes. Source above target =
 * bottom to top, below = top to bottom, side by side = right to left or left to right. The arrow stays at the target.
 */
export function relationHandles(from: PlacedBox, to: PlacedBox): { sourceHandle: string; targetHandle: string } {
  const sides = messageSides(from, to)
  return { sourceHandle: msgHandleId('out', sides.out), targetHandle: msgHandleId('in', sides.in) }
}

/** Items for `layoutCanvas`: the drawn nodes and groups with their parent and box. */
export function layoutItems(d: Pick<DrawnGraph, 'nodes' | 'groups' | 'parents'>, nodeSize: { width: number; height: number }, groupSize: { width: number; height: number }): { id: string; parentId: string | null; width: number; height: number }[] {
  return [
    ...d.nodes.map((n) => ({ id: n.id, parentId: d.parents.get(n.id) ?? null, ...nodeSize })),
    ...d.groups.map((g) => ({ id: retiredGroupId(g.parentId), parentId: g.parentId, ...groupSize }))
  ]
}

/** A stable key of the drawing's topology (ids and parents) for "re-fit once per layout change". */
export function topologyKey(d: Pick<DrawnGraph, 'nodes' | 'groups' | 'parents' | 'edges'>): string {
  return [
    ...d.nodes.map((n) => `${n.id}>${d.parents.get(n.id) ?? ''}`),
    ...d.groups.map((g) => `${retiredGroupId(g.parentId)}>${g.parentId}:${g.members.length}`),
    ...d.edges.map((e) => `e:${e.id}`)
  ]
    .sort()
    .join('|')
}

// ---- keyboard ----

export type ArrowDirection = 'up' | 'down' | 'left' | 'right'

/** Neighbours of a node over the drawn edges (both directions), each once. */
export function drawnNeighbours(edges: readonly Pick<KnowledgeEdge, 'from' | 'to'>[], id: string): string[] {
  const out: string[] = []
  for (const e of edges) {
    const other = e.from === id ? e.to : e.to === id ? e.from : null
    if (other !== null && other !== id && !out.includes(other)) out.push(other)
  }
  return out
}

/**
 * Ctrl+Arrow (rec 17, optional): among `candidates`, the one most in `direction` from `from` on the canvas (positions
 * are node centres or top-left corners alike): only nodes inside the 90-degree cone that way count (travel along the
 * axis at least the sideways offset); the one with the most travel net of its offset wins, the nearer one on a tie.
 * Null when none lies that way.
 */
export function neighbourInDirection(positions: Record<string, { x: number; y: number }>, from: string, candidates: readonly string[], direction: ArrowDirection): string | null {
  const origin = positions[from]
  if (!origin) return null
  let best: { id: string; along: number; across: number } | null = null
  for (const id of candidates) {
    const p = positions[id]
    if (!p || id === from) continue
    const dx = p.x - origin.x
    const dy = p.y - origin.y
    const along = direction === 'right' ? dx : direction === 'left' ? -dx : direction === 'down' ? dy : -dy
    const across = Math.abs(direction === 'left' || direction === 'right' ? dy : dx)
    if (along <= 0 || along < across) continue
    if (!best || along - across > best.along - best.across || (along - across === best.along - best.across && across < best.across)) best = { id, along, across }
  }
  return best?.id ?? null
}
