/**
 * Per-stream stateful TTY sanitizer (cli-spec 2.5, 5.2). Agent and tool text reaches the terminal only through it:
 * escape sequences (CSI, OSC, DCS, APC, PM, SOS, two-byte ESC Fe / Fp / Fs, charset designations), C0 / C1 controls
 * other than newline and tab, and bidi / invisible characters are removed, with the parser state carried across
 * chunks so a sequence split between two writes is still caught. One TtySanitizer per stream (StreamSanitizers keys
 * them, e.g. by `${runId}:${agentId}`).
 *
 * Pure: no I/O, no imports beyond src/shared. Linear in the input.
 */
import { HIDDEN_CLASS } from '../../shared/view/hiddenChars'

/** An unterminated OSC / DCS / string (or a runaway CSI / ESC) swallows at most this many code units. */
export const TTY_SEQUENCE_CAP = 64 * 1024
/** StreamSanitizers keeps at most this many streams (least recently used evicted). */
export const TTY_STREAM_KEYS_MAX = 1000
const DEFAULT_TAB_WIDTH = 4

/**
 * The shared hidden class, minus ZWNJ (U+200C) and ZWJ (U+200D): they are kept so emoji sequences (family, flags with
 * modifiers, profession emoji) survive, the same choice as the main side's 'prose' rule. Everything else in the class
 * (bidi overrides and isolates, zero-width space, word joiner, BOM, tag characters ...) is dropped.
 */
const HIDDEN_ONE = new RegExp(HIDDEN_CLASS, 'u')

const ESC = 0x1b
const BEL = 0x07

type State =
  | 'normal'
  | 'esc' // after ESC
  | 'escInt' // ESC followed by intermediates (0x20-0x2F), e.g. charset designation ESC ( B
  | 'csi'
  | 'osc'
  | 'str' // DCS, SOS, PM, APC: all end only at ST
  | 'strEsc' // ESC seen inside an OSC / string: '\\' ends it (ST)

function droppedNonAscii(cp: number): boolean {
  if (cp === 0x200c || cp === 0x200d) return false
  if (cp >= 0xe0100 && cp <= 0xe01ef) return true // variation selectors supplement
  if (cp >= 0xe0000 && cp <= 0xe007f) return true // tag characters
  return HIDDEN_ONE.test(String.fromCodePoint(cp))
}

export class TtySanitizer {
  protected readonly tabWidth: number
  private state: State = 'normal'
  /** Code units swallowed by the current sequence (for the cap). */
  private seqLen = 0
  private col = 0
  /** A high surrogate held from the end of the previous chunk. */
  private pendingHigh = ''

  constructor(opts: { tabWidth?: number } = {}) {
    const w = opts.tabWidth
    this.tabWidth = typeof w === 'number' && Number.isInteger(w) && w > 0 && w <= 64 ? w : DEFAULT_TAB_WIDTH
  }

  /** Sanitize one chunk; an unfinished sequence at the end is held for the next write. */
  write(chunk: string): string {
    let s = chunk
    if (this.pendingHigh) {
      s = this.pendingHigh + s
      this.pendingHigh = ''
    }
    const out: string[] = []
    const n = s.length
    // Start of the current run of printable code units copied verbatim (each counts one column).
    let runStart = -1
    const endRun = (i: number): void => {
      if (runStart >= 0) {
        out.push(s.slice(runStart, i))
        this.col += i - runStart
        runStart = -1
      }
    }
    let i = 0
    while (i < n) {
      const c = s.charCodeAt(i)
      const state = this.state
      if (state === 'normal') {
        if (c >= 0x20 && c < 0x7f) {
          if (runStart < 0) runStart = i
          i++
          continue
        }
        if (c === 0x0a) {
          endRun(i)
          out.push('\n')
          this.col = 0
          i++
          continue
        }
        if (c === 0x09) {
          endRun(i)
          const spaces = this.tabWidth - (this.col % this.tabWidth)
          out.push(' '.repeat(spaces))
          this.col += spaces
          i++
          continue
        }
        if (c < 0x20 || c === 0x7f) {
          // ESC opens a sequence; every other C0 (CR included: CRLF becomes \n, a lone CR is dropped) and DEL go.
          endRun(i)
          if (c === ESC) this.enter('esc')
          i++
          continue
        }
        if (c >= 0x80 && c <= 0x9f) {
          endRun(i)
          if (c === 0x9b) this.enter('csi')
          else if (c === 0x9d) this.enterString(true)
          else if (c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) this.enterString(false)
          // every other C1 (0x9C ST included) is dropped
          i++
          continue
        }
        if (c >= 0xd800 && c <= 0xdbff) {
          if (i + 1 >= n) {
            endRun(i)
            this.pendingHigh = s[i]
            i++
            continue
          }
          const lo = s.charCodeAt(i + 1)
          if (lo >= 0xdc00 && lo <= 0xdfff) {
            const cp = ((c - 0xd800) << 10) + (lo - 0xdc00) + 0x10000
            if (droppedNonAscii(cp)) {
              endRun(i)
            } else {
              if (runStart < 0) runStart = i
              // A pair is one column; the run adds two, so take one back.
              this.col -= 1
            }
            i += 2
            continue
          }
          endRun(i) // unpaired high surrogate: dropped
          i++
          continue
        }
        if (c >= 0xdc00 && c <= 0xdfff) {
          endRun(i) // unpaired low surrogate: dropped
          i++
          continue
        }
        if (droppedNonAscii(c)) {
          endRun(i)
        } else if (runStart < 0) {
          runStart = i
        }
        i++
        continue
      }

      // Inside a sequence: nothing is emitted.
      if (++this.seqLen > TTY_SEQUENCE_CAP) {
        // A missing terminator must not hide the rest of the stream: drop what was swallowed, back to normal, and
        // treat this code unit as ordinary text.
        this.enter('normal')
        continue
      }
      switch (state) {
        case 'esc':
          if (c === 0x5b) this.enter('csi')
          else if (c === 0x5d) this.enterString(true)
          else if (c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f) this.enterString(false)
          else if (c >= 0x20 && c <= 0x2f) this.state = 'escInt'
          else if (c >= 0x30 && c <= 0x7e) this.enter('normal') // two-byte Fp / Fe / Fs (ESC \ included)
          else if (c === ESC) this.enter('esc')
          else if (c < 0x20 || c === 0x7f) {
            /* a control inside an escape: dropped, still in the escape */
          } else {
            this.enter('normal') // not an escape after all: the escape is dropped, the character is reprocessed
            continue
          }
          break
        case 'escInt':
          if (c >= 0x20 && c <= 0x2f) {
            /* more intermediates */
          } else if (c >= 0x30 && c <= 0x7e) this.enter('normal')
          else if (c === ESC) this.enter('esc')
          else if (c < 0x20 || c === 0x7f) {
            /* dropped */
          } else {
            this.enter('normal')
            continue
          }
          break
        case 'csi':
          if (c >= 0x40 && c <= 0x7e) this.enter('normal')
          else if (c >= 0x20 && c <= 0x3f) {
            /* parameters (private ones included) and intermediates */
          } else if (c === ESC) this.enter('esc')
          else if (c === 0x9b) this.enter('csi')
          else if (c === 0x18 || c === 0x1a) this.enter('normal') // CAN / SUB cancel the sequence
          else if (c < 0x20 || c === 0x7f) {
            /* dropped */
          } else {
            this.enter('normal') // malformed: abort and reprocess the character as text
            continue
          }
          break
        case 'osc':
        case 'str':
          if (c === ESC) this.state = 'strEsc'
          else if (c === 0x9c) this.enter('normal')
          else if (c === BEL && state === 'osc') this.enter('normal')
          break
        case 'strEsc':
          if (c === 0x5c) {
            this.enter('normal') // ST
          } else if (c === ESC) {
            /* still waiting for '\\' */
          } else {
            // ESC followed by anything else aborts the string and starts a new escape (as terminals do).
            this.state = 'esc'
            this.seqLen = 0
            continue
          }
          break
      }
      i++
    }
    endRun(n)
    return out.join('')
  }

  /** End of stream: drop any held partial sequence and return what is safe to print. */
  flush(): string {
    // An incomplete escape or a dangling high surrogate emits nothing.
    this.pendingHigh = ''
    this.state = 'normal'
    this.seqLen = 0
    return ''
  }

  /** Forget the parser state (a new stream on the same key): back to normal at column 0. */
  reset(): void {
    this.flush()
    this.col = 0
  }

  private enter(state: State): void {
    this.state = state
    this.seqLen = 0
  }

  private enterString(osc: boolean): void {
    this.enter(osc ? 'osc' : 'str')
  }
}

/** Sanitize a complete string (a fresh TtySanitizer, written and flushed). */
export function sanitizeTty(s: string, opts: { tabWidth?: number } = {}): string {
  const t = new TtySanitizer(opts)
  return t.write(s) + t.flush()
}

/** One TtySanitizer per stream key, no state shared between keys; at most `maxKeys`, least recently used evicted. */
export class StreamSanitizers {
  private readonly byKey = new Map<string, TtySanitizer>()
  private readonly maxKeys: number
  private readonly tabWidth: number | undefined

  constructor(opts: { maxKeys?: number; tabWidth?: number } = {}) {
    const m = opts.maxKeys
    this.maxKeys = typeof m === 'number' && Number.isInteger(m) && m > 0 ? m : TTY_STREAM_KEYS_MAX
    this.tabWidth = opts.tabWidth
  }

  for(key: string): TtySanitizer {
    let s = this.byKey.get(key)
    if (s) {
      // Move to the most recently used end.
      this.byKey.delete(key)
      this.byKey.set(key, s)
      return s
    }
    s = new TtySanitizer({ tabWidth: this.tabWidth })
    this.byKey.set(key, s)
    while (this.byKey.size > this.maxKeys) {
      const oldest = this.byKey.keys().next().value
      if (oldest === undefined) break
      this.byKey.delete(oldest)
    }
    return s
  }

  get size(): number {
    return this.byKey.size
  }

  has(key: string): boolean {
    return this.byKey.has(key)
  }

  drop(key: string): void {
    this.byKey.delete(key)
  }

  clear(): void {
    this.byKey.clear()
  }
}

const SGR_GREEN = '\x1b[32m'
const SGR_RED = '\x1b[31m'
const SGR_RESET = '\x1b[0m'

/**
 * A diff made safe for a pager (`less -R` must never see agent-written escapes); keeps newlines. Every escape and
 * control is stripped first, then only trusted SGR is re-added: '+' lines (not '+++') green, '-' lines (not '---')
 * red, everything else plain.
 */
export function sanitizeDiffForPager(diff: string): string {
  const clean = sanitizeTty(diff)
  const lines = clean.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('+') && !line.startsWith('+++')) lines[i] = SGR_GREEN + line + SGR_RESET
    else if (line.startsWith('-') && !line.startsWith('---')) lines[i] = SGR_RED + line + SGR_RESET
  }
  return lines.join('\n')
}
