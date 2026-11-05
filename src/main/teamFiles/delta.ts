import type { TeamDoc, TeamMcpDoc, TeamRoleDoc, TeamSettingsDoc } from './doc'
import { canonicalJson, normalizeDoc, teamDigest } from './digest'

/**
 * A three-way merge of what one save changed (before to after) onto another document (base, usually the files' or the
 * approved team). Per item and per field: a field equal in before and after keeps base's value, a field that differs
 * takes after's. An item added in after is added, one removed in after is removed, an item present only in base stays.
 * So a pending change already in base survives an edit of another field, and a pulled change survives a save made from
 * an older copy. Pure; never mutates its inputs.
 */

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)

/** Field-wise merge of one record. `base` undefined: the item is not in base and stays absent (callers decide). */
function mergeFields<T extends object>(base: T, before: T, after: T): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const k of keys) {
    const b = (before as Record<string, unknown>)[k]
    const a = (after as Record<string, unknown>)[k]
    if (same(b, a)) continue
    if (a === undefined) delete out[k]
    else out[k] = structuredClone(a)
  }
  return out as T
}

function mergeKeyed<T extends object>(base: T[], before: T[], after: T[], key: (t: T) => string, merge: (b: T, bf: T, af: T) => T): T[] {
  const baseBy = new Map(base.map((t) => [key(t), t]))
  const beforeBy = new Map(before.map((t) => [key(t), t]))
  const afterBy = new Map(after.map((t) => [key(t), t]))
  const result = new Map(baseBy)
  for (const [k, a] of afterBy) {
    const bf = beforeBy.get(k)
    const b = baseBy.get(k)
    if (!bf) result.set(k, structuredClone(a)) // added in after
    else if (b) result.set(k, merge(b, bf, a))
    // present before and after but not in base: stays absent
  }
  for (const k of beforeBy.keys()) if (!afterBy.has(k)) result.delete(k) // removed in after
  return [...result.values()]
}

export function applyTeamDelta(base: TeamDoc, before: TeamDoc, after: TeamDoc): TeamDoc {
  const settings = mergeFields<TeamSettingsDoc>(base.settings, before.settings, after.settings)
  const roles = mergeKeyed<TeamRoleDoc>(base.roles, before.roles, after.roles, (r) => r.slug, mergeFields)
  const skills = mergeKeyed(base.skills, before.skills, after.skills, (s) => s.name, (b, bf, af) => (same(bf, af) ? b : structuredClone(af)))
  const mcp = mergeKeyed<TeamMcpDoc>(base.mcp, before.mcp, after.mcp, (m) => m.name, mergeFields)
  return normalizeDoc({ settings, roles, skills, mcp })
}

/** Two documents with the same parsed content. */
export function sameTeam(a: TeamDoc, b: TeamDoc): boolean {
  return teamDigest(a) === teamDigest(b)
}
