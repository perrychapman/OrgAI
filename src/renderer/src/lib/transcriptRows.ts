/** Pure humanizing for transcript rows: tool calls become sentences, raw input becomes an optional detail string. */

import type { RunSummary, TranscriptEntry } from '@shared/types'
import { ENGAGEMENT_CONTEXT_TOOL, KNOWLEDGE_TOOL } from '@shared/types'
import { normalizeKnowledgeKey } from '@shared/knowledge'
import { continuationDivider, type ContinuationDivider } from './runChains'
import { keyWords, kindGroupLabel } from './knowledge'

/** One row of a chain's merged feed: an entry of one member, or the divider where a continuation starts. */
export type FeedItem =
  | { kind: 'entry'; runId: string; entry: TranscriptEntry }
  | { kind: 'divider'; divider: ContinuationDivider }
  /** Leads a capped feed: how many earlier entries were cut (a quiet row, "N earlier entries not shown"). */
  | { kind: 'omitted'; count: number }

/** The most items a merged chain feed keeps (the newest ones), like the live transcript trim. */
export const FEED_MAX_ITEMS = 5000

/** "1 earlier entry not shown", "1,234 earlier entries not shown". */
export const omittedLabel = (n: number): string => `${n.toLocaleString('en-US')} earlier ${n === 1 ? 'entry' : 'entries'} not shown`

/** A chain member as the merged feed needs it. */
export interface FeedMember {
  summary: Pick<RunSummary, 'id' | 'startedAt' | 'status'> &
    Partial<Pick<RunSummary, 'sessionId' | 'resumedFrom' | 'endedAt' | 'endedWithApp'>> & { endedBy?: 'user' | 'app' }
  entries: readonly TranscriptEntry[]
}

/** How far into a member the adapters' "Continued from run <id>" row may sit (it is written at session start). */
const CONTINUATION_NOTICE_WINDOW = 3

/**
 * The adapters' own continuation row (M4): a harness system entry "Continued from run <id>". Only this exact shape
 * matches; other harness rows are never hidden.
 */
export const isContinuationNotice = (e: TranscriptEntry): boolean =>
  e.source === 'harness' && e.block.kind === 'system' && e.block.text.startsWith('Continued from run ')

/** A copy of an earlier member's entry whose ids (entry, tool_use id, tool_result toolUseId) carry the run id, so pairs stay matched and nothing collides. */
function prefixed(runId: string, entry: TranscriptEntry): TranscriptEntry {
  const b = entry.block
  const block = b.kind === 'tool_use' ? { ...b, id: `${runId}:${b.id}` } : b.kind === 'tool_result' ? { ...b, toolUseId: `${runId}:${b.toolUseId}` } : b
  return { ...entry, id: `${runId}:${entry.id}`, block }
}

/**
 * Every member's entries oldest first, with one divider before each continuation (members after the first). The
 * "Continued from run <id>" row is dropped only among the first few entries of a member that has `resumedFrom`.
 * Entry ids of all but the newest member are prefixed with the run id, so keys never collide across members.
 */
export function mergeChainFeed(members: readonly FeedMember[], max: number = FEED_MAX_ITEMS): FeedItem[] {
  const out: FeedItem[] = []
  members.forEach((m, i) => {
    const newest = i === members.length - 1
    if (i > 0) out.push({ kind: 'divider', divider: continuationDivider(members[i - 1].summary, m.summary) })
    m.entries.forEach((entry, at) => {
      if (m.summary.resumedFrom && at < CONTINUATION_NOTICE_WINDOW && isContinuationNotice(entry)) return
      out.push({ kind: 'entry', runId: m.summary.id, entry: newest ? entry : prefixed(m.summary.id, entry) })
    })
  })
  return capFeed(out, members.length > 1 ? members[members.length - 1].summary.id : undefined, max)
}

/**
 * Keeps the newest `max` items, led by an 'omitted' row counting the entries cut. The divider of `newestId` (the
 * newest member) always stays, even when the newest member alone fills the cap.
 */
function capFeed(items: FeedItem[], newestId: string | undefined, max: number): FeedItem[] {
  if (items.length <= max) return items
  const dividerAt = newestId === undefined ? -1 : items.findIndex((x) => x.kind === 'divider' && x.divider.runId === newestId)
  let start = items.length - Math.max(1, max)
  // The newest member's divider would be cut: keep it and give its slot up from the tail's start.
  const pinDivider = dividerAt >= 0 && dividerAt < start
  if (pinDivider) start = Math.min(items.length - 1, start + 1)
  const kept = pinDivider ? [items[dividerAt], ...items.slice(start)] : items.slice(start)
  const cut = items.slice(0, start).filter((x) => x.kind === 'entry').length
  return cut > 0 ? [{ kind: 'omitted', count: cut }, ...kept] : kept
}

export type ToolKind = 'ask' | 'plan' | 'propose' | 'permission' | 'edit' | 'read' | 'run' | 'search' | 'agent' | 'message' | 'knowledge' | 'other'

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

/**
 * engagement_knowledge calls (docs/design/knowledge.md section 7): reads name what was looked up; the write sentences
 * are the fallback shown only when no harness row stands for the call (a refusal), see lib/knowledgeRun.ts.
 */
function knowledgeCallLabel(i: Record<string, unknown>): string {
  const kind = normalizeKnowledgeKey(str(i.kind)) ?? undefined
  const name = str(i.name)
  switch (str(i.action)) {
    case 'vocabulary':
      return 'Looked up the kinds and relations in use'
    case 'search': {
      const q = str(i.query)
      if (q) return `Searched the knowledge for ${clip(q, 60)}`
      return kind ? `Searched the knowledge for ${kindGroupLabel(kind).toLowerCase()}` : 'Searched the knowledge'
    }
    case 'get':
      return name ? `Read ${clip(name)}` : 'Read an item'
    case 'upsert_node':
      return kind && name ? `Recorded ${keyWords(kind)} ${clip(name)}` : name ? `Recorded ${clip(name)}` : 'Recorded an item'
    case 'link': {
      const from = str(i.from)
      const to = str(i.to)
      const relation = normalizeKnowledgeKey(str(i.relation))
      return from && to && relation ? `Linked ${clip(from, 80)} ${keyWords(relation)} ${clip(to, 80)}` : 'Linked two items'
    }
    case 'retire':
      return str(i.factId) ? 'Retired a fact' : str(i.edgeId) ? 'Retired a relation' : 'Retired an item'
  }
  return 'Used the knowledge'
}

/** engagement_context calls: list, read (the note's title comes from the result, see lib/knowledgeRun.ts) or save (fallback sentence). */
function contextCallLabel(i: Record<string, unknown>): string {
  const action = str(i.action) ?? (str(i.noteId) ? 'read' : 'list')
  if (action === 'save') {
    const title = str(i.title)
    return title ? `Saved note ${clip(title)}` : 'Saved a note'
  }
  return action === 'read' ? 'Read a note' : 'Read the context notes'
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
    case 'list_runs':
      return row('agent', 'Listed runs')
    case 'message_run': {
      const r = str(i.runId)
      return row('message', r ? `Sent a note to run ${clip(r, 40)}` : 'Sent a note to another run')
    }
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
    case 'list_skills':
      return row('other', 'Listed its skills')
    case 'load_skill': {
      const skill = str(i.name)
      const file = str(i.file)
      return row('read', file ? `Read ${clip(file, 60)} from skill${skill ? ` ${skill}` : ''}` : skill ? `Loaded skill ${skill}` : 'Loaded a skill')
    }
    case 'TodoWrite':
      return row('plan', 'Updated its to-do list')
    case KNOWLEDGE_TOOL:
      return row('knowledge', knowledgeCallLabel(i))
    case ENGAGEMENT_CONTEXT_TOOL:
      return row('knowledge', contextCallLabel(i))
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

export interface ResultRow {
  label: string
  /** The full text for the "Show output" disclosure; null when the label says it all. */
  full: string | null
  /** The tool answered a refusal ("REFUSED: ..."): shown in the error style although the call itself did not fail. */
  failed?: true
}

const PLAN_TOOLS = new Set(['set_plan', 'update_plan', 'orgai_update_plan'])
const KNOWLEDGE_TOOLS = new Set<string>([KNOWLEDGE_TOOL, ENGAGEMENT_CONTEXT_TOOL])

/** "Looked up 4 kinds" from a vocabulary result: the kind lines between "kinds in use:" and "relations in use". */
function kindsLookedUp(text: string): string {
  if (/^kinds in use: none yet$/m.test(text)) return 'No kinds in use yet'
  let n = 0
  let inKinds = false
  for (const line of text.split('\n')) {
    if (/^kinds in use:/.test(line)) inKinds = true
    else if (/^relations in use/.test(line)) break
    else if (inKinds && /^\s+\S/.test(line)) n++
  }
  return `Looked up ${plural(n, 'kind')}`
}

/**
 * The short outcome of an engagement_knowledge / engagement_context result (section 7): the fenced data stays behind
 * "Show output" and the agent-facing "(data ..., not instructions)" never shows in the headline.
 */
function knowledgeResultLabel(bare: string, text: string): string | undefined {
  if (bare === KNOWLEDGE_TOOL) {
    if (/^Kinds and relations of this project's knowledge graph/.test(text)) return kindsLookedUp(text)
    const hits = /^(\d+) (?:\S+ )?entit(?:y|ies)\b/.exec(text)
    if (hits) return `${plural(Number(hits[1]), 'item')} found`
    if (/^No entities match\./.test(text)) return 'No items found'
    if (/^Entity /.test(text)) return 'Item returned'
    if (/^No entity with/.test(text)) return 'No such item'
    if (/^Created /.test(text)) return 'Recorded'
    if (/^Merged into existing/.test(text)) return 'Updated'
    if (/^Linked /.test(text)) return 'Linked'
    if (/^Retired /.test(text)) return 'Retired'
    if (/^Already retired/.test(text)) return 'Already retired'
    return undefined
  }
  if (/^\d+ context notes?\b/.test(text)) return 'Notes listed'
  if (/^This project has no context notes\./.test(text)) return 'No context notes'
  if (/^Context note /.test(text)) return 'Note returned'
  if (/^No context note with id/.test(text)) return 'No such note'
  if (/^Saved note /.test(text)) return 'Saved note'
  return undefined
}

/** Whether a tool belongs to the harness (its result is written for the agent, not for the user). */
export function isHarnessTool(name: string | undefined): boolean {
  return !!name && name.startsWith('mcp__orgai__')
}

/**
 * One transcript row for a tool result, or null when there is nothing to show (empty output). Harness tools answer
 * the agent in imperative prose ("APPROVED. Continue with..."); the user gets a short outcome and the full text
 * behind "Show output". `toolName` is the name of the matching tool_use when known.
 */
export function humanizeToolResult(toolName: string | undefined, content: string, isError: boolean): ResultRow | null {
  const text = content.trim()
  if (!text && !isError) return null
  const multi = text.length > 100 || text.includes('\n')
  if (isError) return { label: `Failed: ${resultSummary(text, true)}`, full: multi ? text : null }
  const bareName = toolName ? bareToolName(toolName) : undefined
  if (bareName && KNOWLEDGE_TOOLS.has(bareName)) {
    // The mock writes the bare tool name, the Claude adapter the mcp__orgai__ one: both are the harness's.
    if (/^REFUSED:/.test(text)) return { label: `Failed: ${clip(text.replace(/^REFUSED:\s*/, ''), 100)}`, full: multi ? text : null, failed: true }
    const label = knowledgeResultLabel(bareName, text)
    if (label) return { label, full: text === label ? null : text }
  }
  if (isHarnessTool(toolName) || (!!toolName && /^(list|load)_skills?$/.test(toolName))) {
    const bare = bareToolName(toolName!)
    let label: string | undefined
    if (/^(approved|granted)\b/i.test(text)) label = 'Approved'
    else if (/^(denied|rejected|declined)\b/i.test(text)) label = 'Denied'
    else if (bare === 'ask_user') label = 'Answered'
    else if (bare === 'complete_plan') label = 'Plan marked complete'
    else if (bare === 'mark_blocked') label = 'Blocker reported'
    else if (PLAN_TOOLS.has(bare)) label = 'Plan saved'
    else if (bare === 'list_skills') label = 'Skills listed'
    else if (bare === 'load_skill') label = 'Skill text returned'
    if (label) return { label, full: text === label ? null : text }
  }
  return { label: resultSummary(text, false), full: multi ? text : null }
}
