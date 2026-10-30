import dagre from '@dagrejs/dagre'

export interface LayoutItem {
  id: string
  parentId: string | null
  width: number
  height: number
}

/**
 * Parent map with unknown parents and cycles removed: a role whose reportsTo chain loops back on itself is detached
 * (treated as a root) so dagre never sees a cycle.
 */
export function acyclicParents(items: LayoutItem[]): Map<string, string> {
  const ids = new Set(items.map((i) => i.id))
  const parents = new Map<string, string>()
  for (const item of items) if (item.parentId && item.parentId !== item.id && ids.has(item.parentId)) parents.set(item.id, item.parentId)
  for (const item of items) {
    const seen = new Set<string>([item.id])
    let cur = item.id
    for (;;) {
      const next = parents.get(cur)
      if (!next) break
      if (seen.has(next)) {
        parents.delete(cur)
        break
      }
      seen.add(next)
      cur = next
    }
  }
  return parents
}

/** Top-down tree layout. Returns top-left positions keyed by id. */
export function treeLayout(items: LayoutItem[], opts?: { nodesep?: number; ranksep?: number }): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: opts?.nodesep ?? 48, ranksep: opts?.ranksep ?? 96, marginx: 20, marginy: 20 })
  g.setDefaultEdgeLabel(() => ({}))
  const parents = acyclicParents(items)
  for (const item of items) g.setNode(item.id, { width: item.width, height: item.height })
  for (const item of items) {
    const parent = parents.get(item.id)
    if (parent) g.setEdge(parent, item.id)
  }
  dagre.layout(g)
  const out: Record<string, { x: number; y: number }> = {}
  for (const item of items) {
    const n = g.node(item.id)
    out[item.id] = { x: n.x - item.width / 2, y: n.y - item.height / 2 }
  }
  return out
}

export function initials(name: string): string {
  const words = name.replace(/[-_]/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

export type CostAuthMode = 'subscription' | 'apiKey' | 'unknown'

export const COST_ESTIMATE_HINT = 'API-equivalent estimate; not billed on a subscription'

/**
 * A cost figure labelled for how the user pays. On a subscription (or when unknown) the SDK's cost is
 * only an estimate at API prices, so it reads "≈$0.09"; with an API key it is real spend.
 */
export function costLabel(usd: number, authMode: CostAuthMode): { text: string; title: string } {
  if (authMode === 'apiKey') return { text: formatCost(usd), title: 'API spend' }
  return { text: `≈${formatCost(usd)}`, title: COST_ESTIMATE_HINT }
}

/** "3h 12m", "12m", "<1m" until `at` (epoch ms). */
/** Plan progress: steps done or skipped, out of all steps. */
export function planProgress(plan: { steps: { status: string }[] }): { done: number; total: number } {
  return { done: plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length, total: plan.steps.length }
}

export function formatUntil(at: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((at - now) / 60000))
  if (mins < 1) return '<1m'
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 48) return `${h}h ${mins % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export function formatElapsed(startedAt: number, endedAt?: number): string {
  const ms = (endedAt ?? Date.now()) - startedAt
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
