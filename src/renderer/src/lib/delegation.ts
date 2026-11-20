import type { Role } from '@shared/types'

export interface DelegationChoices {
  /** Roles that report directly to `role`, in team order. */
  direct: Role[]
  /** Every other offered role (siblings, descendants, a ticked ancestor), in team order. */
  other: Role[]
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
 * Who the delegation list offers: direct reports first, everything else under "Other roles". The role's own manager and
 * further ancestors are left out unless the data already ticks them (so they can be unticked).
 */
export function delegationChoices(roles: readonly Role[], role: Role): DelegationChoices {
  const ancestors = new Set(ancestorsOf(roles, role).map((r) => r.id))
  const ticked = new Set(role.spawnable)
  const direct: Role[] = []
  const other: Role[] = []
  for (const r of roles) {
    if (r.id === role.id) continue
    if (r.reportsTo === role.id) direct.push(r)
    else if (!ancestors.has(r.id) || ticked.has(r.id)) other.push(r)
  }
  return { direct, other }
}
