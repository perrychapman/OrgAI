import { formatDate } from './dates'
import type { KitAction, KitApplyResult, KitExportInput, KitItemKind, KitNeedsSecrets, KitPreviewItem, KitSelection } from './kitApi'

/** Pure helpers of the Practice kit UI (engagement-2 spec section 8). */

export type KitGroupId = 'skills' | 'servers' | 'presets' | 'templates'

export const KIT_GROUPS: readonly KitGroupId[] = ['skills', 'servers', 'presets', 'templates']

export const KIT_GROUP_TITLE: Record<KitGroupId, string> = {
  skills: 'Library skills',
  servers: 'Custom servers',
  presets: 'Your presets',
  templates: 'Team templates'
}

/** The `include` key main reads for each group. */
export const KIT_INCLUDE_KEY: Record<KitGroupId, keyof KitExportInput['include']> = {
  skills: 'skills',
  servers: 'mcpServers',
  presets: 'connectorPresets',
  templates: 'templates'
}

export function kitTypeLabel(kind: KitItemKind): string {
  return kind === 'skill' ? 'Skill' : kind === 'server' ? 'Custom server' : kind === 'preset' ? 'Preset' : 'Template'
}

export const ACTION_LABEL: Record<KitAction, string> = {
  add: 'Add',
  replace: 'Replace mine',
  copy: 'Add as a copy',
  skip: 'Skip'
}

/** Whether the row takes a choice at all (refused and identical items do not). */
export function hasChoice(item: KitPreviewItem): boolean {
  return item.status === 'new' || item.status === 'different'
}

export interface ActionOption {
  value: KitAction
  label: string
}

/** The choices offered for one row. New: Add / Skip. Different: Keep mine / Replace mine (when possible) / copy / Skip. */
export function actionOptions(item: KitPreviewItem): ActionOption[] {
  if (item.status === 'new') return [{ value: 'add', label: 'Add' }, { value: 'skip', label: 'Skip' }]
  if (item.status === 'different') {
    const out: ActionOption[] = [{ value: 'skip', label: 'Keep mine' }]
    if (item.canReplace) out.push({ value: 'replace', label: ACTION_LABEL.replace })
    out.push({ value: 'copy', label: ACTION_LABEL.copy }, { value: 'skip', label: ACTION_LABEL.skip })
    return out
  }
  return []
}

/** Distinct option values (Keep mine and Skip both mean skip; the select shows Keep mine first). */
export function selectOptions(item: KitPreviewItem): { value: string; label: string }[] {
  const seen = new Set<string>()
  const out: { value: string; label: string }[] = []
  for (const o of actionOptions(item)) {
    if (seen.has(o.value)) continue
    seen.add(o.value)
    out.push(o)
  }
  return out
}

/** The preselected choice: main's `action` when this row offers it, else the safe one (add for new, skip otherwise). */
export function defaultChoice(item: KitPreviewItem): KitAction {
  if (!hasChoice(item)) return 'skip'
  if (actionOptions(item).some((o) => o.value === item.action)) return item.action
  return item.status === 'new' ? 'add' : 'skip'
}

export function defaultChoices(items: KitPreviewItem[]): Record<string, KitAction> {
  const out: Record<string, KitAction> = {}
  for (const it of items) if (hasChoice(it)) out[it.key] = defaultChoice(it)
  return out
}

/** After "Preview again": keep a choice for a key that still exists and still offers it; the rest take their default. */
export function mergeChoices(previous: Record<string, KitAction>, items: KitPreviewItem[]): Record<string, KitAction> {
  const out: Record<string, KitAction> = {}
  for (const it of items) {
    if (!hasChoice(it)) continue
    const kept = previous[it.key]
    out[it.key] = kept && actionOptions(it).some((o) => o.value === kept) ? kept : defaultChoice(it)
  }
  return out
}

export interface KitSummary {
  add: number
  replace: number
  copy: number
  skip: number
  /** Items that will be written. */
  total: number
}

export function summarize(items: KitPreviewItem[], choices: Record<string, KitAction>): KitSummary {
  const s: KitSummary = { add: 0, replace: 0, copy: 0, skip: 0, total: 0 }
  for (const it of items) {
    if (!hasChoice(it)) continue
    s[choices[it.key] ?? defaultChoice(it)] += 1
  }
  s.total = s.add + s.replace + s.copy
  return s
}

/** "Adds 6, replaces 1, copies 1, skips 2." Zero parts after the first are still named, so the line is stable. */
export function summaryLine(s: KitSummary): string {
  return `Adds ${s.add}, replaces ${s.replace}, copies ${s.copy}, skips ${s.skip}.`
}

export function importButtonLabel(total: number): string {
  return `Import ${total} ${total === 1 ? 'item' : 'items'}`
}

/** Every non-refused row's choice for the apply call (identical rows are skipped explicitly). */
export function choicesFromRows(items: KitPreviewItem[], choices: Record<string, KitAction>): { key: string; action: KitAction }[] {
  const out: { key: string; action: KitAction }[] = []
  for (const it of items) {
    if (it.status === 'refused') continue
    out.push({ key: it.key, action: hasChoice(it) ? (choices[it.key] ?? defaultChoice(it)) : 'skip' })
  }
  return out
}

/** Names of the items a "Replace mine" choice will overwrite. */
export function replacedNames(items: KitPreviewItem[], choices: Record<string, KitAction>): string[] {
  return items.filter((it) => hasChoice(it) && (choices[it.key] ?? defaultChoice(it)) === 'replace').map((it) => it.name)
}

export function statusLabel(item: KitPreviewItem): string {
  if (item.status === 'new') return 'New'
  if (item.status === 'same') return 'Same as yours'
  if (item.status === 'different') return 'Different from yours'
  return `Refused: ${item.refusal ?? 'main could not read it'}`
}

/** "name (SLOT_A, SLOT_B)" for one item that needs values after import. */
export function needsSecretEntry(n: KitNeedsSecrets): string {
  const slots = [...n.env, ...n.headers]
  const base = slots.length > 0 ? `${n.name} (${slots.join(', ')})` : n.name
  return n.perProject ? `${base}, each project enters its own` : base
}

/** "These need secret values before agents can use them: a (X), b (Y)." or '' when none. */
export function needsSecretsLine(needs: KitNeedsSecrets[]): string {
  if (needs.length === 0) return ''
  return `These need secret values before agents can use them: ${needs.map(needsSecretEntry).join('; ')}.`
}

/** Items written by an apply (added + replaced + copied). */
export function importedCount(r: Pick<KitApplyResult, 'added' | 'replaced' | 'copied'>): number {
  return r.added + r.replaced + r.copied
}

export function importedLine(n: number): string {
  return `Imported ${n} ${n === 1 ? 'item' : 'items'}.`
}

export function itemCountText(n: number): string {
  return `${n} ${n === 1 ? 'item' : 'items'}`
}

/** The export footer's count line. */
export function exportCountLine(n: number): string {
  return n === 0 ? 'Choose at least one item.' : itemCountText(n)
}

// ---------- export selection ----------

export type KitSelectionState = Record<KitGroupId, Set<string>>

export function emptySelection(): KitSelectionState {
  return { skills: new Set(), servers: new Set(), presets: new Set(), templates: new Set() }
}

export function selectedTotal(sel: KitSelectionState): number {
  return KIT_GROUPS.reduce((n, g) => n + sel[g].size, 0)
}

/** Ticked state of a group: 'all', 'some' (mixed) or 'none'. An empty group is 'none'. */
export function groupState(selected: number, total: number): 'all' | 'some' | 'none' {
  if (total === 0 || selected === 0) return 'none'
  return selected >= total ? 'all' : 'some'
}

/** Ids per group -> main's `include`: always the ticked ids (never 'all', so items added after the list loaded stay out), absent when none. */
export function selectionToInclude(sel: KitSelectionState, _totals?: Record<KitGroupId, number>): KitExportInput['include'] {
  const include: KitExportInput['include'] = {}
  for (const g of KIT_GROUPS) {
    if (sel[g].size === 0) continue
    const value: KitSelection = [...sel[g]]
    include[KIT_INCLUDE_KEY[g]] = value
  }
  return include
}

// ---------- last result line ----------

export const KIT_LAST_KEY = 'orgai.kitLast'

export interface KitLast {
  kind: 'exported' | 'imported'
  count: number
  at: number
}

export function parseKitLast(raw: string | null): KitLast | null {
  if (!raw) return null
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object') return null
    const o = v as Record<string, unknown>
    if ((o.kind !== 'exported' && o.kind !== 'imported') || typeof o.count !== 'number' || typeof o.at !== 'number') return null
    if (!Number.isFinite(o.count) || !Number.isFinite(o.at) || o.count < 0) return null
    return { kind: o.kind, count: Math.floor(o.count), at: o.at }
  } catch {
    return null
  }
}

/** "Exported 14 items on 4 Nov 2026." */
export function kitLastLine(last: KitLast): string {
  const date = formatDate(last.at)
  return `${last.kind === 'exported' ? 'Exported' : 'Imported'} ${itemCountText(last.count)} on ${date}.`
}

/** The file name of a path, for the dialog title when main sends none. */
export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}
