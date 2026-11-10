import type { Direction } from './motion'

/**
 * Pure cue engine for the living Pocket Office (docs/design/pocket-office.md sections 2 and 3).
 * No React, no DOM, no clock: every function maps (state, tick) to frame names, so the same input
 * always gives the same output. One tick is OFFICE_TICK_MS (the `--office-step-duration` token);
 * `tick = Math.floor(msSinceClockBaseline / 120)`.
 */
export const OFFICE_TICK_MS = 120
export const TYPING_PERIOD_TICKS = 20
export const TYPING_BURST_TICKS = 8
export const TYPING_FRAME_TICKS = 2
export const FLICKER_FRAME_TICKS = 4
export const WAVE_FRAME_TICKS = 4
export const CHEER_TICKS = 6
export const SLUMP_TICKS = 3
export const GLANCE_TICKS = 5
/** Minimum quiet gap between the end of one glance and the start of the next (3 s). */
export const GLANCE_GAP_TICKS = 25
/** 25 s base period plus up to 15 s of per-person jitter, in whole ticks. */
export const GLANCE_BASE_TICKS = 208
export const GLANCE_JITTER_TICKS = 125
export const MAX_ANIMATED = 12

export type OfficeState = 'idle' | 'running' | 'waiting' | 'finished' | 'failed'
export type OfficeCue = 'typing' | 'waving' | 'glance' | 'arriving' | 'cheering' | 'slumping' | 'walking' | 'none'
export type OfficeMarkName = 'wait' | 'done' | 'error' | 'talk'
export type OfficeScreen = 'crt' | 'crt-b' | 'crt-off' | 'crt-error'
export type OfficePose = 'idle' | 'work' | 'type' | 'wait' | 'hand' | 'done' | 'error' | 'walk-1' | 'walk-2'
export interface CueFrame { pose: OfficePose; direction: Direction; screen: OfficeScreen; mark: OfficeMarkName | null; cue: OfficeCue; offsetY: 0 | 1 }

/** Runtime states (starting, thinking, tool, delegating) and Team's 'Role' collapse to the five office states. */
export function officeState(status: string): OfficeState {
  switch (status) {
    case 'starting': case 'thinking': case 'tool': case 'delegating': case 'running': return 'running'
    case 'waiting': return 'waiting'
    case 'done': case 'finished': return 'finished'
    case 'error': case 'failed': return 'failed'
    default: return 'idle'
  }
}

export interface CuePerson {
  id: string
  state: OfficeState
  /** Tick the current state began after the clock baseline; null = already in that state at baseline (settled, no one-shot). */
  stateTick: number | null
  /** Inside the 12-cap and motion allowed. False gives the static equivalent. */
  animated: boolean
  /** Sender of a live message: shows the talk mark. */
  talking: boolean
  /**
   * Set by `stepGlances` while this person glances (exclusive end tick). A glance is a 600 ms event, not a loop, so
   * it is honoured whatever `animated` says; the scene must simply not run `stepGlances` under reduced motion or Pause.
   */
  glanceUntil?: number
  glanceDirection?: 'left' | 'right'
}

/** FNV-1a, stable 32-bit unsigned. */
export function hashId(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function tickAt(nowMs: number, baselineMs: number): number {
  return Math.max(0, Math.floor((nowMs - baselineMs) / OFFICE_TICK_MS))
}

const mod = (n: number, d: number): number => ((n % d) + d) % d

/** True while the person is inside the 8-tick typing burst of their 20-tick cycle (glances wait for the burst to end). */
export function isTypingBurst(id: string, tick: number): boolean {
  return mod(tick + hashId(id) % TYPING_PERIOD_TICKS, TYPING_PERIOD_TICKS) < TYPING_BURST_TICKS
}

/** A cheer (6 ticks) or slump (3 ticks) that has not finished yet. */
export function oneShotInProgress(state: OfficeState, stateTick: number | null, tick: number): boolean {
  if (stateTick === null) return false
  const elapsed = Math.max(0, tick - stateTick)
  return (state === 'finished' && elapsed < CHEER_TICKS) || (state === 'failed' && elapsed < SLUMP_TICKS)
}

function frame(pose: OfficePose, direction: Direction, screen: OfficeScreen, mark: OfficeMarkName | null, cue: OfficeCue, offsetY: 0 | 1 = 0): CueFrame {
  return { pose, direction, screen, mark, cue, offsetY }
}

function stateFrame(person: CuePerson, tick: number): CueFrame {
  const h = hashId(person.id)
  const animated = person.animated
  switch (person.state) {
    case 'running': {
      if (!animated) return frame('work', 'up', 'crt', null, 'none')
      const local = mod(tick + h % TYPING_PERIOD_TICKS, TYPING_PERIOD_TICKS)
      const typing = local < TYPING_BURST_TICKS && Math.floor(local / TYPING_FRAME_TICKS) % 2 === 0
      const screen: OfficeScreen = Math.floor(mod(tick + (h >>> 5) % 8, FLICKER_FRAME_TICKS * 2) / FLICKER_FRAME_TICKS) === 0 ? 'crt' : 'crt-b'
      return frame(typing ? 'type' : 'work', 'up', screen, null, 'typing')
    }
    case 'waiting': {
      if (!animated) return frame('hand', 'down', 'crt', 'wait', 'none')
      const hand = Math.floor(mod(tick + h % (WAVE_FRAME_TICKS * 2), WAVE_FRAME_TICKS * 2) / WAVE_FRAME_TICKS) === 1
      return frame(hand ? 'hand' : 'wait', 'down', 'crt', 'wait', 'waving')
    }
    case 'finished': {
      if (animated && person.stateTick !== null && Math.max(0, tick - person.stateTick) < CHEER_TICKS) return frame('done', 'down', 'crt-off', 'done', 'cheering')
      return frame('idle', 'down', 'crt-off', 'done', 'none')
    }
    case 'failed': {
      if (animated && person.stateTick !== null && Math.max(0, tick - person.stateTick) < SLUMP_TICKS) return frame('error', 'down', 'crt-error', 'error', 'slumping', 0)
      return frame('error', 'down', 'crt-error', 'error', 'none', 1)
    }
    default:
      return frame('idle', 'up', 'crt-off', null, 'none')
  }
}

/**
 * Frame for one person at one tick. Decisions where the spec is silent:
 * - Team shows everyone idle up with a steady screen and no marks or cues, whatever the state; Sample is one static `work` pose.
 * - The talk mark wins over a state mark while `talking` (it is a 1.2 s event about a real message; the state mark returns at once
 *   afterwards and the exchange nameplates carry the state word meanwhile).
 * - A glance replaces pose and direction for seated running or idle people only; the screen keeps its state.
 */
export function cueFrame(person: CuePerson, tick: number, mode: 'live' | 'team' | 'sample'): CueFrame {
  if (mode === 'team') return frame('idle', 'up', 'crt', null, 'none')
  if (mode === 'sample') return frame('work', 'up', 'crt', null, 'none')
  const base = stateFrame(person, tick)
  const glancing = person.glanceUntil !== undefined && tick < person.glanceUntil && (person.state === 'running' || person.state === 'idle')
  const mark: OfficeMarkName | null = person.talking ? 'talk' : base.mark
  if (!glancing) return mark === base.mark ? base : { ...base, mark }
  return { ...base, pose: person.state === 'running' ? 'work' : 'idle', direction: person.glanceDirection ?? 'left', cue: 'glance', mark }
}

export interface LoopCandidate {
  id: string
  state: OfficeState
  selected: boolean
  focused: boolean
  inExchange: boolean
  /** Building order. */
  order: number
  /** A cheer or slump is still playing (see `oneShotInProgress`). */
  oneShot?: boolean
}

/** Up to `cap` people who loop: Needs you, then selected or focused, then exchange participants, then Running by building order. Idle never loops. */
export function chooseAnimated(people: readonly LoopCandidate[], cap = MAX_ANIMATED): Set<string> {
  const rank = (p: LoopCandidate): number => p.state === 'waiting' ? 0 : p.selected || p.focused ? 1 : p.inExchange ? 2 : 3
  const worth = people.filter(p => p.state === 'waiting' || p.state === 'running' || p.oneShot === true)
  worth.sort((a, b) => rank(a) - rank(b) || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return new Set(worth.slice(0, Math.max(0, cap)).map(p => p.id))
}

export interface GlanceState {
  lastStartTick: number
  active: { id: string; untilTick: number; direction: 'left' | 'right' } | null
  nextDue: ReadonlyMap<string, number>
}

const glancePeriod = (id: string): number => GLANCE_BASE_TICKS + hashId(id) % GLANCE_JITTER_TICKS

export function initialGlances(ids: readonly string[], tick: number): GlanceState {
  return {
    lastStartTick: tick - GLANCE_TICKS - GLANCE_GAP_TICKS,
    active: null,
    nextDue: new Map(ids.map(id => [id, tick + glancePeriod(id)]))
  }
}

/**
 * Advance the single scene-wide glance. At most one glance runs; the next starts no sooner than 25 ticks after the last one ended;
 * a due person who is in a typing burst is deferred (stays due); a glancing person who stops being eligible (exchange, walk) is cut short.
 * Returns the same object when nothing changed.
 */
export function stepGlances(state: GlanceState, people: readonly { id: string; eligible: boolean; typingBurst: boolean }[], tick: number): GlanceState {
  const byId = new Map(people.map(p => [p.id, p]))
  let active = state.active
  if (active && (tick >= active.untilTick || !byId.get(active.id)?.eligible)) active = null
  let nextDue: Map<string, number> | null = null
  const own = (): Map<string, number> => nextDue ??= new Map(state.nextDue)
  for (const p of people) if (!state.nextDue.has(p.id)) own().set(p.id, tick + glancePeriod(p.id))
  for (const id of state.nextDue.keys()) if (!byId.has(id)) own().delete(id)
  let lastStartTick = state.lastStartTick
  if (!active && tick >= lastStartTick + GLANCE_TICKS + GLANCE_GAP_TICKS) {
    const due = nextDue ?? state.nextDue
    let pick: { id: string; at: number } | null = null
    for (const p of people) {
      const at = due.get(p.id)
      if (at === undefined || at > tick || !p.eligible || p.typingBurst) continue
      if (!pick || at < pick.at || (at === pick.at && p.id < pick.id)) pick = { id: p.id, at }
    }
    if (pick) {
      active = { id: pick.id, untilTick: tick + GLANCE_TICKS, direction: hashId(`${pick.id}:${tick}`) % 2 ? 'left' : 'right' }
      own().set(pick.id, tick + glancePeriod(pick.id))
      lastStartTick = tick
    }
  }
  if (active === state.active && !nextDue && lastStartTick === state.lastStartTick) return state
  return { lastStartTick, active, nextDue: nextDue ?? state.nextDue }
}

/** Fields a scene copies onto `CuePerson` for one person from the current glance state. */
export function glanceFor(state: GlanceState, id: string, tick: number): { glanceUntil?: number; glanceDirection?: 'left' | 'right' } {
  const a = state.active
  return a && a.id === id && tick < a.untilTick ? { glanceUntil: a.untilTick, glanceDirection: a.direction } : {}
}
