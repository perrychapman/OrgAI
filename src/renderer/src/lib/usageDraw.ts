/**
 * When a Usage chart draws itself (dashboard-usage-redesign motion.md "Draw"): once on arrival, and once for each filter or
 * metric change the person made, after the new data has rendered. A background refresh never draws.
 *
 * The view bumps `drawSeq` when the person changes something. The data it asks for may arrive in the same commit (a
 * metric change, a client-side filter) or later (a refetch), so a bump stays pending until the panel's data fingerprint
 * changes, for at most `DRAW_PENDING_MS`; a change nobody asked for (no pending bump) is never a draw.
 */

/** How long a bump waits for its data before it is dropped (the data never came). */
export const DRAW_PENDING_MS = 5000

export interface DrawTracker {
  seq: number
  /** The data the panel drew at the last commit: identities and primitives, compared one by one. */
  fp: readonly unknown[]
  /** When an unanswered bump happened, or null. */
  pendingAt: number | null
}

export const initDrawTracker = (seq: number | undefined, fp: readonly unknown[]): DrawTracker => ({ seq: seq ?? 0, fp, pendingAt: null })

export const sameFingerprint = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

/** One commit: the next tracker and whether the panel draws now. */
export function stepDraw(t: DrawTracker, i: { seq: number | undefined; fp: readonly unknown[]; now: number }, windowMs = DRAW_PENDING_MS): { next: DrawTracker; draw: boolean } {
  const seq = i.seq ?? 0
  const dataChanged = !sameFingerprint(t.fp, i.fp)
  let pendingAt = t.pendingAt
  if (seq !== t.seq) pendingAt = i.now
  else if (pendingAt !== null && i.now - pendingAt > windowMs) pendingAt = null
  let draw = false
  if (pendingAt !== null && dataChanged) {
    draw = true
    pendingAt = null
  }
  if (!draw && seq === t.seq && pendingAt === t.pendingAt && !dataChanged) return { next: t, draw }
  return { next: { seq, fp: dataChanged ? i.fp : t.fp, pendingAt }, draw }
}
