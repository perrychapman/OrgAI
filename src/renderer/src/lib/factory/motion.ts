// Factory Floor motion constants and the ambient set (docs/design/factory-floor.md section 5). Pure: no three, no DOM.
// Every duration, speed and cap of section 5 lives here and nowhere else. Slice 4 contract (UI Lead): the constants are
// fixed by the spec; the Scene Engineer (4a) implements the functions below and their tests. Nothing here is shared with
// any other scene presentation.
import type { Ambient, CueKind, FloorModel } from './types'

/** One ambient rate for the whole scene (section 5.1), ease-in-out. */
export const FACTORY_CYCLE_MS = 2800
/** At most this many stations loop at once. */
export const AMBIENT_CAP = 12
/** Phase offset per looping station index. */
export const AMBIENT_PHASE_MS = 150
/** Console screen emissive range while a screen loop runs (static level: SCREEN_GLOW_MAX). */
export const SCREEN_GLOW_MIN = 0.7
export const SCREEN_GLOW_MAX = 1.0

// ---- Event cues (section 5.2) ----
export const ARRIVE_MS = 200
/** Station arrive starts at this y scale. */
export const ARRIVE_SCALE_FROM = 0.2
/** At most this many arrivals animate per ARRIVE_WINDOW_MS; the rest appear at once. */
export const ARRIVE_CAP = 12
export const ARRIVE_WINDOW_MS = 1000
export const LEAVE_MS = 160

export const TOTE_SPEED = 8
export const TOTE_MIN_MS = 600
export const TOTE_MAX_MS = 2000

export const CAPSULE_SPEED = 10
export const CAPSULE_MIN_MS = 500
export const CAPSULE_MAX_MS = 1800
/** `to === null`: rises this far and fades over CAPSULE_ROOF_MS. */
export const CAPSULE_ROOF_RISE = 4
export const CAPSULE_ROOF_MS = 600
/** Capsules from one sender to one recipient within this window coalesce into one. */
export const CAPSULE_COALESCE_MS = 800
/** Carrier cap (totes and capsules together) in flight, and per sender. */
export const CARRIER_CAP = 6
export const CARRIER_PER_SENDER = 2
/** Queued capsules beyond this are dropped from the animation (never from the log), oldest first. */
export const CAPSULE_QUEUE = 12

/** Tool part: pop (scale 0 to 1), ride 1.2 m of belt linear, drop and fade. */
export const PART_POP_MS = 120
export const PART_RIDE_MS = 700
export const PART_DROP_MS = 120
export const PART_MS = PART_POP_MS + PART_RIDE_MS + PART_DROP_MS
export const PART_BELT_M = 1.2
/** At most one part in flight and one queued per station; global cap in flight. */
export const PART_CAP = 12

export const CRATE_SPEED = 5
export const CRATE_MIN_MS = 800
export const CRATE_MAX_MS = 2400
export const CRATE_APEX = 1
export const CRATE_CAP = 4

export const SHUTTER_MS = 260
export const BARRIER_MS = 200
export const POSE_MS = 160
export const HALL_MS = 260
/** A cue whose station left ends where it is with this fade (section 5.3). */
export const CANCEL_FADE_MS = 120

/**
 * Module-level Pause motion (section 5.5): remembered for the app session, never saved to settings. FactoryScene reads
 * it on mount and writes it from the toggle.
 */
export const motionSession: { paused: boolean } = { paused: false }

/** Duration for a carrier or crate of `distance` metres at `speed` m/s, clamped to [min, max] milliseconds. */
export function travelMs(distance: number, speed: number, min: number, max: number): number {
  const ms = (Math.max(0, distance) / speed) * 1000
  return Math.min(max, Math.max(min, ms))
}

/**
 * Eased progress for a cue kind at linear progress t (0 to 1): ease-out for arrive, shutter, barrier; ease-in-out for
 * tote, capsule, crate and pose; linear for the part's ride (its pop and drop are phases of the part cue). 4a implements.
 */
export function cueEase(kind: CueKind, t: number): number {
  const s = Math.min(1, Math.max(0, t))
  switch (kind) {
    case 'part':
    case 'leave':
    case 'hall':
      return s
    case 'arrive':
    case 'shutter':
    case 'barrier':
      return 1 - (1 - s) * (1 - s)
    default:
      return s < 0.5 ? 2 * s * s : 1 - Math.pow(-2 * s + 2, 2) / 2
  }
}

/**
 * Ambient loop value 0 to 1 at `now` for phase index `phase` (ease-in-out about FACTORY_CYCLE_MS, offset by
 * phase * AMBIENT_PHASE_MS): 0 at rest, 1 at the far end of the stroke or the bright end of the glow. 4a implements.
 */
export function ambientWave(now: number, phase: number): number {
  const t = (((now - phase * AMBIENT_PHASE_MS) % FACTORY_CYCLE_MS) + FACTORY_CYCLE_MS) % FACTORY_CYCLE_MS / FACTORY_CYCLE_MS
  return 0.5 - 0.5 * Math.cos(2 * Math.PI * t)
}

/**
 * Section 5.1: the stations that loop now. Candidates are workers whose model `ambient` is not 'none' (tool: 'machine';
 * starting, thinking, delegating: 'screen'). Priority: `selectedId`, then `onScreen` stations in layout order, then the
 * rest in layout order; at most AMBIENT_CAP. Phase index = position in that priority list. Empty when the hall is not
 * 'on' or the model is in team mode. 4a implements and tests (stub returns the first AMBIENT_CAP candidates).
 */
export function ambientSet(
  model: FloorModel,
  onScreen: (id: string) => boolean,
  selectedId: string | null = null
): Map<string, { kind: Exclude<Ambient, 'none'>; phase: number }> {
  void onScreen
  void selectedId
  const out = new Map<string, { kind: Exclude<Ambient, 'none'>; phase: number }>()
  if (model.mode !== 'live' || model.hall !== 'on') return out
  for (const id of model.layout.order) {
    const a = model.workers[id]?.ambient
    if (!a || a === 'none') continue
    out.set(id, { kind: a, phase: out.size })
    if (out.size >= AMBIENT_CAP) break
  }
  return out
}
