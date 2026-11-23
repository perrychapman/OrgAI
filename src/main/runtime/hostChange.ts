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
 * For servers and skills (itemEditOf) the diff is before vs saved on the named items, so a same-save ingest change of
 * a NAMED item comes along when the action sets no `fields` limit; the team-files gate applies only narrowings
 * automatically, so that can only take something away. Pure module.
 */
export type HostProjectChange =
  /** mcp:upsert / mcp:remove / mcp:linkLibrary / mcp:setProjectOverrides: these servers (definition and grants to them). */
  | ({ kind: 'mcp' } & HostItemChange)
  /** skills:create / update / remove / linkLibrary: these skills (content and grants to them). */
  | ({ kind: 'skills' } & HostItemChange)
  /** projects:save (org chart editor, role grants): `before` is the stored project read before the save. */
  | { kind: 'projectSave'; before: Project; request: Project }
  /** An approved org chart card of another session: `before` is the stored project read before the apply. */
  | { kind: 'orgChart'; before: Project; roles: Role[] }

/**
 * A change of named servers or skills (mcp:* / skills:* handlers, or another session's approved card). Only what the
 * action itself changed moves: `before` (the stored project read before the save, a copy) against the saved project,
 * for the named items only, limited to `fields` and `grants`.
 */
export interface HostItemChange {
  /** Server or skill ids, library entry ids included. */
  ids: string[]
  /** Server or skill names. */
  names: string[]
  /** For the run log ("You changed <label>"); raw, RunManager passes it through logText. */
  label: string
  /** The stored project read BEFORE the save (structuredClone'd by the caller). */
  before: Project
  /**
   * The definition fields the action's input set (mcp:upsert: the spec's keys; setProjectOverrides: envOverrides /
   * headerOverrides). Missing = any field the save changed on a named item.
   */
  fields?: readonly string[]
  /**
   * Grants the action's input carried, per item (`item`: an id, name or library id of a named item): `roleIds` is the
   * complete set of roles holding it after the action (skills roleIds replace the set). Missing = the action named no
   * grant: the run's grants to the items stay (a removed item still loses them).
   */
  grants?: readonly { item: string; roleIds: readonly string[] }[]
}

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

/** A running role whose saved slug changed (a rename in the editor): the run keeps `runSlug` until its next run. */
export interface KeptSlug {
  id: string
  /** The slug this run keeps calling the role by (agents, definitions and spawn names are keyed by it). */
  runSlug: string
  /** The slug the save gave it (applies from the next run). */
  savedSlug: string
  /** The role's new name when the same edit renamed it, else undefined. */
  newName?: string
}

/**
 * A host edit of running roles with every slug change taken out (rename design, ARCHITECTURE.md "Host changes in a
 * live run"): a running role's slug is its identity in the run, so the run keeps it and the rest of the edit (the name
 * included) applies. Roles not in `running` (new or waiting roles) keep their slug edit. Returns the edit (a copy) and
 * the slugs kept. Pure.
 */
export function keepRunSlugs(edit: RoleEdit, running: readonly Role[]): { edit: RoleEdit; kept: KeptSlug[] } {
  const byId = new Map(running.map((r) => [r.id, r]))
  const changed = new Map<string, Record<string, unknown>>()
  const kept: KeptSlug[] = []
  for (const [id, fields] of edit.changed) {
    const run = byId.get(id)
    if (!run || !('slug' in fields)) {
      changed.set(id, fields)
      continue
    }
    const { slug, ...rest } = fields
    if (typeof slug === 'string' && slug !== run.slug) {
      kept.push({ id, runSlug: run.slug, savedSlug: slug, ...(typeof rest.name === 'string' && rest.name !== run.name ? { newName: rest.name } : {}) })
    }
    if (Object.keys(rest).length) changed.set(id, rest)
  }
  return { edit: { changed, added: edit.added, removed: edit.removed }, kept }
}

/**
 * McpServerSpec.roles (role slugs) of `items` as THIS RUN names those roles. `running` must be the run's RUNNING roles
 * (ctx.roles) only, never the waiting roles of its view (review H1: a waiting role can hold a slug a running role kept).
 *
 * THE SLUG INVARIANT (third review, N1): inside a live run a slug text in the run's server list means exactly one running
 * role, the one it named BY ID when the text entered the run, and no slug text the run did not map by id grants anything
 * to a running role. So: a slug naming roles of `stored` (the project the list was saved with; every stored role holding
 * it, duplicates included) that are running becomes their slugs in the run (by id), so a run that kept a renamed role's
 * old slug (keepRunSlugs) neither loses nor gains a grant by slug text. Any other slug (it names a stored role that is not
 * running, or no stored role at all, e.g. an old slug left in the list by a rename) is carried as text only while no
 * running role holds that text; when one does, it is dropped (it would reach a role it does not name: fails closed). So
 * a waiting role's slug-keyed grant is remembered under its slug and applies if that role joins under it (it cannot join
 * while a running role holds the slug: runRoster.ts slugTaken / retired slugs). Copies only items with a `roles` list. Pure.
 */
export function mcpRolesForRun<T extends { roles?: string[] }>(items: readonly T[] | undefined, stored: readonly Role[], running: readonly Role[]): T[] | undefined {
  if (!items) return undefined
  const storedIds = new Map<string, string[]>()
  for (const r of stored) storedIds.set(r.slug, [...(storedIds.get(r.slug) ?? []), r.id])
  const runSlugOf = new Map(running.map((r) => [r.id, r.slug]))
  const runSlugs = new Set(running.map((r) => r.slug))
  const map = (slug: string): string[] => {
    const mapped = (storedIds.get(slug) ?? []).flatMap((id) => (runSlugOf.has(id) ? [runSlugOf.get(id)!] : []))
    if (mapped.length) return mapped
    return runSlugs.has(slug) ? [] : [slug]
  }
  return items.map((x) => {
    if (!Array.isArray(x.roles)) return x
    const roles: string[] = []
    for (const slug of x.roles) for (const m of map(slug)) if (!roles.includes(m)) roles.push(m)
    return { ...x, roles }
  })
}

/**
 * N1 (third review): slug texts in the run's server list that the stored project no longer backs for the running role
 * holding them. For each pair (running role `roleId`, server `itemId`) asked about: when the run's server lists the role's
 * RUN slug, that text is legitimate only while the saved server grants the role by slug too (its `roles` is undefined or
 * lists the role's SAVED slug, which mcpRolesForRun maps to the run slug); otherwise the text is a leftover (an old slug
 * left in the stored list by a rename, or a slug the user's revoke could not reach) and is removed from the run's copy.
 * When the saved role holds the server by id (Role.mcpServers: the role inspector's rename copies slug grants to ids) the
 * removal comes with an id grant in `convert` (access kept, never widened: the role had it by text); otherwise the role
 * loses the server and the pair is in `lost`. Pure; returns `items` itself when nothing changes.
 */
export function staleSlugTexts<T extends { id: string; roles?: string[] }>(
  items: readonly T[] | undefined,
  pairs: readonly { roleId: string; itemId: string }[],
  running: readonly Role[],
  saved: { roles: readonly Role[]; mcpServers?: readonly { id: string; roles?: string[] }[] }
): { items: T[] | undefined; convert: GrantEdit[]; lost: GrantEdit[] } {
  const convert: GrantEdit[] = []
  const lost: GrantEdit[] = []
  if (!items) return { items: undefined, convert, lost }
  const runById = new Map(running.map((r) => [r.id, r]))
  const savedRole = new Map(saved.roles.map((r) => [r.id, r]))
  const savedItem = new Map((saved.mcpServers ?? []).map((s) => [s.id, s]))
  const drop = new Map<string, Set<string>>()
  for (const { roleId, itemId } of pairs) {
    const run = runById.get(roleId)
    const item = items.find((x) => x.id === itemId)
    const stored = savedItem.get(itemId)
    if (!run || !item || !Array.isArray(item.roles) || !item.roles.includes(run.slug) || !stored) continue
    const sr = savedRole.get(roleId)
    if (sr && (stored.roles === undefined || stored.roles.includes(sr.slug))) continue
    if (drop.get(itemId)?.has(run.slug)) continue
    drop.set(itemId, new Set([...(drop.get(itemId) ?? []), run.slug]))
    // Every running role holding that text loses it (two can share a slug stored before the run started): each keeps
    // the server by id where its saved role holds it, else is reported as losing it (review Low 1, never silent).
    for (const holder of running.filter((r) => r.slug === run.slug)) {
      const edit: GrantEdit = { roleId: holder.id, field: 'mcpServers', id: itemId, granted: true }
      if ((savedRole.get(holder.id)?.mcpServers ?? []).includes(itemId)) convert.push(edit)
      else lost.push({ ...edit, granted: false })
    }
  }
  if (!drop.size) return { items: items as T[], convert, lost }
  return {
    items: items.map((x) => {
      const gone = drop.get(x.id)
      return gone && Array.isArray(x.roles) ? { ...x, roles: x.roles.filter((s) => !gone.has(s)) } : x
    }),
    convert,
    lost
  }
}

/**
 * Role slugs an agent of a live run wrote (a proposal's or install's `roles`) as the STORED project names those roles:
 * a slug a running role holds becomes the stored slug of that role (by id), so a run that kept a renamed role's old slug
 * proposes grants the save understands and that land on the role the agent meant. A slug no running role holds stays
 * (a waiting role of the view, or a stored role). A running role the stored project no longer has keeps its slug only
 * when no stored role holds that slug text; otherwise it is dropped (never granted to the other stored role). Pure.
 */
export function slugsForStore(slugs: readonly string[], running: readonly Role[], stored: readonly Role[]): string[] {
  const runOwner = new Map(running.map((r) => [r.slug, r.id]))
  const storedById = new Map(stored.map((r) => [r.id, r.slug]))
  const storedSlugs = new Set(stored.map((r) => r.slug))
  const out: string[] = []
  for (const slug of slugs) {
    const id = runOwner.get(slug)
    const mapped = id === undefined ? slug : storedById.get(id) ?? (storedSlugs.has(slug) ? undefined : slug)
    if (mapped !== undefined && !out.includes(mapped)) out.push(mapped)
  }
  return out
}

/**
 * The roles of a run's own org chart card as the save should get them (follow-up b): a card role that is a running role
 * under the slug the run kept (keepRunSlugs) takes the stored slug of that role (by id), so SetupService's merge
 * (orgMerge.ts matches by slug, then name) finds the right stored role and never reverts the user's rename or matches
 * another stored role that now holds the old slug; its name likewise takes the stored name when the card left the name
 * as the run had it (`baseline`: the card's runBaseline, else the run's roles). A role the card itself renamed (another
 * slug or name than the run had) keeps the card's value. Returns `roles` itself when nothing changes. Pure.
 */
export function cardRolesForStore(roles: readonly Role[], running: readonly Role[], baseline: readonly Role[], stored: readonly Role[]): Role[] {
  const runById = new Map(running.map((r) => [r.id, r]))
  const runBySlug = new Map(running.map((r) => [r.slug, r]))
  const baseById = new Map(baseline.map((r) => [r.id, r]))
  const storedById = new Map(stored.map((r) => [r.id, r]))
  let changed = false
  const out = roles.map((card) => {
    // By id when the card kept the role's id (a waiting role sharing a kept slug is not the running role); by slug when
    // the tool gave it a fresh id. Either way the card must still use the slug the run has.
    const known = runById.has(card.id) || baseById.has(card.id) || storedById.has(card.id)
    const run = known ? runById.get(card.id) : runBySlug.get(card.slug)
    const s = run && run.slug === card.slug ? storedById.get(run.id) : undefined
    if (!run || !s) return card
    const was = baseById.get(run.id) ?? run
    const next = { ...card }
    if (s.slug !== run.slug) next.slug = s.slug
    if (card.name === was.name && s.name !== card.name) next.name = s.name
    if (next.slug === card.slug && next.name === card.name) return card
    changed = true
    return next
  })
  return changed ? out : (roles as Role[])
}

/**
 * mcp:upsert's `HostItemChange.fields` (review L4): the keys the input spec set plus the stored item's keys, except, for
 * a server linked to library entry `entry` before and after, the library-sourced keys (not MCP_LINK_OWN) the input left
 * out or set to the entry's value: those are the library's, not the user's edit. Without an entry every key is kept. Pure.
 */
export function upsertFieldsOf(input: Record<string, unknown>, stored: Record<string, unknown> | undefined, entry: Record<string, unknown> | undefined): string[] {
  const keys = [...new Set([...Object.keys(input), ...Object.keys(stored ?? {})])]
  const linked = !!entry && typeof stored?.libraryId === 'string' && stored.libraryId === entry.id && (input.libraryId === undefined || input.libraryId === entry.id)
  if (!linked) return keys
  return keys.filter((k) => MCP_LINK_OWN.has(k) || (k in input && !same(input[k], entry![k])))
}

/** The fields of a server the terminal UI changes with mcp:upsert, one per save. */
const TERMINAL_UPSERT_FIELDS: ReadonlySet<string> = new Set(['enabled', 'roles'])

/**
 * mcp:upsert on the terminal's own host: a client sends the whole spec, read before the save, so it can carry a stale
 * value of some other field. `shown` is the server as mcp:list answers it now, read under the same lock as the save.
 * Only a spec that differs from it in exactly one field, `enabled` or `roles`, is the user's one edit and may reach a
 * live run: that field's name. Anything else (a new server, two differing fields, another field): undefined, and the
 * save applies from the next run.
 */
export function terminalUpsertField(spec: Record<string, unknown> | undefined, shown: Record<string, unknown> | undefined): string | undefined {
  if (!spec || !shown || typeof spec !== 'object' || typeof shown !== 'object') return undefined
  const differs = [...new Set([...Object.keys(spec), ...Object.keys(shown)])].filter((k) => JSON.stringify(spec[k]) !== JSON.stringify(shown[k]))
  return differs.length === 1 && TERMINAL_UPSERT_FIELDS.has(differs[0]) ? differs[0] : undefined
}

/** Fields of a linked MCP server the project owns (defaults.ts linkedSpec); every other field comes from the library. */
export const MCP_LINK_OWN: ReadonlySet<string> = new Set(['id', 'enabled', 'roles', 'envOverrides', 'headerOverrides', 'addedAt', 'source', 'libraryId'])
/** Fields of a linked skill the project owns (skills/service.ts linkedSnapshot); every other field comes from the library. */
export const SKILL_LINK_OWN: ReadonlySet<string> = new Set(['id', 'enabled', 'addedAt', 'source', 'libraryId'])

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

/** What an item edit (itemEditOf) does to the run's list, split into what takes away and what adds. */
export interface ItemEdit<T> {
  /** The run's list with only the narrowing part applied: removals, a turn-off, a smaller MCP `roles` list. */
  narrowed: T[] | undefined
  /** The run's list with the whole edit applied (narrowed plus redefinitions and new items). */
  widened: T[] | undefined
  /** The run's items the action removed. */
  removed: T[]
  /** Items the action created (in neither `before` nor the run). */
  added: T[]
  /** Ids of the run's items whose narrowing fields moved. */
  narrowedIds: string[]
  /** Ids of the run's items whose other fields moved. */
  widenedIds: string[]
  /** Ids of every named item (run, before or saved). */
  ownIds: Set<string>
}

/** True when the change of `field` from the run's `run` value to `next` only takes something away. */
function narrowsField(field: string, run: Loose, next: Loose): boolean {
  if (field === 'enabled') return next.enabled === false
  if (field === 'roles') {
    // McpServerSpec.roles: undefined = every role.
    const to = next.roles
    if (!Array.isArray(to)) return false
    const from = run.roles
    return !Array.isArray(from) || to.every((x) => from.includes(x))
  }
  return false
}

/**
 * The servers / skills the action named, `before` -> `saved`, applied to the run's `live` list. Only fields the action
 * changed move (before vs saved, limited to `fields` when given): a stored change the run did not take (approved for
 * the next run, a pull) is equal on both sides and never rides in on an unrelated edit of the same item. An item the
 * action removed leaves; an item it created (in neither `before` nor the run) is added whole; a stored item the run
 * does not have stays out. Items are matched by id, then by name. Pure.
 */
export function itemEditOf<T extends { id: string; name: string; libraryId?: string }>(
  live: readonly T[] | undefined,
  before: readonly T[] | undefined,
  saved: readonly T[] | undefined,
  own: { ids: readonly string[]; names: readonly string[] },
  fields?: readonly string[],
  /**
   * Review L-f: the fields a library-linked item owns (MCP_LINK_OWN / SKILL_LINK_OWN). `before` is the raw stored
   * project while `saved` is the handler's result with linked items refreshed from the library, so for an item linked to
   * the same entry on both sides a library-sourced field the input did not name (`fields`) is not the user's edit and
   * never moves (the gates refresh linked items from the library at read time anyway). Missing = every field compared.
   */
  linkOwn?: ReadonlySet<string>
): ItemEdit<T> {
  const ids = new Set(own.ids)
  const names = new Set(own.names)
  const isOwn = (x: T): boolean => ids.has(x.id) || names.has(x.name) || (!!x.libraryId && ids.has(x.libraryId))
  const find = (list: readonly T[] | undefined, x: { id: string; name: string }): T | undefined =>
    (list ?? []).find((y) => y.id === x.id) ?? (list ?? []).find((y) => y.name === x.name)
  const only = fields ? new Set(fields) : undefined
  const narrowed: T[] = []
  const widened: T[] = []
  const edit: ItemEdit<T> = { narrowed, widened, removed: [], added: [], narrowedIds: [], widenedIds: [], ownIds: new Set() }
  for (const x of [...(live ?? []), ...(before ?? []), ...(saved ?? [])]) if (isOwn(x)) edit.ownIds.add(x.id)
  const matched = new Set<string>()
  for (const x of live ?? []) {
    if (!isOwn(x)) {
      narrowed.push(x)
      widened.push(x)
      continue
    }
    const b = find(before, x)
    const s = find(saved, x)
    if (s) matched.add(s.id)
    if (b && !s) {
      edit.removed.push(x)
      continue
    }
    if (!b || !s) {
      // Not something this action changed as the run has it.
      narrowed.push(x)
      widened.push(x)
      continue
    }
    const bl = b as unknown as Loose
    const sl = s as unknown as Loose
    const n = structuredClone(x) as unknown as Loose
    let narrows = false
    const wide: [string, unknown][] = []
    const linked = !!linkOwn && typeof bl.libraryId === 'string' && bl.libraryId === sl.libraryId
    for (const k of new Set([...Object.keys(bl), ...Object.keys(sl)])) {
      if (k === 'id' || (only && !only.has(k)) || same(bl[k], sl[k])) continue
      if (linked && !linkOwn!.has(k) && !only?.has(k)) continue
      if (narrowsField(k, x as unknown as Loose, sl)) {
        n[k] = structuredClone(sl[k])
        narrows = true
      } else wide.push([k, sl[k]])
    }
    const w = wide.length ? (structuredClone(n) as Loose) : n
    for (const [k, v] of wide) {
      if (v === undefined) delete w[k]
      else w[k] = structuredClone(v)
    }
    narrowed.push((narrows ? n : x) as unknown as T)
    widened.push((narrows || wide.length ? w : x) as unknown as T)
    if (narrows) edit.narrowedIds.push(x.id)
    if (wide.length) edit.widenedIds.push(x.id)
  }
  for (const s of saved ?? []) {
    if (!isOwn(s) || matched.has(s.id) || find(before, s) || find(live, s)) continue
    const copy = structuredClone(s)
    edit.added.push(copy)
    widened.push(copy)
  }
  if (live === undefined) {
    edit.narrowed = undefined
    if (!edit.added.length) edit.widened = undefined
  }
  return edit
}

/**
 * The grant edits of named items an action made (before.roles -> saved.roles, field `field`), limited to the grants its
 * input carried: per item, a role in `roleIds` may gain it, a role outside may lose it. Items are resolved by id, name or
 * library id among `items`. No `scopes` = none. Pure.
 */
export function itemGrantEditsOf<T extends { id: string; name: string; libraryId?: string }>(
  before: readonly Role[],
  saved: readonly Role[],
  field: GrantEdit['field'],
  items: readonly T[],
  scopes: HostItemChange['grants']
): GrantEdit[] {
  if (!scopes?.length) return []
  const resolved = scopes.map((sc) => ({
    ids: new Set(items.filter((x) => x.id === sc.item || x.name === sc.item || (!!x.libraryId && x.libraryId === sc.item)).map((x) => x.id)),
    roleIds: new Set(sc.roleIds)
  }))
  return grantEditsOf(before, saved, saved).filter(
    (e) => e.field === field && resolved.some((sc) => sc.ids.has(e.id) && (e.granted ? sc.roleIds.has(e.roleId) : !sc.roleIds.has(e.roleId)))
  )
}

/** Ungrant edits for every grant `roles` hold to `ids` in `field` (a removed item's grants leave with it). Pure. */
export function ungrantsOf(roles: readonly Role[], field: GrantEdit['field'], ids: ReadonlySet<string>): GrantEdit[] {
  return roles.flatMap((r) => (r[field] ?? []).filter((id) => ids.has(id)).map((id) => ({ roleId: r.id, field, id, granted: false })))
}
