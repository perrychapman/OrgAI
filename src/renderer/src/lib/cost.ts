import type { AgentInstance, CostSource, RunSummary } from '@shared/types'

export { formatTokens } from './layout'

/** The cost facts every aggregate carries (AgentUsage, RunUsage, RoleUsage, UsageTrendPoint-like totals). */
export interface CostInput {
  /** null = unknown (tokens spent, no price). Never shown as $0. */
  costUsd: number | null
  costSource: CostSource
  /** Some models had no price: costUsd is a lower bound. */
  costPartial?: boolean
  /** Recorded before usage tracking: approximate. */
  legacy?: boolean
}

export interface CostView {
  /** "$0.42", "$0.42+", "unknown" or "—". */
  text: string
  /** Tooltip explaining the figure; empty when there is nothing to add. */
  title: string
  kind: 'known' | 'partial' | 'unknown' | 'none'
  /** Nothing spent yet (callers may omit the figure). */
  empty: boolean
}

export const COST_TITLES = {
  provider: 'Reported by the provider',
  computed: 'Computed by OrgAI from model prices',
  unknown: 'Cost unknown: no price is known for the model used. Tokens are still counted.',
  none: 'Nothing spent yet',
  legacy: 'Recorded before usage tracking; approximate.'
} as const

/** "$0.00", "$0.0042" (under a cent), "$12.50". */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

/** Describes one cost figure. The single place cost wording lives. */
export function costView(input: CostInput): CostView {
  const { costUsd, costSource } = input
  const legacy = input.legacy ? ` ${COST_TITLES.legacy}` : ''
  if (costSource === 'none' && (costUsd === null || costUsd === 0)) {
    return { text: '—', title: COST_TITLES.none, kind: 'none', empty: true }
  }
  if (costUsd === null || costSource === 'unknown') {
    return { text: 'unknown', title: COST_TITLES.unknown + legacy, kind: 'unknown', empty: false }
  }
  const how = costSource === 'computed' ? COST_TITLES.computed : COST_TITLES.provider
  if (input.costPartial) {
    return {
      text: `${formatUsd(costUsd)}+`,
      title: `At least ${formatUsd(costUsd)}: some models have no known price. ${how}.${legacy}`,
      kind: 'partial',
      empty: false
    }
  }
  return { text: formatUsd(costUsd), title: how + (input.legacy ? '.' : '') + legacy, kind: 'known', empty: false }
}

/** An agent's cost: its usage when present, else the mirrored costUsd (a 0 means nothing spent, not unknown). */
export function agentCostInput(agent: Pick<AgentInstance, 'costUsd' | 'usage'>): CostInput {
  if (agent.usage) return agent.usage
  return agent.costUsd > 0 ? { costUsd: agent.costUsd, costSource: 'provider' } : { costUsd: 0, costSource: 'none' }
}

/** A run's cost: its usage when present, else totalCostUsd. */
export function runCostInput(run: Pick<RunSummary, 'totalCostUsd' | 'usage'>): CostInput {
  if (run.usage) return run.usage
  return run.totalCostUsd > 0 ? { costUsd: run.totalCostUsd, costSource: 'provider' } : { costUsd: 0, costSource: 'none' }
}

/**
 * Adds cost figures. Unknown parts make the sum partial (a lower bound) when anything else is known, unknown when
 * nothing is. Any computed part makes the source computed.
 */
export function sumCosts(inputs: CostInput[]): CostInput {
  let known = 0
  let anyKnown = false
  let anyUnknown = false
  let partial = false
  let computed = false
  let legacy = false
  for (const c of inputs) {
    if (c.legacy) legacy = true
    if (c.costSource === 'none' && !c.costUsd) continue
    if (c.costUsd === null || c.costSource === 'unknown') {
      anyUnknown = true
      continue
    }
    anyKnown = true
    known += c.costUsd
    if (c.costPartial) partial = true
    if (c.costSource === 'computed') computed = true
  }
  const base = { ...(legacy ? { legacy: true } : {}) }
  if (!anyKnown && !anyUnknown) return { costUsd: 0, costSource: 'none', ...base }
  if (!anyKnown) return { costUsd: null, costSource: 'unknown', ...base }
  return { costUsd: known, costSource: computed ? 'computed' : 'provider', ...(partial || anyUnknown ? { costPartial: true } : {}), ...base }
}

/** "1m 20s", "45s", "2h 05m" for a duration in ms. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
