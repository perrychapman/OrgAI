import type { Role } from '@shared/types'

/** The other roles of one branch, listed under the branch's head ("Roles on other branches"). */
export interface BranchGroup {
  /** The role that heads the branch (the highest role of it that is not on the role's own manager chain). */
  head: Role
  /** The roles of this branch that are offered, in team order. The head is among them unless it is a direct report. */
  roles: Role[]
}

export interface DelegationView {
  /** Roles that report directly to `role`, in team order. */
  direct: Role[]
  /** Every role that is neither a direct report nor on the role's manager chain, grouped by branch head. */
  branches: BranchGroup[]
  /** How many roles `branches` offers. */
  otherCount: number
  /** How many of them the role already delegates to (the "{n} on other branches" chip; opens the disclosure). */
  otherTicked: number
  /** The manager chain (nearest first) the data already ticks. Never offered as a choice: shown as a removable line. */
  tickedAncestors: Role[]
}

/** The managers above `role`, nearest first. Stops on a loop. */
export function ancestorsOf(roles: readonly Role[], role: Role): Role[] {
  const out: Role[] = []
  const seen = new Set<string>([role.id])
  let cur = role.reportsTo
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const r = roles.find((x) => x.id === cur)
    if (!r) break
    out.push(r)
    cur = r.reportsTo
  }
  return out
}

/**
 * The head of the branch `r` sits on, seen from `role`: walk up from `r` while the manager is neither `role` nor one of
 * its own managers. A role directly under the manager chain heads its own branch; a descendant of a direct report is
 * headed by that report.
 */
function branchHead(byId: ReadonlyMap<string, Role>, stop: ReadonlySet<string>, r: Role): Role {
  let cur = r
  const seen = new Set<string>([r.id])
  while (cur.reportsTo && !stop.has(cur.reportsTo) && !seen.has(cur.reportsTo)) {
    const up = byId.get(cur.reportsTo)
    if (!up) break
    seen.add(up.id)
    cur = up
  }
  return cur
}

/**
 * What the Delegation section offers: direct reports first; every other role that is not on the role's own manager
 * chain, grouped by branch head under "Roles on other branches"; and the managers the data already ticks, kept apart so
 * they can be removed without being offered as a choice (a role delegating up its own chain skips nothing and loops).
 */
export function delegationView(roles: readonly Role[], role: Role): DelegationView {
  const chain = ancestorsOf(roles, role)
  const chainIds = new Set(chain.map((r) => r.id))
  const ticked = new Set(role.spawnable)
  const byId = new Map(roles.map((r) => [r.id, r]))
  const stop = new Set<string>([role.id, ...chainIds])
  const direct: Role[] = []
  const groups = new Map<string, BranchGroup>()
  let otherCount = 0
  let otherTicked = 0
  for (const r of roles) {
    if (r.id === role.id || chainIds.has(r.id)) continue
    if (r.reportsTo === role.id) {
      direct.push(r)
      continue
    }
    const head = branchHead(byId, stop, r)
    const g = groups.get(head.id) ?? { head, roles: [] }
    g.roles.push(r)
    groups.set(head.id, g)
    otherCount++
    if (ticked.has(r.id)) otherTicked++
  }
  return {
    direct,
    branches: [...groups.values()],
    otherCount,
    otherTicked,
    tickedAncestors: chain.filter((r) => ticked.has(r.id))
  }
}
