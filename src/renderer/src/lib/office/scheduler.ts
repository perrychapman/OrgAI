import type { AgentMessage } from '@shared/types'

export const MAX_ACTIVE = 3
export const MAX_QUEUED = 12
export const MAX_AGE = 8000
export interface Delivery { message: AgentMessage; received: number; started: number; count: number; durationMs?: number }
export interface Scheduler { seen: readonly AgentMessage[]; active: Delivery[]; queued: Delivery[] }

export function baseline(messages: readonly AgentMessage[]): Scheduler {
  return { seen: messages.slice(), active: [], queued: [] }
}

/** Store preserves object references as its capped history rolls forward. */
export function ingest(state: Scheduler, messages: readonly AgentMessage[], agents: ReadonlySet<string>, now: number, visible: boolean, reduced: boolean): Scheduler {
  let overlap = Math.min(state.seen.length, messages.length)
  while (overlap > 0 && !state.seen.slice(-overlap).every((message, i) => message === messages[i])) overlap--
  const fresh = messages.slice(overlap)
  const active = visible ? state.active.filter(d => now - d.started < (d.durationMs ?? MAX_AGE) && agents.has(d.message.from) && !!d.message.to && agents.has(d.message.to)) : []
  const queued = visible ? state.queued.filter(d => now - d.received <= MAX_AGE && agents.has(d.message.from) && !!d.message.to && agents.has(d.message.to)).map(d => ({ ...d })) : []
  if (visible) for (const message of fresh) {
    if (!message.to || !agents.has(message.from) || !agents.has(message.to)) continue
    const delivery = { message, received: now, started: now, count: 1 }
    if (active.length < MAX_ACTIVE) active.push(delivery)
    else {
      const existing = queued.find(d => d.message.from === message.from && d.message.to === message.to)
      if (existing) { existing.count++; existing.message = message; existing.received = now }
      else if (queued.length < MAX_QUEUED) queued.push(delivery)
    }
  }
  // Reduced motion still exposes the immediate delivered captions; never builds a traversal backlog.
  return { seen: messages.slice(), active, queued: reduced ? [] : queued }
}

export function finish(state: Scheduler, now: number): Scheduler {
  const active = state.active.filter(d => now - d.started < (d.durationMs ?? 2000))
  const queued = state.queued.filter(d => now - d.received < MAX_AGE)
  while (active.length < MAX_ACTIVE && queued.length) active.push({ ...queued.shift()!, started: now })
  return { ...state, active, queued }
}
