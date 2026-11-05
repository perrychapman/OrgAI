/**
 * The canvas of a session chain (docs/design/ux-review-continue.md, model 4): the newest member's agents are the live
 * nodes, the root carries the tokens and cost of every member, and each earlier member folds into one "Earlier: N
 * agents" group of settled agents. Pure: no store, no IPC.
 */
import type { AgentInstance, AgentUsage, RunEndedBy, RunSummary } from '@shared/types'
import { agentCostInput, sumCosts } from './cost'
import { settleEndedAgents } from './runStatus'

/** A loaded chain member as the canvas needs it. */
export interface ChainMemberView {
  summary: Pick<RunSummary, 'id' | 'status' | 'endedAt' | 'endedWithApp'> & { endedBy?: RunEndedBy }
  agents: Record<string, AgentInstance>
}

/** One earlier member's reports, settled and re-parented under the newest root. Ids are `${runId}/${agentId}`. */
export interface EarlierGroup {
  runId: string
  /** The key the view uses for the group node and its expanded state (not an agent id). */
  key: string
  label: string
  agents: AgentInstance[]
}

export interface ChainCanvas {
  /** The newest member's agents (settled when its run ended); the root's tokens and cost are summed over the chain. */
  agents: AgentInstance[]
  /** Earlier members' groups, oldest first; members without non-root agents are omitted. */
  earlier: EarlierGroup[]
  /** Prefixed earlier agent id -> where it came from. */
  origin: Map<string, { runId: string; agentId: string }>
  /** The id of the newest root agent (parent of every earlier group), when there is one. */
  rootId: string | undefined
}

export const EARLIER_PREFIX = 'earlier:'
/** The group key of an earlier member (used where a parent agent id would be). */
export const earlierKey = (runId: string): string => `${EARLIER_PREFIX}${runId}`
export const isEarlierKey = (key: string): boolean => key.startsWith(EARLIER_PREFIX)

export const earlierLabel = (n: number): string => `Earlier: ${n} agent${n === 1 ? '' : 's'}`

const rootOf = (agents: Record<string, AgentInstance>): AgentInstance | undefined => Object.values(agents).find((a) => a.parentId === null)

/**
 * `members` are the loaded chain members, oldest first; the last one is the newest (the viewed run). With a single
 * member the agents come back as the run holds them (settled when it ended).
 */
export function chainCanvas(members: readonly ChainMemberView[]): ChainCanvas {
  const newest = members[members.length - 1]
  if (!newest) return { agents: [], earlier: [], origin: new Map(), rootId: undefined }
  const settledNewest = settleEndedAgents(newest.summary, newest.agents)
  let agents = Object.values(settledNewest)
  const newestRoot = agents.find((a) => a.parentId === null)

  const earlier: EarlierGroup[] = []
  const origin = new Map<string, { runId: string; agentId: string }>()
  // Hold the earlier groups until the newest root exists: without it they would render as roots themselves.
  const before = newestRoot ? members.slice(0, -1) : []
  for (const m of before) {
    const settled = settleEndedAgents(m.summary, m.agents)
    const list: AgentInstance[] = []
    for (const a of Object.values(settled)) {
      if (a.parentId === null) continue
      const id = `${m.summary.id}/${a.id}`
      const parent = settled[a.parentId]
      const nested = !!parent && parent.parentId !== null
      list.push({ ...a, id, parentId: nested ? `${m.summary.id}/${a.parentId}` : (newestRoot as AgentInstance).id })
      origin.set(id, { runId: m.summary.id, agentId: a.id })
    }
    if (list.length > 0) earlier.push({ runId: m.summary.id, key: earlierKey(m.summary.id), label: earlierLabel(list.length), agents: list })
  }

  if (newestRoot && before.length > 0) {
    const roots = members.map((m) => rootOf(m.agents)).filter((a): a is AgentInstance => !!a)
    const cost = sumCosts(roots.map(agentCostInput))
    const base: AgentUsage = newestRoot.usage ?? {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      models: [],
      costUsd: 0,
      costSource: 'none',
      turns: 0,
      toolCalls: 0,
      retries: 0
    }
    const summed: AgentInstance = {
      ...newestRoot,
      inputTokens: roots.reduce((n, a) => n + a.inputTokens, 0),
      outputTokens: roots.reduce((n, a) => n + a.outputTokens, 0),
      costUsd: cost.costUsd ?? 0,
      usage: { ...base, costUsd: cost.costUsd, costSource: cost.costSource, ...(cost.costPartial ? { costPartial: true as const } : {}) }
    }
    agents = agents.map((a) => (a.id === newestRoot.id ? summed : a))
  }
  return { agents, earlier, origin, rootId: newestRoot?.id }
}
