import type { Role } from '@shared/types'
import { obligationsFor } from './delegation'

/**
 * UI overhaul "Who will work on it" (StartRunInput.excludeRoleIds): leave roles out of one run. Pure. A role left out takes
 * every role below it (reportsTo chain) with it; the roles that stay lose the excluded ids from their spawnable and
 * requiredReports lists, so the adapters' spawn gates refuse them. An obligation that pointed at a role left out is not
 * dropped quietly: excludedObligationProblems names it, and RunManager adds it to the delegation preflight problems.
 */

/** The largest list of role ids one run may leave out. */
export const EXCLUDE_ROLE_IDS_MAX = 200

export interface ExclusionResult {
  /** The roles that stay, with spawnable / requiredReports cleaned. */
  roles: Role[]
  /** The ids the user named, de-duplicated, in order (what RunSummary.excludedRoleIds records). */
  ids: string[]
  /** Every id removed from the run: the named roles and everything below them. */
  removed: Set<string>
}

/** The root of an org chart: the role that reports to nobody (else the first). */
export function rootRole(roles: readonly Role[]): Role | undefined {
  return roles.find((r) => r.reportsTo === null) ?? roles[0]
}

/**
 * Leave `ids` out of `roles`. `lenient` (a continuation carrying an earlier choice): ids that no longer name a role, or
 * that now name the root, are dropped instead of refused. A user's choice is never lenient: unknown ids and the root are
 * refused in plain words and nothing is changed.
 */
export function excludeRoles(roles: readonly Role[], rawIds: unknown, opts: { lenient?: boolean } = {}): ExclusionResult {
  if (!Array.isArray(rawIds) || rawIds.length > EXCLUDE_ROLE_IDS_MAX) throw new Error('Choose which roles to leave out from the list of roles.')
  const known = new Map(roles.map((r) => [r.id, r]))
  const root = rootRole(roles)
  const ids: string[] = []
  for (const id of rawIds) {
    if (typeof id !== 'string' || !id) throw new Error('Choose which roles to leave out from the list of roles.')
    if (ids.includes(id)) continue
    if (!known.has(id)) {
      if (opts.lenient) continue
      throw new Error('One of the roles you left out is not on this team any more. Choose the roles again.')
    }
    if (root && id === root.id) {
      if (opts.lenient) continue
      throw new Error(`${root.name} leads the team and cannot be left out of the run.`)
    }
    ids.push(id)
  }
  const removed = new Set(ids)
  // Everything below a role left out goes with it. A fixpoint pass handles any order and cuts a cycle at once.
  for (let changed = true; changed; ) {
    changed = false
    for (const r of roles) {
      if (!removed.has(r.id) && r.reportsTo !== null && removed.has(r.reportsTo)) {
        removed.add(r.id)
        changed = true
      }
    }
  }
  const kept: Role[] = []
  for (const r of roles) {
    if (removed.has(r.id)) continue
    const out: Role = { ...r }
    if (r.spawnable?.some((id) => removed.has(id))) out.spawnable = r.spawnable.filter((id) => !removed.has(id))
    if (r.requiredReports?.some((id) => removed.has(id))) {
      const left = r.requiredReports.filter((id) => !removed.has(id))
      if (left.length) out.requiredReports = left
      else delete out.requiredReports
    }
    kept.push(out)
  }
  return { roles: kept, ids, removed }
}

/**
 * Delegation preflight problems for the obligations of the full team that point at roles left out ("Required delegation:"
 * lines on the run, like the existing preflight). Strict delegation counts every spawnable role as required.
 */
export function excludedObligationProblems(original: readonly Role[], removed: ReadonlySet<string>, strict: boolean): string[] {
  if (!removed.size) return []
  const byId = new Map(original.map((r) => [r.id, r]))
  const name = (id: string): string => byId.get(id)?.name ?? id
  const problems: string[] = []
  const obligations = obligationsFor(original, strict)
  for (const [holder, required] of Object.entries(obligations)) {
    if (removed.has(holder)) continue
    const gone = required.filter((id) => removed.has(id))
    if (!gone.length) continue
    problems.push(`${name(holder)} must delegate to ${gone.map(name).join(', ')}, which ${gone.length === 1 ? 'is' : 'are'} left out of this run, so that report will not be made.`)
  }
  return problems
}
