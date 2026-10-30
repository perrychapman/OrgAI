import { basename } from 'node:path'
import { PROPOSAL_TOOLS } from '@shared/setup'
import type { AgentInstance, AgentState, RunStatus } from '@shared/types'
import { MCP_HARNESS_TOOLS, PERMISSION_HARNESS_TOOLS } from '@shared/types'
import { PLAN_TOOLS } from './continuation'

/**
 * One-line activity strings for agent nodes, keyed by bare tool name. Vendor-neutral: an adapter that
 * namespaces the harness's own tools (Claude: mcp__orgai__<name>) strips its prefix and passes
 * `{ harness: true }`.
 */

/** Activity labels for the harness's own tools. */
export const HARNESS_TOOL_ACTIVITY: Record<string, string> = {
  [PROPOSAL_TOOLS.architecture]: 'Proposing the architecture…',
  [PROPOSAL_TOOLS.orgChart]: 'Proposing the org chart…',
  [PROPOSAL_TOOLS.settings]: 'Proposing run settings…',
  [PROPOSAL_TOOLS.complete]: 'Wrapping up setup…',
  [PROPOSAL_TOOLS.question]: 'Asking you a question…',
  [PROPOSAL_TOOLS.orgChange]: 'Proposing an org chart change…',
  [PLAN_TOOLS.set]: 'Writing the plan…',
  [PLAN_TOOLS.update]: 'Updating the plan…',
  [PLAN_TOOLS.complete]: 'Completing the plan…',
  [PLAN_TOOLS.blocked]: 'Marking the plan blocked…',
  [MCP_HARNESS_TOOLS.listServers]: 'Checking the MCP servers…',
  [MCP_HARNESS_TOOLS.searchRegistry]: 'Searching the MCP registry…',
  [MCP_HARNESS_TOOLS.requestInstall]: 'Asking you to add an MCP server…',
  [MCP_HARNESS_TOOLS.proposeServers]: 'Proposing MCP servers…',
  [PERMISSION_HARNESS_TOOLS.request]: 'Asking you for a permission rule…'
}

/** Short, single-line, length-capped text from untrusted tool input. */
function snippet(v: unknown, max = 40): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.replace(/\s+/g, ' ').trim()
  if (!t) return undefined
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** Harness tool labels that name their subject when the input carries one. */
function harnessToolDetail(name: string, input: unknown): string | undefined {
  const i = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  if (name === MCP_HARNESS_TOOLS.searchRegistry) {
    const q = snippet(i.query)
    return q ? `Searching the MCP registry for "${q}"…` : undefined
  }
  if (name === MCP_HARNESS_TOOLS.requestInstall) {
    const reg = i.registry && typeof i.registry === 'object' ? (i.registry as Record<string, unknown>) : undefined
    const man = i.manual && typeof i.manual === 'object' ? (i.manual as Record<string, unknown>) : undefined
    const server = snippet(reg?.name) ?? snippet(man?.name)
    return server ? `Asking you to add the ${server} MCP server…` : undefined
  }
  return undefined
}

/** Label for one of the harness's own tools (bare name). */
export function harnessToolActivity(name: string): string {
  return HARNESS_TOOL_ACTIVITY[name] ?? 'Talking to the harness'
}

export function describeTool(name: string, input: unknown, opts: { harness?: boolean } = {}): string {
  if (opts.harness) return harnessToolDetail(name, input) ?? harnessToolActivity(name)
  const i = (input ?? {}) as Record<string, unknown>
  const str = (k: string): string => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const file = (): string => basename(str('file_path') || str('path') || str('notebook_path') || '')
  switch (name) {
    case 'Read':
      return `Reading ${file()}`
    case 'Edit':
      return `Editing ${file()}`
    case 'Write':
      return `Writing ${file()}`
    case 'NotebookEdit':
      return `Editing notebook ${file()}`
    case 'Bash':
      return `$ ${str('command').replace(/\s+/g, ' ').slice(0, 70)}`
    case 'Grep':
      return `Searching for "${str('pattern').slice(0, 40)}"`
    case 'Glob':
      return `Finding ${str('pattern').slice(0, 50)}`
    case 'WebSearch':
      return `Searching the web: ${str('query').slice(0, 50)}`
    case 'WebFetch':
      return `Fetching ${str('url').slice(0, 60)}`
    case 'Agent':
    case 'Task':
      return `Delegating to ${str('subagent_type') || 'a subagent'}`
    case 'TodoWrite':
      return 'Updating task list'
    case 'SendMessage':
      return `Messaging ${str('to') || 'an agent'}`
    case 'ListAgents':
      return 'Checking who is running'
    default:
      return `Using ${name}`
  }
}

// ---------- Terminal labels ----------

/** How a run ended, for agent labels: one vocabulary with the run strip (Finished, Stopped, Failed). */
export type RunOutcome = 'finished' | 'stopped' | 'failed'

export const TERMINAL_ACTIVITY: Record<RunOutcome, string> = { finished: 'Finished', stopped: 'Stopped', failed: 'Failed' }

/** The outcome of a terminal run.status, or null while the run lives (and for 'paused', which continues later). */
export function runOutcome(status: RunStatus, userStopped: boolean): RunOutcome | null {
  if (status === 'error') return 'failed'
  if (status === 'finished') return userStopped ? 'stopped' : 'finished'
  return null
}

/** Still working (not done, not error). */
export const isLiveAgent = (a: Pick<AgentInstance, 'state'>): boolean => a.state !== 'done' && a.state !== 'error'
const live = isLiveAgent

/**
 * How an agent should read once its run ended, so no node keeps saying "Waiting for you" or "Needs approval".
 * The root always takes the run's label. A report that was cut off (`cutOff`: it was still live when the run
 * ended, as the caller tracks it; a live `agent` always counts) reads Stopped, or Failed on a failed run; reports
 * that had already finished keep their own label ("Reported back"). Live states become done (error on a failed
 * run). Returns the same object when nothing changes.
 */
export function settleAgent(agent: AgentInstance, cutOff: boolean, outcome: RunOutcome, rootId: string): AgentInstance {
  // The label check covers adapters that mark agents done before the terminal status (Codex).
  const wasLive = cutOff || live(agent) || /^(Needs approval|Waiting for you)/.test(agent.activity)
  let activity = agent.activity
  if (agent.id === rootId) activity = TERMINAL_ACTIVITY[outcome]
  else if (wasLive) activity = outcome === 'failed' ? TERMINAL_ACTIVITY.failed : TERMINAL_ACTIVITY.stopped
  const state: AgentState = live(agent) ? (outcome === 'failed' ? 'error' : 'done') : agent.state
  if (activity === agent.activity && state === agent.state) return agent
  const endedAt = agent.endedAt ?? (state !== agent.state ? Date.now() : undefined)
  return { ...agent, activity, state, ...(endedAt !== undefined ? { endedAt } : {}) }
}
