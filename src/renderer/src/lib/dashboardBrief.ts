import { costView, formatUsdCompact, type CostInput } from './cost'
import { plural } from '../components/dashboard/dashboardProjects'

/**
 * The Dashboard greeting (docs/design/dashboard-overhaul.md section 5): the salutation by local hour and the brief, one or
 * two true sentences about what changed and what waits. Pure: plain numbers and objects in, strings out. Every figure is
 * computed from stored facts; there is no model call.
 */

const DAY_MS = 24 * 60 * 60 * 1000

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
 * "Good morning, Sam." with a name, "Good morning." without; "Welcome to OrgAI." on first launch (never the name there:
 * it is a first-launch screen).
 */
export function salutation(hour: number, name: string | undefined, firstLaunch: boolean): string {
  if (firstLaunch) return 'Welcome to OrgAI.'
  const word = greetingWord(hour)
  return name ? `${word}, ${name}.` : `${word}.`
}

export interface BriefInput {
  /** No projects: the brief is the one welcome line. */
  firstLaunch: boolean
  /** Every project's history is loaded. Until then "since" and "quiet" are never claimed. */
  ready: boolean
  /** At least one run exists anywhere (live or history). Only read once `ready`. */
  anyRunEver: boolean
  now: number
  /** The time the person last left the Dashboard (epoch ms). */
  lastSeen: number
  firstVisit: boolean
  /** Runs that finished since `lastSeen` (kind finished). */
  finished: number
  /** Runs that failed since `lastSeen`. */
  failed: number
  /** Runs cut by a quit while waiting on the person, since `lastSeen`. */
  closedWaiting: number
  /** The summed cost of the finished and failed runs; absent when there are none. */
  cost?: CostInput
  /** Open decisions (the bell). */
  decisions: number
  /** Agents working now and the runs holding them. */
  workingAgents: number
  workingRuns: number
  /** Paused runs and the earliest automatic resume time, as a clock label ("14:05"), when one is known. */
  paused: number
  pausedUntilLabel?: string
}

/** True when "since you were last here" must read "in the past 7 days". */
export function sinceIsLongAgo(lastSeen: number, now: number, firstVisit: boolean): boolean {
  return firstVisit || now - lastSeen > 7 * DAY_MS
}

/**
 * ", costing $1.42" (known), ", costing at least $1.42" (partial), ", costing less than $0.01" (a known amount under a cent).
 * Empty for an unknown cost, a reported zero or nothing spent, and for a partial figure under a cent (a lower bound that
 * small says nothing true). Never "$0.00".
 */
export function costClause(cost: CostInput | undefined): string {
  if (!cost) return ''
  const view = costView(cost, { compact: true })
  if (view.kind !== 'known' && view.kind !== 'partial') return ''
  const usd = cost.costUsd
  if (usd === null || !(usd > 0)) return ''
  if (usd < 0.01) return view.kind === 'known' ? ', costing less than $0.01' : ''
  return view.kind === 'partial' ? `, costing at least ${formatUsdCompact(usd)}` : `, costing ${formatUsdCompact(usd)}`
}

function waitingSentence(n: number): string {
  return n === 1 ? '1 decision is waiting on you.' : `${n} decisions are waiting on you.`
}

function sinceSentence(i: BriefInput): string {
  const when = sinceIsLongAgo(i.lastSeen, i.now, i.firstVisit) ? 'in the past 7 days' : 'since you were last here'
  const clause = costClause(i.cost)
  let lead: string
  if (i.finished > 0 && i.failed > 0) lead = `${plural(i.finished, 'run', 'runs')} finished and ${i.failed} failed`
  else if (i.finished > 0) lead = `${plural(i.finished, 'run', 'runs')} finished`
  else lead = `${plural(i.failed, 'run', 'runs')} failed`
  return `${lead} ${when}${clause}.`
}

function closedSentence(n: number): string {
  return n === 1 ? '1 run was waiting on you when OrgAI closed.' : `${n} runs were waiting on you when OrgAI closed.`
}

function workingSentence(agents: number, runs: number): string {
  const r = plural(Math.max(1, runs), 'run', 'runs')
  return agents === 1 ? `1 agent is working in ${r}.` : `${agents} agents are working in ${r}.`
}

function pausedSentence(n: number, until: string | undefined): string {
  const tail = until ? ` until ${until}` : ''
  return n === 1 ? `1 run is paused${tail}.` : `${n} runs are paused${tail}.`
}

/**
 * The brief under the salutation: at most two sentences (section 5.4).
 * 1. Decisions waiting lead, then one more: the first present of since, closed, working, paused.
 * 2. With none waiting: the first two present of since, closed, working, paused.
 * 3. None present: the quiet sentence, or "No runs yet" when no run ever existed.
 * 4. Until `ready` only waiting, working and paused can show, so "Nothing has changed" never flashes before history loads
 *    (the result may be empty; the line keeps its height in CSS).
 */
export function dashboardBrief(i: BriefInput): string {
  if (i.firstLaunch) return FIRST_LAUNCH_BRIEF
  const since = i.ready && i.finished + i.failed > 0 ? sinceSentence(i) : ''
  const closed = i.ready && i.closedWaiting > 0 ? closedSentence(i.closedWaiting) : ''
  const working = i.workingAgents > 0 ? workingSentence(i.workingAgents, i.workingRuns) : ''
  const paused = i.paused > 0 ? pausedSentence(i.paused, i.pausedUntilLabel) : ''
  const rest = [since, closed, working, paused].filter((s) => s !== '')
  const waiting = i.decisions > 0 ? waitingSentence(i.decisions) : ''
  const picked = waiting ? [waiting, ...rest.slice(0, 1)] : rest.slice(0, 2)
  if (picked.length > 0) return picked.join(' ')
  if (!i.ready) return ''
  if (!i.anyRunEver) return NO_RUNS_BRIEF
  const span = sinceIsLongAgo(i.lastSeen, i.now, i.firstVisit) ? 'in the past 7 days' : 'since you were last here'
  return `Nothing has changed ${span}, and nothing is waiting on you.`
}
