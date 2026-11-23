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
