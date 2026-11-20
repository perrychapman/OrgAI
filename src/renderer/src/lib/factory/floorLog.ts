// Factory Floor log and announcements (docs/design/factory-floor.md sections 6.5 and 7.5). Pure. Slice 4 contract (UI
// Lead): signatures fixed here; implemented and tested by the Scene Engineer (4a). Message text is untrusted agent output:
// it is only ever returned as plain text for React text nodes.
import type { FloorEvent, FloorLogEntry } from './types'

/** Section 6.5: at most this many entries, newest first. */
export const FLOOR_LOG_CAP = 50
/** Message text in a log line is cut to this many characters. */
export const LOG_MESSAGE_CHARS = 80
/** Section 7.5: at most one announcement per window; more in a window coalesce. */
export const ANNOUNCE_WINDOW_MS = 2000

/**
 * A message's text for one log line: whitespace runs (newlines included) become one space, then the first
 * LOG_MESSAGE_CHARS characters (code points, so a surrogate pair is never split), with "…" when cut.
 */
export function logMessageText(text: string): string {
  const flat = Array.from(text.replace(/\s+/g, ' ').trim())
  return flat.length > LOG_MESSAGE_CHARS ? `${flat.slice(0, LOG_MESSAGE_CHARS).join('')}…` : flat.join('')
}

/**
 * The line for an event without its time (section 6.5 templates, "{time} " dropped: the strip prints it), or null when
 * the event has no line ('left': the station's vacant outline is the record).
 */
export function logText(event: FloorEvent): string | null {
  switch (event.kind) {
    case 'assigned':
      return `${event.parent} assigned work to ${event.child}`
    case 'started':
      return `${event.name} started the shift`
    case 'message':
      return `${event.sender} to ${event.recipient}: “${logMessageText(event.text)}”`
    case 'state':
      return `${event.name}: ${event.word}`
    case 'merged':
      return event.into === 'main'
        ? `${event.name}'s branch merged into the main checkout`
        : `${event.name}'s branch merged into ${event.into}'s branch`
    case 'branch':
      switch (event.status) {
        case 'conflict':
          return `${event.name}'s branch has a merge conflict`
        case 'review':
          return `${event.name}'s branch is waiting for your review`
        case 'held':
          return `${event.name}'s branch is held`
        case 'empty':
          return `${event.name} changed no files`
      }
      return null
    case 'plan':
      return `Plan updated: ${event.done} of ${event.total} steps done`
    case 'run':
      return event.status === 'paused' ? 'Line stopped: run paused' : event.status === 'resumed' ? 'Run resumed' : 'Shift over'
    case 'left':
      return null
  }
}

/** Prepends the events' lines (newest first) and keeps FLOOR_LOG_CAP. Ids are unique within a mount. */
export function appendLog(log: readonly FloorLogEntry[], events: readonly FloorEvent[], nextId: () => string): FloorLogEntry[] {
  const added: FloorLogEntry[] = []
  for (const e of events) {
    const text = logText(e)
    if (text !== null) added.push({ id: nextId(), at: e.at, text })
  }
  if (added.length === 0) return log.slice(0, FLOOR_LOG_CAP)
  added.reverse()
  return [...added, ...log].slice(0, FLOOR_LOG_CAP)
}

/**
 * Section 7.5 announcements: "{name} failed" (a 'state' event whose word is Failed) and "{name}'s branch has a merge
 * conflict" (a 'branch' conflict event). At most one per ANNOUNCE_WINDOW_MS; several in a window coalesce ("2 workers
 * failed", "2 branches have merge conflicts", or both joined with ". "). Never at mount (diffCues gives no events there).
 * The scene calls `offer` with each diff's events and `due` from a timer, and announces what they return. A worker
 * counts once per held announcement (keyed by id).
 */
export class AnnounceGate {
  private last = -Infinity
  private failed = new Map<string, string>()
  private conflicts = new Map<string, string>()

  /** Takes new events; returns text to announce now, or null (held for the window, or nothing to say). */
  offer(events: readonly FloorEvent[], now: number): string | null {
    for (const e of events) {
      if (e.kind === 'state' && e.word === 'Failed') this.failed.set(e.id, e.name)
      else if (e.kind === 'branch' && e.status === 'conflict') this.conflicts.set(e.id, e.name)
    }
    return this.due(now)
  }

  /** Milliseconds until held text may be announced, or null when nothing is held. */
  pendingIn(now: number): number | null {
    if (this.failed.size === 0 && this.conflicts.size === 0) return null
    return Math.max(0, this.last + ANNOUNCE_WINDOW_MS - now)
  }

  /** Held text once its window has passed, else null. */
  due(now: number): string | null {
    if (this.failed.size === 0 && this.conflicts.size === 0) return null
    if (now - this.last < ANNOUNCE_WINDOW_MS) return null
    const parts: string[] = []
    const f = [...this.failed.values()]
    const c = [...this.conflicts.values()]
    if (f.length === 1) parts.push(`${f[0]} failed`)
    else if (f.length > 1) parts.push(`${f.length} workers failed`)
    if (c.length === 1) parts.push(`${c[0]}'s branch has a merge conflict`)
    else if (c.length > 1) parts.push(`${c.length} branches have merge conflicts`)
    this.failed.clear()
    this.conflicts.clear()
    this.last = now
    return parts.join('. ')
  }
}
