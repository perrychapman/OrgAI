import type { AgentMessage } from '@shared/types'
import { bubbleDurationMs, TALK_MARK_TICKS } from './motion'

/** Also the bubble cap: at most three bubbles (and three walks) at once; further messages go to the strip log only. */
export const MAX_ACTIVE = 3
export const MAX_QUEUED = 12
export const MAX_AGE = 8000

/**
 * `started` is when the delivery went live (the walk begins then). `durationMs` is the walk's round trip when a walk was admitted.
 * `bubbleStart` (default `started`) is when the recipient's bubble shows, the walk's settle; `bubbleMs` (default
 * `bubbleDurationMs(text)`) is how long it shows. The delivery lives until both the walk and the bubble are over.
 */
export interface Delivery { message: AgentMessage; received: number; started: number; count: number; durationMs?: number; bubbleStart?: number; bubbleMs?: number }
export interface Scheduler { seen: readonly AgentMessage[]; active: Delivery[]; queued: Delivery[] }

export function baseline(messages: readonly AgentMessage[]): Scheduler {
  return { seen: messages.slice(), active: [], queued: [] }
}

export function bubbleWindow(d: Delivery): { start: number; end: number } {
  const start = d.bubbleStart ?? d.started
  return { start, end: start + (d.bubbleMs ?? bubbleDurationMs(d.message.text)) }
}

/** Absolute end of a delivery: the later of the walk's return and the bubble's end. */
export function deliveryEnd(d: Delivery): number {
  return Math.max(d.started + (d.durationMs ?? 0), bubbleWindow(d).end)
}

/** Record an admitted walk: the bubble starts when the sender arrives (`outboundMs` after `now`). */
export function attachWalk(d: Delivery, now: number, durationMs: number, outboundMs: number): void {
  d.started = now; d.durationMs = durationMs; d.bubbleStart = now + outboundMs
}

/** Deliveries whose bubble shows now: newest per recipient, at most MAX_ACTIVE. */
export function activeBubbles(state: Scheduler, now: number): Delivery[] {
  const byRecipient = new Map<string, Delivery>()
  for (const d of state.active) {
    const to = d.message.to
    if (!to) continue
    const { start, end } = bubbleWindow(d)
    if (now < start || now >= end) continue
    const current = byRecipient.get(to)
    if (!current || bubbleWindow(current).start <= start) byRecipient.set(to, d)
  }
  return [...byRecipient.values()].slice(0, MAX_ACTIVE)
}

/** Sender ids showing the talk mark: during the outbound walk, or TALK_MARK_TICKS (stepMs each) from the start when there is no walk. */
export function activeTalkers(state: Scheduler, now: number, stepMs = 120): Set<string> {
  const ids = new Set<string>()
  for (const d of state.active) {
    const end = d.durationMs === undefined ? d.started + TALK_MARK_TICKS * stepMs : bubbleWindow(d).start
    if (now >= d.started && now < end) ids.add(d.message.from)
  }
  return ids
}

const endpointsPresent = (d: Delivery, agents: ReadonlySet<string>): boolean => agents.has(d.message.from) && !!d.message.to && agents.has(d.message.to)

/** Store preserves object references as its capped history rolls forward. */
export function ingest(state: Scheduler, messages: readonly AgentMessage[], agents: ReadonlySet<string>, now: number, visible: boolean, reduced: boolean): Scheduler {
  let overlap = Math.min(state.seen.length, messages.length)
  while (overlap > 0 && !state.seen.slice(-overlap).every((message, i) => message === messages[i])) overlap--
  const fresh = messages.slice(overlap)
  const active = visible ? state.active.filter(d => now < deliveryEnd(d) && endpointsPresent(d, agents)) : []
  const queued = visible ? state.queued.filter(d => now - d.received <= MAX_AGE && endpointsPresent(d, agents)).map(d => ({ ...d })) : []
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
  // Reduced motion still shows the bubble for its readable time; it never builds a traversal backlog.
  return { seen: messages.slice(), active, queued: reduced ? [] : queued }
}

/** Drop deliveries whose walk and bubble are both over, then promote queued ones (not past the 8 s queue expiry) into the free slots. */
export function finish(state: Scheduler, now: number): Scheduler {
  const active = state.active.filter(d => now < deliveryEnd(d))
  const queued = state.queued.filter(d => now - d.received < MAX_AGE)
  // Queued deliveries never carry walk or bubble fields (only admitted ones do), so promotion starts a clean lifetime.
  while (active.length < MAX_ACTIVE && queued.length) active.push({ ...queued.shift()!, started: now })
  return { ...state, active, queued }
}
