import { basename } from 'node:path'
import { PROPOSAL_TOOLS } from '@shared/setup'
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
