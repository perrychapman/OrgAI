import { plural } from '../components/dashboard/dashboardProjects'

/**
 * The Briefing's words (docs/design/dashboard-usage-redesign/project/components/Briefing): the salutation by local hour,
 * the status sentence and the project the primary quick action continues. Pure: plain numbers and objects in, strings out.
 * Every figure is computed from stored facts; there is no model call. What changed since the last visit is
 * `lib/sinceSummary.ts`.
 */

export const FIRST_LAUNCH_BRIEF = 'Start a project or just chat. Nothing runs until you say so.'
export const NO_RUNS_BRIEF = 'No runs yet. Open a project to start one.'

/** "Good morning" 05:00-11:59, "Good afternoon" 12:00-16:59, "Good evening" 17:00-21:59, else "Hello". */
export function greetingWord(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 17) return 'Good afternoon'
  if (hour >= 17 && hour < 22) return 'Good evening'
  return 'Hello'
}

/**
 * "Good morning, Sam" with a name, "Good morning" without; on first launch "Welcome to OrgAI" or, once a name is saved,
 * "Welcome to OrgAI, Sam" (walk 4 M2: saving a name must visibly land). A display line: no full stop.
 */
export function salutation(hour: number, name: string | undefined, firstLaunch: boolean): string {
  if (firstLaunch) return name ? `Welcome to OrgAI, ${name}` : 'Welcome to OrgAI'
  const word = greetingWord(hour)
  return name ? `${word}, ${name}` : word
}

export interface StatusInput {
  /** No projects: the status is the one welcome line. */
  firstLaunch: boolean
  /** Every project's history is loaded. Until then "No runs yet" is never claimed. */
  ready: boolean
  /** At least one run exists anywhere (live or history). Only read once `ready`. */
  anyRunEver: boolean
  /** Open decisions: the bell's count (`useDecisionTotal`). */
  decisions: number
  /** Live runs that are idle and waiting for the person's reply (not decisions). Absent reads as none. */
  awaitingReply?: number
  /** Agents working now and the runs holding them. */
  workingAgents: number
  workingRuns: number
  /** Paused runs and the earliest automatic resume time, as a clock label ("14:05"), when one is known. */
  paused: number
  pausedUntilLabel?: string
}

/** One sentence of the status; `attention` marks the one that carries the decision count (warning text, semibold). */
export interface StatusPart {
  text: string
  attention?: true
}

function workingSentence(agents: number, runs: number): string {
  const r = plural(Math.max(1, runs), 'run', 'runs')
  return agents === 1 ? `1 agent is working in ${r}.` : `${agents} agents are working in ${r}.`
}

function pausedSentence(n: number, until: string | undefined): string {
  const tail = until ? ` until ${until}` : ''
  return n === 1 ? `1 run is paused${tail}.` : `${n} runs are paused${tail}.`
}

/** "2 decisions need you." The one place a count of decisions is written on the Briefing. */
export function decisionsSentence(n: number): string {
  return n === 1 ? '1 decision needs you.' : `${n} decisions need you.`
}

function replySentence(n: number): string {
  return n === 1 ? '1 run is idle and waiting on your reply.' : `${n} runs are idle and waiting on your reply.`
}

/**
 * The status under the greeting, as sentences: what is working, what needs the person (decisions, then idle runs waiting
 * for a reply), what is paused; "Nothing needs you." when no decision and no reply waits. Before history is in and with
 * nothing live, nothing is claimed beyond that (the decision count is live, so it is always true).
 */
export function statusParts(i: StatusInput): StatusPart[] {
  if (i.firstLaunch) return [{ text: FIRST_LAUNCH_BRIEF }]
  const replies = i.awaitingReply ?? 0
  const parts: StatusPart[] = []
  if (i.workingAgents > 0) parts.push({ text: workingSentence(i.workingAgents, i.workingRuns) })
  if (i.decisions > 0) parts.push({ text: decisionsSentence(i.decisions), attention: true })
  if (replies > 0) parts.push({ text: replySentence(replies) })
  if (i.paused > 0) parts.push({ text: pausedSentence(i.paused, i.pausedUntilLabel) })
  if (i.decisions === 0 && replies === 0) {
    const quiet = i.workingAgents === 0 && i.paused === 0 && i.ready && !i.anyRunEver
    parts.push({ text: quiet ? NO_RUNS_BRIEF : 'Nothing needs you.' })
  }
  return parts
}

/** The status as one string (the accessible text and the live check in tests). */
export function statusSentence(i: StatusInput): string {
  return statusParts(i)
    .map((p) => p.text)
    .join(' ')
}

/**
 * The project the primary quick action continues: the first pinned project that still exists, else the project whose
 * newest run started last, else the first project. Null with no projects.
 */
export function continueProjectId(pinned: readonly string[], projects: readonly { id: string }[], summaries: readonly { projectId: string; startedAt: number }[]): string | null {
  const known = new Set(projects.map((p) => p.id))
  const pin = pinned.find((id) => known.has(id))
  if (pin) return pin
  let best: { id: string; at: number } | null = null
  for (const s of summaries) {
    if (!known.has(s.projectId)) continue
    if (!best || s.startedAt > best.at) best = { id: s.projectId, at: s.startedAt }
  }
  return best?.id ?? projects[0]?.id ?? null
}
