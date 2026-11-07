import type { AgentInstance, CostSource, ModelUsageEntry, RunSummary } from '@shared/types'

/** "950", "1.2k", "34k", "1.25M". Moved here from the renderer's layout.ts, which re-exports it. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** The cost facts every aggregate carries (AgentUsage, RunUsage, RoleUsage, UsageTrendPoint-like totals). */
export interface CostInput {
  /** null = unknown (tokens spent, no price). Never shown as $0. */
  costUsd: number | null
  costSource: CostSource
  /** Some models had no price: costUsd is a lower bound. */
  costPartial?: boolean
  /** Recorded before usage tracking: approximate. */
  legacy?: boolean
  /** An aggregate over runs of different sources: the tooltip says "reported or computed" instead of naming one. */
  sourceMixed?: boolean
  /** Per-model breakdown (AgentUsage / RunUsage / RoleUsage carry it); names the unpriced models in the tooltip. */
  models?: readonly (Pick<ModelUsageEntry, 'model' | 'costUsd' | 'priceSource'> | string)[]
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
  /** An aggregate (trends) that may mix provider-reported and computed costs. */
  mixed: 'Reported by the provider or computed by OrgAI from model prices',
  none: 'Nothing spent yet',
  legacy: 'Recorded before usage tracking; approximate.'
} as const

/**
 * One precision rule for every figure (rows and totals alike, so a total never rounds below its rows): 2 decimals from
 * $1 up; below $1 four significant digits with trailing zeros trimmed to at least 2 decimals ("$0.42", "$0.0057",
 * "$0.1257"); under $0.0001 "<$0.0001".
 */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd < 0.0001) return '<$0.0001'
  const digits = Math.min(8, Math.max(2, 3 - Math.floor(Math.log10(usd))))
  let t = usd.toFixed(digits)
  while (t.endsWith('0') && t.length - t.indexOf('.') - 1 > 2) t = t.slice(0, -1)
  return `$${t}`
}

/**
 * Cents precision for glanceable pages (the Dashboard, docs/design/dashboard-2.md 11): two decimals from $0.01 up,
 * "<$0.01" above zero and below a cent. The full figure stays in the tooltip.
 */
export function formatUsdCompact(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

/** Model ids with tokens but no known price (priceSource 'unknown' or a null cost), unique, in first-seen order. */
export function unpricedModels(models: CostInput['models']): string[] {
  const out: string[] = []
  for (const m of models ?? []) if (typeof m !== 'string' && (m.priceSource === 'unknown' || m.costUsd === null) && m.model && !out.includes(m.model)) out.push(m.model)
  return out
}

function unpricedNote(models: CostInput['models']): string {
  const ids = unpricedModels(models)
  return ids.length > 0 ? ` No price for ${ids.join(', ')}; set one in App settings > Connections > Model prices.` : ''
}

/**
 * Describes one cost figure. The single place cost wording lives. `compact` rounds the text to cents
 * (`formatUsdCompact`); the title keeps the full figure.
 */
export function costView(input: CostInput, opts?: { compact?: boolean }): CostView {
  const v = fullCostView(input)
  if (!opts?.compact || (v.kind !== 'known' && v.kind !== 'partial') || input.costUsd === null) return v
  const text = formatUsdCompact(input.costUsd) + (v.kind === 'partial' ? '+' : '')
  return text === v.text ? v : { ...v, text, title: `${formatUsd(input.costUsd)}${v.kind === 'partial' ? '+' : ''}. ${v.title}` }
}

function fullCostView(input: CostInput): CostView {
  const { costUsd, costSource } = input
  const legacy = input.legacy ? ` ${COST_TITLES.legacy}` : ''
  if (costSource === 'none' && (costUsd === null || costUsd === 0)) {
    return { text: '—', title: COST_TITLES.none, kind: 'none', empty: true }
  }
  if (costUsd === null || costSource === 'unknown') {
    return { text: 'unknown', title: COST_TITLES.unknown + unpricedNote(input.models) + legacy, kind: 'unknown', empty: false }
  }
  const how = costSource === 'computed' ? COST_TITLES.computed : input.sourceMixed ? COST_TITLES.mixed : COST_TITLES.provider
  if (input.costPartial) {
    return {
      text: `${formatUsd(costUsd)}+`,
      title: `At least ${formatUsd(costUsd)}: some models have no known price. ${how}.${unpricedNote(input.models)}${legacy}`,
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
  const models: NonNullable<CostInput['models']>[number][] = []
  for (const c of inputs) {
    if (c.legacy) legacy = true
    if (c.models) models.push(...c.models)
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
  const base = { ...(legacy ? { legacy: true } : {}), ...(models.length > 0 ? { models } : {}) }
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
