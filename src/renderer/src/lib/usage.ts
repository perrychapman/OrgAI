import type { ConnectionId, UsageSpend, UsageStatus } from '@shared/types'

export const CONNECTION_LABEL: Record<ConnectionId, string> = { anthropic: 'Claude', openai: 'Codex', litellm: 'LiteLLM' }

export const WARN_AT = 80

export type SpendLevel = '' | 'warn' | 'danger'

/** The connection whose figures the account row shows: the open project's, else the app default, else Anthropic. */
export function currentConnection(projectConnection: ConnectionId | null | undefined, defaultConnection: ConnectionId | null | undefined): ConnectionId {
  return projectConnection ?? defaultConnection ?? 'anthropic'
}

/** Connections in popover order: the current one first, then the others that reported something. */
export function connectionOrder(current: ConnectionId, byConnection: Partial<Record<ConnectionId, UsageStatus>>): ConnectionId[] {
  const all: ConnectionId[] = ['anthropic', 'openai', 'litellm']
  return [current, ...all.filter((c) => c !== current && byConnection[c]?.available)]
}

export function spendPct(spend: UsageSpend): number | null {
  if (spend.budgetUsd === null || spend.budgetUsd <= 0) return null
  return (spend.usd / spend.budgetUsd) * 100
}

export function spendLevel(spend: UsageSpend): SpendLevel {
  const pct = spendPct(spend)
  if (pct === null) return ''
  if (pct >= 100) return 'danger'
  return pct >= WARN_AT ? 'warn' : ''
}

export function money(usd: number): string {
  return `$${usd.toFixed(2)}`
}

/** "$42.10 of $50.00" or "$42.10 spent". */
export function spendText(spend: UsageSpend): string {
  if (spend.budgetUsd === null) return `${money(spend.usd)} spent`
  return `${money(spend.usd)} of ${money(spend.budgetUsd)}`
}

/** Sidebar label for a LiteLLM report. */
export function spendLabel(spend: UsageSpend): string {
  return `LiteLLM · ${spendText(spend)}`
}

export function spendAria(spend: UsageSpend): string {
  const pct = spendPct(spend)
  return pct === null ? `LiteLLM spend ${money(spend.usd)}, no budget set` : `LiteLLM spend ${Math.round(pct)} percent of budget`
}
