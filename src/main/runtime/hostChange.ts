import type { Project, Role } from '@shared/types'

/**
 * Changes the user makes in the desktop app while a work run of the project is live (projects:save, mcp:*, skills:*),
 * or approves on another session's card for the same project, reaching that live run (RunManager.applyProjectChange,
 * ARCHITECTURE.md "Host changes in a live run").
 *
 * THE INVARIANT: only what the user's action itself named may move onto a live run. A save also ingests team files
 * that agents in the run can edit (.orgai/team.json, agents, mcp.json, skills), and a file change never reaches a live
 * run. So the caller names the items (servers / skills by id and name), and for projects:save RunManager diffs the
 * request against the project as stored BEFORE the save (and before any ingest): a field only the ingest changed is in
 * neither side of that diff. A named change also has to be in the saved project (the save may have refused or kept it).
 * Pure module.
 */
export type HostProjectChange =
  /** mcp:upsert / mcp:remove / mcp:linkLibrary / mcp:setProjectOverrides: these servers (definition and grants to them). */
  | { kind: 'mcp'; ids: string[]; names: string[]; label: string }
  /** skills:create / update / remove / linkLibrary: these skills (content and grants to them). */
  | { kind: 'skills'; ids: string[]; names: string[]; label: string }
  /** projects:save (org chart editor, role grants): `before` is the stored project read before the save. */
  | { kind: 'projectSave'; before: Project; request: Project }
  /** An approved org chart card of another session: `before` is the stored project read before the apply. */
  | { kind: 'orgChart'; before: Project; roles: Role[] }

/** Role fields an org chart edit never moves through this route: identity, grants (their own route) and the canvas. */
const NOT_A_ROLE_EDIT: ReadonlySet<string> = new Set(['id', 'mcpServers', 'skills', 'position'])

type Loose = Record<string, unknown>
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** What an org chart edit changed, role by role (grants and positions aside). */
export interface RoleEdit {
  /** Role id -> the fields the action changed, with their new value (undefined = the field was cleared). */
  changed: Map<string, Record<string, unknown>>
  /** Roles the action added (in `after`, not in `before`), whole. */
  added: Role[]
  /** Ids of roles the action removed (in `before`, not in `after`). */
  removed: string[]
}

/**
 * The org chart edit `before` -> `after`, confirmed against `saved`: a changed field counts only when the saved role
 * has the new value (model / tier: when the saved role exists, since the save may resolve them), an added role only
 * when the save kept it, a removal only when the save dropped it. Roles are matched by id.
 */
export function roleEditOf(before: readonly Role[], after: readonly Role[], saved: readonly Role[]): RoleEdit {
  const was = new Map(before.map((r) => [r.id, r]))
  const now = new Map(after.map((r) => [r.id, r]))
  const kept = new Map(saved.map((r) => [r.id, r]))
  const edit: RoleEdit = { changed: new Map(), added: [], removed: [] }
  for (const r of after) {
    const b = was.get(r.id)
    const s = kept.get(r.id)
    if (!s) continue
    if (!b) {
      edit.added.push(structuredClone(r))
      continue
    }
    const fields: Record<string, unknown> = {}
    const bl = b as unknown as Loose
    const al = r as unknown as Loose
    const sl = s as unknown as Loose
    for (const k of new Set([...Object.keys(bl), ...Object.keys(al)])) {
      if (NOT_A_ROLE_EDIT.has(k) || same(bl[k], al[k])) continue
      if (k !== 'model' && k !== 'tier' && !same(sl[k], al[k])) continue
      fields[k] = al[k] === undefined ? undefined : structuredClone(al[k])
    }
    if (Object.keys(fields).length) edit.changed.set(r.id, fields)
  }
  for (const r of before) if (!now.has(r.id) && !kept.has(r.id)) edit.removed.push(r.id)
  return edit
}

export function roleEditEmpty(edit: RoleEdit): boolean {
  return !edit.changed.size && !edit.added.length && !edit.removed.length
}

/**
 * The chart to hand applyRosterChange for one run: the run's baseline (runBaselineOf) with only the edit's own fields
 * changed, the edit's removals left out and its additions appended. Diffed against that same baseline, nothing but the
 * user's edit can move (applyRosterChange's invariant does the rest: deferrals, root keeps, grants never move).
 */
export function proposedFromEdit(baseline: readonly Role[], edit: RoleEdit): Role[] {
  const gone = new Set(edit.removed)
  const out: Role[] = []
  const seen = new Set<string>()
  for (const b of baseline) {
    if (gone.has(b.id)) continue
    seen.add(b.id)
    const fields = edit.changed.get(b.id) ?? edit.added.find((a) => a.id === b.id)
    if (!fields) {
      out.push(structuredClone(b))
      continue
    }
    const next = structuredClone(b) as unknown as Loose
    for (const [k, v] of Object.entries(fields)) {
      if (NOT_A_ROLE_EDIT.has(k)) continue
      if (v === undefined) delete next[k]
      else next[k] = structuredClone(v)
    }
    out.push(next as unknown as Role)
  }
  for (const a of edit.added) {
    if (seen.has(a.id)) continue
    const r = structuredClone(a)
    delete r.mcpServers
    delete r.skills
    out.push(r)
  }
  return out
}

/** One grant the action changed: role `roleId` gained (granted) or lost the server / skill `id`. */
export interface GrantEdit {
  roleId: string
  field: 'mcpServers' | 'skills'
  id: string
  granted: boolean
}

/**
 * The grant pairs `before` -> `after` (Role.mcpServers / Role.skills, by role id; a role new in `after` starts with
 * none), confirmed against `saved` (the saved role must hold the pair as the edit left it). A removed role's grants are
 * not edits (the role leaves through the org chart).
 */
export function grantEditsOf(before: readonly Role[], after: readonly Role[], saved: readonly Role[]): GrantEdit[] {
  const was = new Map(before.map((r) => [r.id, r]))
  const kept = new Map(saved.map((r) => [r.id, r]))
  const out: GrantEdit[] = []
  for (const r of after) {
    const s = kept.get(r.id)
    if (!s) continue
    const b = was.get(r.id)
    for (const field of ['mcpServers', 'skills'] as const) {
      const from = new Set(b?.[field] ?? [])
      const to = new Set(r[field] ?? [])
      const savedHas = new Set(s[field] ?? [])
      for (const id of to) if (!from.has(id) && savedHas.has(id)) out.push({ roleId: r.id, field, id, granted: true })
      for (const id of from) if (!to.has(id) && !savedHas.has(id)) out.push({ roleId: r.id, field, id, granted: false })
    }
  }
  return out
}

/**
 * Copies of `roles` with the grant edits applied (only roles and items that exist: `has(field, id)` says whether the
 * run has the server / skill). Returns the roles and the edits that applied; the rest are `skipped`.
 */
export function applyGrantEdits(
  roles: readonly Role[],
  edits: readonly GrantEdit[],
  has: (field: GrantEdit['field'], id: string) => boolean
): { roles: Role[]; applied: GrantEdit[]; skipped: GrantEdit[] } {
  const applied: GrantEdit[] = []
  const skipped: GrantEdit[] = []
  const out = roles.map((r) => ({ ...r }))
  const byId = new Map(out.map((r) => [r.id, r]))
  for (const e of edits) {
    const r = byId.get(e.roleId)
    if (!r || (e.granted && !has(e.field, e.id))) {
      skipped.push(e)
      continue
    }
    const list = [...(r[e.field] ?? [])]
    const at = list.indexOf(e.id)
    if (e.granted && at < 0) list.push(e.id)
    else if (!e.granted && at >= 0) list.splice(at, 1)
    else continue
    r[e.field] = list
    applied.push(e)
  }
  return { roles: out, applied, skipped }
}
