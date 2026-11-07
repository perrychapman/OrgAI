import { connectionTag } from './roleConnection'
import type { ConnectionId, Effort, ModelFamily, ModelRef, ModelTier, ProviderId, ProviderModel, Role } from '@shared/types'
import { MODEL_TIER_OPTIONS } from '@shared/types'
import { effortOptionsFor } from '@shared/defaults'
import { groupByFamily, roleTier } from './remap'
import { FAMILY_WORD } from './modelFamily'

type TierModels = Partial<Record<ModelTier, ModelRef>>

export const TIER_LABEL = Object.fromEntries(MODEL_TIER_OPTIONS.map((o) => [o.value, o.label])) as Record<ModelTier, string>

/** The Model select's value for a role: 'inherit', a tier word, or 'custom' (an exact model that is no tier's model). */
export type RoleModelChoice = 'inherit' | ModelTier | 'custom'

/** The Exact model select's empty option (nothing pinned; the Model select above decides). */
export const EXACT_NOT_SET = 'Not set (use the tier above)'

/** "Everyday (sonnet)": the tier word plus the model it resolves to on the project's connection. */
export function tierOptionLabel(tier: ModelTier, tierModels: TierModels): string {
  const model = tierModels[tier]
  return model ? `${TIER_LABEL[tier]} (${model})` : TIER_LABEL[tier]
}

/** Which Model select option a role sits on. */
export function roleModelChoice(role: Pick<Role, 'model' | 'tier'>, tierModels: TierModels): RoleModelChoice {
  if (role.model === 'inherit') return 'inherit'
  const tier = roleTier(role)
  if (tier && tierModels[tier] === role.model) return tier
  // A model that is another tier's model counts as that tier.
  const other = MODEL_TIER_OPTIONS.find((o) => tierModels[o.value] === role.model)
  return other ? other.value : 'custom'
}

/** The fold summary: the tier label, "Inherited" or "Custom", plus " · <connection>" when the role is pinned (`on` its connection, `base` the project's). */
export function roleModelSummary(role: Pick<Role, 'model' | 'tier'>, tierModels: TierModels, on?: ConnectionId, base?: ConnectionId): string {
  const choice = roleModelChoice(role, tierModels)
  if (choice === 'inherit') return 'Inherited'
  const word = choice === 'custom' ? 'Custom' : TIER_LABEL[choice]
  const tag = connectionTag(on, base)
  return tag ? `${word} · ${tag}` : word
}

/** What picking a Model option writes: inherit, or the tier's model with the tier recorded. */
export function applyModelChoice(choice: string, tierModels: TierModels): { model: ModelRef; tier: ModelTier | undefined } | null {
  if (choice === 'inherit') return { model: 'inherit', tier: undefined }
  const tier = MODEL_TIER_OPTIONS.find((o) => o.value === choice)?.value
  const model = tier ? tierModels[tier] : undefined
  return tier && model ? { model, tier } : null
}

/**
 * What picking an exact model writes: the id, with the tier it happens to be (if any). '' ("Not set") goes back to the
 * tier chosen above: the role's saved tier, else the everyday tier, else the first mapped tier. It never turns a tier
 * role into inherit; only a role whose connection maps no tier at all falls back to inherit (ux-review-config-2 N3).
 */
export function applyExactModel(
  value: string,
  tierModels: TierModels,
  role?: Pick<Role, 'model' | 'tier'>
): { model: ModelRef; tier: ModelTier | undefined } {
  if (!value) {
    if (role?.model === 'inherit') return { model: 'inherit', tier: undefined }
    const saved = role ? roleTier(role) : undefined
    const tier = [saved, 'everyday' as ModelTier, ...MODEL_TIER_OPTIONS.map((o) => o.value)].find((t): t is ModelTier => !!t && !!tierModels[t])
    return tier ? { model: tierModels[tier]!, tier } : { model: 'inherit', tier: undefined }
  }
  return { model: value, tier: MODEL_TIER_OPTIONS.find((o) => tierModels[o.value] === value)?.value }
}

/** The Exact model select's value: the pinned id only for a custom role; '' ("Not set") for inherit and tier roles. */
export function exactModelValue(role: Pick<Role, 'model' | 'tier'>, tierModels: TierModels): string {
  return roleModelChoice(role, tierModels) === 'custom' ? role.model : ''
}

/** The org chart node's model chip: the tier word (the id goes in its title), "Inherit", or the custom id; " · <connection>" when pinned to another connection than the project's. */
export function roleChipLabel(role: Pick<Role, 'model' | 'tier'>, on?: ConnectionId, base?: ConnectionId): string {
  const tier = roleTier(role)
  const word = role.model === 'inherit' ? 'Inherit' : tier ? TIER_LABEL[tier] : role.model
  const tag = connectionTag(on, base)
  return tag ? `${word} · ${tag}` : word
}

export interface ExactGroup {
  label?: string
  options: { value: string; label: string; disabled?: boolean }[]
}

/**
 * Concrete ids for the "Exact model" select. A proxy project lists the whole catalog grouped by family (Claude, GPT,
 * Other), each option naming its family (any role may run any model the proxy serves); other connections list their
 * catalog in one group.
 */
export function exactModelGroups(catalog: readonly ProviderModel[], proxy: boolean, current: ModelRef): ExactGroup[] {
  const option = (m: ProviderModel): { value: string; label: string } => ({
    value: m.id,
    label: proxy ? `${m.id}${m.recommended ? ' (recommended)' : ''} · ${FAMILY_WORD[m.family]}` : m.recommended ? `${m.id} (recommended)` : m.id
  })
  const groups: ExactGroup[] = proxy
    ? groupByFamily(catalog).map((g) => ({ label: FAMILY_WORD[g.family as ModelFamily], options: g.models.map(option) }))
    : catalog.length > 0
      ? [{ label: 'Models', options: catalog.map(option) }]
      : []
  const known = current === '' || current === 'inherit' || catalog.some((m) => m.id === current)
  const lead: ExactGroup[] = [{ options: [{ value: '', label: EXACT_NOT_SET }] }]
  if (!known) lead.push({ options: [{ value: current, label: `${current} (unavailable)`, disabled: true }] })
  return [...lead, ...groups]
}

export interface EffortView {
  options: { value: string; label: string }[]
  /** A saved effort the adapter does not use; it stays selected and is explained. */
  unsupported?: Effort
  note?: string
}

/** Effort options for an adapter. `where` is the connection's display name; a saved unsupported value stays selected as "xhigh (not used on OpenAI)". */
export function effortView(effort: Effort | undefined, adapter: ProviderId | null | undefined, where?: string): EffortView {
  const supported = effortOptionsFor(adapter)
  const options = [{ value: '', label: 'Default' }, ...supported.map((v) => ({ value: v as string, label: v as string }))]
  if (!effort || supported.includes(effort)) return { options }
  const name = where ?? (adapter === 'codex' ? 'OpenAI' : 'this provider')
  return {
    options: [...options, { value: effort, label: `${effort} (not used on ${name})` }],
    unsupported: effort,
    note: `${effort} is not used on ${name}; Default applies.`
  }
}
