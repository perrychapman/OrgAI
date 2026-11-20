import type { Role } from '@shared/types'
import { cleanRequiredReports } from '@shared/defaults'

/** "New role", then "New role 2", "New role 3"... only when the plain name is taken. */
export function nextRoleName(roles: Role[], base = 'New role'): string {
  const taken = new Set(roles.map((r) => r.name.trim().toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
}

/** requiredReports without `id`, as a spread-able patch (nothing when the role has none). */
function withoutRequired(r: Role, id: string): Partial<Role> {
  if (!r.requiredReports) return {}
  const rest = r.requiredReports.filter((x) => x !== id)
  return { requiredReports: rest.length > 0 ? rest : undefined }
}

/**
 * Spawn rights follow delegation (Team tab phase 1, D1): a role whose `spawnable` list a move or a removal empties loses
 * `canSpawn`. A role that had no delegates before the change keeps whatever the user ticked by hand.
 */
function dropEmptied(before: readonly Role[], after: Role[]): Role[] {
  const had = new Set(before.filter((r) => r.spawnable.length > 0).map((r) => r.id))
  return after.map((r) => (r.canSpawn && r.spawnable.length === 0 && had.has(r.id) ? { ...r, canSpawn: false } : r))
}

/** A manager's delegation fields as they were before a removal, so Undo puts them back exactly. */
export interface DelegationSnapshot {
  canSpawn: boolean
  spawnable: string[]
  requiredReports?: string[]
}

/** Everything needed to put a removed role back without touching later edits to other roles. */
export interface RemovedRole {
  role: Role
  index: number
  /** Roles that reported to it and were handed to its own manager. */
  childIds: string[]
  /** Roles whose spawnable list contained it. */
  spawnableOf: string[]
  /** Delegation fields of every role in `spawnableOf`, before the removal. */
  delegation?: Record<string, DelegationSnapshot>
}

export function removeRole(roles: Role[], id: string): { roles: Role[]; removed: RemovedRole | null } {
  const index = roles.findIndex((r) => r.id === id)
  if (index < 0) return { roles, removed: null }
  const role = roles[index]
  const holders = roles.filter((r) => r.spawnable.includes(id))
  const removed: RemovedRole = {
    role,
    index,
    childIds: roles.filter((r) => r.reportsTo === id).map((r) => r.id),
    spawnableOf: holders.map((r) => r.id),
    delegation: Object.fromEntries(
      holders.map((r) => [r.id, { canSpawn: r.canSpawn, spawnable: [...r.spawnable], ...(r.requiredReports ? { requiredReports: [...r.requiredReports] } : {}) }])
    )
  }
  const next = roles
    .filter((r) => r.id !== id)
    .map((r) => ({
      ...r,
      reportsTo: r.reportsTo === id ? role.reportsTo : r.reportsTo,
      spawnable: r.spawnable.filter((x) => x !== id),
      ...withoutRequired(r, id)
    }))
  return { roles: dropEmptied(roles, next), removed }
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

export function restoreRole(roles: Role[], removed: RemovedRole): Role[] {
  if (roles.some((r) => r.id === removed.role.id)) return roles
  const rid = removed.role.id
  const next = roles.map((r) => {
    const reportsTo = removed.childIds.includes(r.id) ? rid : r.reportsTo
    if (!removed.spawnableOf.includes(r.id)) return { ...r, reportsTo }
    const snap = removed.delegation?.[r.id]
    // Untouched since the removal: everything goes back exactly as it was (order, canSpawn, Required).
    if (snap && sameList(r.spawnable, snap.spawnable.filter((x) => x !== rid))) {
      const back: Role = { ...r, reportsTo, canSpawn: snap.canSpawn, spawnable: [...snap.spawnable] }
      if (snap.requiredReports) back.requiredReports = [...snap.requiredReports]
      else delete back.requiredReports
      return back
    }
    // Edited since: add the role back to the list without undoing those later edits.
    return {
      ...r,
      reportsTo,
      canSpawn: snap ? snap.canSpawn || r.canSpawn : r.canSpawn,
      spawnable: r.spawnable.includes(rid) ? r.spawnable : [...r.spawnable, rid]
    }
  })
  next.splice(Math.min(removed.index, next.length), 0, removed.role)
  return next
}

/** Make `parentId` the manager of `childId`: delegation is granted to the new parent and withdrawn from others. */
export function setReportsTo(roles: Role[], childId: string, parentId: string | null): Role[] {
  const next = roles.map((r) => {
    if (r.id === childId) return { ...r, reportsTo: parentId }
    if (r.id === parentId) return { ...r, canSpawn: true, spawnable: [...new Set([...r.spawnable, childId])] }
    return { ...r, spawnable: r.spawnable.filter((id) => id !== childId), ...withoutRequired(r, childId) }
  })
  return dropEmptied(roles, next)
}

/** Append `role` (its `reportsTo` names the manager); the manager may delegate to it and so may create subagents. */
export function addRoleUnder(roles: Role[], role: Role): Role[] {
  const mid = role.reportsTo
  return [...roles.map((r) => (r.id === mid ? { ...r, canSpawn: true, spawnable: [...new Set([...r.spawnable, role.id])] } : r)), role]
}

/** Which roles gained or lost `canSpawn` between two versions of the team (roles present in both only). */
export function spawnRightsChange(before: readonly Role[], after: readonly Role[]): { gained: Role[]; lost: Role[] } {
  const was = new Map(before.map((r) => [r.id, r.canSpawn]))
  const gained: Role[] = []
  const lost: Role[] = []
  for (const r of after) {
    const prev = was.get(r.id)
    if (prev === undefined || prev === r.canSpawn) continue
    if (r.canSpawn) gained.push(r)
    else lost.push(r)
  }
  return { gained, lost }
}

const names = (roles: readonly Role[]): string =>
  roles.length <= 1 ? (roles[0]?.name ?? '') : `${roles.slice(0, -1).map((r) => r.name).join(', ')} and ${roles[roles.length - 1].name}`

/**
 * The inspector banner after a change of reporting lines, or null when no role gained or lost spawn rights.
 * `cause` is the name of the role that was added, moved or removed.
 */
export function spawnNotice(before: readonly Role[], after: readonly Role[], cause: string): string | null {
  const { gained, lost } = spawnRightsChange(before, after)
  const parts: string[] = []
  if (gained.length > 0) parts.push(`${names(gained)} can now create subagents, because ${cause} reports to ${gained.length === 1 ? 'it' : 'them'}.`)
  if (lost.length > 0) parts.push(`${names(lost)} can no longer create subagents: nobody ${lost.length === 1 ? 'it' : 'they'} may delegate to is left.`)
  return parts.length > 0 ? parts.join(' ') : null
}

/** Would making `parentId` the manager of `childId` loop (parent is the child or one of its descendants)? */
export function wouldCycle(roles: Role[], childId: string, parentId: string | null): boolean {
  const seen = new Set<string>()
  let cur = parentId
  while (cur && !seen.has(cur)) {
    if (cur === childId) return true
    seen.add(cur)
    cur = roles.find((r) => r.id === cur)?.reportsTo ?? null
  }
  return false
}

/** Toggle a spawnable report. Removing it also drops it from requiredReports; the result is sanitized. */
export function withSpawnableToggled(role: Role, rid: string): Partial<Role> {
  const spawnable = role.spawnable.includes(rid) ? role.spawnable.filter((x) => x !== rid) : [...role.spawnable, rid]
  const canSpawn = spawnable.length > 0 ? true : role.canSpawn
  return { spawnable, canSpawn, requiredReports: cleanRequiredReports({ ...role, spawnable, canSpawn }) }
}

/** Mark or unmark a spawnable report as required. Ids outside spawnable are ignored (cleanRequiredReports). */
export function withRequiredReport(role: Role, rid: string, required: boolean): Partial<Role> {
  const current = role.requiredReports ?? []
  const requiredReports = required ? [...new Set([...current, rid])] : current.filter((x) => x !== rid)
  return { requiredReports: cleanRequiredReports({ ...role, requiredReports }) }
}
