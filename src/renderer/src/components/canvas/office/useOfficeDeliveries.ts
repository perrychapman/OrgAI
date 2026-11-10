import { useEffect, useMemo, useRef, useState, type FocusEvent } from 'react'
import type { AgentMessage } from '@shared/types'
import { tokenMs } from '../../../lib/useExitPresence'
import { doorwayOf, routeInBuilding, type Building } from '../../../lib/office/building'
import { clearWorkerPath, OFFICE_TILE } from '../../../lib/office/layout'
import { consumeSceneMessages } from '../../../lib/office/messageCursor'
import {
  DEFAULT_JOURNEY_TIMING, journeyDuration, MAX_WALKS, outboundDuration, planMessageWalk, routesConflict, sampleJourney,
  type Direction, type Point
} from '../../../lib/office/motion'
import { attachWalk, baseline, finish, ingest, type Delivery, type Scheduler } from '../../../lib/office/scheduler'
import type { Pin, Walker } from './officePeople'

/** Visual deliveries over the message log: who walks where and which deliveries are live. Visuals never gate the runtime. */
export interface OfficeDeliveriesOptions {
  messages: readonly AgentMessage[]
  mode: 'live' | 'team' | 'sample'
  runId: string | undefined
  /** Reduced motion or Pause: no walks start and none continues; bubbles and talk marks still show for their time. */
  motionOff: boolean
  building: Building
  /** `buildingBlocked(building, props)`: walls, desks, chairs and prop footprints. */
  blocked: ReadonlySet<string>
  /** Ids of every person drawn. */
  agentIds: readonly string[]
  /** Walks in progress that are not message walks (arrivals, S4); they share the three-walk cap. */
  extraWalks?: number
}

export interface OfficeDeliveries {
  /** The scheduler as of this render (S5b reads active bubbles and talkers from it). */
  scheduler: Scheduler
  /** Message -> admitted walk path (anchor cells) and start time. */
  journeys: ReadonlyMap<AgentMessage, { path: Point[]; started: number }>
  /** Sender id -> sampled position this render, anchor pixels. */
  walkers: ReadonlyMap<string, Walker>
  /** Ids that are away from their desk right now. */
  walkingIds: ReadonlySet<string>
  /** Active deliveries between people who are both present (the strip's captions). */
  deliveries: readonly Delivery[]
  /** People frozen where they were when focus arrived. */
  pinned: ReadonlyMap<string, Pin>
  /** Written by the sprite builder each render; focus pins a person at these points. */
  rendered: Map<string, Pin>
  now: number
  onFocusCapture(event: FocusEvent<HTMLElement>): void
}

const cell = (pin: Pin): Point => ({ x: pin.x / OFFICE_TILE, y: pin.y / OFFICE_TILE })
const key = (p: Point): string => `${p.x},${p.y}`

export function useOfficeDeliveries(options: OfficeDeliveriesOptions): OfficeDeliveries {
  const { messages, mode, runId, motionOff, building, blocked, agentIds, extraWalks = 0 } = options
  const [tick, setTick] = useState(Date.now())
  void tick
  const [, redraw] = useState(0)
  const scheduler = useRef(baseline(messages))
  const journeys = useRef(new Map<AgentMessage, { path: Point[]; started: number }>())
  const attempted = useRef(new WeakSet<AgentMessage>())
  const pinned = useRef(new Map<string, Pin>())
  const rendered = useRef(new Map<string, Pin>())
  const cursor = useRef({ runId, seen: messages as readonly AgentMessage[] })

  const idsKey = JSON.stringify(agentIds)
  const ids = useMemo(() => new Set<string>(JSON.parse(idsKey) as string[]), [idsKey])
  const present = new Set(agentIds)
  for (const id of pinned.current.keys()) if (!present.has(id)) pinned.current.delete(id)
  for (const id of rendered.current.keys()) if (!present.has(id)) rendered.current.delete(id)

  // Someone moved (a room grew above them): nothing replays and walks in flight are dropped. A new person is not a move.
  const anchors = new Map<string, string>()
  for (const id of agentIds) { const desk = building.desks.get(id); if (desk) anchors.set(id, key(desk.anchor)) }
  const previousAnchors = useRef(anchors)
  const geometry = useRef({ stamp: 0, reset: false })
  for (const [id, anchor] of anchors) { const before = previousAnchors.current.get(id); if (before !== undefined && before !== anchor) { geometry.current.stamp++; geometry.current.reset = true; break } }
  previousAnchors.current = anchors

  const timing = useMemo(() => ({
    stepMs: tokenMs('--office-step-duration') || DEFAULT_JOURNEY_TIMING.stepMs,
    settleMs: tokenMs('--office-arrival-duration') || DEFAULT_JOURNEY_TIMING.settleMs,
    maxMs: tokenMs('--office-delivery-max-duration') || DEFAULT_JOURNEY_TIMING.maxMs
  }), [])

  const live = useRef({ building, blocked, ids, motionOff, mode, extraWalks, timing })
  live.current = { building, blocked, ids, motionOff, mode, extraWalks, timing }

  const admitJourneys = (now: number): void => {
    const { building: b, blocked: base, ids: present, motionOff: off, mode: m, extraWalks: extra } = live.current
    const active = new Set(scheduler.current.active.map(d => d.message))
    for (const message of journeys.current.keys()) if (!active.has(message)) journeys.current.delete(message)
    for (const delivery of scheduler.current.active) {
      const message = delivery.message
      if (attempted.current.has(message)) continue
      attempted.current.add(message)
      if (off || document.hidden || m !== 'live' || !message.to || pinned.current.has(message.from) || pinned.current.has(message.to)) continue
      if (!present.has(message.from) || !present.has(message.to)) continue
      const from = b.desks.get(message.from); const to = b.desks.get(message.to)
      if (!from || !to) continue
      if (journeys.current.size + extra >= MAX_WALKS) continue
      if ([...journeys.current.keys()].some(other => [other.from, other.to].some(id => id === message.from || id === message.to))) continue
      const obstacles = new Set(base)
      const others: Point[] = []
      for (const [id, desk] of b.desks) {
        if (!present.has(id) || id === message.from) continue
        others.push(desk.anchor)
        if (id !== message.to) obstacles.add(key(desk.anchor))
      }
      const full = clearWorkerPath(routeInBuilding(b, obstacles, from.anchor, to.anchor), others)
      const doorway = doorwayOf(b, message.from)
      const own = doorway ? clearWorkerPath(routeInBuilding(b, obstacles, from.anchor, doorway), others) : []
      const plan = planMessageWalk(full, own, live.current.timing)
      if (!plan) continue
      const duration = journeyDuration(plan.path, live.current.timing)
      const pinCells = [...pinned.current.values()].map(cell)
      if (duration === null || now - delivery.received >= 8000 || [...journeys.current.values()].some(journey => routesConflict(plan.path, journey.path)) || routesConflict(plan.path, pinCells)) continue
      attachWalk(delivery, now, duration, outboundDuration(plan.path, live.current.timing))
      journeys.current.set(message, { path: plan.path, started: now })
    }
  }

  if (cursor.current.runId !== runId) {
    scheduler.current = baseline(messages); journeys.current.clear(); pinned.current.clear(); rendered.current.clear()
  }

  useEffect(() => {
    const incoming = consumeSceneMessages(cursor.current, runId, messages)
    cursor.current = incoming.cursor
    if (geometry.current.reset || incoming.reset) {
      scheduler.current = baseline(messages); journeys.current.clear(); pinned.current.clear(); rendered.current.clear()
      const focusedId = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-office-worker-id]')?.dataset.officeWorkerId
      const desk = focusedId ? building.desks.get(focusedId) : undefined
      if (focusedId && desk) pinned.current.set(focusedId, { x: desk.anchor.x * OFFICE_TILE, y: desk.anchor.y * OFFICE_TILE, direction: 'up' })
      geometry.current.reset = false
      redraw(n => n + 1)
      return
    }
    scheduler.current = mode === 'live' ? ingest(scheduler.current, messages, ids, Date.now(), !document.hidden, motionOff) : baseline(messages)
    if (motionOff || mode !== 'live') journeys.current.clear()
    admitJourneys(Date.now())
    redraw(n => n + 1)
  }, [messages, ids, mode, motionOff, geometry.current.stamp, runId])

  useEffect(() => {
    const change = (): void => {
      scheduler.current = baseline(messages); journeys.current.clear()
      cursor.current = { runId, seen: messages.slice() }
      redraw(n => n + 1)
    }
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [messages, runId])

  // One animation-frame loop only while a live delivery is active.
  useEffect(() => {
    if (mode !== 'live' || motionOff || document.hidden || !scheduler.current.active.length) return
    let handle = 0
    const frame = (): void => {
      if (document.hidden) { scheduler.current = baseline(messages); return }
      const now = Date.now()
      scheduler.current = finish(scheduler.current, now); admitJourneys(now); setTick(now)
      if (scheduler.current.active.length) handle = requestAnimationFrame(frame)
    }
    handle = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(handle)
  }, [messages, mode, motionOff, ids, geometry.current.stamp])

  // Without the loop (reduced motion, Pause) deliveries still expire on time.
  useEffect(() => {
    if (!motionOff || !scheduler.current.active.length) return
    const timer = window.setTimeout(() => { scheduler.current = finish(scheduler.current, Date.now()); redraw(n => n + 1) }, 8000)
    return () => window.clearTimeout(timer)
  }, [messages, motionOff, ids])

  const now = Date.now()
  const walkers = new Map<string, Walker>()
  if (!motionOff) {
    for (const [message, journey] of journeys.current) {
      const sample = sampleJourney(journey.path, now - journey.started, timing)
      walkers.set(message.from, { x: sample.x, y: sample.y, direction: sample.direction as Direction, pose: sample.pose, phase: sample.phase })
    }
  }
  const walkingIds = new Set([...walkers].filter(([, walker]) => walker.phase !== 'done').map(([id]) => id))
  const deliveries = scheduler.current.active.filter(d => present.has(d.message.from) && !!d.message.to && present.has(d.message.to))

  const onFocusCapture = (event: FocusEvent<HTMLElement>): void => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-office-worker-id]')?.dataset.officeWorkerId
    const point = id ? rendered.current.get(id) : undefined
    if (!id || !point) return
    pinned.current.set(id, point)
    const cells = [cell(point)]
    for (const [message, journey] of journeys.current) if (message.from === id || message.to === id || routesConflict(journey.path, cells)) journeys.current.delete(message)
    redraw(n => n + 1)
  }

  return { scheduler: scheduler.current, journeys: journeys.current, walkers, walkingIds, deliveries, pinned: pinned.current, rendered: rendered.current, now, onFocusCapture }
}
