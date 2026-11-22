import type { ModelTier } from '@shared/types'

/**
 * Plain-language tier words (UI overhaul, owner decision 8: "Fast / Standard / Most capable"). The app has four tiers, so
 * the one between Standard and Most capable reads "Advanced". The stored values (`fast`, `everyday`, `deep`, `top`) and
 * the shared MODEL_TIER_OPTIONS labels are unchanged; this is the renderer's wording for the Team editor, import and kit.
 */
export const PLAIN_TIER_WORD: Record<ModelTier, string> = {
  fast: 'Fast',
  everyday: 'Standard',
  deep: 'Advanced',
  top: 'Most capable'
}

/** Ordered as a choice from cheapest to most capable (the Model segmented control and selects). */
export const PLAIN_TIER_ORDER: readonly ModelTier[] = ['fast', 'everyday', 'deep', 'top']
