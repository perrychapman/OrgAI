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

/** Everything needed to put a removed role back without touching later edits to other roles. */
export interface RemovedRole {
  role: Role
  index: number
  /** Roles that reported to it and were handed to its own manager. */
  childIds: string[]
  /** Roles whose spawnable list contained it. */
  spawnableOf: string[]
}

export function removeRole(roles: Role[], id: string): { roles: Role[]; removed: RemovedRole | null } {
  const index = roles.findIndex((r) => r.id === id)
  if (index < 0) return { roles, removed: null }
  const role = roles[index]
  const removed: RemovedRole = {
    role,
    index,
    childIds: roles.filter((r) => r.reportsTo === id).map((r) => r.id),
    spawnableOf: roles.filter((r) => r.spawnable.includes(id)).map((r) => r.id)
  }
  const next = roles
    .filter((r) => r.id !== id)
    .map((r) => ({
      ...r,
      reportsTo: r.reportsTo === id ? role.reportsTo : r.reportsTo,
      spawnable: r.spawnable.filter((x) => x !== id),
      ...withoutRequired(r, id)
    }))
  return { roles: next, removed }
}

export function restoreRole(roles: Role[], removed: RemovedRole): Role[] {
  if (roles.some((r) => r.id === removed.role.id)) return roles
  const next = roles.map((r) => ({
    ...r,
    reportsTo: removed.childIds.includes(r.id) ? removed.role.id : r.reportsTo,
    spawnable: removed.spawnableOf.includes(r.id) && !r.spawnable.includes(removed.role.id) ? [...r.spawnable, removed.role.id] : r.spawnable
  }))
  next.splice(Math.min(removed.index, next.length), 0, removed.role)
  return next
}

/** Make `parentId` the manager of `childId`: delegation is granted to the new parent and withdrawn from others. */
export function setReportsTo(roles: Role[], childId: string, parentId: string | null): Role[] {
  return roles.map((r) => {
    if (r.id === childId) return { ...r, reportsTo: parentId }
    if (r.id === parentId) return { ...r, canSpawn: true, spawnable: [...new Set([...r.spawnable, childId])] }
    return { ...r, spawnable: r.spawnable.filter((id) => id !== childId), ...withoutRequired(r, childId) }
  })
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
