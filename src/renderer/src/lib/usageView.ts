import type { AgentInstance, AgentUsage, RunUsage, TokenUsage } from '@shared/types'
import { agentProducedNothing, cacheHitRate, totalTokens } from '@shared/defaults'
import { agentCostInput, formatDuration, formatTokens, type CostInput } from './cost'

/** A waiting share at or above this (and at least WAITING_MIN_MS) is called out. */
export const WAITING_SHARE = 0.25
export const WAITING_MIN_MS = 30_000

export interface TokenRow {
  kind: 'input' | 'output' | 'cacheRead' | 'cacheWrite'
  label: string
  value: number
  text: string
}

const TOKEN_LABELS: Record<TokenRow['kind'], string> = {
  input: 'Input',
  output: 'Output',
  cacheRead: 'Cache read',
  cacheWrite: 'Cache write'
}

/** The four token kinds in display order. */
export function tokenRows(t: TokenUsage): TokenRow[] {
  return (['input', 'output', 'cacheRead', 'cacheWrite'] as const).map((kind) => ({
    kind,
    label: TOKEN_LABELS[kind],
    value: t[kind],
    text: formatTokens(t[kind])
  }))
}

/** "72%" or "—" without prompt tokens. */
export function formatHitRate(t: TokenUsage): string {
  const r = cacheHitRate(t)
  return r === null ? '—' : `${Math.round(r * 100)}%`
}

export interface AgentRow {
  id: string
  name: string
  roleSlug: string
  tokens: TokenUsage
  total: number
  cost: CostInput
  turns: number
  toolCalls: number
  retries: number
  producedNothing: boolean
  legacy: boolean
  /** No usage block: numbers come from the old input/output counters. */
  approximate: boolean
}

/** One agent as a table row. An agent with no usage block falls back to its counters and is marked approximate. */
export function agentRow(agent: AgentInstance): AgentRow {
  const u: AgentUsage | undefined = agent.usage
  const tokens: TokenUsage = u ? u.tokens : { input: agent.inputTokens, output: agent.outputTokens, cacheRead: 0, cacheWrite: 0 }
  return {
    id: agent.id,
    name: agent.name,
    roleSlug: agent.roleSlug,
    tokens,
    total: totalTokens(tokens),
    cost: agentCostInput(agent),
    turns: u?.turns ?? 0,
    toolCalls: u?.toolCalls ?? 0,
    retries: u?.retries ?? 0,
    producedNothing: u?.producedNothing === true || agentProducedNothing(agent),
    legacy: u?.legacy === true,
    approximate: !u || u.legacy === true
  }
}

/** Agent rows, most tokens first (ties by name). */
export function agentRows(agents: Record<string, AgentInstance> | AgentInstance[]): AgentRow[] {
  const list = Array.isArray(agents) ? agents : Object.values(agents)
  return list.map(agentRow).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Plain-sentence efficiency signals for a whole run. Empty when nothing stands out. */
export function runSignals(u: RunUsage): string[] {
  const out: string[] = []
  if (u.agentsWithoutResult > 0) {
    out.push(`${plural(u.agentsWithoutResult, 'agent', 'agents')} spent ${formatTokens(u.noResultTokens)} tokens and produced no result.`)
  }
  if (u.retries > 0) out.push(`${plural(u.retries, 'API retry', 'API retries')} slowed the run down.`)
  if (u.waitingMs >= WAITING_MIN_MS && u.wallMs > 0 && u.waitingMs / u.wallMs >= WAITING_SHARE) {
    out.push(`${Math.round((u.waitingMs / u.wallMs) * 100)}% of the run (${formatDuration(u.waitingMs)}) was spent waiting on decisions.`)
  }
  if (u.limitHoldMs > 0) out.push(`Held ${formatDuration(u.limitHoldMs)} on a usage limit.`)
  if (u.nudges > 0) out.push(`The harness sent ${plural(u.nudges, 'automatic continue', 'automatic continues')}.`)
  return out
}

/** Signals for one agent. */
export function agentSignals(row: AgentRow): string[] {
  const out: string[] = []
  if (row.producedNothing) out.push(`Ended without a result; its ${formatTokens(row.total)} tokens produced nothing.`)
  if (row.retries > 0) out.push(`${plural(row.retries, 'API retry', 'API retries')}.`)
  return out
}

export interface TimeRow {
  id: 'wall' | 'waiting' | 'limit' | 'idle'
  label: string
  text: string
}

/** Wall time always; waiting, limit hold and idle only when non-zero. */
export function timeRows(u: RunUsage): TimeRow[] {
  const rows: TimeRow[] = [{ id: 'wall', label: 'Wall time', text: formatDuration(u.wallMs) }]
  if (u.waitingMs > 0) rows.push({ id: 'waiting', label: 'Waiting on you', text: formatDuration(u.waitingMs) })
  if (u.limitHoldMs > 0) rows.push({ id: 'limit', label: 'Usage limit hold', text: formatDuration(u.limitHoldMs) })
  if (u.idleMs > 0) rows.push({ id: 'idle', label: 'Idle', text: formatDuration(u.idleMs) })
  return rows
}

/** Role rollup rows, most tokens first; a role whose agents all produced nothing is dimmed. */
export function roleRows(u: RunUsage): Array<{ key: string; name: string; agents: number; total: number; dim: boolean; role: RunUsage['roles'][number] }> {
  return u.roles
    .map((role) => ({
      key: role.roleId ?? `slug:${role.roleSlug}`,
      name: role.roleName || role.roleSlug,
      agents: role.agents,
      total: totalTokens(role.tokens),
      dim: role.agents > 0 && role.agentsWithoutResult >= role.agents,
      role
    }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
}
