// Factory Floor "Find a worker": the pure filter and grouping (docs/design/factory-floor.md section 6.4).
export interface FindEntry {
  id: string
  name: string
  handle?: string
  session: 'current' | 'earlier'
}

/** Entries whose name or handle contains the query (trimmed, case-insensitive); order is kept. A blank query keeps all. */
export function filterFind<T extends FindEntry>(entries: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...entries]
  return entries.filter((e) => e.name.toLowerCase().includes(q) || (e.handle?.toLowerCase().includes(q) ?? false))
}

/** Current-session entries first, then earlier ones, each in input order. */
export function groupFind<T extends FindEntry>(entries: readonly T[]): { current: T[]; earlier: T[] } {
  return { current: entries.filter((e) => e.session === 'current'), earlier: entries.filter((e) => e.session === 'earlier') }
}
