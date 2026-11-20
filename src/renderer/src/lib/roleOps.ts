import type { McpMutationResult, McpServerSpec, Project, Role } from '@shared/types'
import { cleanRequiredReports, slugify } from '@shared/defaults'

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
  delegation: Record<string, DelegationSnapshot>
  /**
   * The same fields right after the removal (review M1). On Undo a field goes back to `delegation` only while it still
   * equals this; a field the user changed since keeps the user's value.
   */
  leftBy: Record<string, DelegationSnapshot>
}

const snapshotOf = (r: Role): DelegationSnapshot => ({
  canSpawn: r.canSpawn,
  spawnable: [...r.spawnable],
  ...(r.requiredReports ? { requiredReports: [...r.requiredReports] } : {})
})

export function removeRole(roles: Role[], id: string): { roles: Role[]; removed: RemovedRole | null } {
  const index = roles.findIndex((r) => r.id === id)
  if (index < 0) return { roles, removed: null }
  const role = roles[index]
  const holders = roles.filter((r) => r.spawnable.includes(id))
  const next = dropEmptied(
    roles,
    roles
      .filter((r) => r.id !== id)
      .map((r) => ({
        ...r,
        reportsTo: r.reportsTo === id ? role.reportsTo : r.reportsTo,
        spawnable: r.spawnable.filter((x) => x !== id),
        ...withoutRequired(r, id)
      }))
  )
  const holderIds = new Set(holders.map((r) => r.id))
  const removed: RemovedRole = {
    role,
    index,
    childIds: roles.filter((r) => r.reportsTo === id).map((r) => r.id),
    spawnableOf: holders.map((r) => r.id),
    delegation: Object.fromEntries(holders.map((r) => [r.id, snapshotOf(r)])),
    leftBy: Object.fromEntries(next.filter((r) => holderIds.has(r.id)).map((r) => [r.id, snapshotOf(r)]))
  }
  return { roles: next, removed }
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * Undo of a removal. For each manager that could delegate to the role, field by field (review M1): `spawnable`,
 * `canSpawn` and `requiredReports` go back to their state before the removal only while they still equal what the
 * removal left. A field the user changed since keeps the user's value; `spawnable` then only gets the role appended,
 * and `canSpawn` is never raised above a value the user set (unticking "May create subagents" or a Required box
 * after the removal survives Undo).
 */
export function restoreRole(roles: Role[], removed: RemovedRole): Role[] {
  if (roles.some((r) => r.id === removed.role.id)) return roles
  const rid = removed.role.id
  const next = roles.map((r) => {
    const reportsTo = removed.childIds.includes(r.id) ? rid : r.reportsTo
    if (!removed.spawnableOf.includes(r.id)) return { ...r, reportsTo }
    const snap = removed.delegation[r.id]
    const left = removed.leftBy[r.id]
    if (!snap || !left) return { ...r, reportsTo, spawnable: r.spawnable.includes(rid) ? r.spawnable : [...r.spawnable, rid] }
    const back: Role = {
      ...r,
      reportsTo,
      spawnable: sameList(r.spawnable, left.spawnable) ? [...snap.spawnable] : r.spawnable.includes(rid) ? r.spawnable : [...r.spawnable, rid],
      canSpawn: r.canSpawn === left.canSpawn ? snap.canSpawn : r.canSpawn
    }
    if (sameList(r.requiredReports ?? [], left.requiredReports ?? [])) {
      // Only reports the manager may still delegate to (its list may have been edited since).
      const req = (snap.requiredReports ?? []).filter((x) => back.spawnable.includes(x))
      if (req.length > 0) back.requiredReports = req
      else delete back.requiredReports
    }
    return back
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

/**
 * The banner after `movedId` got a new manager (review L1): the spawn-right changes, plus every other role that could
 * delegate to the moved role (and so may have had it as Required) and no longer can, by name. Null when nothing changed
 * beyond the reporting line itself.
 */
export function moveNotice(before: readonly Role[], after: readonly Role[], movedId: string): string | null {
  const moved = after.find((r) => r.id === movedId) ?? before.find((r) => r.id === movedId)
  if (!moved) return null
  const lostDelegation = before.filter((r) => r.id !== movedId && r.spawnable.includes(movedId) && !after.find((a) => a.id === r.id)?.spawnable.includes(movedId))
  const parts: string[] = []
  if (lostDelegation.length > 0) parts.push(`${names(lostDelegation)} no longer ${lostDelegation.length === 1 ? 'delegates' : 'delegate'} to ${moved.name}.`)
  const spawn = spawnNotice(before, after, moved.name)
  if (spawn) parts.push(spawn)
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

/**
 * The role as it was when an edit of its Name or Slug field began (RoleInspector takes it on focus, or on the first
 * keystroke when no focus event came). Every keystroke of that edit is computed against this, never against the
 * slug of the previous keystroke (review H1).
 */
export type RenameStart = Pick<Role, 'id' | 'slug' | 'mcpServers'>

/**
 * The start snapshot for a Name or Slug edit. `previous` is the snapshot open before (settled by the caller first, or
 * null). Security recheck (Medium): a re-snapshot of the same role and project keeps the slug the edit started from, so
 * an in-between slug of the same edit never becomes the "own" slug that `reservedSlugs` exempts. The grants are re-read.
 */
export function renameSnapshot(
  previous: (RenameStart & { projectId: string }) | null,
  role: Pick<Role, 'id' | 'slug' | 'mcpServers'>,
  projectId: string
): RenameStart & { projectId: string } {
  const same = previous !== null && previous.id === role.id && previous.projectId === projectId
  return { id: role.id, projectId, slug: same ? previous.slug : role.slug, mcpServers: role.mcpServers ? [...role.mcpServers] : undefined }
}

/** The project fields a rename reads: its servers, and its roles so the slug stays unique. */
export type RenameProject = Pick<Project, 'mcpServers'> & { roles?: readonly Pick<Role, 'id' | 'slug'>[] }

/**
 * Does a role other than `roleId` hold `slug`, or is it `reserved`? (The CLI refuses the same thing: teamRoleEdit
 * `--name`.) `reserved` is `reservedSlugs`: slugs a server's explicit `roles` still names.
 */
export function slugTaken(
  roles: readonly Pick<Role, 'id' | 'slug'>[] | undefined,
  roleId: string,
  slug: string,
  reserved?: ReadonlySet<string>
): boolean {
  return !!slug && ((reserved?.has(slug) ?? false) || (roles ?? []).some((r) => r.id !== roleId && r.slug === slug))
}

/**
 * Security recheck (Medium): slugs that some server's explicit `roles` names, except the slug the edited role held when
 * the edit began. Such a slug may belong to no role right now (a role removed with Undo on screen, team files awaiting
 * approval); taking it would grant that server to the renamed role by slug, and a save at that moment could keep it.
 */
export function reservedSlugs(project: Pick<Project, 'mcpServers'>, startSlug: string): Set<string> {
  const out = new Set<string>()
  for (const s of project.mcpServers ?? []) for (const slug of s.roles ?? []) if (slug !== startSlug) out.add(slug)
  return out
}

/** `base`, or `base-2`, `base-3`... the first one no other role holds and no server reserves (as nextRoleName picks a free name). */
export function uniqueSlug(
  roles: readonly Pick<Role, 'id' | 'slug'>[] | undefined,
  roleId: string,
  base: string,
  reserved?: ReadonlySet<string>
): string {
  if (!slugTaken(roles, roleId, base, reserved)) return base
  for (let n = 2; ; n++) if (!slugTaken(roles, roleId, `${base}-${n}`, reserved)) return `${base}-${n}`
}

/**
 * A rename as ONE patch (D8). The slug follows the name, and connection grants are keyed by slug (McpServerSpec.roles),
 * which projects:save cannot remap: so every server the role held by its STARTING slug is also granted by id
 * (Role.mcpServers), which survives the slug change. Servers for every role (roles undefined) need nothing.
 *
 * The slug is unique in the project (recheck M): when `slugify(name)` is another role's slug the name stays as typed
 * and the slug gets the next free numeric suffix (`qa-2`), so a role never takes another role's slug-keyed servers
 * and the subagent type stays unambiguous, not even for one keystroke.
 *
 * Review H1: the grant list is always `start.mcpServers ∪ {servers whose roles include start.slug}`, never the current
 * value plus something. An in-between slug while typing therefore adds nothing.
 */
export function renamePatch(project: RenameProject, start: RenameStart, name: string): Partial<Role> {
  return slugPatch(project, start, uniqueSlug(project.roles, start.id, slugify(name), reservedSlugs(project, start.slug)), name)
}

/**
 * The same for an edit of the slug field alone (name left as it is). The caller refuses a taken slug first
 * (`slugFieldEdit`). Recheck M (main's rename rule): once anything is carried, the patch carries it at every slug,
 * the starting one included. A debounced save of an in-between slug may already have let main move the starting
 * slug's grants to ids, so typing back must not drop those ids; a redundant id grant is harmless.
 */
export function slugPatch(project: RenameProject, start: RenameStart, slug: string, name?: string): Partial<Role> {
  const patch: Partial<Role> = name === undefined ? { slug } : { name, slug }
  const have = start.mcpServers ?? []
  const add = (project.mcpServers ?? [])
    .filter((s) => s.roles !== undefined && s.roles.includes(start.slug) && !have.includes(s.id))
    .map((s) => s.id)
  // Nothing to carry over: the grants stay the starting ones throughout, so the patch leaves them alone.
  if (add.length === 0) return patch
  patch.mcpServers = [...have, ...add]
  return patch
}

export const SLUG_TAKEN_TEXT = 'Another role already uses this ID.'
export const SLUG_EMPTY_TEXT = 'An ID needs at least one letter or number.'

/**
 * The Slug field: a slug another role holds (or a server reserves, `reservedSlugs`) is refused with a field error and not
 * applied; so is a value with no letter or number, which slugify would turn into the placeholder `role`.
 */
export function slugFieldEdit(project: RenameProject, start: RenameStart, value: string): { patch: Partial<Role> } | { error: string } {
  if (!/[a-z0-9]/i.test(value)) return { error: SLUG_EMPTY_TEXT }
  const slug = slugify(value)
  if (slugTaken(project.roles, start.id, slug, reservedSlugs(project, start.slug))) return { error: SLUG_TAKEN_TEXT }
  return { patch: slugPatch(project, start, slug) }
}

/**
 * Review M3: the servers that still name a renamed role's OLD slug in `roles`, and may now drop it. Only when no role in
 * the project holds that slug any more (another role may have taken it), only servers with an explicit list (`undefined`
 * means every role and is left alone), and only servers the renamed role now holds by id, so it keeps its access.
 * Returns each server with the `roles` list to send: exactly the old slug removed (recheck M). Other slugs no current
 * role holds stay, since they may belong to a role removed with Undo on screen or named by team files awaiting approval.
 */
export function staleSlugServers(
  project: Pick<Project, 'roles'>,
  servers: readonly McpServerSpec[],
  roleId: string,
  oldSlug: string
): { spec: McpServerSpec; roles: string[] }[] {
  if (!oldSlug || project.roles.some((r) => r.slug === oldSlug)) return []
  const role = project.roles.find((r) => r.id === roleId)
  if (!role) return []
  const held = role.mcpServers ?? []
  return servers
    .filter((s) => s.roles !== undefined && s.roles.includes(oldSlug) && held.includes(s.id))
    .map((s) => ({ spec: s, roles: (s.roles ?? []).filter((x) => x !== oldSlug) }))
}

export interface SettleRenameDeps {
  /** The renderer's current copy of the project (the store), read when the edit ends. */
  current(): Project | undefined
  /** projects:save of that copy; resolves only once main has stored it. */
  save(project: Project): Promise<Project>
  /** The project's servers as main has them now (mcp:list), read after the save. */
  servers(): Promise<McpServerSpec[]>
  /** mcp:upsert of one server. */
  upsert(spec: McpServerSpec): Promise<McpMutationResult>
  /** Takes a successful upsert's result in (the caller keeps only the server list; see RoleInspector). */
  applied(result: McpMutationResult): void
}

export interface SettleRenameResult {
  /** mcp:upsert calls made. */
  upserts: number
  /** Set when the save or an upsert failed; nothing after the failure was sent. */
  error?: 'save' | 'upsert'
  /** Servers that still name the old slug because of the failure. */
  left: number
}

/**
 * Review M3 part (a), run once when a Name or Slug edit ends. Sequencing: first projects:save of the current project
 * (which carries the role's id grants), awaited; only when that save succeeded, a fresh mcp:list, and the plan is
 * judged against the roles main returned from the save (what is really stored) and that fresh list. Then one
 * mcp:upsert per server that still names the old slug, one at a time. A failed save sends no upsert, so the old slug
 * stays in `roles` and the role keeps access both ways. When main already dropped the old slug itself on save, the
 * fresh list no longer names it and nothing is sent. Nothing here runs per keystroke.
 */
export async function settleRename(roleId: string, oldSlug: string, deps: SettleRenameDeps): Promise<SettleRenameResult> {
  const now = deps.current()
  const role = now?.roles.find((r) => r.id === roleId)
  if (!now || !role || role.slug === oldSlug || staleSlugServers(now, now.mcpServers ?? [], roleId, oldSlug).length === 0) return { upserts: 0, left: 0 }
  let saved: Project
  try {
    saved = await deps.save(now)
  } catch {
    return { upserts: 0, error: 'save', left: staleSlugServers(now, now.mcpServers ?? [], roleId, oldSlug).length }
  }
  let fresh: McpServerSpec[]
  try {
    fresh = await deps.servers()
  } catch {
    return { upserts: 0, error: 'upsert', left: staleSlugServers(saved, saved.mcpServers ?? [], roleId, oldSlug).length }
  }
  const plan = staleSlugServers(saved, fresh, roleId, oldSlug)
  let upserts = 0
  for (const [i, item] of plan.entries()) {
    upserts++
    try {
      deps.applied(await deps.upsert({ ...item.spec, roles: item.roles }))
    } catch {
      return { upserts, error: 'upsert', left: plan.length - i }
    }
  }
  return { upserts, left: 0 }
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
