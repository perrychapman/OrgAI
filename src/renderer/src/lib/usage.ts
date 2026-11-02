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

/** Sidebar label for a LiteLLM report. */
export function spendLabel(spend: UsageSpend): string {
  return `LiteLLM · ${spendText(spend)}`
}

export function spendAria(spend: UsageSpend): string {
  const pct = spendPct(spend)
  return pct === null ? `LiteLLM spend ${money(spend.usd)}, no budget set` : `LiteLLM spend ${Math.round(pct)} percent of budget`
}
