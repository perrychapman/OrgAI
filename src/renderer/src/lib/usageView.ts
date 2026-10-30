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
  /** How the row names the agent: its handle (implementer-2), else role-slug plus an index when several share a role, else its name. */
  label: string
  /** Second line: the role name when the label differs from it. */
  sub?: string
  isRoot: boolean
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
  const isRoot = agent.id === 'root' || !agent.parentId
  return {
    id: agent.id,
    name: agent.name,
    label: agent.handle ?? agent.name,
    sub: agent.handle && agent.handle !== agent.name ? agent.name : undefined,
    isRoot,
    roleSlug: agent.roleSlug,
    tokens,
    total: totalTokens(tokens),
    cost: agentCostInput(agent),
    turns: u?.turns ?? 0,
    toolCalls: u?.toolCalls ?? 0,
    retries: u?.retries ?? 0,
    // The orchestrator speaks the answer; it is never counted as producing nothing.
    producedNothing: !isRoot && (u?.producedNothing === true || agentProducedNothing(agent)),
    legacy: u?.legacy === true,
    approximate: !u || u.legacy === true
  }
}

/** Agent rows, most tokens first (ties by name). */
export function agentRows(agents: Record<string, AgentInstance> | AgentInstance[]): AgentRow[] {
  const list = Array.isArray(agents) ? agents : Object.values(agents)
  const rows = list.map(agentRow)
  // Agents without a handle that share a role get role-slug-N (spawn order) so two rows never read the same.
  const bySlug = new Map<string, AgentInstance[]>()
  for (const a of list) if (!a.handle) bySlug.set(a.roleSlug, [...(bySlug.get(a.roleSlug) ?? []), a])
  for (const r of rows) {
    const same = bySlug.get(r.roleSlug)
    if (!same || same.length < 2 || r.label !== r.name) continue
    const n = [...same].sort((x, y) => x.startedAt - y.startedAt).findIndex((a) => a.id === r.id) + 1
    r.label = `${r.roleSlug}-${n}`
    r.sub = r.name
  }
  return rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Plain-sentence efficiency signals for a whole run. Empty when nothing stands out. */
export function runSignals(u: RunUsage, rows?: readonly AgentRow[]): string[] {
  const out: string[] = []
  // With the agent rows at hand the count is taken here and never includes the root.
  const idle = rows ? rows.filter((r) => !r.isRoot && r.producedNothing) : undefined
  const without = idle ? idle.length : u.agentsWithoutResult
  const wasted = idle ? idle.reduce((n, r) => n + r.total, 0) : u.noResultTokens
  if (without > 0) {
    out.push(`${plural(without, 'agent', 'agents')} spent ${formatTokens(wasted)} tokens and produced no result.`)
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
export function roleRows(u: RunUsage, rows?: readonly AgentRow[]): Array<{ key: string; name: string; agents: number; total: number; dim: boolean; role: RunUsage['roles'][number] }> {
  return u.roles
    .map((role) => {
      // Dim only a role whose non-root agents all produced nothing.
      const mine = rows?.filter((r) => r.roleSlug === role.roleSlug && !r.isRoot)
      return { role, dim: mine ? mine.length > 0 && mine.every((r) => r.producedNothing) : role.agents > 0 && role.agentsWithoutResult >= role.agents }
    })
    .map(({ role, dim }) => ({
      key: role.roleId ?? `slug:${role.roleSlug}`,
      name: role.roleName || role.roleSlug,
      agents: role.agents,
      total: totalTokens(role.tokens),
      dim,
      role
    }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
}

export interface SkillRow {
  skillId: string
  name: string
  loads: number
  /** "3 loads" / "1 load". */
  loadsText: string
  /** Role slugs as plain text, "" when unknown. */
  roles: string
}

/** RunUsage.skills as rows, most loaded first. Empty when the run loaded none. */
export function skillRows(u: Pick<RunUsage, 'skills'>): SkillRow[] {
  return [...(u.skills ?? [])]
    .filter((s) => s.loads > 0)
    .sort((a, b) => b.loads - a.loads || a.name.localeCompare(b.name))
    .map((s) => ({ skillId: s.skillId, name: s.name, loads: s.loads, loadsText: `${s.loads} ${s.loads === 1 ? 'load' : 'loads'}`, roles: s.roles.join(', ') }))
}
