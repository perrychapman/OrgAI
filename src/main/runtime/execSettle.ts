/**
 * Headless exec settlement (cli-spec 6.2(2)-(3)): when an `orgai exec` run is done, and how it ended. Pure; RunManager
 * (`trySettleExecRun`) gathers the inputs at a stable (rootTurnGen, activityGen) and finalizes with the result.
 */
import type { AgentInstance, AgentState, ExecOutcome, RunEndedBy, RunPlan } from '@shared/types'
import type { SessionSettlement } from './types'
import { ROOT_AGENT_ID } from './types'

/** Agent states that mean a report is still working (or waiting on a card). */
const WORKING_STATES: ReadonlySet<AgentState> = new Set<AgentState>(['starting', 'thinking', 'tool', 'waiting', 'delegating'])

/** A non-root agent that is still working. */
export function isWorkingReport(a: Pick<AgentInstance, 'id' | 'state'>): boolean {
  return a.id !== ROOT_AGENT_ID && WORKING_STATES.has(a.state)
}

export interface ExecSettleInput {
  /** session.settlement(); undefined = the adapter cannot report it, so the run never settles on its own. */
  settlement: SessionSettlement | undefined
  /** RunManager's own copy of the newest root turn generation (ctx.onRootTurnEnded). */
  rootTurnGen: number
  limitHold: boolean
  held: boolean
  agents: readonly Pick<AgentInstance, 'id' | 'state'>[]
  openCards: number
  inboxLength: number
  flushing: boolean
  plan: RunPlan | undefined
  /** ctx.autoContinue (already folded with planNudgesApply): the continuation driver may send the turn-1 nudge. */
  autoContinue: boolean
}

/** Why the run is not quiescent yet, or null when it is. For logs and tests. */
export function execNotQuiescentReason(i: ExecSettleInput): string | null {
  const s = i.settlement
  if (!s) return 'the adapter reports no settlement'
  if (i.rootTurnGen < 1) return 'no root turn has ended yet'
  if (!s.rootIdle) return 'the root is in a turn'
  if (s.rootTurnGen !== i.rootTurnGen) return 'the adapter is on another root turn'
  if (!s.continuationSettled) return 'the continuation check is pending'
  if (!s.quiescent) return 'the adapter has pending work'
  if (i.limitHold) return 'held on a usage limit'
  if (i.held) return 'held by an interrupt'
  if (i.agents.some(isWorkingReport)) return 'reports are working'
  if (i.openCards > 0) return 'a decision card is open'
  if (i.inboxLength > 0 || i.flushing) return 'peer messages are pending'
  // Turn-1 rule: a planned run with nudges on gets the set-plan nudge (and its follow-up turn) before it may end unplanned.
  if (i.plan === undefined && i.autoContinue && !s.nudgeTurn1Sent) return 'the set-plan nudge has not been sent'
  return null
}

export function execQuiescent(i: ExecSettleInput): boolean {
  return execNotQuiescentReason(i) === null
}

export interface ExecOutcomeInput {
  plan: RunPlan | undefined
  agents: readonly Pick<AgentInstance, 'worktree'>[]
  allowUnmerged?: boolean
}

/** The outcome of a quiescent exec run and the endedBy it records (spec 6.2(3) table). */
export function execOutcomeFor(i: ExecOutcomeInput): { outcome: ExecOutcome; endedBy?: RunEndedBy } {
  const plan = i.plan
  if (!plan) return { outcome: 'completed-unplanned' }
  if (plan.status === 'blocked') return { outcome: 'blocked', endedBy: 'policy' }
  // 'active' is incomplete even with no steps left: complete_plan was never called.
  if (plan.status !== 'done') return { outcome: 'incomplete-plan', endedBy: 'policy' }
  if (!i.allowUnmerged && i.agents.some((a) => a.worktree?.status === 'conflict')) return { outcome: 'unmerged-conflicts', endedBy: 'policy' }
  return { outcome: 'completed' }
}

/** The endedBy a finalized outcome records when the caller gives none (spec 6.2(3) table). */
export function defaultEndedBy(outcome: ExecOutcome): RunEndedBy | undefined {
  switch (outcome) {
    case 'unmerged-conflicts':
    case 'blocked':
    case 'incomplete-plan':
    case 'needs-decision':
    case 'stalled':
      return 'policy'
    case 'budget-exceeded':
      return 'budget'
    case 'interrupted':
      return 'user'
    default:
      return undefined
  }
}
