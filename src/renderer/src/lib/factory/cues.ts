// Factory Floor event cues (docs/design/factory-floor.md sections 1.4, 5.2 to 5.4). Pure: no three, no DOM, no clock of
// its own (every call takes `now`). Slice 4 contract (UI Lead): signatures fixed here; the Scene Engineer (4a) implements
// them and their tests on a fixed clock. Stubs below compile and do nothing.
import type { ActiveCue, Cue, CueRequest, FactoryTestState, FloorEvent, FloorFrame } from './types'

/** Section 5.4 message key: `{at}|{from}|{to}|{text first 32 chars}` (to null is the empty string). */
export function messageKey(m: FloorFrame['messages'][number]): string {
  return `${m.at}|${m.from}|${m.to ?? ''}|${m.text.slice(0, 32)}`
}

/** The cursor at mount (or run id change): the key of the newest message, or null when there is none. */
export function messageCursor(messages: FloorFrame['messages']): string | null {
  const last = messages[messages.length - 1]
  return last ? messageKey(last) : null
}

export interface FloorDiff {
  /** Cues for this change, durations resolved, in push order. Never anything already true at `prev`. */
  cues: CueRequest[]
  /** Floor log and announcement events (section 6.5, 7.5). */
  events: FloorEvent[]
  /** The new message cursor (the newest message seen). */
  cursor: string | null
}

/**
 * Section 1.4 and 5.4: what changed between `prev` and `next`. `prev === null` is mount (or a run id change): returns no
 * cues and no events, only the cursor (everything present is the baseline). Messages count only after `cursor`
 * (compare `at` first, then the key). Tool-call increases, worktree status changes, state changes, new and removed
 * agents, plan and run status changes produce cues and events as section 1.4 lists. `now` stamps events. 4a implements.
 */
export function diffCues(prev: FloorFrame | null, next: FloorFrame, cursor: string | null, now = Date.now()): FloorDiff {
  void prev
  void now
  return { cues: [], events: [], cursor: cursor ?? messageCursor(next.messages) }
}

/**
 * Owns every transient cue (section 5.3). push applies caps and coalescing (carrier 6 and 2 per sender, capsule
 * coalescing within 800 ms and a queue of 12, part 1 in flight plus 1 queued per station and 12 global, crate 4 with the
 * rest landing at once, 12 arrivals per 1 s window), assigns ids and absolute start times. advance returns the active
 * cues (progress 0 to 1, opacity) and starts queued ones as room frees. cancelFor ends cues to or from a worker where they
 * are with a CANCEL_FADE_MS fade and drops its queued ones. finishAll ends everything at once (pause, end, hidden,
 * reduced motion). The scheduler never replays: a new scheduler starts empty. 4a implements.
 */
export class CueScheduler {
  /** Cues accepted since construction (the test state's `cuesStarted`). */
  started = 0
  push(cues: readonly CueRequest[], now: number): void {
    void cues
    void now
  }
  advance(now: number): ActiveCue[] {
    void now
    return []
  }
  /** True while a cue is active, delayed or queued at `now`. */
  busy(now: number): boolean {
    void now
    return false
  }
  cancelFor(workerId: string, now: number): void {
    void workerId
    void now
  }
  finishAll(): void {}
  /** The last 40 accepted cues, oldest first (test state `recentCues`). */
  recent(): readonly Cue[] {
    return []
  }
  /** Highest counts seen since construction (test state `cuePeaks`; `ambient` is filled by the caller). */
  peaks(): Omit<FactoryTestState['cuePeaks'], 'ambient'> {
    return { carriers: 0, perSender: 0, parts: 0, crates: 0, arrivalsPerSecond: 0 }
  }
}
