/** Diff of a proposed org chart against the project's current one (spec 12.3). Pure; no UI. */
import { MODEL_TIER_OPTIONS } from '@shared/types'
import { settingTier, tierForModel } from '@shared/defaults'

/** The tier name the user chose ("Fast") for a tier, or a vendor alias or id that maps to one; any other model is kept as is. */
export function modelDisplay(model: string): string {
  const tier = settingTier(model) ?? tierForModel(model)
  return tier ? (MODEL_TIER_OPTIONS.find((o) => o.value === tier)?.label ?? model) : model
}

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
  /** Role.requiredReports as ids (like spawnable). A full role without it reads as none. */
  requiredReports?: readonly string[]
  skills?: readonly string[]
  prompt?: string
  responsibilities?: readonly string[]
  /** The tier behind `model` (Role.tier); remaps follow it, so a change the model line does not show is diffed too. */
  tier?: string
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
  /** The proposal gave the role a new slug and a similar name: shown as one renamed row. */
  renamed?: boolean
  /** Set when the proposal states a different prompt: both texts, so the card can show the new one (review M3). */
  prompt?: PromptChange
  /** Set when the proposal states a different responsibilities list (they go into the role's system prompt). */
  responsibilities?: ResponsibilitiesChange
}

export interface ResponsibilitiesChange {
  before: readonly string[]
  after: readonly string[]
}

/** The responsibilities change between two roles (compared in order), or undefined when the proposal leaves them out or keeps them. */
export function responsibilitiesChange(before: DiffRole, after: DiffRole): ResponsibilitiesChange | undefined {
  if (after.responsibilities === undefined) return undefined
  const was = before.responsibilities ?? []
  const now = after.responsibilities
  if (was.length === now.length && was.every((x, i) => x === now[i])) return undefined
  return { before: was, after: now }
}

/** The tier a role is remapped by: its own, else the one its model stands for (legacy roles), else none. */
function effectiveTier(r: DiffRole): string | undefined {
  return r.tier ?? tierForModel(r.model)
}

function tierLabel(tier: string | undefined): string {
  return tier ? (MODEL_TIER_OPTIONS.find((o) => o.value === tier)?.label ?? tier) : NONE
}

export interface PromptChange {
  before: string
  after: string
}

/** The prompt change between two roles, or undefined when the proposal leaves the prompt out or keeps it. */
export function promptChange(before: DiffRole, after: DiffRole): PromptChange | undefined {
  if (after.prompt === undefined || (before.prompt ?? '') === after.prompt) return undefined
  return { before: before.prompt ?? '', after: after.prompt }
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
  const modelFrom = modelDisplay(before.model)
  const modelTo = modelDisplay(after.model)
  // Two ids that read as the same tier ("claude-sonnet-4-5" and "claude-sonnet-4-6") still re-pin the role: show the ids.
  if (modelFrom === modelTo && before.model !== after.model) push('model', 'model', `${modelFrom} (${before.model})`, `${modelTo} (${after.model})`)
  else push('model', 'model', modelFrom, modelTo)
  // A tier change the model line already shows (both models read as their tier) is not repeated.
  const tierFrom = tierLabel(effectiveTier(before))
  const tierTo = tierLabel(effectiveTier(after))
  if (tierFrom !== tierTo && !(modelDisplay(before.model) === tierFrom && modelDisplay(after.model) === tierTo)) push('tier', 'tier', tierFrom, tierTo)
  push('reportsTo', 'reports to', parentName(before, cur), parentName(after, prop))
  // A field the proposal leaves out (undefined) is not a change: only what it states is compared.
  if (after.description !== undefined) push('description', 'description', before.description ?? '', after.description)
  if (after.tools !== undefined) push('tools', 'tools', sortedList(before.tools), sortedList(after.tools))
  if (after.canSpawn !== undefined && (after.spawnable !== undefined || after.canSpawn !== !!before.canSpawn)) {
    push('canSpawn', 'spawns', spawnNames(before, cur), spawnNames(after, prop))
  }
  // A changed list is a line ("must delegate to: none -> Dev, QA"); a role that states spawnable states this too.
  if (after.requiredReports !== undefined || after.spawnable !== undefined) {
    const names = (r: DiffRole, by: Map<string, DiffRole>): string => sortedList((r.requiredReports ?? []).map((id) => by.get(id)?.name ?? id))
    push('requiredReports', 'must delegate to', names(before, cur), names(after, prop))
  }
  if (after.skills !== undefined) push('skills', 'skills', sortedList(before.skills), sortedList(after.skills))
  if (responsibilitiesChange(before, after)) out.push({ field: 'responsibilities', label: 'responsibilities', from: '', to: 'responsibilities changed' })
  if (after.prompt !== undefined && (before.prompt ?? '') !== after.prompt) out.push({ field: 'prompt', label: 'prompt', from: '', to: 'prompt changed' })
  return out
}

function normName(n: string): string {
  return n.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = row
  }
  return prev[b.length]
}

/** 0..1: how alike two role names read ("Backend Dev" and "Backend Developer" are close, "Researcher" and "QA" are not). */
export function nameSimilarity(a: string, b: string): number {
  const x = normName(a)
  const y = normName(b)
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.includes(y) || y.includes(x)) return 0.8
  return 1 - editDistance(x, y) / Math.max(x.length, y.length)
}

/** At or above this a removed role and an added role are taken to be one role that was renamed. */
export const RENAME_SIMILARITY = 0.7

export function diffSummary(added: number, removed: number, changed: number): string {
  const parts: string[] = []
  if (added) parts.push(`${added} added`)
  if (removed) parts.push(`${removed} removed`)
  if (changed) parts.push(`${changed} changed`)
  return parts.length > 0 ? parts.join(', ') : 'No changes'
}

function withPrompt<R extends DiffRole>(c: ChangedRole<R>): ChangedRole<R> {
  const prompt = promptChange(c.before, c.role)
  const responsibilities = responsibilitiesChange(c.before, c.role)
  return { ...c, ...(prompt ? { prompt } : {}), ...(responsibilities ? { responsibilities } : {}) }
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
    if (changes.length > 0) changed.push(withPrompt({ role, before, changes }))
    else unchanged.push(role)
  }
  let removed = current.filter((r) => !seen.has(keyOf(r)))
  // A rename that also changes the slug looks like one removed plus one added role. Pair the most alike ones.
  const pairs: { r: DiffRole; a: R; score: number }[] = []
  for (const r of removed) for (const a of added) pairs.push({ r, a, score: nameSimilarity(r.name, a.name) })
  pairs.sort((x, y) => y.score - x.score)
  const usedRemoved = new Set<DiffRole>()
  const usedAdded = new Set<R>()
  for (const { r, a, score } of pairs) {
    if (score < RENAME_SIMILARITY || usedRemoved.has(r) || usedAdded.has(a)) continue
    usedRemoved.add(r)
    usedAdded.add(a)
    const changes = fieldChanges(r, a, curById, propById)
    if (keyOf(r) !== keyOf(a)) changes.push({ field: 'slug', label: 'id', from: keyOf(r), to: keyOf(a) })
    changed.push(withPrompt({ role: a, before: r, changes, renamed: true }))
  }
  if (usedRemoved.size > 0) {
    removed = removed.filter((r) => !usedRemoved.has(r))
    for (let i = added.length - 1; i >= 0; i--) if (usedAdded.has(added[i])) added.splice(i, 1)
  }
  return { added, removed, changed, unchanged, summary: diffSummary(added.length, removed.length, changed.length) }
}
