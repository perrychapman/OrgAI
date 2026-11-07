/**
 * Props every Usage page panel takes (docs/design/usage-app.md sections 6, 7). UsageView owns the state and passes
 * these down; panels never read the store's usage filters themselves, so a panel renders from its props alone.
 */
import type { UsageOverview } from '@shared/types'
import type { PeriodSpan, UsageBucket, UsageData, UsageFilters, UsageNarrowing } from '../../lib/usageOverview'

/** "Runs worth a look" sort (6.6). 'no-result' is the default when the data carries noResultCostUsd. */
export type WastefulSort = 'no-result' | 'cost' | 'cache' | 'retries' | 'nudges' | 'idle'

/** Efficiency instruments (6.5), also their data-signal values. */
export type EfficiencySignal = 'cache' | 'cost-per-run' | 'tokens-per-turn' | 'retries' | 'no-result' | 'nudges' | 'idle' | 'team-vs-ask'

export interface UsagePanelProps {
  /** The data under every filter and narrowing (lib/usageOverview.ts usageData). */
  data: UsageData
  /** The overview as main answered it (for connection names, truncation, the query main ran). */
  overview: UsageOverview
  filters: UsageFilters
  /** The bucket in force (effectiveBucket). */
  bucket: UsageBucket
  span: PeriodSpan
  /** Project id -> series index 0..4 (s1..s5); absent = folded into "Other". Stable while the period is unchanged. */
  series: ReadonlyMap<string, number>
  /** Apply a drilldown narrowing (7.1). The view adds the chip, refetches when needed, announces and keeps focus. */
  onNarrow: (n: UsageNarrowing) => void
  /** Say one sentence through the page's polite region (usage-live); at most one per 2 s, the view joins. */
  announce: (text: string) => void
}
