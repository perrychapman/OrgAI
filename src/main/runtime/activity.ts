import { basename } from 'node:path'
import { PROPOSAL_TOOLS } from '@shared/setup'

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
  [PROPOSAL_TOOLS.orgChange]: 'Proposing an org chart change…'
}

/** Label for one of the harness's own tools (bare name). */
export function harnessToolActivity(name: string): string {
  return HARNESS_TOOL_ACTIVITY[name] ?? 'Talking to the harness'
}

export function describeTool(name: string, input: unknown, opts: { harness?: boolean } = {}): string {
  if (opts.harness) return harnessToolActivity(name)
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
