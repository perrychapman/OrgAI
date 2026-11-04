import { connectionInUse } from '@shared/defaults'
import type { AppSettings, ConnectionId, ConnectionInfo, Project, UsageSpend, UsageStatus } from '@shared/types'

export const CONNECTION_LABEL: Record<ConnectionId, string> = { anthropic: 'Claude', openai: 'Codex', litellm: 'LiteLLM' }

export const WARN_AT = 80

export type SpendLevel = '' | 'warn' | 'danger'

/** The connection whose figures the account row shows: the open project's, else the app default, else Anthropic. */
export function currentConnection(projectConnection: ConnectionId | null | undefined, defaultConnection: ConnectionId | null | undefined): ConnectionId {
  return projectConnection ?? defaultConnection ?? 'anthropic'
}

const ALL_CONNECTIONS: ConnectionId[] = ['anthropic', 'openai', 'litellm']

/**
 * Connections in popover order: the current one always first, then each other connection that has an
 * available report AND is in use (enabled and the app default or some project's connection). A stale
 * report of a connection nobody uses never adds a section.
 */
export function connectionOrder(current: ConnectionId, byConnection: Partial<Record<ConnectionId, UsageStatus>>, inUse: (id: ConnectionId) => boolean): ConnectionId[] {
  return [current, ...ALL_CONNECTIONS.filter((c) => c !== current && byConnection[c]?.available && inUse(c))]
}

/**
 * The connections in use, by `connectionInUse` from the store's connection list, default connection and
 * projects. Before the list loads only Anthropic can count (the others are not known to be enabled).
 */
export function connectionsInUse(
  connections: readonly Pick<ConnectionInfo, 'connection'>[] | null | undefined,
  defaultConnection: ConnectionId | null | undefined,
  projects: readonly Pick<Project, 'provider'>[]
): Set<ConnectionId> {
  const records: Partial<AppSettings['connections']> = {}
  for (const c of connections ?? []) (records as Record<string, unknown>)[c.connection.id] = c.connection
  const settings = { defaultConnection: defaultConnection ?? 'anthropic', connections: records as AppSettings['connections'] }
  return new Set(ALL_CONNECTIONS.filter((id) => connectionInUse(id, settings, projects)))
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

/** Sidebar label for a LiteLLM report without period figures: the current budget text. */
export function spendLabel(spend: UsageSpend): string {
  return `LiteLLM · ${spendText(spend)}`
}

/** The bar's name: share of the key budget only (a "today" figure has no denominator). */
export function spendAria(spend: UsageSpend): string {
  const pct = spendPct(spend)
  return pct === null ? `LiteLLM spend ${money(spend.usd)}, no budget set` : `LiteLLM spend ${Math.round(pct)} percent of budget`
}

export type SpendPeriodKey = 'day' | 'week' | 'month'

/** Row labels in the popover list, in display order. */
export const SPEND_PERIOD_LABEL: Record<SpendPeriodKey, string> = { day: 'Today', week: 'This week', month: 'This month' }

export const SPEND_PERIOD_ORDER: readonly SpendPeriodKey[] = ['day', 'week', 'month']

const PERIOD_WORD: Record<SpendPeriodKey, string> = { day: 'today', week: 'this week', month: 'this month' }

/** "$3.20 today", "$12.40 this week", "$31.00 this month". */
export function periodText(usd: number, period: SpendPeriodKey): string {
  return `${money(usd)} ${PERIOD_WORD[period]}`
}

/**
 * The one figure the account row and the Dashboard Usage row show: today's spend when the proxy reports periods,
 * else the current budget text. Never two figures (the row clips at 200 px, ux-review-litellm-periods.md M1).
 */
export function spendRowLabel(spend: UsageSpend): string {
  if (spend.periods) return `LiteLLM · ${periodText(spend.periods.day.usd, 'day')}`
  return spendLabel(spend)
}

/** "$42.10 of $50.00 budget." or "No budget set." */
function budgetSentence(spend: UsageSpend): string {
  return spend.budgetUsd === null ? 'No budget set.' : `${money(spend.usd)} of ${money(spend.budgetUsd)} budget.`
}

/**
 * The whole sentence for the account row's tooltip and the rail's accessible name:
 * "LiteLLM spend: $3.20 today, $12.40 this week, $31.00 this month. $42.10 of $50.00 budget."
 * Without periods: "LiteLLM spend: $42.10 of $50.00 budget." / "LiteLLM spend: $42.10. No budget set."
 */
export function spendSentence(spend: UsageSpend): string {
  const p = spend.periods
  if (!p) return spend.budgetUsd === null ? `LiteLLM spend: ${money(spend.usd)}. No budget set.` : `LiteLLM spend: ${budgetSentence(spend)}`
  return `LiteLLM spend: ${periodText(p.day.usd, 'day')}, ${periodText(p.week.usd, 'week')}, ${periodText(p.month.usd, 'month')}. ${budgetSentence(spend)}`
}

/** The Dashboard Usage card's second caption: "$12.40 this week · $31.00 this month". Empty without periods. */
export function periodsCaption(spend: UsageSpend): string {
  const p = spend.periods
  if (!p) return ''
  return `${periodText(p.week.usd, 'week')} · ${periodText(p.month.usd, 'month')}`
}

/**
 * The popover row's tooltip: "Since Mon 2 Nov (UTC)". Period starts are UTC calendar boundaries, so the date is
 * printed in UTC and says so (a local-time print would show the previous evening west of Greenwich).
 */
export function periodSince(since: number, locale?: string): string {
  const d = new Date(since)
  if (!Number.isFinite(d.getTime())) return ''
  return `Since ${d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })} (UTC)`
}

/** A quiet "Lifetime $X" line: only when the proxy reports a lifetime total that differs from the current budget period's spend. */
export function lifetimeText(spend: UsageSpend): string {
  const t = spend.totalUsd
  if (t === null || t === undefined || !Number.isFinite(t) || Math.abs(t - spend.usd) < 0.005) return ''
  return `Lifetime ${money(t)}`
}
