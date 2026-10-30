/** Diff of a proposed org chart against the project's current one (spec 12.3). Pure; no UI. */

/** The fields the diff reads. Both the project's Role and a proposal payload role satisfy it. */
export interface DiffRole {
  id: string
  slug?: string
  name: string
  model: string
  reportsTo: string | null
  description?: string
  tools?: readonly string[]
  canSpawn?: boolean
  spawnable?: readonly string[]
  skills?: readonly string[]
  prompt?: string
}

export interface FieldChange {
  field: string
  label: string
  from: string
  to: string
}

export interface ChangedRole<R extends DiffRole = DiffRole> {
  role: R
  before: DiffRole
  changes: FieldChange[]
}

export interface OrgDiff<R extends DiffRole = DiffRole> {
  added: R[]
  removed: DiffRole[]
  changed: ChangedRole<R>[]
  unchanged: R[]
  summary: string
}

const NONE = 'none'

function keyOf(r: DiffRole): string {
  return r.slug || r.id
}

function sortedList(v: readonly string[] | undefined): string {
  return v && v.length > 0 ? [...v].sort().join(', ') : NONE
}

/** Parents resolve to names so a chart reads the way the user sees it. */
function parentName(r: DiffRole, byId: Map<string, DiffRole>): string {
  if (!r.reportsTo) return NONE
  return byId.get(r.reportsTo)?.name ?? NONE
}

function spawnNames(r: DiffRole, byId: Map<string, DiffRole>): string {
  if (!r.canSpawn) return 'cannot spawn'
  const names = (r.spawnable ?? []).map((id) => byId.get(id)?.name ?? id).sort()
  return names.length > 0 ? names.join(', ') : 'any'
}

function fieldChanges(before: DiffRole, after: DiffRole, cur: Map<string, DiffRole>, prop: Map<string, DiffRole>): FieldChange[] {
  const out: FieldChange[] = []
  const push = (field: string, label: string, from: string, to: string): void => {
    if (from !== to) out.push({ field, label, from, to })
  }
  push('name', 'name', before.name, after.name)
  push('model', 'model', before.model, after.model)
  push('reportsTo', 'reports to', parentName(before, cur), parentName(after, prop))
  push('description', 'description', before.description ?? '', after.description ?? '')
  push('tools', 'tools', sortedList(before.tools), sortedList(after.tools))
  push('canSpawn', 'spawns', spawnNames(before, cur), spawnNames(after, prop))
  if (before.skills !== undefined || after.skills !== undefined) push('skills', 'skills', sortedList(before.skills), sortedList(after.skills))
  if ((before.prompt ?? '') !== (after.prompt ?? '')) out.push({ field: 'prompt', label: 'prompt', from: '', to: 'prompt changed' })
  return out
}

export function diffSummary(added: number, removed: number, changed: number): string {
  const parts: string[] = []
  if (added) parts.push(`${added} added`)
  if (removed) parts.push(`${removed} removed`)
  if (changed) parts.push(`${changed} changed`)
  return parts.length > 0 ? parts.join(', ') : 'No changes'
}

export function diffOrgChart<R extends DiffRole>(current: readonly DiffRole[], proposed: readonly R[]): OrgDiff<R> {
  const curById = new Map(current.map((r) => [r.id, r]))
  const propById = new Map<string, DiffRole>(proposed.map((r) => [r.id, r]))
  const curByKey = new Map(current.map((r) => [keyOf(r), r]))
  const seen = new Set<string>()
  const added: R[] = []
  const changed: ChangedRole<R>[] = []
  const unchanged: R[] = []
  for (const role of proposed) {
    const key = keyOf(role)
    const before = curByKey.get(key)
    if (!before) {
      added.push(role)
      continue
    }
    seen.add(key)
    const changes = fieldChanges(before, role, curById, propById)
    if (changes.length > 0) changed.push({ role, before, changes })
    else unchanged.push(role)
  }
  const removed = current.filter((r) => !seen.has(keyOf(r)))
  return { added, removed, changed, unchanged, summary: diffSummary(added.length, removed.length, changed.length) }
}
