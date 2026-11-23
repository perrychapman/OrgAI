/**
 * Pure helpers for the run canvas chrome that has to stay readable with many agents (docs/design/ui-overhaul, Scale
 * board): the counts behind the "Show" filter, the search, the "needs you first" order and the grouping by the lead an
 * agent sits under. No store, no React. The agent list, the filter and the canvas dimming all read these, so they
 * agree on what "waiting" and "working" mean.
 */
import type { AgentInstance } from '@shared/types'
import { isWorkingAgent } from './agentActivity'
import { agentLabel, ancestorsOf } from './agentTree'

/** The one bucket an agent counts in. 'other' is idle, which is neither working nor finished. */
export type AgentBucket = 'waiting' | 'working' | 'failed' | 'other' | 'done'

export type AgentFilterValue = 'all' | 'working' | 'waiting' | 'done'

export type AgentSortMode = 'needs' | 'name' | 'group'

export interface AgentCounts {
  all: number
  working: number
  waiting: number
  done: number
  failed: number
}

/** The structural slice of a run's open decisions that names an agent. */
export interface DecisionAgents {
  permissions?: readonly { agentId: string }[]
  questions?: readonly { agentId: string }[]
  ruleRequests?: readonly { agentId: string }[]
  mergeReviews?: readonly { agentId: string }[]
  mcpInstalls?: readonly { agentId: string }[]
}

/** The ids of the agents a decision is waiting on (a card names its agent). Plans and proposals name none. */
export function waitingAgentIds(run: DecisionAgents): Set<string> {
  const ids = new Set<string>()
  for (const list of [run.permissions, run.questions, run.ruleRequests, run.mergeReviews, run.mcpInstalls]) {
    for (const item of list ?? []) ids.add(item.agentId)
  }
  return ids
}

/** Waiting wins over working: an agent with an open card is waiting on you even while its state still reads "tool". */
export function agentBucket(agent: Pick<AgentInstance, 'id' | 'state'>, waiting: ReadonlySet<string>): AgentBucket {
  if (waiting.has(agent.id) || agent.state === 'waiting') return 'waiting'
  if (isWorkingAgent(agent.state)) return 'working'
  if (agent.state === 'error') return 'failed'
  if (agent.state === 'done') return 'done'
  return 'other'
}

export function agentCounts(agents: readonly AgentInstance[], waiting: ReadonlySet<string>): AgentCounts {
  const counts: AgentCounts = { all: agents.length, working: 0, waiting: 0, done: 0, failed: 0 }
  for (const a of agents) {
    const b = agentBucket(a, waiting)
    if (b === 'working') counts.working++
    else if (b === 'waiting') counts.waiting++
    else if (b === 'done') counts.done++
    else if (b === 'failed') counts.failed++
  }
  return counts
}

/** The "Show" filter: All, or one bucket. */
export function matchesAgentFilter(agent: Pick<AgentInstance, 'id' | 'state'>, filter: AgentFilterValue, waiting: ReadonlySet<string>): boolean {
  return filter === 'all' || agentBucket(agent, waiting) === filter
}

/**
 * Case-insensitive search over what a person can see on a row: the name, the handle (as agentLabel shows it), the role
 * slug and the current activity text. `extra` adds more haystack text (the list passes the group name).
 */
export function matchesAgentQuery(agent: Pick<AgentInstance, 'name' | 'handle' | 'roleSlug' | 'activity'>, query: string, extra: readonly string[] = []): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hay = [agent.name, agentLabel(agent), agent.roleSlug, agent.activity, ...extra]
  return hay.some((h) => !!h && h.toLowerCase().includes(q))
}

const RANK: Record<AgentBucket, number> = { waiting: 0, working: 1, failed: 2, other: 3, done: 4 }

function byName(a: AgentInstance, b: AgentInstance): number {
  return agentLabel(a).localeCompare(agentLabel(b), undefined, { numeric: true, sensitivity: 'base' }) || a.id.localeCompare(b.id)
}

/** The lead an agent sits under: the ancestor right below the root. Undefined for a root (no ancestor above it). */
export function groupLeadId(byId: Record<string, AgentInstance>, id: string): string | undefined {
  const up = ancestorsOf(byId, id)
  if (up.length === 0) return undefined
  // up = [parent, ..., root]; the group lead is the one before the root, or the agent itself when its parent is the root.
  return up.length === 1 ? id : up[up.length - 2]
}

/** The group name of every agent (the lead's label); a root has none. Computed once per list. */
export function groupLabels(agents: readonly AgentInstance[]): Map<string, string | undefined> {
  const byId: Record<string, AgentInstance> = {}
  for (const a of agents) byId[a.id] = a
  const out = new Map<string, string | undefined>()
  for (const a of agents) {
    const lead = groupLeadId(byId, a.id)
    out.set(a.id, lead ? agentLabel(byId[lead]) : undefined)
  }
  return out
}

/**
 * "Needs you first": waiting, working, failed, idle, done last. Stable by name inside a bucket. `mode` 'name' ignores
 * the buckets; 'group' orders by group then name (an agent with no group, the root, first). Returns a new array.
 */
export function sortAgents(
  agents: readonly AgentInstance[],
  waiting: ReadonlySet<string>,
  mode: AgentSortMode = 'needs',
  groupOf?: (agent: AgentInstance) => string | undefined
): AgentInstance[] {
  const list = agents.slice()
  if (mode === 'name') return list.sort(byName)
  if (mode === 'group') {
    const g = (a: AgentInstance): string => groupOf?.(a) ?? ''
    return list.sort((a, b) => g(a).localeCompare(g(b), undefined, { numeric: true, sensitivity: 'base' }) || byName(a, b))
  }
  return list.sort((a, b) => RANK[agentBucket(a, waiting)] - RANK[agentBucket(b, waiting)] || byName(a, b))
}

export interface AgentGroup {
  /** The lead's agent id. */
  leadId: string
  /** The lead's label: what a row calls its group. */
  label: string
  /** The lead and everyone below it, needs-you first. */
  agents: AgentInstance[]
  counts: AgentCounts
}

/**
 * The run's groups: each direct report of the root with everything below it, so a 121-agent run reads as a handful of
 * groups. Roots themselves are returned apart (`roots`). Groups are ordered by what needs you most (a group with a
 * waiting agent first, then one with working agents), then by label.
 */
export function groupAgents(agents: readonly AgentInstance[], waiting: ReadonlySet<string>): { roots: AgentInstance[]; groups: AgentGroup[] } {
  const byId: Record<string, AgentInstance> = {}
  for (const a of agents) byId[a.id] = a
  const roots: AgentInstance[] = []
  const members = new Map<string, AgentInstance[]>()
  for (const a of agents) {
    const lead = groupLeadId(byId, a.id)
    if (!lead) {
      roots.push(a)
      continue
    }
    const list = members.get(lead)
    if (list) list.push(a)
    else members.set(lead, [a])
  }
  const groups: AgentGroup[] = [...members].map(([leadId, list]) => ({
    leadId,
    label: agentLabel(byId[leadId]),
    agents: sortAgents(list, waiting, 'needs'),
    counts: agentCounts(list, waiting)
  }))
  groups.sort((a, b) => b.counts.waiting - a.counts.waiting || b.counts.working - a.counts.working || a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }))
  return { roots, groups }
}

/** The sentence a screen reader gets for the counts: "16 agents: 7 working, 1 waiting for you". */
export function agentCountsLabel(c: AgentCounts): string {
  const parts = [`${c.working} working`, `${c.waiting} waiting for you`]
  if (c.done) parts.push(`${c.done} done`)
  if (c.failed) parts.push(`${c.failed} failed`)
  return `${c.all} ${c.all === 1 ? 'agent' : 'agents'}: ${parts.join(', ')}`
}
