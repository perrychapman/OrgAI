import type { AgentInstance, RunEvent, RunSummary } from './types'

type DelegationEvent = Extract<RunEvent, { type: 'run.delegation' }>

/**
 * Apply a `run.delegation` event: the summary field is replaced and every listed agent gets its `delegation`
 * (agents the event does not list, or the run does not have, are untouched). Pure; shared by the renderer and TUI stores.
 */
export function applyRunDelegation<A extends Pick<AgentInstance, 'delegation'>>(
  summary: RunSummary,
  agents: Record<string, A>,
  e: Pick<DelegationEvent, 'summary' | 'agents'>
): { summary: RunSummary; agents: Record<string, A> } {
  let next = agents
  for (const [id, delegation] of Object.entries(e.agents ?? {})) {
    const agent = agents[id]
    if (!agent) continue
    if (next === agents) next = { ...agents }
    next[id] = { ...agent, delegation }
  }
  return { summary: { ...summary, delegation: e.summary }, agents: next }
}

export type DelegationBadgeKind = 'failed' | 'corrected' | 'native'

/** The badges an agent shows, in order. `failed` = skipped required reports. */
export function delegationBadges(d: AgentInstance['delegation']): DelegationBadgeKind[] {
  if (!d) return []
  const out: DelegationBadgeKind[] = []
  if (d.verdict === 'failed') out.push('failed')
  if (d.corrected) out.push('corrected')
  if (d.nativeSpawns > 0) out.push('native')
  return out
}

export const DELEGATION_BADGE_LABEL: Record<DelegationBadgeKind, string> = {
  failed: 'Skipped required reports',
  corrected: 'Corrected',
  native: 'Used native agents'
}

/** Short TUI wording. */
export const DELEGATION_BADGE_SHORT: Record<DelegationBadgeKind, string> = {
  failed: 'skipped reports',
  corrected: 'corrected',
  native: 'native agents'
}
