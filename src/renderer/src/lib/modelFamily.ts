import type { ModelFamily, ProviderModel } from '@shared/types'

/** Plain words for a model's family in pickers: Claude, GPT, Other. */
export const FAMILY_WORD: Record<ModelFamily, string> = { claude: 'Claude', openai: 'GPT', other: 'Other' }
export const FAMILY_WORD_ORDER: ModelFamily[] = ['claude', 'openai', 'other']

/** True when the models span more than one family (then each option names its family). */
export function mixedFamilies(models: readonly Pick<ProviderModel, 'family'>[]): boolean {
  return new Set(models.map((m) => m.family)).size > 1
}

/** "Claude 3, GPT 4, Other 2": the per-family counts of a catalog, families with no model left out. */
export function familyCountsText(models: readonly Pick<ProviderModel, 'family'>[]): string {
  return FAMILY_WORD_ORDER.map((f) => [f, models.filter((m) => m.family === f).length] as const)
    .filter(([, n]) => n > 0)
    .map(([f, n]) => `${FAMILY_WORD[f]} ${n}`)
    .join(', ')
}

/**
 * One line on which URL the models go through, for a catalog that reports `baseUrl` per model and holds both Claude
 * and other-family models on different routes. undefined otherwise (a single route needs no explanation).
 */
export function routeHintFor(models: readonly Pick<ProviderModel, 'family' | 'baseUrl'>[]): string | undefined {
  const claude = models.find((m) => m.family === 'claude' && m.baseUrl)
  const rest = models.find((m) => m.family !== 'claude' && m.baseUrl)
  if (!claude || !rest || claude.baseUrl === rest.baseUrl) return undefined
  return 'Claude models use the Anthropic URL; GPT and other models use the OpenAI URL.'
}

/** A model option's text: "gemini-2.5-pro · Other" when the catalog mixes families, else the plain text. */
export function withFamily(text: string, family: ModelFamily, mixed: boolean): string {
  return mixed ? `${text} · ${FAMILY_WORD[family]}` : text
}
