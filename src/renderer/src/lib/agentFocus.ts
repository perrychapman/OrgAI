/**
 * Pure helpers for the Agent board's one-agent view (docs/design/ui-overhaul, Agent board): the siblings and the
 * "k of n in <group>" line, the reporting chain, the delegation brief and the state pill. No store, no React.
 */
import type { AgentInstance, TranscriptEntry } from '@shared/types'
import { agentBucket, groupLeadId, type AgentBucket } from './canvasAgents'
import { agentLabel, ancestorsOf } from './agentTree'

export interface AgentSiblings {
  /** The group's name: its lead's label. Undefined for the root, which sits in no group. */
  group?: string
  /** The group's agent ids, in the order the run lists them. */
  ids: string[]
  /** 1-based position of the agent among `ids`. */
  position: number
  total: number
  prevId?: string
  nextId?: string
}

/**
 * The agents that share this one's group (the lead below the root and everyone under it, as the agent list groups
 * them). The root has no group: it is alone. Previous and next stop at the ends (no wrap).
 */
export function agentSiblings(agents: Record<string, AgentInstance>, id: string): AgentSiblings {
  const lead = groupLeadId(agents, id)
  if (!lead) return { ids: [id], position: 1, total: 1 }
  const ids = Object.values(agents)
    .filter((a) => groupLeadId(agents, a.id) === lead)
    .map((a) => a.id)
  const i = Math.max(0, ids.indexOf(id))
  return { group: agentLabel(agents[lead]), ids, position: i + 1, total: ids.length, prevId: ids[i - 1], nextId: ids[i + 1] }
}

/** "2 of 5 in Build", or "" for an agent that sits in no group. */
export function positionLabel(s: Pick<AgentSiblings, 'group' | 'position' | 'total'>): string {
  return s.group ? `${s.position} of ${s.total} in ${s.group}` : ''
}

export interface ChainLink {
  id: string
  label: string
  roleSlug: string
  roleId: string | null
  self: boolean
  /** The agent this link reports to, when it is not the root. */
  isRoot: boolean
}

/** Root first, this agent last. An agent whose parent is missing from the run starts the chain itself. */
export function whereItSits(agents: Record<string, AgentInstance>, id: string): ChainLink[] {
  const me = agents[id]
  if (!me) return []
  const up = ancestorsOf(agents, id)
  return [...up.slice().reverse(), id]
    .map((x) => agents[x])
    .filter((a): a is AgentInstance => !!a)
    .map((a) => ({ id: a.id, label: agentLabel(a), roleSlug: a.roleSlug, roleId: a.roleId, self: a.id === id, isRoot: a.id === 'root' || !a.parentId }))
}

export interface AgentBrief {
  text: string
  /** The agent that wrote it (the one whose tool call spawned this agent). */
  fromId: string
  at: number
}

const BRIEF_KEYS = ['prompt', 'task', 'instructions', 'message', 'description'] as const

/**
 * The delegation prompt: the input of the tool call (`agent.spawnToolUseId`) that spawned this agent. Undefined when
 * the transcript has no such call or it carries no text; the caller then hides the box. Text is data, never markup.
 */
export function extractBrief(entries: readonly TranscriptEntry[], agent: Pick<AgentInstance, 'spawnToolUseId'>): AgentBrief | undefined {
  const want = agent.spawnToolUseId
  if (!want) return undefined
  for (const e of entries) {
    if (e.block.kind !== 'tool_use' || e.block.id !== want) continue
    const input = e.block.input
    if (typeof input === 'string') return input.trim() ? { text: input.trim(), fromId: e.agentId, at: e.at } : undefined
    if (!input || typeof input !== 'object') return undefined
    const rec = input as Record<string, unknown>
    for (const k of BRIEF_KEYS) {
      const v = rec[k]
      if (typeof v === 'string' && v.trim()) return { text: v.trim(), fromId: e.agentId, at: e.at }
    }
    return undefined
  }
  return undefined
}

export type FocusStateKind = 'working' | 'waiting' | 'done' | 'failed' | 'idle'

export const FOCUS_STATE_LABEL: Record<FocusStateKind, string> = {
  working: 'Working',
  waiting: 'Needs you',
  done: 'Done',
  failed: 'Failed',
  idle: 'Idle'
}

/** The pill an agent wears; waiting wins over working (an open card, or the waiting state). */
export function focusState(agent: Pick<AgentInstance, 'id' | 'state'>, waiting: ReadonlySet<string>): FocusStateKind {
  const b: AgentBucket = agentBucket(agent, waiting)
  return b === 'other' ? 'idle' : b
}

/** Up to two capital letters: "Implementer 2" -> "I2", "Lead implementer" -> "LI", "qa" -> "Q". */
export function agentInitials(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return Array.from(words[0])[0].toUpperCase()
  return (Array.from(words[0])[0] + Array.from(words[1])[0]).toUpperCase()
}

/** The entries one agent wrote or was shown (its own transcript lines). */
export function entriesOfAgent(transcript: readonly TranscriptEntry[], agentId: string): TranscriptEntry[] {
  return transcript.filter((e) => e.agentId === agentId)
}

export interface DiffFile {
  path: string
  added: number
  removed: number
  /** Hunk headers and changed / context lines, each starting "@", "+", "-" or " ". File headers are dropped. */
  lines: string[]
}

/** A diff block shows this many lines before the "Show all N lines" toggle. */
export const DIFF_LINE_CAP = 40

/**
 * Splits a unified diff (git's `diff --git` form) into per-file blocks with +/- counts. Lines before the first
 * `diff --git` are ignored; "\ No newline" markers are dropped. Never throws: unparseable input gives [].
 */
export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  let cur: DiffFile | undefined
  let inHunk = false
  const rows = patch.replace(/\n$/, '').split('\n')
  for (const raw of rows) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
      cur = { path: m ? m[2] : line.slice(11), added: 0, removed: 0, lines: [] }
      files.push(cur)
      inHunk = false
      continue
    }
    if (!cur) continue
    if (!inHunk) {
      if (line.startsWith('@@')) {
        inHunk = true
        cur.lines.push(line)
      } else if (line.startsWith('Binary files')) cur.lines.push(' ' + line)
      continue
    }
    if (line.startsWith('@@')) cur.lines.push(line)
    else if (line.startsWith('+')) {
      cur.added++
      cur.lines.push(line)
    } else if (line.startsWith('-')) {
      cur.removed++
      cur.lines.push(line)
    } else if (line.startsWith(' ')) cur.lines.push(line)
    else if (line === '') cur.lines.push(' ')
  }
  return files
}

/**
 * What a key press in the agent message box does. Ctrl+Enter (Cmd+Enter) sends once; its key repeats are swallowed (they
 * must not insert a newline either) and never send: after a failed send the text is kept, so a held chord would
 * otherwise send it again on every repeat.
 */
export function messageKeyAction(e: { key: string; ctrlKey: boolean; metaKey: boolean; repeat: boolean }): 'send' | 'swallow' | null {
  if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return null
  return e.repeat ? 'swallow' : 'send'
}
