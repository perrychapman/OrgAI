import type { AgentInstance, AgentState } from '@shared/types'
import { agentProducedNothing } from '@shared/defaults'

/**
 * The activity words an agent shows, shared by the canvas node (AgentNode) and the Dashboard's Right now band so the
 * two never drift (docs/design/dashboard-2.md 6.6). Pure. The streaming `partial` text stays canvas-only.
 */

type Worktree = NonNullable<AgentInstance['worktree']>

export const WORKTREE_LABEL: Record<Worktree['status'], string> = {
  active: 'isolated worktree',
  merging: 'merging…',
  merged: 'merged',
  empty: 'no changes',
  conflict: 'merge conflict',
  removed: 'worktree removed',
  review: 'awaiting your review',
  held: 'held for later',
  'waiting-children': 'waiting for its reports'
}

/** Nested reports merge into their parent's branch, not the main checkout. */
export function worktreeLabel(wt: Pick<Worktree, 'status' | 'mergeTarget'>): string {
  if (wt.mergeTarget === 'parent' && wt.status === 'merged') return 'merged into parent'
  return WORKTREE_LABEL[wt.status]
}

const WORKING: ReadonlySet<AgentState> = new Set<AgentState>(['starting', 'thinking', 'tool', 'delegating'])

/** Starting, thinking, using a tool or delegating. */
export function isWorkingAgent(state: AgentState): boolean {
  return WORKING.has(state)
}

/** Ended without result text: its tokens bought nothing. The root speaks the answer, so it is never flagged. */
export function agentNoResult(agent: Pick<AgentInstance, 'id' | 'usage' | 'state' | 'result' | 'parentId'>, isRoot: boolean): boolean {
  return !isRoot && agent.id !== 'root' && (!!agent.usage?.producedNothing || agentProducedNothing(agent))
}

/**
 * The activity line: "Ended without a result" for a non-root agent whose tokens bought nothing; "Waiting for your
 * reply" for an idle root (an idle run is not a pending decision: "Waiting for you" is for a card); else the agent's own
 * activity string.
 */
export function nodeActivity(agent: AgentInstance, opts: { isRoot: boolean }): string {
  if (agentNoResult(agent, opts.isRoot)) return 'Ended without a result'
  if (opts.isRoot && agent.state === 'idle' && agent.activity === 'Waiting for you') return 'Waiting for your reply'
  return agent.activity
}
