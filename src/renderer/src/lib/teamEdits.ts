import type { Role } from '@shared/types'
import { removeRole, wouldCycle } from './roleOps'

/**
 * Undo for the edits the Team notice row offers besides a removal (which is `restoreRole`): an added role and a changed
 * reporting line. Like restoreRole they work field by field: a delegation field that still equals what the edit left
 * behind goes back to its value before the edit; a field the user changed since keeps the user's value.
 */

interface DelegationFields {
  canSpawn: boolean
  spawnable: string[]
  requiredReports: string[]
}

/** A role's delegation fields before an edit and right after it. */
interface FieldPair {
  before: DelegationFields
  left: DelegationFields
}

const fieldsOf = (r: Role): DelegationFields => ({ canSpawn: r.canSpawn, spawnable: [...r.spawnable], requiredReports: [...(r.requiredReports ?? [])] })
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])
const sameFields = (a: DelegationFields, b: DelegationFields): boolean => a.canSpawn === b.canSpawn && sameList(a.spawnable, b.spawnable) && sameList(a.requiredReports, b.requiredReports)

/**
 * `base` with each field put back to `pair.before` when `current` (the role as it is now) still equals `pair.left` in
 * that field; otherwise the field stays what `base` has. `base` is `current` itself, or `current` after another
 * operation (a removal) that already touched it.
 */
function revertFields(base: Role, current: Role, pair: FieldPair): Role {
  const next: Role = { ...base }
  if (sameList(current.spawnable, pair.left.spawnable)) next.spawnable = [...pair.before.spawnable]
  if (current.canSpawn === pair.left.canSpawn) next.canSpawn = pair.before.canSpawn
  else next.canSpawn = current.canSpawn
  if (sameList(current.requiredReports ?? [], pair.left.requiredReports)) {
    // Only reports the role may still delegate to (its list may have been edited since).
    const kept = pair.before.requiredReports.filter((x) => next.spawnable.includes(x))
    if (kept.length > 0) next.requiredReports = kept
    else delete next.requiredReports
  }
  return next
}

/** What an Add role did to its manager, taken from the team before and after it. */
export interface AddedRole {
  roleId: string
  managerId: string | null
  /** The manager's delegation fields before and right after the add; absent for the first role of an empty team. */
  manager?: FieldPair
}

export function snapshotAdd(before: readonly Role[], after: readonly Role[], roleId: string): AddedRole {
  const managerId = after.find((r) => r.id === roleId)?.reportsTo ?? null
  const was = managerId ? before.find((r) => r.id === managerId) : undefined
  const now = managerId ? after.find((r) => r.id === managerId) : undefined
  return { roleId, managerId, ...(was && now ? { manager: { before: fieldsOf(was), left: fieldsOf(now) } } : {}) }
}

/**
 * Takes the added role out again. Roles that were later put under it move up to its manager (removeRole). The manager's
 * delegation goes back to what it was before the add, field by field.
 */
export function undoAdd(roles: Role[], added: AddedRole): Role[] {
  if (!roles.some((r) => r.id === added.roleId)) return roles
  const manager = added.managerId ? roles.find((r) => r.id === added.managerId) : undefined
  const { roles: removed } = removeRole(roles, added.roleId)
  if (!manager || !added.manager) return removed
  const pair = added.manager
  return removed.map((r) => (r.id === manager.id ? revertFields(r, manager, pair) : r))
}

/** A changed reporting line and the delegation it changed on other roles. */
export interface Reparented {
  roleId: string
  /** Its manager before and after (null: the root). */
  from: string | null
  to: string | null
  /** Every role whose delegation fields the change touched, before and right after. */
  delegation: Record<string, FieldPair>
}

export function snapshotReparent(before: readonly Role[], after: readonly Role[], roleId: string): Reparented {
  const delegation: Record<string, FieldPair> = {}
  for (const was of before) {
    const now = after.find((r) => r.id === was.id)
    if (!now) continue
    const pair = { before: fieldsOf(was), left: fieldsOf(now) }
    if (!sameFields(pair.before, pair.left)) delegation[was.id] = pair
  }
  return {
    roleId,
    from: before.find((r) => r.id === roleId)?.reportsTo ?? null,
    to: after.find((r) => r.id === roleId)?.reportsTo ?? null,
    delegation
  }
}

/**
 * Puts the previous reporting line back and, field by field, the delegation it changed. A change that is no longer the
 * role's current line (it was moved again since) is left alone and the roles come back unchanged.
 */
export function undoReparent(roles: Role[], edit: Reparented): Role[] {
  const child = roles.find((r) => r.id === edit.roleId)
  if (!child || child.reportsTo !== edit.to || wouldCycle(roles, edit.roleId, edit.from)) return roles
  return roles.map((r) => {
    const base: Role = r.id === edit.roleId ? { ...r, reportsTo: edit.from } : r
    const pair = edit.delegation[r.id]
    return pair ? revertFields(base, r, pair) : base
  })
}
