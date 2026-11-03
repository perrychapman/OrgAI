import type { Effort, ModelFamily, ModelRef, ModelTier, ProviderId, ProviderModel, Role } from '@shared/types'
import { MODEL_TIER_OPTIONS } from '@shared/types'
import { effortOptionsFor } from '@shared/defaults'
import { groupByFamily, FAMILY_LABEL, roleTier } from './remap'

type TierModels = Partial<Record<ModelTier, ModelRef>>

export const TIER_LABEL = Object.fromEntries(MODEL_TIER_OPTIONS.map((o) => [o.value, o.label])) as Record<ModelTier, string>

/** The Model select's value for a role: 'inherit', a tier word, or 'custom' (an exact model that is no tier's model). */
export type RoleModelChoice = 'inherit' | ModelTier | 'custom'

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

/** The fold summary: the tier label, "Inherited" or "Custom". */
export function roleModelSummary(role: Pick<Role, 'model' | 'tier'>, tierModels: TierModels): string {
  const choice = roleModelChoice(role, tierModels)
  if (choice === 'inherit') return 'Inherited'
  if (choice === 'custom') return 'Custom'
  return TIER_LABEL[choice]
}

/** What picking a Model option writes: inherit, or the tier's model with the tier recorded. */
export function applyModelChoice(choice: string, tierModels: TierModels): { model: ModelRef; tier: ModelTier | undefined } | null {
  if (choice === 'inherit') return { model: 'inherit', tier: undefined }
  const tier = MODEL_TIER_OPTIONS.find((o) => o.value === choice)?.value
  const model = tier ? tierModels[tier] : undefined
  return tier && model ? { model, tier } : null
}

/** What picking an exact model writes: the id, with the tier it happens to be (if any). '' goes back to inherit. */
export function applyExactModel(value: string, tierModels: TierModels): { model: ModelRef; tier: ModelTier | undefined } {
  if (!value) return { model: 'inherit', tier: undefined }
  return { model: value, tier: MODEL_TIER_OPTIONS.find((o) => tierModels[o.value] === value)?.value }
}

export interface ExactGroup {
  label?: string
  options: { value: string; label: string; disabled?: boolean }[]
}

/**
 * Concrete ids for the Advanced "Exact model" select. A LiteLLM project lists the whole proxy catalog grouped by
 * family (other roles may run any model the proxy serves); other connections list their catalog in one group.
 */
export function exactModelGroups(catalog: readonly ProviderModel[], litellm: boolean, current: ModelRef): ExactGroup[] {
  const option = (m: ProviderModel): { value: string; label: string } => ({ value: m.id, label: m.recommended ? `${m.id} (recommended)` : m.id })
  const groups: ExactGroup[] = litellm
    ? groupByFamily(catalog).map((g) => ({ label: FAMILY_LABEL[g.family as ModelFamily], options: g.models.map(option) }))
    : catalog.length > 0
      ? [{ label: 'Models', options: catalog.map(option) }]
      : []
  const known = current === 'inherit' || catalog.some((m) => m.id === current)
  const lead: ExactGroup[] = [{ options: [{ value: '', label: 'Not set (use Model above)' }] }]
  if (!known) lead.push({ options: [{ value: current, label: `${current} (unavailable)`, disabled: true }] })
  return [...lead, ...groups]
}

export interface EffortView {
  options: { value: string; label: string }[]
  /** A saved effort the adapter does not use; it stays selected and is explained. */
  unsupported?: Effort
  note?: string
}

/** Effort options for an adapter. A saved unsupported value stays selected as "xhigh (not used on OpenAI)". */
export function effortView(effort: Effort | undefined, adapter: ProviderId | null | undefined): EffortView {
  const supported = effortOptionsFor(adapter)
  const options = [{ value: '', label: 'Default' }, ...supported.map((v) => ({ value: v as string, label: v as string }))]
  if (!effort || supported.includes(effort)) return { options }
  const where = adapter === 'codex' ? 'OpenAI' : 'this adapter'
  return {
    options: [...options, { value: effort, label: `${effort} (not used on ${where})` }],
    unsupported: effort,
    note: `${effort} is ignored on ${where}; Default applies.`
  }
}
