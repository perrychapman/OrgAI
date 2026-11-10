import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import { tokenMs } from '../../../lib/useExitPresence'
import { doorwayOf, routeInBuilding, type Building } from '../../../lib/office/building'
import type { Rect } from '../../../lib/office/camera'
import {
  chooseAnimated, cueFrame, glanceFor, initialGlances, isTypingBurst, officeState, oneShotInProgress, OFFICE_TICK_MS, stepGlances,
  type CuePerson, type GlanceState, type LoopCandidate, type OfficeState
} from '../../../lib/office/cues'
import { clearWorkerPath } from '../../../lib/office/layout'
import {
  admitArrivals, arrivalDuration, DEFAULT_ARRIVAL_TIMING, emptyArrivalQueue, freshIds, planArrival, releaseArrivals, routesConflict, sampleArrival,
  type ArrivalQueue, type ArrivalTiming, type Point
} from '../../../lib/office/motion'
import { activeTalkers } from '../../../lib/office/scheduler'
import { framePosition, propFrames, spriteTop, workerFrameName, workerFrames, type OfficeAgent } from './officeArt'
import type { PersonCues, PersonView, Walker } from './officePeople'
import { targetBox, type SpriteRefs } from './OfficeSprites'
import type { OfficeDeliveries } from './useOfficeDeliveries'

/**
 * The Pocket Office clock (rework spec sections 2 and 3). One `requestAnimationFrame` loop, quantised to the
 * `--office-step-duration` tick, writes frame changes straight to the sprite elements registered in `spriteRefs`: no React
 * render per tick. It runs only in a live scene while the document is visible, motion is on (not reduced, not paused) and a
 * cue is active (somebody loops, a cheer or slump is playing, an arrival is walking or queued).
 *
 * React and the clock agree because every render asks the clock for the cue inputs of its own tick (`cues`), so a commit writes
 * the frame the clock would write. After each commit the clock forgets what it wrote (`generation`), because React may have
 * overwritten it. When the clock stops, the commit that follows paints the static equivalents over whatever the clock left.
 *
 * Baselines: mount, run switch, mode change, a desk that moved, the document becoming visible again and motion coming back all
 * take a new baseline. Everybody present is then settled (no one-shot, no arrival, a fresh glance schedule) and nothing replays.
 */

interface Rec { state: OfficeState; tick: number | null }

interface ClockData {
  ready: boolean
  runId: string | undefined
  mode: string
  eligible: boolean
  /** Clock is running as of the last commit (the stop transition repaints). */
  paintedRunning: boolean
  baseline: number
  stepMs: number
  /** Tick of the last frame pass, and of the last render. */
  lastTick: number
  tick: number
  now: number
  generation: number
  records: Map<string, Rec>
  known: Set<string>
  anchors: Map<string, string>
  glances: GlanceState
  queue: ArrivalQueue
  started: Map<string, number>
  animated: Set<string>
  exchange: ReadonlySet<string>
  talkers: ReadonlySet<string>
  wants: boolean
}

interface ClockIO {
  mode: 'live' | 'team' | 'sample'
  motionOff: boolean
  runId: string | undefined
  building: Building
  blocked: ReadonlySet<string>
  area: Rect
  zoom: number
  order: readonly OfficeAgent[]
  selectedId: string | undefined
  deliveries: OfficeDeliveries
  registry: Map<string, SpriteRefs>
  arriving: Map<string, readonly Point[]>
  timing: ArrivalTiming
  views: readonly PersonView[]
}

export interface OfficeClockOptions {
  mode: 'live' | 'team' | 'sample'
  runId: string | undefined
  motionOff: boolean
  building: Building
  blocked: ReadonlySet<string>
  area: Rect
  zoom: number
  /** Agents in building order. */
  order: readonly OfficeAgent[]
  selectedId?: string
  deliveries: OfficeDeliveries
  spriteRefs: MutableRefObject<Map<string, SpriteRefs>>
  /** Shared with `useOfficeDeliveries`: arrival walks in progress, id -> path in anchor cells. */
  arriving: MutableRefObject<Map<string, readonly Point[]>>
}

export interface OfficeClock {
  /** `data-office-clock`. */
  running: boolean
  /** `data-office-animated`: people who loop this render (at most 12). */
  animated: number
  /** Cue inputs for `buildPersonViews`. */
  cues: PersonCues
  /** Arrivals waiting for a walk slot: not drawn yet. */
  queued: ReadonlySet<string>
  /** `base` plus the arrival walkers sampled now. */
  withArrivals(base: ReadonlyMap<string, Walker>): ReadonlyMap<string, Walker>
  /** Tell the clock which views this render drew (the imperative frames follow these). */
  bind(views: readonly PersonView[]): void
}

const cellKey = (p: Point): string => `${p.x},${p.y}`
const written = new WeakMap<Element, string>()
const nowMs = (): number => performance.now()

function personAt(d: ClockData, id: string, state: OfficeState, tick: number): CuePerson {
  const rec = d.records.get(id)
  return { id, state, stateTick: rec?.tick ?? null, animated: d.animated.has(id), talking: d.talkers.has(id), ...(d.wants ? glanceFor(d.glances, id, tick) : {}) }
}

function candidates(d: ClockData, io: ClockIO, tick: number): LoopCandidate[] {
  const pinned = io.deliveries.pinned
  return io.order.map((agent, order) => {
    const rec = d.records.get(agent.id)
    const state = rec?.state ?? officeState(agent.status)
    return {
      id: agent.id, state, selected: agent.id === io.selectedId, focused: pinned.has(agent.id), inExchange: d.exchange.has(agent.id), order,
      oneShot: oneShotInProgress(state, rec?.tick ?? null, tick)
    }
  })
}

function rebase(d: ClockData, io: ClockIO, now: number, ids: readonly string[]): void {
  d.baseline = now; d.lastTick = 0; d.tick = 0
  d.records = new Map(io.order.map(agent => [agent.id, { state: officeState(agent.status), tick: null }]))
  d.known = new Set(ids)
  d.glances = initialGlances(ids, 0)
  d.queue = emptyArrivalQueue
  d.started.clear(); io.arriving.clear()
}

/** Plan the walk in for one agent; false means "appears at the desk". */
function startArrival(d: ClockData, io: ClockIO, id: string, now: number): boolean {
  const { building, deliveries } = io
  const desk = building.desks.get(id)
  if (!desk || deliveries.pinned.has(id)) return false
  const present = new Set(io.order.map(agent => agent.id))
  const obstacles = new Set(io.blocked)
  const others: Point[] = []
  for (const [other, otherDesk] of building.desks) {
    if (other === id || !present.has(other)) continue
    others.push(otherDesk.anchor); obstacles.add(cellKey(otherDesk.anchor))
  }
  const safe = (path: Point[]): Point[] => (clearWorkerPath(path, others).length === path.length ? path : [])
  const full = building.frontDoor ? safe(routeInBuilding(building, obstacles, building.frontDoor, desk.anchor)) : []
  const doorway = doorwayOf(building, id)
  const own = doorway ? safe(routeInBuilding(building, obstacles, doorway, desk.anchor)) : []
  const plan = planArrival(full, own, io.timing)
  if (!plan) return false
  const pins = [...deliveries.pinned.values()].map(pin => ({ x: pin.x / 16, y: pin.y / 16 }))
  if ([...deliveries.journeys.values()].some(journey => routesConflict(plan.path, journey.path)) || routesConflict(plan.path, pins)) return false
  d.started.set(id, now); io.arriving.set(id, plan.path)
  return true
}

/** Render-phase bookkeeping: baseline, state ticks, new arrivals, the loop cap. Idempotent for the same inputs. */
function sync(d: ClockData, io: ClockIO, now: number, hidden: boolean): void {
  const eligible = io.mode === 'live' && !io.motionOff && !hidden
  const ids = io.order.map(agent => agent.id)
  const anchors = new Map<string, string>()
  for (const id of ids) { const desk = io.building.desks.get(id); if (desk) anchors.set(id, cellKey(desk.anchor)) }
  let moved = false
  for (const [id, anchor] of anchors) { const before = d.anchors.get(id); if (before !== undefined && before !== anchor) { moved = true; break } }
  d.anchors = anchors
  if (!d.ready || d.runId !== io.runId || d.mode !== io.mode || (eligible && !d.eligible) || moved) rebase(d, io, now, ids)
  d.ready = true; d.runId = io.runId; d.mode = io.mode; d.eligible = eligible; d.now = now
  if (!eligible) { io.arriving.clear(); d.started.clear(); d.queue = emptyArrivalQueue }
  const tick = Math.max(0, Math.floor((now - d.baseline) / d.stepMs))
  d.tick = tick

  for (const agent of io.order) {
    const state = officeState(agent.status)
    const rec = d.records.get(agent.id)
    if (!rec) d.records.set(agent.id, { state, tick: null })
    else if (rec.state !== state) { rec.state = state; rec.tick = eligible ? tick : null }
  }
  const present = new Set(ids)
  for (const id of d.records.keys()) if (!present.has(id)) d.records.delete(id)
  for (const id of io.arriving.keys()) if (!present.has(id)) { io.arriving.delete(id); d.started.delete(id) }

  const fresh = freshIds(d.known, ids)
  for (const id of fresh) d.known.add(id)
  if (eligible && fresh.length && io.building.frontDoor) {
    const admitted = admitArrivals(d.queue, fresh, now, io.deliveries.journeys.size + io.arriving.size)
    d.queue = admitted.queue
    for (const id of admitted.start) startArrival(d, io, id, now)
  }

  const exchange = new Set<string>()
  for (const delivery of io.deliveries.deliveries) { exchange.add(delivery.message.from); if (delivery.message.to) exchange.add(delivery.message.to) }
  d.exchange = exchange
  d.talkers = io.mode === 'live' ? activeTalkers(io.deliveries.scheduler, io.deliveries.now, d.stepMs) : new Set<string>()
  d.animated = eligible ? chooseAnimated(candidates(d, io, tick)) : new Set<string>()
  const was = d.wants
  d.wants = eligible && (d.animated.size > 0 || io.arriving.size > 0 || d.queue.queued.length > 0)
  // A clock that starts after a quiet spell has no glances overdue.
  if (!was && d.wants) d.glances = initialGlances(ids, tick)
}

function write(element: Element | null | undefined, key: string, apply: (element: HTMLElement) => void, generation: number): void {
  if (!element) return
  const stamped = `${generation}|${key}`
  if (written.get(element) === stamped) return
  written.set(element, stamped)
  apply(element as HTMLElement)
}

/** Write one person's frames. Static (rest) for seated people, sampled for an arrival, nothing for anyone a message walk or a pin owns. */
function paintPerson(d: ClockData, io: ClockIO, view: PersonView, tick: number, now: number): void {
  const refs = io.registry.get(view.id)
  if (!refs?.art) return
  const path = io.arriving.get(view.id)
  const sample = path ? sampleArrival(path, now - (d.started.get(view.id) ?? now), io.timing) : null
  const walking = !!sample && sample.phase !== 'done'
  const finishedArrival = view.arrival && !path
  if (!walking && !view.seated && !finishedArrival) return
  const state = d.records.get(view.id)?.state ?? view.state
  const frame = cueFrame(personAt(d, view.id, state, tick), tick, 'live')
  const anchor = walking ? { x: sample.x, y: sample.y } : view.home
  const pose = walking ? sample.pose : frame.pose
  const direction = walking ? sample.direction : frame.direction
  const cue = walking ? sample.cue : frame.cue
  const phase = walking ? sample.phase === 'sit' ? 'sit' : 'arrive' : view.phase === 'pinned' ? 'pinned' : 'rest'
  const x = anchor.x
  const y = spriteTop(anchor.y) + (walking ? 0 : frame.offsetY)
  const depth = anchor.y + 8
  const g = d.generation

  const art = workerFrames[workerFrameName(view.silhouette, direction, pose)] ?? workerFrames[workerFrameName(view.silhouette, 'down', 'idle')]
  write(refs.art, `${x},${y},${depth},${direction},${pose},${cue},${phase}`, element => {
    element.style.left = `${x}px`; element.style.top = `${y}px`; element.style.zIndex = `${depth}`
    element.style.backgroundPosition = framePosition(art)
    element.dataset.officeCue = cue; element.dataset.officeMotionPhase = phase; element.dataset.officeX = `${x}`; element.dataset.officeY = `${y}`
  }, g)

  write(refs.screen, frame.screen, element => {
    element.style.backgroundPosition = framePosition(propFrames[`prop.${frame.screen}`])
    element.dataset.officeScreen = frame.screen
  }, g)

  write(refs.mark, `${frame.mark ?? ''},${x},${y},${depth}`, element => {
    element.style.left = `${x}px`; element.style.top = `${y - 13}px`; element.style.zIndex = `${depth + 1000}`
    if (frame.mark) {
      element.hidden = false; element.dataset.mark = frame.mark; element.setAttribute('data-testid', 'office-mark')
      element.style.backgroundPosition = framePosition(propFrames[`prop.mark-${frame.mark}`])
    } else {
      element.hidden = true; element.removeAttribute('data-mark'); element.removeAttribute('data-testid')
    }
  }, g)

  if (walking || finishedArrival) {
    const box = targetBox(x, y, io.area, io.zoom)
    write(refs.button, `${box.left},${box.top},${box.width},${box.height}`, element => {
      element.style.left = `${box.left}px`; element.style.top = `${box.top}px`
    }, g)
  }
}

function paintAll(d: ClockData, io: ClockIO, tick: number, now: number): void {
  for (const view of io.views) paintPerson(d, io, view, tick, now)
}

/** One animation frame. Returns true when React must render (an arrival was released from the queue, or the cues ran out). */
function advance(d: ClockData, io: ClockIO, now: number): boolean {
  let render = false
  const journeys = io.deliveries.journeys
  const walkers = new Set([...journeys.keys()].map(message => message.from))
  for (const [id, path] of [...io.arriving]) {
    const total = arrivalDuration(path, io.timing) ?? 0
    if (io.deliveries.pinned.has(id) || walkers.has(id)) { io.arriving.delete(id); d.started.delete(id); render = true; continue }
    if (now - (d.started.get(id) ?? now) >= total) {
      io.arriving.delete(id); d.started.delete(id)
      const view = io.views.find(candidate => candidate.id === id)
      if (view) paintPerson(d, io, view, d.lastTick, now)
    }
  }
  if (d.queue.queued.length) {
    const released = releaseArrivals(d.queue, now, journeys.size + io.arriving.size, new Set(io.order.map(agent => agent.id)))
    d.queue = released.queue
    for (const id of released.start) startArrival(d, io, id, now)
    if (released.start.length || released.desk.length) render = true
  }
  const tick = Math.max(0, Math.floor((now - d.baseline) / d.stepMs))
  if (tick !== d.lastTick) {
    d.lastTick = tick
    const people = io.views.map(view => {
      const state = d.records.get(view.id)?.state ?? view.state
      const rec = d.records.get(view.id)
      return {
        id: view.id,
        eligible: view.seated && (state === 'running' || state === 'idle') && !d.exchange.has(view.id) && !oneShotInProgress(state, rec?.tick ?? null, tick) && !d.talkers.has(view.id),
        typingBurst: state === 'running' && isTypingBurst(view.id, tick)
      }
    })
    d.glances = stepGlances(d.glances, people, tick)
    d.animated = chooseAnimated(candidates(d, io, tick))
    paintAll(d, io, tick, now)
    if (!d.animated.size && !io.arriving.size && !d.queue.queued.length) render = true
  } else for (const id of io.arriving.keys()) {
    const view = io.views.find(candidate => candidate.id === id)
    if (view) paintPerson(d, io, view, tick, now)
  }
  return render
}

export function useOfficeClock(options: OfficeClockOptions): OfficeClock {
  const [, setStamp] = useState(0)
  const data = useRef<ClockData | null>(null)
  if (!data.current) {
    data.current = {
      ready: false, runId: undefined, mode: '', eligible: false, paintedRunning: false, baseline: nowMs(),
      stepMs: tokenMs('--office-step-duration') || OFFICE_TICK_MS, lastTick: 0, tick: 0, now: nowMs(), generation: 0,
      records: new Map(), known: new Set(), anchors: new Map(), glances: initialGlances([], 0), queue: emptyArrivalQueue, started: new Map(),
      animated: new Set(), exchange: new Set(), talkers: new Set(), wants: false
    }
  }
  const d = data.current
  const timing = useRef<ArrivalTiming>(DEFAULT_ARRIVAL_TIMING)
  if (timing.current === DEFAULT_ARRIVAL_TIMING) {
    timing.current = { ...DEFAULT_ARRIVAL_TIMING, stepMs: d.stepMs, sitMs: tokenMs('--office-arrival-duration') || DEFAULT_ARRIVAL_TIMING.sitMs }
  }
  const io = useRef<ClockIO | null>(null)
  io.current = {
    mode: options.mode, motionOff: options.motionOff, runId: options.runId, building: options.building, blocked: options.blocked,
    area: options.area, zoom: options.zoom, order: options.order, selectedId: options.selectedId, deliveries: options.deliveries,
    registry: options.spriteRefs.current, arriving: options.arriving.current as Map<string, readonly Point[]>, timing: timing.current,
    views: io.current?.views ?? []
  }
  const now = nowMs()
  sync(d, io.current, now, typeof document !== 'undefined' && document.hidden)
  const wants = d.wants

  useEffect(() => {
    const change = (): void => setStamp(n => n + 1)
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [])

  // After every commit: React may have overwritten the clock's values, and a stop leaves the last loop frame behind.
  useLayoutEffect(() => {
    d.generation++
    const current = io.current
    if (current && d.paintedRunning && !d.wants) paintAll(d, current, d.tick, d.now)
    d.paintedRunning = d.wants
  })

  useEffect(() => {
    if (!wants) return
    let frame = 0
    const loop = (): void => {
      frame = requestAnimationFrame(loop)
      const current = io.current
      // `wants` is the render-time verdict: a frame that fires between a stopping commit and this effect's cleanup must not repaint.
      if (!current || document.hidden || !d.wants) return
      if (advance(d, current, nowMs())) setStamp(n => n + 1)
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [wants, d])

  const queued = new Set(d.queue.queued.map(entry => entry.id))
  return {
    running: wants,
    animated: d.animated.size,
    queued,
    cues: { tick: d.tick, person: (id, state) => personAt(d, id, state, d.tick) },
    withArrivals(base) {
      const arrivals = options.arriving.current
      if (!arrivals.size) return base
      const merged = new Map(base)
      for (const [id, path] of arrivals) {
        const sample = sampleArrival(path, d.now - (d.started.get(id) ?? d.now), timing.current)
        if (sample.phase === 'done') continue
        merged.set(id, { x: sample.x, y: sample.y, direction: sample.direction, pose: sample.pose, phase: sample.phase, cue: sample.cue })
      }
      return merged
    },
    bind(views) { if (io.current) io.current.views = views }
  }
}
