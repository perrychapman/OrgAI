import type { AgentInstance, AgentMessage } from '@shared/types'
import { ROOT_AGENT_ID } from './types'

/**
 * Agent handles and agent-to-agent messages, independent of the provider. A handle is the name other
 * agents use to address a running report (Claude: the Agent call's `name`, used by SendMessage({to})).
 * The harness names reports `<role slug>-<n>` in spawn order, per role and per run.
 */

/** How much of a message the canvas and the sender's transcript show. */
export const MESSAGE_PREVIEW_CHARS = 200

/** Per-run handle counter: implementer-1, implementer-2, reviewer-1, ... Never repeats a handle already taken. */
export class HandleNamer {
  private counters = new Map<string, number>()
  private taken = new Set<string>()

  /** The next free handle for a role slug. */
  next(slug: string): string {
    const base = slug.trim() || 'agent'
    let n = this.counters.get(base) ?? 0
    let handle: string
    do {
      n += 1
      handle = `${base}-${n}`
    } while (this.taken.has(handle))
    this.counters.set(base, n)
    this.taken.add(handle)
    return handle
  }

  /** Record a handle the model chose itself so the counter never hands it out again. */
  reserve(handle: string): void {
    this.taken.add(handle)
  }
}

/**
 * The handle for a spawn: the name the caller passed, or the next generated one. `generated` is true when
 * the harness made it up and must inject it into the spawn call.
 */
export function spawnHandle(namer: HandleNamer, slug: string, requestedName: unknown): { handle: string; generated: boolean } {
  if (typeof requestedName === 'string' && requestedName.trim()) {
    const handle = requestedName.trim()
    namer.reserve(handle)
    return { handle, generated: false }
  }
  return { handle: namer.next(slug), generated: true }
}

function textOfMessage(v: unknown): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const k of ['text', 'content', 'message', 'body']) if (typeof o[k] === 'string') return o[k] as string
    try {
      return JSON.stringify(v)
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * Address and text of a SendMessage call. Tolerant of the input shape: the address is `to` (or
 * `recipient`), the text is `message` (string or structured), else `content`, `text` or `summary`.
 */
export function readSendMessage(input: unknown): { toHandle: string; text: string } | null {
  if (!input || typeof input !== 'object') return null
  const i = input as Record<string, unknown>
  const to = typeof i.to === 'string' ? i.to : typeof i.recipient === 'string' ? i.recipient : ''
  if (!to.trim()) return null
  const raw = textOfMessage(i.message) || textOfMessage(i.content) || textOfMessage(i.text) || textOfMessage(i.summary)
  return { toHandle: to.trim(), text: raw.replace(/\s+/g, ' ').trim().slice(0, MESSAGE_PREVIEW_CHARS) }
}

const USER_ADDRESSES = new Set(['user', 'human', 'you'])

/**
 * The agent a message is addressed to: an exact handle first, then a role slug (a running agent of that
 * role, newest first, else the newest of any state). null for the user and for addresses nobody has.
 */
export function resolveRecipient(toHandle: string, agents: Iterable<AgentInstance>, fromId?: string): string | null {
  const to = toHandle.trim().toLowerCase()
  if (!to || USER_ADDRESSES.has(to)) return null
  const list = [...agents].filter((a) => a.id !== fromId)
  const byHandle = list.find((a) => a.handle?.toLowerCase() === to)
  if (byHandle) return byHandle.id
  if (to === ROOT_AGENT_ID || to === 'main' || to === 'orchestrator') {
    const root = list.find((a) => a.id === ROOT_AGENT_ID)
    if (root) return root.id
  }
  const bySlug = list.filter((a) => a.roleSlug.toLowerCase() === to).sort((a, b) => b.startedAt - a.startedAt)
  const live = bySlug.find((a) => a.state !== 'done' && a.state !== 'error')
  return (live ?? bySlug[0])?.id ?? null
}

/** The normalized message for a SendMessage call by `fromId`, or null when the call has no address. */
export function mapSendMessage(fromId: string, input: unknown, agents: Iterable<AgentInstance>, at = Date.now()): AgentMessage | null {
  const parsed = readSendMessage(input)
  if (!parsed) return null
  return { from: fromId, to: resolveRecipient(parsed.toHandle, agents, fromId), toHandle: parsed.toHandle, text: parsed.text, at }
}

/** The transcript line recorded on the sender, so the message survives in the run record. */
export function messageTranscriptText(m: AgentMessage): string {
  return `→ ${m.toHandle}: ${m.text}`
}
