// Factory Floor log and announcements (docs/design/factory-floor.md sections 6.5 and 7.5). Pure. Slice 4 contract (UI
// Lead): signatures fixed here; the Scene Engineer (4a) implements and tests them. Message text is untrusted agent output:
// it is only ever returned as plain text for React text nodes.
import type { FloorEvent, FloorLogEntry } from './types'

/** Section 6.5: at most this many entries, newest first. */
export const FLOOR_LOG_CAP = 50
/** Message text in a log line is cut to this many characters. */
export const LOG_MESSAGE_CHARS = 80
/** Section 7.5: at most one announcement per window; more in a window coalesce. */
export const ANNOUNCE_WINDOW_MS = 2000

/**
 * The line for an event without its time (section 6.5 templates, "{time} " dropped: the strip prints it), or null when
 * the event has no line. 4a implements every template.
 */
export function logText(event: FloorEvent): string | null {
  void event
  return null
}

/** Prepends the events' lines (newest first) and keeps FLOOR_LOG_CAP. Ids are unique within a mount. 4a implements. */
export function appendLog(log: readonly FloorLogEntry[], events: readonly FloorEvent[], nextId: () => string): FloorLogEntry[] {
  void events
  void nextId
  return [...log]
}

/**
 * Section 7.5 announcements: "{name} failed" (a 'state' event whose word is Failed) and "{name}'s branch has a merge
 * conflict" (a 'branch' conflict event). At most one per ANNOUNCE_WINDOW_MS; several in a window coalesce ("2 workers
 * failed", "2 branches have merge conflicts", or both joined). Never at mount (diffCues gives no events there). 4a
 * implements; the scene calls `offer` with each diff's events and `due` from a timer, and announces what they return.
 */
export class AnnounceGate {
  /** Takes new events; returns text to announce now, or null (held for the window, or nothing to say). */
  offer(events: readonly FloorEvent[], now: number): string | null {
    void events
    void now
    return null
  }
  /** Milliseconds until held text may be announced, or null when nothing is held. */
  pendingIn(now: number): number | null {
    void now
    return null
  }
  /** Held text once its window has passed, else null. */
  due(now: number): string | null {
    void now
    return null
  }
}
