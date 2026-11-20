// Factory Floor event cues (docs/design/factory-floor.md sections 1.4, 5.2 to 5.4). Pure: no three, no DOM, no clock of
// its own (every call takes `now`). Slice 4 contract (UI Lead): signatures fixed here; implemented by the Scene
// Engineer (4a) with tests on a fixed clock (cues.test.ts).
import { GANTRY_TOP } from './layout'
import {
  ARRIVE_CAP,
  ARRIVE_MS,
  ARRIVE_WINDOW_MS,
  BARRIER_MS,
  CANCEL_FADE_MS,
  CAPSULE_COALESCE_MS,
  CAPSULE_MAX_MS,
  CAPSULE_MIN_MS,
  CAPSULE_QUEUE,
  CAPSULE_ROOF_MS,
  CAPSULE_ROOF_RISE,
  CAPSULE_SPEED,
  CARRIER_CAP,
  CARRIER_PER_SENDER,
  CRATE_CAP,
  CRATE_MAX_MS,
  CRATE_MIN_MS,
  CRATE_SPEED,
  HALL_MS,
  LEAVE_MS,
  PART_CAP,
  PART_MS,
  POSE_MS,
  SHUTTER_MS,
  TOTE_MAX_MS,
  TOTE_MIN_MS,
  TOTE_SPEED,
  travelMs
} from './motion'
import { DOCK_SLOTS, dockSlot, holdPad, outfeedPad } from './routes'
import type { ActiveCue, Cue, CueRequest, FactoryAgentInput, FactoryTestState, FloorEvent, FloorFrame, FloorLayout, Vec2 } from './types'

type Message = FloorFrame['messages'][number]

/** Section 5.4 message key: `{at}|{from}|{to}|{text first 32 chars}` (to null is the empty string). */
export function messageKey(m: Message): string {
  return `${m.at}|${m.from}|${m.to ?? ''}|${m.text.slice(0, 32)}`
}

/** The cursor at mount (or run id change): the key of the newest message, or null when there is none. */
export function messageCursor(messages: FloorFrame['messages']): string | null {
  const last = messages[messages.length - 1]
  return last ? messageKey(last) : null
}

/**
 * Section 5.4: the messages after `cursor`. A null cursor means "no message existed at mount", so every message is new.
 * When the cursor's message is still in the list, everything after it is new (the list is in arrival order). When it
 * has fallen out of the store's last 100, a message is new only if its `at` is later than the cursor's, or equal with a
 * greater key: older messages never replay. A malformed cursor (no numeric `at`) yields nothing.
 */
export function messagesAfter(messages: FloorFrame['messages'], cursor: string | null): Message[] {
  if (cursor === null) return messages.slice()
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messageKey(messages[i]) === cursor) return messages.slice(i + 1)
  }
  const bar = cursor.indexOf('|')
  const cAt = Number(bar < 0 ? NaN : cursor.slice(0, bar))
  if (!Number.isFinite(cAt)) return []
  return messages.filter((m) => m.at > cAt || (m.at === cAt && messageKey(m) > cursor))
}

export interface FloorDiff {
  /** Cues for this change, durations resolved, in push order. Never anything already true at `prev`. */
  cues: CueRequest[]
  /** Floor log and announcement events (section 6.5, 7.5). */
  events: FloorEvent[]
  /** The new message cursor (the newest message seen). */
  cursor: string | null
}

interface Anchor {
  p: Vec2
  y: number
}

/** A placed station's world anchor: its centre, on the gantry (y GANTRY_TOP) for the booth, else the floor (y 0). */
function anchor(layout: FloorLayout, id: string): Anchor | null {
  const st = layout.stations[id]
  if (!st) return null
  return { p: { x: st.center.x, z: st.center.z }, y: st.kind === 'booth' ? GANTRY_TOP : 0 }
}

const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.z - a.z)
const at = (a: Anchor): NonNullable<CueRequest['path']> => ({ from: { ...a.p }, to: { ...a.p }, fromY: a.y, toY: a.y })
const span = (a: Vec2, ay: number, b: Vec2, by: number): NonNullable<CueRequest['path']> => ({ from: { ...a }, to: { ...b }, fromY: ay, toY: by })

/**
 * Section 1.4 and 5.4: what changed between `prev` and `next`. `prev === null` is mount (or a run id change): returns no
 * cues and no events, only the cursor of the newest message (everything present is the baseline). Team mode returns
 * nothing and keeps the cursor. Every cue traces to a row of section 1.4:
 * - a new station (in next's layout, not in prev's): the root's booth gets a 'started' event and no cue (it lights in
 *   one frame); any other station an 'assigned' event (when its parent is known) and an 'arrive' cue, preceded by a
 *   parent-to-child 'tote' when the parent is on the floor (the arrive waits `delay` = the tote's duration);
 * - a station gone from the layout: a 'leave' cue and a 'left' event (no log line; the scene calls cancelFor);
 * - tool calls up: one 'part' with count = the increase; pose, shutter and barrier changes: their cues;
 * - worktree status changes: merged (crate to the dock slot or the parent's pad, 'merged' event), conflict / held
 *   (crate slides to the hold pad), and 'branch' events for conflict, review, held and empty;
 * - status word changes: 'state'; plan done / total changes: 'plan'; hall changes: a 'hall' cue and a 'run' event;
 * - messages after the cursor: a 'message' event each and, when the sender is on the floor, one 'capsule' each (to the
 *   recipient's station when it is on the floor, else to null: it rises into the roof).
 * Station-local cues carry path.from = path.to = the station anchor. `now` stamps events.
 */
export function diffCues(prev: FloorFrame | null, next: FloorFrame, cursor: string | null, now = Date.now()): FloorDiff {
  if (next.model.mode !== 'live') return { cues: [], events: [], cursor }
  if (prev === null) return { cues: [], events: [], cursor: messageCursor(next.messages) }

  const cues: CueRequest[] = []
  const events: FloorEvent[] = []
  const pl = prev.model.layout
  const nl = next.model.layout
  const prevAgents = new Map<string, FactoryAgentInput>(prev.agents.map((a) => [a.id, a]))
  const nextAgents = new Map<string, FactoryAgentInput>(next.agents.map((a) => [a.id, a]))
  const nameOf = (id: string): string =>
    next.model.workers[id]?.name ?? nextAgents.get(id)?.name ?? prev.model.workers[id]?.name ?? prevAgents.get(id)?.name ?? id

  // Agent removed: leave cue at its old anchor, 'left' event.
  for (const id of pl.order) {
    if (nl.stations[id]) continue
    const a = anchor(pl, id)
    if (a) cues.push({ kind: 'leave', from: id, duration: LEAVE_MS, path: at(a) })
    events.push({ kind: 'left', at: now, id, name: nameOf(id) })
  }

  // New stations, in reading order (a parent placed in the same change comes first).
  for (const id of nl.order) {
    if (pl.stations[id]) continue
    const st = nl.stations[id]
    const child = anchor(nl, id)
    if (!st || !child) continue
    if (st.kind === 'booth') {
      events.push({ kind: 'started', at: now, name: nameOf(id) })
      continue
    }
    const parentId = nextAgents.get(id)?.parentId ?? null
    if (parentId !== null && (nextAgents.has(parentId) || prevAgents.has(parentId) || next.model.workers[parentId])) {
      events.push({ kind: 'assigned', at: now, parent: nameOf(parentId), child: nameOf(id), childId: id })
    }
    const parent = parentId !== null && parentId !== id ? anchor(nl, parentId) : null
    if (parent && parentId !== null) {
      const duration = travelMs(dist(parent.p, child.p), TOTE_SPEED, TOTE_MIN_MS, TOTE_MAX_MS)
      cues.push({ kind: 'tote', from: parentId, to: id, duration, path: span(parent.p, parent.y, child.p, child.y) })
      cues.push({ kind: 'arrive', from: id, duration: ARRIVE_MS, delay: duration, path: at(child) })
    } else {
      cues.push({ kind: 'arrive', from: id, duration: ARRIVE_MS, path: at(child) })
    }
  }

  // Changes on stations present in both frames, in reading order.
  let dockIndex = prev.model.dockCrates
  for (const id of nl.order) {
    if (!pl.stations[id]) continue
    const a = anchor(nl, id)
    const pw = prev.model.workers[id]
    const nw = next.model.workers[id]
    if (!a || !pw || !nw) continue
    const pa = prevAgents.get(id)
    const na = nextAgents.get(id)

    if (pa && na && na.toolCalls > pa.toolCalls) {
      cues.push({ kind: 'part', from: id, count: na.toolCalls - pa.toolCalls, duration: PART_MS, path: at(a) })
    }
    if (pw.pose !== nw.pose) cues.push({ kind: 'pose', from: id, pose: { from: pw.pose, to: nw.pose }, duration: POSE_MS, path: at(a) })
    if (pw.shutter !== nw.shutter) cues.push({ kind: 'shutter', from: id, lower: nw.shutter, duration: SHUTTER_MS, path: at(a) })
    if (pw.barrier !== nw.barrier) cues.push({ kind: 'barrier', from: id, lower: nw.barrier, duration: BARRIER_MS, path: at(a) })

    if (pw.statusWord !== nw.statusWord) events.push({ kind: 'state', at: now, id, name: nw.name, word: nw.statusWord })

    const ps = pa?.worktree?.status
    const nwt = na?.worktree
    if (nwt && nwt.status !== ps) {
      // The crate starts where it stood: on the hold pad after a conflict or hold, else on the outfeed pad.
      const onHold = pw.crate?.at === 'hold' || pw.crate?.at === 'hold-striped'
      const start = onHold ? holdPad(a.p) : outfeedPad(a.p)
      const crate = (to: Vec2, toY: number, extra: Partial<CueRequest>): void => {
        cues.push({
          kind: 'crate',
          from: id,
          duration: travelMs(dist(start, to), CRATE_SPEED, CRATE_MIN_MS, CRATE_MAX_MS),
          path: span(start, a.y, to, toY),
          ...extra
        })
      }
      switch (nwt.status) {
        case 'merged': {
          if (nwt.mergeTarget === 'main') {
            const slot = dockIndex++
            const p = dockSlot(slot, nl.dock)
            crate(p ?? nl.dock, GANTRY_TOP, { to: 'dock', dest: 'dock', ...(p && slot < DOCK_SLOTS ? { slot } : {}) })
            events.push({ kind: 'merged', at: now, name: nw.name, into: 'main' })
          } else {
            const parentId = na?.parentId ?? null
            const parent = parentId !== null ? anchor(nl, parentId) : null
            if (parent && parentId !== null) crate(outfeedPad(parent.p), parent.y, { to: parentId, dest: 'parent-pad' })
            events.push({ kind: 'merged', at: now, name: nw.name, into: parentId !== null ? nameOf(parentId) : 'main' })
          }
          break
        }
        case 'conflict':
        case 'held':
          if (!onHold) crate(holdPad(a.p), a.y, { dest: 'hold' })
          events.push({ kind: 'branch', at: now, id, name: nw.name, status: nwt.status })
          break
        case 'review':
        case 'empty':
          events.push({ kind: 'branch', at: now, id, name: nw.name, status: nwt.status })
          break
        default:
          break
      }
    }
  }

  // Messages after the cursor.
  const fresh = messagesAfter(next.messages, cursor)
  for (const m of fresh) {
    const recipientOnFloor = m.to !== null && nl.stations[m.to] !== undefined
    const recipientKnown = m.to !== null && (nextAgents.has(m.to) || prevAgents.has(m.to))
    const recipient = m.to !== null && recipientKnown ? nameOf(m.to) : (m.toHandle ?? m.to ?? 'unknown')
    events.push({ kind: 'message', at: now, sender: nameOf(m.from), recipient, text: m.text, offFloor: !recipientOnFloor })
    const from = anchor(nl, m.from)
    if (!from) continue
    const to = recipientOnFloor && m.to !== null ? anchor(nl, m.to) : null
    if (to && m.to !== null) {
      const duration = travelMs(dist(from.p, to.p), CAPSULE_SPEED, CAPSULE_MIN_MS, CAPSULE_MAX_MS)
      cues.push({ kind: 'capsule', from: m.from, to: m.to, count: 1, duration, path: span(from.p, from.y, to.p, to.y) })
    } else {
      cues.push({ kind: 'capsule', from: m.from, to: null, count: 1, duration: CAPSULE_ROOF_MS, path: span(from.p, from.y, from.p, from.y + CAPSULE_ROOF_RISE) })
    }
  }
  const newCursor = fresh.length > 0 ? messageKey(fresh[fresh.length - 1]) : cursor

  // Plan board counts.
  const pb = prev.model.board
  const nb = next.model.board
  if (nb && (!pb || pb.done !== nb.done || pb.total !== nb.total)) events.push({ kind: 'plan', at: now, done: nb.done, total: nb.total })

  // Hall: paused, resumed (from paused or ended), ended.
  const ph = prev.model.hall
  const nh = next.model.hall
  if (ph !== nh) {
    cues.push({ kind: 'hall', hall: { from: ph, to: nh }, duration: HALL_MS })
    events.push({ kind: 'run', at: now, status: nh === 'paused' ? 'paused' : nh === 'ended' ? 'ended' : 'resumed' })
  }

  return { cues, events, cursor: newCursor }
}

// ---- Scheduler ----

interface Entry {
  cue: Cue
  /** Push time (capsule coalescing window). */
  pushedAt: number
  cancelledAt?: number
  frozen?: number
}
interface Queued {
  req: CueRequest
  pushedAt: number
}

const RECENT_CAP = 40
const isCarrier = (k: CueRequest['kind']): boolean => k === 'tote' || k === 'capsule'
const sameTarget = (a: CueRequest, b: CueRequest): boolean => (a.to ?? null) === (b.to ?? null)

/**
 * Owns every transient cue (section 5.3). push applies caps and coalescing (carrier 6 and 2 per sender, capsule
 * coalescing within 800 ms and a queue of 12, part 1 in flight plus 1 queued per station and 12 global, crate 4 with the
 * rest landing at once, 12 arrivals per 1 s window), assigns ids and absolute start times. advance returns the active
 * cues (progress 0 to 1, opacity) and starts queued ones as room frees. cancelFor ends cues to or from a worker where they
 * are with a CANCEL_FADE_MS fade and drops its queued ones. finishAll ends everything at once (pause, end, hidden,
 * reduced motion). The scheduler never replays: a new scheduler starts empty.
 *
 * Details the spec left open (docs/design/factory-floor.md Slice 4 implementation notes):
 * - A cue waiting for its delay (an arrive behind its tote) is returned by advance with progress 0.
 * - A tote that cannot fly (carrier caps) is dropped, and the arrive pushed after it for the same station starts at once.
 *   Totes never queue.
 * - Capsules over the carrier caps queue (at most CAPSULE_QUEUE, oldest dropped). A capsule coalesces into a queued one
 *   with the same sender and recipient at any time, or into an in-flight one pushed within CAPSULE_COALESCE_MS.
 * - A part for a station with one in flight adds its count to that station's queued part. A part that finds the global
 *   cap of 12 full is dropped (parts are "just happened" cues; a late part would misplace the moment), and so is a
 *   queued part that finds it full when its station frees.
 * - Crates over the cap and arrivals over 12 in any 1 s window (sliding, by start time) are dropped: they land or appear
 *   at once.
 * - Cancelled (fading) cues no longer count against any cap. 'leave' cues are never cancelled.
 * - `started` and recent() count a cue when it starts or is scheduled with its delay, so dropped ones never count and
 *   coalesced ones count once.
 */
export class CueScheduler {
  /** Cues accepted since construction (the test state's `cuesStarted`). */
  started = 0
  private active: Entry[] = []
  private capsuleQueue: Queued[] = []
  private partQueue = new Map<string, Queued>()
  private arriveStarts: number[] = []
  private recentCues: Cue[] = []
  private seq = 0
  private peak = { carriers: 0, perSender: 0, parts: 0, crates: 0, arrivalsPerSecond: 0 }

  push(cues: readonly CueRequest[], now: number): void {
    this.prune(now)
    const totesDropped = new Set<string>()
    for (const req of cues) {
      switch (req.kind) {
        case 'tote':
          if (this.carrierRoom(req.from)) this.start(req, now, now)
          else if (typeof req.to === 'string') totesDropped.add(req.to)
          break
        case 'capsule':
          this.pushCapsule(req, now)
          break
        case 'part':
          this.pushPart(req, now)
          break
        case 'crate':
          if (this.count((e) => e.cue.kind === 'crate') < CRATE_CAP) this.start(req, now, now)
          break
        case 'arrive': {
          const delay = req.from !== undefined && totesDropped.has(req.from) ? 0 : Math.max(0, req.delay ?? 0)
          const s = now + delay
          const inWindow = this.arrivalWindowMax(s)
          if (inWindow + 1 > ARRIVE_CAP) break
          this.arriveStarts.push(s)
          this.peak.arrivalsPerSecond = Math.max(this.peak.arrivalsPerSecond, inWindow + 1)
          this.start({ ...req, delay }, now, s)
          break
        }
        default:
          this.start(req, now, now)
      }
    }
    this.measure(now)
  }

  advance(now: number): ActiveCue[] {
    this.prune(now)
    this.drain(now)
    this.measure(now)
    return this.active.map((e) => {
      if (e.cancelledAt !== undefined) {
        return { ...e.cue, progress: e.frozen ?? 0, opacity: Math.max(0, 1 - (now - e.cancelledAt) / CANCEL_FADE_MS) }
      }
      const p = e.cue.duration > 0 ? (now - e.cue.start) / e.cue.duration : 1
      return { ...e.cue, progress: Math.min(1, Math.max(0, p)), opacity: 1 }
    })
  }

  /** True while a cue is active, delayed or queued at `now`. */
  busy(now: number): boolean {
    if (this.capsuleQueue.length > 0 || this.partQueue.size > 0) return true
    return this.active.some((e) => !this.ended(e, now))
  }

  cancelFor(workerId: string, now: number): void {
    const kept: Entry[] = []
    for (const e of this.active) {
      const c = e.cue
      const touches = c.kind !== 'leave' && (c.from === workerId || c.to === workerId)
      if (!touches || e.cancelledAt !== undefined) {
        kept.push(e)
        continue
      }
      if (c.start > now) continue // still waiting for its delay: dropped
      const p = c.duration > 0 ? (now - c.start) / c.duration : 1
      if (p >= 1) continue // already at its end
      e.cancelledAt = now
      e.frozen = Math.max(0, p)
      kept.push(e)
    }
    this.active = kept
    this.capsuleQueue = this.capsuleQueue.filter((q) => q.req.from !== workerId && q.req.to !== workerId)
    this.partQueue.delete(workerId)
  }

  finishAll(): void {
    this.active = []
    this.capsuleQueue = []
    this.partQueue.clear()
  }

  /** The last 40 accepted cues, oldest first (test state `recentCues`). */
  recent(): readonly Cue[] {
    return this.recentCues.slice()
  }

  /** Highest counts seen since construction (test state `cuePeaks`; `ambient` is filled by the caller). */
  peaks(): Omit<FactoryTestState['cuePeaks'], 'ambient'> {
    return { ...this.peak }
  }

  // ---- internals ----

  private start(req: CueRequest, pushedAt: number, start: number): Entry {
    const cue: Cue = { ...req, id: `cue-${++this.seq}`, start }
    const entry: Entry = { cue, pushedAt }
    this.active.push(entry)
    this.started++
    this.recentCues.push(cue)
    if (this.recentCues.length > RECENT_CAP) this.recentCues.splice(0, this.recentCues.length - RECENT_CAP)
    return entry
  }

  private ended(e: Entry, now: number): boolean {
    if (e.cancelledAt !== undefined) return now >= e.cancelledAt + CANCEL_FADE_MS
    return now >= e.cue.start + e.cue.duration
  }

  private prune(now: number): void {
    this.active = this.active.filter((e) => !this.ended(e, now))
    this.arriveStarts = this.arriveStarts.filter((s) => s > now - ARRIVE_WINDOW_MS)
  }

  /** Live (not fading) cues matching `pred`. */
  private count(pred: (e: Entry) => boolean): number {
    let n = 0
    for (const e of this.active) if (e.cancelledAt === undefined && pred(e)) n++
    return n
  }

  private carrierRoom(sender: string | undefined): boolean {
    if (this.count((e) => isCarrier(e.cue.kind)) >= CARRIER_CAP) return false
    return this.count((e) => isCarrier(e.cue.kind) && e.cue.from === sender) < CARRIER_PER_SENDER
  }

  private pushCapsule(req: CueRequest, now: number): void {
    const add = req.count ?? 1
    const queued = this.capsuleQueue.find((q) => q.req.from === req.from && sameTarget(q.req, req))
    if (queued) {
      queued.req = { ...queued.req, count: (queued.req.count ?? 1) + add }
      return
    }
    const flying = this.active.find(
      (e) =>
        e.cancelledAt === undefined &&
        e.cue.kind === 'capsule' &&
        e.cue.from === req.from &&
        sameTarget(e.cue, req) &&
        now - e.pushedAt <= CAPSULE_COALESCE_MS
    )
    if (flying) {
      flying.cue.count = (flying.cue.count ?? 1) + add
      return
    }
    if (this.capsuleQueue.length === 0 && this.carrierRoom(req.from)) {
      this.start({ ...req, count: add }, now, now)
      return
    }
    this.capsuleQueue.push({ req: { ...req, count: add }, pushedAt: now })
    if (this.capsuleQueue.length > CAPSULE_QUEUE) this.capsuleQueue.splice(0, this.capsuleQueue.length - CAPSULE_QUEUE)
    // A queued capsule may still fit (another sender's capsule ahead of it is blocked by its per-sender cap).
    this.drain(now)
  }

  private pushPart(req: CueRequest, now: number): void {
    const station = req.from
    if (station === undefined) return
    const add = req.count ?? 1
    const flying = this.active.some((e) => e.cancelledAt === undefined && e.cue.kind === 'part' && e.cue.from === station)
    if (flying) {
      const q = this.partQueue.get(station)
      if (q) q.req = { ...q.req, count: (q.req.count ?? 1) + add }
      else this.partQueue.set(station, { req: { ...req, count: add }, pushedAt: now })
      return
    }
    if (this.count((e) => e.cue.kind === 'part') < PART_CAP) this.start({ ...req, count: add }, now, now)
  }

  /** Starts queued capsules (oldest first, skipping senders at their cap) and queued parts whose station is free. */
  private drain(now: number): void {
    for (let i = 0; i < this.capsuleQueue.length; ) {
      if (this.count((e) => isCarrier(e.cue.kind)) >= CARRIER_CAP) break
      const q = this.capsuleQueue[i]
      if (this.carrierRoom(q.req.from)) {
        this.capsuleQueue.splice(i, 1)
        this.start(q.req, now, now)
      } else i++
    }
    for (const [station, q] of [...this.partQueue]) {
      const flying = this.active.some((e) => e.cancelledAt === undefined && e.cue.kind === 'part' && e.cue.from === station)
      if (flying) continue
      this.partQueue.delete(station)
      if (this.count((e) => e.cue.kind === 'part') < PART_CAP) this.start(q.req, now, now)
    }
  }

  /** The most arrival starts in any 1 s window [w, w + 1000) that contains `s` (accepted starts only). */
  private arrivalWindowMax(s: number): number {
    let best = 0
    const near = this.arriveStarts.filter((x) => x > s - ARRIVE_WINDOW_MS && x < s + ARRIVE_WINDOW_MS)
    // A window that contains s and holds the most starts can begin at s or at an accepted start just before it.
    for (const w of [s, ...near.filter((x) => x <= s)]) {
      let n = 0
      for (const x of near) if (x >= w && x < w + ARRIVE_WINDOW_MS) n++
      best = Math.max(best, n)
    }
    return best
  }

  private measure(now: number): void {
    const bySender = new Map<string, number>()
    let carriers = 0
    let parts = 0
    let crates = 0
    for (const e of this.active) {
      if (e.cancelledAt !== undefined || e.cue.start > now) continue
      const k = e.cue.kind
      if (isCarrier(k)) {
        carriers++
        const s = e.cue.from ?? ''
        bySender.set(s, (bySender.get(s) ?? 0) + 1)
      } else if (k === 'part') parts++
      else if (k === 'crate') crates++
    }
    const p = this.peak
    p.carriers = Math.max(p.carriers, carriers)
    p.parts = Math.max(p.parts, parts)
    p.crates = Math.max(p.crates, crates)
    for (const n of bySender.values()) p.perSender = Math.max(p.perSender, n)
  }
}
