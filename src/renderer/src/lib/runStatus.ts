import type { AgentInstance, RunStatus } from '@shared/types'

/**
 * The one status vocabulary of the app (spec 12.4): tabs, run header, history, sidebar, node activity and the topbar
 * pill all use these words. 'Paused' is the one addition: a run waiting on a usage limit that resumes by itself.
 */
export type StatusWord = 'Running' | 'Needs you' | 'Idle' | 'Paused' | 'Finished' | 'Stopped' | 'Failed'
export type RunTone = 'is-running' | 'warn' | 'idle' | 'paused' | 'ok' | 'danger'

export interface RunStatusView {
  word: StatusWord
  tone: RunTone
  /** Extra detail for a tooltip (never replaces the word). */
  note?: string
}

const TONES: Record<StatusWord, RunTone> = {
  Running: 'is-running',
  'Needs you': 'warn',
  Idle: 'idle',
  Paused: 'paused',
  Finished: 'ok',
  // Neutral like Idle: the topbar, sidebar and tab styles have no separate stopped tone.
  Stopped: 'idle',
  Failed: 'danger'
}

export interface RunStatusOptions {
  /** A card, question or blocked plan waits on the user; wins over the status. */
  waiting?: boolean
  endedWithApp?: boolean
  /** The user ended the session (see isStoppedRun). A finished run reads Stopped instead of Finished. */
  stopped?: boolean
  /** The harness is auto-continuing an active plan: idle between turns reads Running, not Idle. */
  autoContinuing?: boolean
}

/** Maps a run's status to the shared vocabulary. `waiting` wins over the status. */
export function runStatus(status: RunStatus, opts: RunStatusOptions = {}): RunStatusView {
  const make = (word: StatusWord, note?: string): RunStatusView => ({ word, tone: TONES[word], ...(note ? { note } : {}) })
  if (opts.waiting) return make('Needs you')
  switch (status) {
    case 'starting':
    case 'running':
      return make('Running')
    case 'stopping':
      return make('Running', 'Stopping')
    case 'idle':
      return opts.autoContinuing ? make('Running', 'The harness is continuing the plan') : make('Idle')
    case 'paused':
      return make('Paused')
    case 'error':
      return make('Failed')
    default:
      if (opts.stopped) return make('Stopped', opts.endedWithApp ? 'Ended when OrgAI closed' : 'You ended this session')
      return make('Finished', opts.endedWithApp ? 'Ended when OrgAI closed' : undefined)
  }
}

/**
 * True when the run's root agent was labelled Stopped by the runtime (the user ended the session, or the run was cut
 * off). The summary does not carry the reason, so the root's terminal activity is the source of truth.
 */
export function isStoppedRun(agents: Record<string, Pick<AgentInstance, 'parentId' | 'activity'>> | undefined): boolean {
  if (!agents) return false
  return Object.values(agents).some((a) => a.parentId === null && a.activity === 'Stopped')
}

/** Plan facts the auto-continue check needs. */
export interface AutoContinueInput {
  status: RunStatus
  plan?: { status: string; autoContinues: number }
  /** Project autoContinue (default on) and cap (default 40). */
  autoContinue?: boolean
  maxAutoContinues?: number
  kind?: string
}

/** The harness re-engages the orchestrator by itself: an active plan, the session open, the cap not reached. */
export function autoContinueState(input: AutoContinueInput, defaultMax = 40): { active: boolean; count: number; max: number } {
  const max = input.maxAutoContinues ?? defaultMax
  const count = input.plan?.autoContinues ?? 0
  const open = input.status === 'running' || input.status === 'idle' || input.status === 'starting'
  const active = input.kind !== 'setup' && input.autoContinue !== false && !!input.plan && input.plan.status === 'active' && open && count < max
  return { active, count, max }
}
