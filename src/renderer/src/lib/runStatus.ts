import type { AgentInstance, AgentState, RunStatus, RunSummary } from '@shared/types'

/**
 * The one status vocabulary of the app (spec 12.4): tabs, run header, history, sidebar, node activity and the topbar
 * pill all use these words. 'Paused' is the one addition: a run waiting on a usage limit that resumes by itself.
 */
export type StatusWord = 'Running' | 'Needs you' | 'Idle' | 'Paused' | 'Finished' | 'Stopped' | 'Failed'
export type RunTone = 'is-running' | 'warn' | 'idle' | 'paused' | 'ok' | 'danger' | 'stopped'

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
  // Neutral grey: Idle is the info blue, and a Stopped run must not read as waiting or idle in the tab dot.
  Stopped: 'stopped',
  Failed: 'danger'
}

/** Who ended a finished run: 'user' (End session) or 'app' (OrgAI quit or crashed while it was live). Absent: it ended on its own. */
export type EndedBy = 'user' | 'app'

/** The summary fields that say how a run ended. `endedBy` is RunSummary.endedBy (older records only have endedWithApp). */
export interface EndFacts {
  endedBy?: EndedBy
  endedWithApp?: boolean
}

/** How the run ended, from the summary alone: endedBy, else 'app' for an old record with endedWithApp. */
export function endedByOf(s: EndFacts): EndedBy | undefined {
  if (s.endedBy === 'user' || s.endedBy === 'app') return s.endedBy
  return s.endedWithApp ? 'app' : undefined
}

/** The note (and statusText) of a run cut off by OrgAI closing. */
export const ENDED_WITH_APP = 'Ended when OrgAI closed'

export interface RunStatusOptions {
  /** A card, question or blocked plan waits on the user; wins over the status. */
  waiting?: boolean
  /** RunSummary.endedBy: 'user' reads Stopped, 'app' reads "Ended when OrgAI closed". */
  endedBy?: EndedBy
  /** Old records: the run was still live when OrgAI quit (same as endedBy 'app'). */
  endedWithApp?: boolean
  /** Fallback for old records without endedBy only: the root agent was labelled Stopped (see isStoppedRun). */
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
    default: {
      const by = endedByOf(opts)
      if (by === 'app') return make('Stopped', ENDED_WITH_APP)
      if (by === 'user') return make('Stopped', 'You ended this session')
      // Old records carry no endedBy: the root agent's label is the only trace of an End session.
      if (opts.stopped) return make('Stopped', 'You ended this session')
      return make('Finished')
    }
  }
}

/**
 * Fallback for records saved before RunSummary.endedBy: true when the run's root agent was labelled Stopped by the
 * runtime. Never consulted when the summary says how the run ended (statusOfRun).
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

/** The words to show for a status: a run cut off by the app closing says so instead of "Stopped". Use it wherever a status is shown as text. */
export function statusText(view: RunStatusView): string {
  return view.note === ENDED_WITH_APP ? view.note : view.word
}

/** The shared status of a run held in the store, so tab, header, pill, sidebar and history never disagree. */
export function statusOfRun(
  run: {
    summary: Pick<RunSummary, 'status' | 'kind' | 'endedWithApp'> & { endedBy?: EndedBy }
    plan?: AutoContinueInput['plan']
    agents?: Record<string, Pick<AgentInstance, 'parentId' | 'activity'>>
  },
  project: { autoContinue?: boolean; maxAutoContinues?: number } | undefined,
  waiting: boolean
): RunStatusView {
  const auto = autoContinueState({
    status: run.summary.status,
    plan: run.plan,
    autoContinue: project?.autoContinue,
    maxAutoContinues: project?.maxAutoContinues,
    kind: run.summary.kind
  })
  const endedBy = endedByOf(run.summary)
  return runStatus(run.summary.status, {
    waiting,
    endedBy,
    // The summary decides; the root agent's label is read only for old records that carry no end reason.
    stopped: endedBy === undefined && isStoppedRun(run.agents),
    autoContinuing: auto.active
  })
}

const WORKING_STATES: ReadonlySet<AgentState> = new Set<AgentState>(['starting', 'thinking', 'tool', 'delegating'])
const OPEN_AGENT_STATES: ReadonlySet<AgentState> = new Set<AgentState>(['starting', 'thinking', 'tool', 'waiting', 'delegating', 'idle'])
const WAITING_ACTIVITY = /^(Needs approval|Waiting for you)/

/**
 * What a run cut off by OrgAI closing was doing, read from its saved agents before they are settled: 'waiting' when
 * nothing was working and the root sat idle or an agent waited on the user, else 'working' (also the answer when the
 * record carries no trace either way).
 */
export function cutWhile(agents: Record<string, Pick<AgentInstance, 'parentId' | 'state' | 'activity'>> | undefined): 'working' | 'waiting' {
  const list = Object.values(agents ?? {})
  if (list.some((a) => WORKING_STATES.has(a.state))) return 'working'
  const waiting = list.some((a) => a.state === 'waiting' || (a.parentId === null && a.state === 'idle') || WAITING_ACTIVITY.test(a.activity))
  return waiting ? 'waiting' : 'working'
}

/**
 * Agents of an ended run as they should read (H4): nothing on a finished or failed run says Thinking, Waiting for
 * you or Needs approval. The root takes the run's status text ("Finished", "Stopped", "Ended when OrgAI closed",
 * "Failed"); a report still open reads Stopped (Failed on a failed run) and becomes done (error). Agents that had
 * already finished keep their own label. Live, idle and paused runs are returned unchanged (same object).
 */
export function settleEndedAgents<A extends Pick<AgentInstance, 'id' | 'parentId' | 'state' | 'activity' | 'endedAt'>>(
  summary: Pick<RunSummary, 'status' | 'endedWithApp' | 'endedAt'> & { endedBy?: EndedBy },
  agents: Record<string, A>
): Record<string, A> {
  if (summary.status !== 'finished' && summary.status !== 'error') return agents
  const failed = summary.status === 'error'
  const rootLabel = statusText(statusOfRun({ summary: { ...summary, kind: 'work' }, agents }, undefined, false))
  let changed = false
  const out: Record<string, A> = {}
  for (const [id, a] of Object.entries(agents)) {
    const open = OPEN_AGENT_STATES.has(a.state)
    const stale = open || WAITING_ACTIVITY.test(a.activity)
    let activity = a.activity
    if (a.parentId === null) activity = rootLabel
    else if (stale) activity = failed ? 'Failed' : 'Stopped'
    const state: AgentState = open ? (failed ? 'error' : 'done') : a.state
    if (activity === a.activity && state === a.state) {
      out[id] = a
      continue
    }
    changed = true
    out[id] = { ...a, activity, state, ...(a.endedAt === undefined && open ? { endedAt: summary.endedAt ?? Date.now() } : {}) }
  }
  return changed ? out : agents
}
