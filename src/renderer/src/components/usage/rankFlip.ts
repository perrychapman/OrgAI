/** Most rows a reorder animates (docs plan M10); more rows update at once. */
export const FLIP_MAX_ROWS = 8

export interface FlipMove {
  key: string
  /** Old top minus new top, in px: the translateY the row starts from. */
  delta: number
}

/**
 * Which rows glide when a ranked list reorders. Only when the same keys are present before and after and the order
 * changed (a sort or period change); a different key set (tab change, "Show all", refresh with new rows) updates at
 * once. Rows that moved less than a pixel are skipped and at most `max` rows animate.
 */
export function flipPlan(prevKeys: readonly string[], nextKeys: readonly string[], prevTops: ReadonlyMap<string, number>, nextTops: ReadonlyMap<string, number>, max = FLIP_MAX_ROWS): FlipMove[] {
  if (prevKeys.length === 0 || prevKeys.length !== nextKeys.length) return []
  const prev = new Set(prevKeys)
  if (!nextKeys.every((k) => prev.has(k))) return []
  if (prevKeys.every((k, i) => k === nextKeys[i])) return []
  const out: FlipMove[] = []
  for (const key of nextKeys) {
    const a = prevTops.get(key)
    const b = nextTops.get(key)
    if (a === undefined || b === undefined) continue
    const delta = a - b
    if (Math.abs(delta) < 1) continue
    out.push({ key, delta })
    if (out.length >= max) break
  }
  return out
}

/** The `--i` stagger index of a row, or null when the row (7th and later) enters without a delay or animation. */
export function enterIndex(index: number): number | null {
  return index < 6 ? index : null
}
