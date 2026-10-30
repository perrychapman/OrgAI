/** Pure humanizing for transcript rows: tool calls become sentences, raw input becomes an optional detail string. */

export type ToolKind = 'ask' | 'plan' | 'propose' | 'permission' | 'edit' | 'read' | 'run' | 'search' | 'agent' | 'message' | 'other'

export interface ToolRow {
  /** One human line, e.g. "Edited src/x.ts". */
  label: string
  kind: ToolKind
  /** The raw input for the "Show details" disclosure. */
  details: string
}

const asObj = (input: unknown): Record<string, unknown> => (input && typeof input === 'object' ? (input as Record<string, unknown>) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const clip = (s: string, max = 120): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

/** `mcp__orgai__ask_user` becomes `ask_user`; other names are unchanged. */
export function bareToolName(name: string): string {
  const m = /^mcp__.+?__(.+)$/.exec(name)
  return m ? m[1] : name
}

/** Turns a snake_case or CamelCase tool name into words: "list_agents" -> "list agents". */
export function toolWords(name: string): string {
  return bareToolName(name)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim()
}

/** The raw input as readable text (pretty JSON, capped). */
export function rawDetails(input: unknown): string {
  if (typeof input === 'string') return input
  let s: string
  try {
    s = JSON.stringify(input, null, 2) ?? ''
  } catch {
    s = String(input)
  }
  return s.length > 4000 ? s.slice(0, 4000) + '\n…' : s
}

const count = (v: unknown): number | undefined => (Array.isArray(v) ? v.length : undefined)
const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : one + 's'}`

function proposalNoun(bare: string): string {
  return bare
    .replace(/^propose_/, '')
    .replace(/_/g, ' ')
    .replace(/\bmcp\b/g, 'MCP')
}

export function humanizeToolUse(name: string, input: unknown): ToolRow {
  const bare = bareToolName(name)
  const i = asObj(input)
  const details = rawDetails(input)
  const row = (kind: ToolKind, label: string): ToolRow => ({ kind, label, details })
  const path = str(i.file_path) ?? str(i.path) ?? str(i.notebook_path)

  switch (bare) {
    case 'ask_user': {
      const first = Array.isArray(i.questions) ? i.questions[0] : undefined
      const q = str(i.question) ?? str(i.prompt) ?? str(i.message) ?? str(asObj(first).question) ?? str(first)
      return row('ask', q ? `Asked you: ${clip(q)}` : 'Asked you a question')
    }
    case 'set_plan': {
      const n = count(i.steps)
      return row('plan', n ? `Planned ${plural(n, 'step')}` : 'Made a plan')
    }
    case 'update_plan':
    case 'orgai_update_plan':
      return row('plan', 'Updated the plan')
    case 'complete_plan':
      return row('plan', 'Marked the plan complete')
    case 'mark_blocked':
      return row('plan', str(i.reason) ? `Reported a blocker: ${clip(str(i.reason)!)}` : 'Reported a blocker')
    case 'request_permission_rules':
      return row('permission', 'Asked for a permission rule')
    case 'request_mcp_install':
      return row('permission', 'Asked to install an MCP server')
    case 'search_mcp_registry':
      return row('search', str(i.query) ? `Searched the MCP registry for "${clip(str(i.query)!, 60)}"` : 'Searched the MCP registry')
    case 'list_mcp_servers':
      return row('search', 'Listed MCP servers')
    case 'integrate_worktrees':
      return row('agent', 'Integrated worktrees')
    case 'Edit':
    case 'MultiEdit':
      return row('edit', path ? `Edited ${path}` : 'Edited a file')
    case 'Write':
      return row('edit', path ? `Wrote ${path}` : 'Wrote a file')
    case 'NotebookEdit':
      return row('edit', path ? `Edited ${path}` : 'Edited a notebook')
    case 'Read':
      return row('read', path ? `Read ${path}` : 'Read a file')
    case 'Glob':
    case 'Grep': {
      const p = str(i.pattern)
      return row('search', p ? `Searched for ${clip(p, 60)}` : 'Searched the project')
    }
    case 'Bash':
    case 'PowerShell': {
      const c = str(i.command)
      return row('run', c ? `Ran \`${clip(c, 80)}\`` : 'Ran a command')
    }
    case 'WebSearch':
      return row('search', str(i.query) ? `Searched the web for "${clip(str(i.query)!, 60)}"` : 'Searched the web')
    case 'WebFetch':
      return row('read', str(i.url) ? `Fetched ${clip(str(i.url)!, 80)}` : 'Fetched a web page')
    case 'Agent':
    case 'Task':
    case 'spawn_agent': {
      const who = str(i.name) ?? str(i.subagent_type)
      const what = str(i.description)
      return row('agent', who ? `Handed work to ${who}${what ? `: ${clip(what, 80)}` : ''}` : what ? `Handed off: ${clip(what, 80)}` : 'Handed work to a report')
    }
    case 'SendMessage':
    case 'send_message': {
      const to = str(i.to) ?? str(i.recipient)
      return row('message', to ? `Messaged ${to}` : 'Sent a message')
    }
    case 'ListAgents':
      return row('agent', 'Listed running agents')
    case 'TodoWrite':
      return row('plan', 'Updated its to-do list')
  }
  if (bare.startsWith('propose_')) {
    const n = count(i.servers) ?? count(i.proposals) ?? count(i.changes) ?? count(i.items) ?? count(i.roles) ?? count(i.plugins)
    return row('propose', n ? `Proposed ${proposalNoun(bare)} (${n})` : `Proposed ${proposalNoun(bare)}`)
  }
  return row('other', `Used ${toolWords(name)}`)
}

/** A short headline for a tool result: the first non-empty line, capped. */
export function resultSummary(content: string, isError: boolean): string {
  const first = content.split('\n').find((l) => l.trim()) ?? ''
  if (!first) return isError ? 'The tool failed' : 'No output'
  return clip(first, 100)
}

/** The Plan tab's line about automatic continuation. */
export function autoContinueLine(auto: boolean, used: number, max: number): { pill: string; explain: string } {
  if (!auto) return { pill: 'Auto-continue off', explain: 'Automatic continue is off for this project. The orchestrator stops after each turn until you reply.' }
  return {
    pill: `Auto-continued ${used} ${used === 1 ? 'time' : 'times'} (limit ${max})`,
    explain: `When the orchestrator stops with steps left, OrgAI nudges it to carry on, up to ${max} times per run.`
  }
}
