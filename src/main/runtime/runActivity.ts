/**
 * What a live run is doing right now, for the host's activity and the desktop close prompt (review H3). Pure.
 *
 * - 'working': the run does work without the user: the root is in a turn, or it is idle while reports work, peer
 *   messages are queued, a continuation nudge is due or the adapter has work pending (an MCP restart, an integration).
 * - 'ending': its session is being stopped (status 'stopping'); short-lived.
 * - 'waiting': it only waits on the user: idle with nothing pending, a decision card open, held by an interrupt, or
 *   held on a usage limit (which lifts only on the user's next send).
 *
 * Paused runs are not live (they leave RunManager's run map); their auto-resume timers are counted separately
 * (RunManager.activeResumeTimerCount).
 */
import type { AgentInstance, RunSummary } from '@shared/types'
import { isWorkingReport } from './execSettle'
import type { SessionSettlement } from './types'

export type RunActivityState = 'working' | 'ending' | 'waiting'

export interface RunActivityInput {
  status: RunSummary['status']
  /** Decision cards open on the run (permission, proposal, question, merge review, install, rules). */
  openCards: number
  /** Held by the user's interrupt until their next send. */
  held: boolean
  /** Held on a usage-limit report until the user's next send. */
  limitHold: boolean
  agents: readonly Pick<AgentInstance, 'id' | 'state'>[]
  /** Peer messages queued for the run, or a flush in progress. */
  peerMessagesPending: boolean
  /** session.settlement(), when the adapter reports it. */
  settlement?: SessionSettlement
}

export function runActivityState(i: RunActivityInput): RunActivityState {
  if (i.status === 'stopping') return 'ending'
  if (i.status !== 'starting' && i.status !== 'running' && i.status !== 'idle') return 'waiting'
  if (i.held || i.limitHold || i.openCards > 0) return 'waiting'
  if (i.status === 'starting' || i.status === 'running') return 'working'
  // Idle: the root's turn ended. Work can still be under way without the user.
  if (i.agents.some(isWorkingReport)) return 'working'
  if (i.peerMessagesPending) return 'working'
  const s = i.settlement
  if (s) {
    if (!s.rootIdle) return 'working'
    if (!s.quiescent) return 'working'
    // A continuation nudge is due (its timer or evaluation is pending). Only once a root turn ended: before that the
    // driver has nothing to settle.
    if (s.rootTurnGen >= 1 && !s.continuationSettled) return 'working'
  }
  return 'waiting'
}

/** Runs counted as work that keeps a host alive (the 'liveRuns' activity source): working, ending, or an exec run in flight. */
export function keepsHostBusy(state: RunActivityState, execInFlight: boolean): boolean {
  return state !== 'waiting' || execInFlight
}
