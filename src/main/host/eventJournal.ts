/**
 * The host's durable run-event ring (cli-spec 3.3(4).4). Electron-free, relative imports only.
 *
 * Every durable `runs:event` (everything but agent.partial) gets a host-wide monotonic seq starting at 1 and is kept
 * in a ring bounded by both JOURNAL_MAX_EVENTS and JOURNAL_MAX_BYTES of serialized JSON, oldest evicted first. An
 * event whose JSON exceeds JOURNAL_SCRUB_OVER_BYTES has every image's base64 replaced by an OmittedImage; that copy is
 * stored and pushed, and the original (shared with other bus listeners) is never touched. agent.partial is never
 * stored: it carries `atSeq`, the current durable watermark.
 */
import type { ImageMediaType, OmittedImage, RunEvent, SequencedHostEvent } from '../../shared/types'
import { stringifyJson } from './jsonCodec'

export const JOURNAL_MAX_EVENTS = 2000
export const JOURNAL_MAX_BYTES = 16 * 1024 * 1024
export const JOURNAL_SCRUB_OVER_BYTES = 512 * 1024

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function isImageLike(v: unknown): v is { mediaType: ImageMediaType; data: string } {
  return isObj(v) && !Array.isArray(v) && typeof v.mediaType === 'string' && typeof v.data === 'string'
}

/** The decoded byte count of a base64 string (padding and whitespace aware). */
export function base64ByteLength(data: string): number {
  return Buffer.byteLength(data, 'base64')
}

export function omitImage(img: { mediaType: ImageMediaType; data: string }): OmittedImage {
  return { mediaType: img.mediaType, byteLength: base64ByteLength(img.data), omittedBase64: true }
}

/**
 * A copy of `value` with every element of every `images` array that looks like an ImageAttachment (mediaType and a
 * string data) replaced by an OmittedImage. Untouched subtrees are shared; when nothing changes the input itself is
 * returned. Never mutates its input.
 */
export function scrubImages<T>(value: T): T {
  return scrub(value, 0) as T
}

function scrub(v: unknown, depth: number): unknown {
  if (!isObj(v) || depth > 64) return v
  if (Array.isArray(v)) {
    let out: unknown[] | undefined
    for (let i = 0; i < v.length; i++) {
      const next = scrub(v[i], depth + 1)
      if (next !== v[i]) {
        out ??= v.slice()
        out[i] = next
      }
    }
    return out ?? v
  }
  let out: Record<string, unknown> | undefined
  for (const [k, item] of Object.entries(v)) {
    let next: unknown
    if (k === 'images' && Array.isArray(item)) {
      let arr: unknown[] | undefined
      item.forEach((img, i) => {
        if (isImageLike(img)) {
          arr ??= item.slice()
          arr[i] = omitImage(img)
        }
      })
      next = arr ?? item
    } else {
      next = scrub(item, depth + 1)
    }
    if (next !== item) {
      out ??= { ...v }
      out[k] = next
    }
  }
  return out ?? v
}

export interface JournalAppend {
  /** Durable events: the ring slot. */
  seq?: number
  /** agent.partial: the current durable watermark. */
  atSeq?: number
  /** The event as stored and pushed (a scrubbed copy when it was too large). */
  event: RunEvent
  /** stringifyJson(event), reused for push frames. */
  json: string
}

interface Entry {
  seq: number
  event: RunEvent
  bytes: number
}

export interface EventJournalOptions {
  maxEvents?: number
  maxBytes?: number
  scrubOverBytes?: number
}

export class EventJournal {
  private readonly maxEvents: number
  private readonly maxBytes: number
  private readonly scrubOverBytes: number
  private entries: Entry[] = []
  private head = 0
  private bytes = 0
  private seq = 0

  constructor(opts: EventJournalOptions = {}) {
    this.maxEvents = opts.maxEvents ?? JOURNAL_MAX_EVENTS
    this.maxBytes = opts.maxBytes ?? JOURNAL_MAX_BYTES
    this.scrubOverBytes = opts.scrubOverBytes ?? JOURNAL_SCRUB_OVER_BYTES
  }

  /** The last seq handed out (0 before the first durable event). */
  get currentSeq(): number {
    return this.seq
  }

  /** The seq of the oldest stored event; currentSeq + 1 while the ring is empty. */
  get oldestSeq(): number {
    return this.head < this.entries.length ? this.entries[this.head].seq : this.seq + 1
  }

  /** Stored events (tests and diagnostics). */
  get size(): number {
    return this.entries.length - this.head
  }

  get storedBytes(): number {
    return this.bytes
  }

  append(event: RunEvent): JournalAppend {
    if (event.type === 'agent.partial') return { atSeq: this.seq, event, json: stringifyJson(event) }
    let stored = event
    let json = stringifyJson(event)
    let size = Buffer.byteLength(json, 'utf8')
    if (size > this.scrubOverBytes) {
      const scrubbed = scrubImages(event)
      if (scrubbed !== event) {
        stored = scrubbed
        json = stringifyJson(scrubbed)
        size = Buffer.byteLength(json, 'utf8')
      }
    }
    const seq = ++this.seq
    this.entries.push({ seq, event: stored, bytes: size })
    this.bytes += size
    this.evict()
    return { seq, event: stored, json }
  }

  /**
   * Stored events with seq > `seq`, oldest first, or 'evicted' when some of them are gone (or `seq` is not a seq this
   * journal could have handed out).
   */
  since(seq: number): SequencedHostEvent[] | 'evicted' {
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > this.seq) return 'evicted'
    if (seq < this.oldestSeq - 1) return 'evicted'
    const out: SequencedHostEvent[] = []
    for (let i = this.head; i < this.entries.length; i++) {
      const e = this.entries[i]
      if (e.seq > seq) out.push({ seq: e.seq, event: e.event })
    }
    return out
  }

  private evict(): void {
    while (this.size > 0 && (this.size > this.maxEvents || this.bytes > this.maxBytes)) {
      this.bytes -= this.entries[this.head].bytes
      this.head++
    }
    // Compact the backing array now and then so it does not grow without bound.
    if (this.head > 1024 && this.head * 2 > this.entries.length) {
      this.entries = this.entries.slice(this.head)
      this.head = 0
    }
  }
}
