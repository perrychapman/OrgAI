/**
 * Saving a project that another orgai session changed in the meantime (docs/design/cli-sessions.md).
 *
 * A save hands the store a whole project, built from a copy read a moment (or, for a terminal UI, a while) earlier.
 * With several sessions in one project, writing that copy as is would undo whatever another session saved since.
 * So the store keeps the versions it has handed out and saves a three-way merge instead:
 *
 * - `base`   the version the caller's copy was made from,
 * - `mine`   the caller's project,
 * - `theirs` what the file holds now.
 *
 * The caller's changes are what differs between `base` and `mine`, and only those are put onto `theirs`. Fields are
 * compared whole, except lists of things with an `id` (roles, MCP servers, skills): those are merged per item, so two
 * sessions that each edit a different role, or each add a server to a project that had none, both keep theirs. Two sessions that change the same field, or the same
 * role, at the same moment: the later save wins, as with any two saves.
 *
 * Pure. Electron-free; relative imports only.
 */
import { isDeepStrictEqual } from 'node:util'

type Item = { id: string }

function isIdList(v: unknown): v is Item[] {
  return Array.isArray(v) && v.every((x) => x !== null && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string')
}

/** Whether a field is merged per item: every side is a list of items with ids or missing, and at least one is a list with items. */
function mergesPerItem(...sides: unknown[]): boolean {
  return sides.every((v) => v === undefined || isIdList(v)) && sides.some((v) => Array.isArray(v) && v.length > 0)
}

/** {@link mergeProject} for one list of items with ids. Order: the caller's, then what only the others added. */
export function mergeIdList<T extends Item>(base: readonly T[], mine: readonly T[], theirs: readonly T[]): T[] {
  const baseById = new Map(base.map((x) => [x.id, x]))
  const theirsById = new Map(theirs.map((x) => [x.id, x]))
  const out: T[] = []
  const seen = new Set<string>()
  for (const item of mine) {
    seen.add(item.id)
    const before = baseById.get(item.id)
    // Untouched by the caller: the others' version stands, including their removal of it.
    if (before !== undefined && isDeepStrictEqual(before, item)) {
      const now = theirsById.get(item.id)
      if (now !== undefined) out.push(now)
      continue
    }
    // Added or changed by the caller.
    out.push(item)
  }
  for (const item of theirs) {
    // Not in the caller's list: removed by the caller when it was in the base, else added by the others.
    if (!seen.has(item.id) && !baseById.has(item.id)) out.push(item)
  }
  return out
}

/** The caller's changes (`base` to `mine`) applied to `theirs`. `updatedAt` is the store's to set and is left as `theirs` has it. */
export function mergeProject<P extends { id: string; updatedAt?: string }>(base: P, mine: P, theirs: P): P {
  const out: Record<string, unknown> = { ...theirs }
  const b = base as Record<string, unknown>
  const m = mine as Record<string, unknown>
  const t = theirs as Record<string, unknown>
  for (const key of new Set([...Object.keys(b), ...Object.keys(m)])) {
    if (key === 'updatedAt' || key === 'id') continue
    if (isDeepStrictEqual(m[key], b[key])) continue
    if (mergesPerItem(b[key], m[key], t[key])) {
      // A list that is missing on a side is an empty one there (a project starts without `mcpServers` or `skills`).
      const merged = mergeIdList((b[key] as Item[] | undefined) ?? [], (m[key] as Item[] | undefined) ?? [], (t[key] as Item[] | undefined) ?? [])
      if (merged.length > 0 || Array.isArray(m[key])) out[key] = merged
      else delete out[key]
    } else if (m[key] === undefined) delete out[key]
    else out[key] = m[key]
  }
  return out as P
}
