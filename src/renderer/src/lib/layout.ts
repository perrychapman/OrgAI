import dagre from '@dagrejs/dagre'

export interface LayoutItem {
  id: string
  parentId: string | null
  width: number
  height: number
}

/** Top-down tree layout. Returns top-left positions keyed by id. */
export function treeLayout(items: LayoutItem[], opts?: { nodesep?: number; ranksep?: number }): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: opts?.nodesep ?? 48, ranksep: opts?.ranksep ?? 96, marginx: 20, marginy: 20 })
  g.setDefaultEdgeLabel(() => ({}))
  const ids = new Set(items.map((i) => i.id))
  for (const item of items) g.setNode(item.id, { width: item.width, height: item.height })
  for (const item of items) if (item.parentId && ids.has(item.parentId)) g.setEdge(item.parentId, item.id)
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

export function formatElapsed(startedAt: number, endedAt?: number): string {
  const ms = (endedAt ?? Date.now()) - startedAt
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
