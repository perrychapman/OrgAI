/**
 * Raw key and bracketed-paste parser (W4-T4; cli-spec 5.1, 5.3(1)). The TUI never uses Ink's input handling: the shell
 * puts stdin in raw mode with utf8 encoding, feeds every chunk to one KeyParser and dispatches the events through the
 * InputBus to the focused target only.
 *
 * Stateful and chunk-boundary safe: an escape sequence, a paste marker or a surrogate pair split across two feed()
 * calls is completed on the next chunk. A lone ESC is only reported by flush(), which the shell calls after about
 * 50 ms without input (ESC is also the first byte of every sequence). Unknown or over-long sequences become one
 * 'unknown' event and never leak characters. Pure: no I/O.
 *
 * Enter: both \r and \n are 'enter' (a line-mode or dumb terminal sends \n), so Ctrl+J arrives as a newline key only
 * on terminals that report it as CSI-u / modifyOtherKeys ('char' 'j' ctrl).
 */
import { sanitizeTty, TtySanitizer } from '../sanitizeTty'
import type { InputEvent, KeyEvent, KeyName } from '../types'

/** A paste keeps at most this many characters (after sanitizing); the rest is dropped. The shell shows a notice when
 * `text.length === PASTE_MAX_CHARS`. */
export const PASTE_MAX_CHARS = 1024 * 1024
/** A sequence longer than this is reported as one 'unknown' event; the rest of it is skipped. */
export const KEY_SEQUENCE_MAX = 64

const ESC = '\x1b'
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function key(name: KeyName, raw: string, extra: Partial<Omit<KeyEvent, 'type' | 'name' | 'raw'>> = {}): KeyEvent {
  return { type: 'key', name, ctrl: false, alt: false, shift: false, raw, ...extra }
}

/** xterm modifier parameter (1 + bitmask: 1 shift, 2 alt, 4 ctrl, 8 meta). */
function mods(param: number | undefined): { shift: boolean; alt: boolean; ctrl: boolean } {
  const m = typeof param === 'number' && Number.isFinite(param) && param >= 1 ? param - 1 : 0
  return { shift: (m & 1) !== 0, alt: (m & 2) !== 0 || (m & 8) !== 0, ctrl: (m & 4) !== 0 }
}

/** A key from a Unicode code point plus modifiers (CSI-u and modifyOtherKeys). */
function codeKey(code: number, m: { shift: boolean; alt: boolean; ctrl: boolean }, raw: string): KeyEvent {
  if (code === 13) return key('enter', raw, m)
  if (code === 9) return key(m.shift ? 'backtab' : 'tab', raw, m)
  if (code === 27) return key('escape', raw, m)
  if (code === 127 || code === 8) return key('backspace', raw, m)
  if (!Number.isInteger(code) || code < 0x20 || code > 0x10ffff || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff)) {
    return key('unknown', raw)
  }
  let ch = String.fromCodePoint(code)
  if (sanitizeTty(ch) !== ch) return key('unknown', raw)
  if (m.ctrl) ch = ch.toLowerCase()
  else if (m.shift && !m.alt) ch = ch.toUpperCase()
  return key('char', raw, { ...m, ch })
}

/** A C0 control byte as a key. */
function controlKey(c: number, raw: string, alt: boolean): KeyEvent {
  if (c === 0x0d || c === 0x0a) return key('enter', raw, { alt })
  if (c === 0x09) return key('tab', raw, { alt })
  if (c === 0x08 || c === 0x7f) return key('backspace', raw, { alt })
  if (c === 0x00) return key('char', raw, { ch: ' ', ctrl: true, alt })
  if (c >= 0x01 && c <= 0x1a) return key('char', raw, { ch: String.fromCharCode(0x60 + c), ctrl: true, alt })
  // 0x1c..0x1f: Ctrl+\ ] ^ _
  return key('char', raw, { ch: String.fromCharCode(0x40 + c), ctrl: true, alt })
}

function csiKey(params: string, final: string, raw: string): KeyEvent {
  if (/^[<=>?]/.test(params)) return key('unknown', raw)
  const nums = params === '' ? [] : params.split(';').map((p) => (p === '' ? NaN : Number(p.split(':')[0])))
  const m = mods(nums[1])
  switch (final) {
    case 'A':
      return key('up', raw, m)
    case 'B':
      return key('down', raw, m)
    case 'C':
      return key('right', raw, m)
    case 'D':
      return key('left', raw, m)
    case 'H':
      return key('home', raw, m)
    case 'F':
      return key('end', raw, m)
    case 'Z':
      return key('backtab', raw, { ...m, shift: true })
    case 'Q':
      return key('f2', raw, m)
    case 'u': {
      const code = nums[0]
      if (typeof code !== 'number' || !Number.isFinite(code)) return key('unknown', raw)
      return codeKey(code, m, raw)
    }
    case '~': {
      const n = nums[0]
      if (n === 27) {
        const code = nums[2]
        if (typeof code !== 'number' || !Number.isFinite(code)) return key('unknown', raw)
        return codeKey(code, mods(nums[1]), raw)
      }
      if (n === 1 || n === 7) return key('home', raw, m)
      if (n === 4 || n === 8) return key('end', raw, m)
      if (n === 3) return key('delete', raw, m)
      if (n === 5) return key('pageup', raw, m)
      if (n === 6) return key('pagedown', raw, m)
      if (n === 12) return key('f2', raw, m)
      return key('unknown', raw)
    }
    default:
      return key('unknown', raw)
  }
}

function ss3Key(params: string, final: string, raw: string): KeyEvent {
  const m = mods(params === '' ? undefined : Number(params))
  switch (final) {
    case 'A':
      return key('up', raw, m)
    case 'B':
      return key('down', raw, m)
    case 'C':
      return key('right', raw, m)
    case 'D':
      return key('left', raw, m)
    case 'H':
      return key('home', raw, m)
    case 'F':
      return key('end', raw, m)
    case 'Q':
      return key('f2', raw, m)
    case 'M':
      return key('enter', raw, m)
    default:
      return key('unknown', raw)
  }
}

/** Longest suffix of `s` that is a proper prefix of `marker`. */
function heldPrefix(s: string, marker: string): number {
  const max = Math.min(s.length, marker.length - 1)
  for (let n = max; n > 0; n--) if (marker.startsWith(s.slice(s.length - n))) return n
  return 0
}

type Step = { events: InputEvent[]; used: number } | 'wait'

export class KeyParser {
  private readonly bracketedPaste: boolean
  /** Unparsed input (key mode) or a held possible end-marker prefix (paste mode). */
  private pending = ''
  /** Skipping the tail of an over-long CSI sequence. */
  private skipping = false
  private paste: { sanitizer: TtySanitizer; text: string; cr: boolean } | null = null

  constructor(opts: { bracketedPaste: boolean }) {
    this.bracketedPaste = opts.bracketedPaste === true
  }

  feed(chunk: string): InputEvent[] {
    if (typeof chunk !== 'string' || chunk === '') return []
    this.pending += chunk
    return this.run(false)
  }

  /** Emits a lone ESC (and completes any held incomplete input) after the escape timeout. A paste in progress waits. */
  flush(): InputEvent[] {
    return this.run(true)
  }

  private run(final: boolean): InputEvent[] {
    const out: InputEvent[] = []
    for (;;) {
      if (this.paste) {
        if (!this.pastePart(out)) break
        continue
      }
      if (this.pending === '') break
      if (this.skipping) {
        let i = 0
        while (i < this.pending.length) {
          const c = this.pending.charCodeAt(i)
          if (c >= 0x20 && c <= 0x3f) {
            i++
            continue
          }
          if (c >= 0x40 && c <= 0x7e) i++
          this.skipping = false
          break
        }
        this.pending = this.pending.slice(i)
        continue
      }
      const step = this.step(this.pending, final)
      if (step === 'wait') break
      out.push(...step.events)
      this.pending = this.pending.slice(step.used)
    }
    return out
  }

  /** Paste mode: consume content up to the end marker. Returns true when the paste ended (keep parsing). */
  private pastePart(out: InputEvent[]): boolean {
    const p = this.paste
    if (!p) return false
    const idx = this.pending.indexOf(PASTE_END)
    if (idx >= 0) {
      this.pasteContent(this.pending.slice(0, idx))
      this.pending = this.pending.slice(idx + PASTE_END.length)
      p.sanitizer.flush()
      out.push({ type: 'paste', text: p.text })
      this.paste = null
      return true
    }
    const hold = heldPrefix(this.pending, PASTE_END)
    this.pasteContent(this.pending.slice(0, this.pending.length - hold))
    this.pending = this.pending.slice(this.pending.length - hold)
    return false
  }

  private pasteContent(s: string): void {
    const p = this.paste
    if (!p || s === '') return
    if (p.text.length >= PASTE_MAX_CHARS) return
    let norm = ''
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]
      if (ch === '\r') {
        norm += '\n'
        p.cr = true
        continue
      }
      if (ch === '\n' && p.cr) {
        p.cr = false
        continue
      }
      p.cr = false
      norm += ch
    }
    const clean = p.sanitizer.write(norm)
    const room = PASTE_MAX_CHARS - p.text.length
    p.text += clean.length > room ? clean.slice(0, room) : clean
  }

  /** One event (or none) from the start of `s`. */
  private step(s: string, final: boolean): Step {
    const c = s.charCodeAt(0)
    if (c === 0x1b) return this.escape(s, final)
    if (c < 0x20 || c === 0x7f) return { events: [controlKey(c, s[0], false)], used: 1 }
    if (c >= 0x80 && c <= 0x9f) return { events: [key('unknown', s[0])], used: 1 }
    // A printable grapheme. Hold one that may still grow (a trailing ZWJ or a lone high surrogate) until more input.
    const it = segmenter.segment(s)[Symbol.iterator]().next()
    const g = it.done ? s[0] : it.value.segment
    if (!final && g.length === s.length) {
      const last = g.charCodeAt(g.length - 1)
      if (last === 0x200d || (last >= 0xd800 && last <= 0xdbff)) return 'wait'
    }
    // Stop the grapheme at an ESC or control (Intl may join a control-free run only, but be safe).
    let end = 0
    while (end < g.length) {
      const cc = g.charCodeAt(end)
      if (cc < 0x20 || cc === 0x7f) break
      end++
    }
    const raw = g.slice(0, Math.max(1, end))
    const ch = sanitizeTty(raw)
    if (ch === '') return { events: [], used: raw.length }
    return { events: [key('char', raw, { ch })], used: raw.length }
  }

  private escape(s: string, final: boolean): Step {
    if (s.length === 1) return final ? { events: [key('escape', ESC)], used: 1 } : 'wait'
    const n = s[1]
    if (n === '[') return this.csi(s, final)
    if (n === 'O') return this.ss3(s, final)
    const c = s.charCodeAt(1)
    if (c === 0x1b) return { events: [key('escape', ESC)], used: 1 }
    if (c < 0x20 || c === 0x7f) return { events: [controlKey(c, s.slice(0, 2), true)], used: 2 }
    if (c >= 0x80 && c <= 0x9f) return { events: [key('unknown', s.slice(0, 2))], used: 2 }
    // Alt+<printable>: one code point.
    const cp = s.codePointAt(1) ?? c
    const len = cp > 0xffff ? 2 : 1
    if (!final && len === 1 && c >= 0xd800 && c <= 0xdbff && s.length === 2) return 'wait'
    const raw = s.slice(0, 1 + len)
    const ch = sanitizeTty(raw.slice(1))
    if (ch === '') return { events: [key('unknown', raw)], used: raw.length }
    return { events: [key('char', raw, { ch, alt: true })], used: raw.length }
  }

  private csi(s: string, final: boolean): Step {
    let i = 2
    while (i < s.length) {
      const c = s.charCodeAt(i)
      if (c >= 0x20 && c <= 0x3f) {
        i++
        if (i > KEY_SEQUENCE_MAX) {
          this.skipping = true
          return { events: [key('unknown', s.slice(0, i))], used: i }
        }
        continue
      }
      if (c >= 0x40 && c <= 0x7e) {
        const raw = s.slice(0, i + 1)
        const params = s.slice(2, i)
        const fin = s[i]
        if (this.bracketedPaste && raw === PASTE_START) {
          this.paste = { sanitizer: new TtySanitizer(), text: '', cr: false }
          return { events: [], used: raw.length }
        }
        if (/[\x20-\x2f]/.test(params)) return { events: [key('unknown', raw)], used: raw.length }
        return { events: [csiKey(params, fin, raw)], used: raw.length }
      }
      // A byte that cannot be in a CSI: what came so far is one unknown key; the byte is parsed again.
      return { events: [key('unknown', s.slice(0, i))], used: i }
    }
    if (!final) return 'wait'
    if (s.length === 2) return { events: [key('char', s, { ch: '[', alt: true })], used: 2 }
    return { events: [key('unknown', s)], used: s.length }
  }

  private ss3(s: string, final: boolean): Step {
    let i = 2
    while (i < s.length && s.charCodeAt(i) >= 0x30 && s.charCodeAt(i) <= 0x39) {
      i++
      if (i > KEY_SEQUENCE_MAX) return { events: [key('unknown', s.slice(0, i))], used: i }
    }
    if (i >= s.length) {
      if (!final) return 'wait'
      if (s.length === 2) return { events: [key('char', s, { ch: 'O', alt: true, shift: true })], used: 2 }
      return { events: [key('unknown', s)], used: s.length }
    }
    const c = s.charCodeAt(i)
    if (c >= 0x40 && c <= 0x7e) {
      const raw = s.slice(0, i + 1)
      return { events: [ss3Key(s.slice(2, i), s[i], raw)], used: raw.length }
    }
    return { events: [key('unknown', s.slice(0, i))], used: i }
  }
}

/** Alt+D, F2 and Ctrl+. focus the Decision Tray (Shift+Tab from the Composer goes through its onLeave). */
export function isTrayFocusKey(e: InputEvent): boolean {
  if (e.type !== 'key') return false
  if (e.name === 'f2') return true
  if (e.name !== 'char') return false
  if (e.alt && !e.ctrl && (e.ch === 'd' || e.ch === 'D')) return true
  return e.ctrl && e.ch === '.'
}
