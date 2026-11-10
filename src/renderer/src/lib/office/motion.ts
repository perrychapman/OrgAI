export interface Point { x: number; y: number }
export interface JourneyTiming { stepMs: number; settleMs: number; maxMs: number }
export const DEFAULT_JOURNEY_TIMING: JourneyTiming = { stepMs: 120, settleMs: 240, maxMs: 10000 }
export type Direction = 'up' | 'down' | 'left' | 'right'
export type JourneyPhase = 'outbound' | 'settle' | 'return' | 'done'

export function journeyDuration(path: readonly Point[], timing = DEFAULT_JOURNEY_TIMING): number | null {
  if (path.length < 2 || path.some((p, i) => i > 0 && Math.abs(p.x - path[i - 1].x) + Math.abs(p.y - path[i - 1].y) !== 1)) return null
  const duration = (path.length - 1) * timing.stepMs * 2 + timing.settleMs
  return duration <= timing.maxMs ? duration : null
}

function facing(a: Point, b: Point): Direction {
  return b.x > a.x ? 'right' : b.x < a.x ? 'left' : b.y > a.y ? 'down' : 'up'
}

/** Source-pixel positions: one tile per step, with an honest arrival and the same route home. */
export function sampleJourney(path: readonly Point[], elapsed: number, timing = DEFAULT_JOURNEY_TIMING): { x: number; y: number; direction: Direction; pose: 'walk-1' | 'walk-2' | 'idle'; phase: JourneyPhase } {
  const leg = Math.max(0, path.length - 1) * timing.stepMs
  const t = Math.max(0, elapsed)
  const phase: JourneyPhase = t < leg ? 'outbound' : t < leg + timing.settleMs ? 'settle' : t < leg * 2 + timing.settleMs ? 'return' : 'done'
  if (path.length < 2) return { x: (path[0]?.x ?? 0) * 16, y: (path[0]?.y ?? 0) * 16, direction: 'down', pose: 'idle', phase: 'done' }
  if (phase === 'settle') return { x: path.at(-1)!.x * 16, y: path.at(-1)!.y * 16, direction: facing(path.at(-2)!, path.at(-1)!), pose: 'idle', phase }
  if (phase === 'done') return { x: path[0].x * 16, y: path[0].y * 16, direction: facing(path[1], path[0]), pose: 'idle', phase }
  const points = phase === 'return' ? [...path].reverse() : path
  const progress = (phase === 'return' ? t - leg - timing.settleMs : t) / timing.stepMs
  const index = Math.min(points.length - 2, Math.floor(progress))
  const fraction = progress - index
  const a = points[index]; const b = points[index + 1]
  return { x: Math.round((a.x + (b.x - a.x) * fraction) * 16), y: Math.round((a.y + (b.y - a.y) * fraction) * 16), direction: facing(a, b), pose: index % 2 ? 'walk-2' : 'walk-1', phase }
}

/** Reserve a full target-width corridor for the whole decorative round trip. */
export function routesConflict(a: readonly Point[], b: readonly Point[]): boolean {
  return a.some(p => b.some(q => Math.abs(p.x - q.x) < 2 && Math.abs(p.y - q.y) < 3))
}

// ---- Message walks (S5a). One building, no floors: a route either fits the time budget or there is no walk. ----

export type MessageWalkKind = 'full' | 'doorway'

/**
 * Full round trip when it fits `timing.maxMs`; otherwise only to the sender's own doorway and back when that fits; otherwise null
 * (empty, discontinuous or too long: bubble and mark only, never a fabricated path or a teleport). Caps and pinned people are the
 * caller's concern (see `MAX_WALKS` / `admitArrivals`): a blocked or capped walk simply never asks for a plan.
 */
export function planMessageWalk(fullPath: readonly Point[], doorwayPath: readonly Point[], timing: JourneyTiming = DEFAULT_JOURNEY_TIMING): { path: Point[]; kind: MessageWalkKind } | null {
  if (journeyDuration(fullPath, timing) !== null) return { path: fullPath.slice(), kind: 'full' }
  if (journeyDuration(doorwayPath, timing) !== null) return { path: doorwayPath.slice(), kind: 'doorway' }
  return null
}

/** Outbound leg in ms: the recipient's bubble starts when the sender arrives (the settle), i.e. `started + outboundDuration(path)`. */
export function outboundDuration(path: readonly Point[], timing: JourneyTiming = DEFAULT_JOURNEY_TIMING): number {
  return Math.max(0, path.length - 1) * timing.stepMs
}

export interface BubbleTiming { baseMs: number; perCharMs: number; maxMs: number }
export const DEFAULT_BUBBLE_TIMING: BubbleTiming = { baseMs: 1500, perCharMs: 45, maxMs: 6000 }
/** Ticks the sender's talk mark shows when there is no walk (1.2 s at 120 ms). */
export const TALK_MARK_TICKS = 10
export const BUBBLE_MAX_CHARS = 80

/** Text as shown in a bubble: trimmed, at most 80 characters (by code point) plus an ellipsis. */
export function bubbleText(text: string): string {
  const trimmed = text.trim()
  // Slice before splitting so a very long message costs O(80), not O(length): 2 x (80 + 1) UTF-16 units always hold
  // at least 81 code points when the text is longer than that, which is enough to know it must be cut.
  const chars = Array.from(trimmed.length > 2 * (BUBBLE_MAX_CHARS + 1) ? trimmed.slice(0, 2 * (BUBBLE_MAX_CHARS + 1)) : trimmed)
  return chars.length > BUBBLE_MAX_CHARS ? `${chars.slice(0, BUBBLE_MAX_CHARS).join('').trimEnd()}…` : chars.join('')
}

/** Readable time: base + perChar x displayed characters, clamped to max. With the defaults the longest bubble (81 characters) is 5145 ms, so the 6000 ms clamp only guards custom timing. */
export function bubbleDurationMs(text: string, t: BubbleTiming = DEFAULT_BUBBLE_TIMING): number {
  return Math.min(t.maxMs, t.baseMs + t.perCharMs * Array.from(bubbleText(text)).length)
}

// ---- Arrival (S3). A new agent walks in along the building route, sits two ticks, then runs its state loop. ----

export interface ArrivalTiming { stepMs: number; sitMs: number; maxMs: number }
export const DEFAULT_ARRIVAL_TIMING: ArrivalTiming = { stepMs: 120, sitMs: 240, maxMs: 8000 }
export type ArrivalPhase = 'arrive' | 'sit' | 'done'

function continuous(path: readonly Point[]): boolean {
  return path.length >= 2 && path.every((p, i) => i === 0 || Math.abs(p.x - path[i - 1].x) + Math.abs(p.y - path[i - 1].y) === 1)
}

/** Walking time one way, or null for an empty, discontinuous or over-budget path. */
export function arrivalWalkMs(path: readonly Point[], timing: ArrivalTiming = DEFAULT_ARRIVAL_TIMING): number | null {
  if (!continuous(path)) return null
  const ms = (path.length - 1) * timing.stepMs
  return ms <= timing.maxMs ? ms : null
}

/** Path runs from the entrance to the desk anchor. Front door first, then the room's own doorway, else null (appears at the desk). */
export function planArrival(fullPath: readonly Point[], doorwayPath: readonly Point[], timing: ArrivalTiming = DEFAULT_ARRIVAL_TIMING): { path: Point[]; from: 'door' | 'doorway' } | null {
  if (arrivalWalkMs(fullPath, timing) !== null) return { path: fullPath.slice(), from: 'door' }
  if (arrivalWalkMs(doorwayPath, timing) !== null) return { path: doorwayPath.slice(), from: 'doorway' }
  return null
}

/** Total arrival: walk plus sit. */
export function arrivalDuration(path: readonly Point[], timing: ArrivalTiming = DEFAULT_ARRIVAL_TIMING): number | null {
  const walk = arrivalWalkMs(path, timing)
  return walk === null ? null : walk + timing.sitMs
}

/** Source pixels (16 per tile). Seated pose after the walk is `idle` facing `up`; the state loop takes over at phase `done`. */
export function sampleArrival(path: readonly Point[], elapsedMs: number, timing: ArrivalTiming = DEFAULT_ARRIVAL_TIMING): { x: number; y: number; direction: Direction; pose: 'walk-1' | 'walk-2' | 'idle'; phase: ArrivalPhase; cue: 'arriving' | 'none' } {
  if (path.length < 2) return { x: (path[0]?.x ?? 0) * 16, y: (path[0]?.y ?? 0) * 16, direction: 'up', pose: 'idle', phase: 'done', cue: 'none' }
  const leg = (path.length - 1) * timing.stepMs
  const t = Math.max(0, elapsedMs)
  const last = path[path.length - 1]
  if (t >= leg) return { x: last.x * 16, y: last.y * 16, direction: 'up', pose: 'idle', phase: t < leg + timing.sitMs ? 'sit' : 'done', cue: 'none' }
  const progress = t / timing.stepMs
  const index = Math.min(path.length - 2, Math.floor(progress))
  const fraction = progress - index
  const a = path[index]; const b = path[index + 1]
  return { x: Math.round((a.x + (b.x - a.x) * fraction) * 16), y: Math.round((a.y + (b.y - a.y) * fraction) * 16), direction: facing(a, b), pose: index % 2 ? 'walk-2' : 'walk-1', phase: 'arrive', cue: 'arriving' }
}

/** Ids not yet known to the scene. Agents present at mount, run switch or resume go into `known` first, so they appear settled. */
export function freshIds(known: ReadonlySet<string>, ids: readonly string[]): string[] {
  return ids.filter(id => !known.has(id))
}

// ---- Walk admission shared by arrivals and message walks. ----

/** At most three walks (arrivals and message walks together). */
export const MAX_WALKS = 3
export const MAX_ARRIVAL_QUEUE = 6
export const ARRIVAL_QUEUE_GAP_MS = 480
/** A queued arrival that has waited this long appears at its desk instead. */
export const ARRIVAL_QUEUE_EXPIRY_MS = 8000

export interface ArrivalQueue { queued: readonly { id: string; since: number }[]; lastStartMs: number }
export const emptyArrivalQueue: ArrivalQueue = { queued: [], lastStartMs: Number.NEGATIVE_INFINITY }

/**
 * Admit newly seen agents. `activeWalks` counts every walk in progress, message walks included. Free slots start at once, up to 6
 * more queue, the rest are listed in `desk` (appear at the desk). Order is the order given.
 */
export function admitArrivals(queue: ArrivalQueue, ids: readonly string[], now: number, activeWalks: number): { queue: ArrivalQueue; start: string[]; desk: string[] } {
  const start: string[] = []; const desk: string[] = []; const queued = queue.queued.slice()
  let walks = activeWalks
  for (const id of ids) {
    if (queued.length === 0 && walks < MAX_WALKS) { start.push(id); walks++ }
    else if (queued.length < MAX_ARRIVAL_QUEUE) queued.push({ id, since: now })
    else desk.push(id)
  }
  return { queue: { queued, lastStartMs: start.length ? now : queue.lastStartMs }, start, desk }
}

/**
 * Release queued arrivals: one per call when a walk slot is free and 480 ms have passed since the last start; drop agents that left
 * and send entries older than 8 s to their desk.
 */
export function releaseArrivals(queue: ArrivalQueue, now: number, activeWalks: number, present: ReadonlySet<string>): { queue: ArrivalQueue; start: string[]; desk: string[] } {
  const desk: string[] = []
  let queued = queue.queued.filter(q => {
    if (!present.has(q.id)) return false
    if (now - q.since >= ARRIVAL_QUEUE_EXPIRY_MS) { desk.push(q.id); return false }
    return true
  })
  const start: string[] = []
  let lastStartMs = queue.lastStartMs
  if (queued.length && activeWalks < MAX_WALKS && now - lastStartMs >= ARRIVAL_QUEUE_GAP_MS) {
    start.push(queued[0].id); queued = queued.slice(1); lastStartMs = now
  }
  return { queue: { queued, lastStartMs }, start, desk }
}
