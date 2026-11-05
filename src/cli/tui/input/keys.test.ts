import { describe, expect, it } from 'vitest'
import type { InputEvent, KeyEvent } from '../types'
import { isTrayFocusKey, KeyParser, PASTE_MAX_CHARS } from './keys'

const parse = (s: string, bracketedPaste = true): InputEvent[] => {
  const p = new KeyParser({ bracketedPaste })
  return [...p.feed(s), ...p.flush()]
}
const one = (s: string, bracketedPaste = true): KeyEvent => {
  const ev = parse(s, bracketedPaste)
  expect(ev).toHaveLength(1)
  const e = ev[0]
  if (e.type !== 'key') throw new Error('expected a key')
  return e
}
const short = (e: InputEvent) =>
  e.type === 'paste' ? { paste: e.text } : { name: e.name, ch: e.ch, ctrl: e.ctrl, alt: e.alt, shift: e.shift }

describe('KeyParser keys', () => {
  it('decodes printable characters, one event each, emoji as one char', () => {
    const ev = parse('ab é😀👨‍👩‍👧')
    expect(ev.map((e) => (e.type === 'key' ? e.ch : ''))).toEqual(['a', 'b', ' ', 'é', '😀', '👨‍👩‍👧'])
    expect(ev.every((e) => e.type === 'key' && e.name === 'char' && !e.ctrl && !e.alt)).toBe(true)
  })

  it('completes a surrogate pair and a ZWJ emoji split across feeds', () => {
    const p = new KeyParser({ bracketedPaste: true })
    expect(p.feed('\ud83d')).toEqual([])
    expect(p.feed('\ude00').map(short)).toEqual([{ name: 'char', ch: '😀', ctrl: false, alt: false, shift: false }])
    expect(p.feed('👨‍')).toEqual([])
    const rest = p.feed('👩')
    expect(rest).toHaveLength(1)
    expect((rest[0] as KeyEvent).ch).toBe('👨‍👩')
  })

  it('drops bidi and zero-width characters typed as keys', () => {
    expect(parse('‮​')).toEqual([])
  })

  it('Enter, Tab, Backspace', () => {
    expect(one('\r').name).toBe('enter')
    expect(one('\n').name).toBe('enter')
    expect(one('\t').name).toBe('tab')
    expect(one('\x7f').name).toBe('backspace')
    expect(one('\b').name).toBe('backspace')
  })

  it('Ctrl+letters', () => {
    expect(short(one('\x01'))).toMatchObject({ name: 'char', ch: 'a', ctrl: true })
    expect(short(one('\x03'))).toMatchObject({ name: 'char', ch: 'c', ctrl: true })
    expect(short(one('\x04'))).toMatchObject({ name: 'char', ch: 'd', ctrl: true })
    expect(short(one('\x1a'))).toMatchObject({ name: 'char', ch: 'z', ctrl: true })
    expect(short(one('\x15'))).toMatchObject({ name: 'char', ch: 'u', ctrl: true })
  })

  it('Alt+char and Alt+Enter', () => {
    expect(short(one('\x1bd'))).toMatchObject({ name: 'char', ch: 'd', alt: true, ctrl: false })
    expect(short(one('\x1b\r'))).toMatchObject({ name: 'enter', alt: true })
  })

  it('a lone ESC is reported only on flush', () => {
    const p = new KeyParser({ bracketedPaste: true })
    expect(p.feed('\x1b')).toEqual([])
    expect(p.flush().map(short)).toEqual([{ name: 'escape', ch: undefined, ctrl: false, alt: false, shift: false }])
    expect(p.flush()).toEqual([])
  })

  it('arrows in CSI and SS3 forms, with modifiers', () => {
    for (const [s, name] of [
      ['\x1b[A', 'up'],
      ['\x1b[B', 'down'],
      ['\x1b[C', 'right'],
      ['\x1b[D', 'left'],
      ['\x1bOA', 'up'],
      ['\x1bOB', 'down'],
      ['\x1bOC', 'right'],
      ['\x1bOD', 'left']
    ] as const) {
      expect(one(s).name).toBe(name)
    }
    expect(short(one('\x1b[1;2A'))).toMatchObject({ name: 'up', shift: true, alt: false, ctrl: false })
    expect(short(one('\x1b[1;3B'))).toMatchObject({ name: 'down', alt: true })
    expect(short(one('\x1b[1;5C'))).toMatchObject({ name: 'right', ctrl: true, shift: false })
    expect(short(one('\x1b[1;6D'))).toMatchObject({ name: 'left', ctrl: true, shift: true })
    expect(short(one('\x1b[1;8A'))).toMatchObject({ name: 'up', ctrl: true, shift: true, alt: true })
  })

  it('Home/End variants, PageUp/Down, Delete', () => {
    for (const s of ['\x1b[H', '\x1b[1~', '\x1bOH', '\x1b[7~']) expect(one(s).name).toBe('home')
    for (const s of ['\x1b[F', '\x1b[4~', '\x1bOF', '\x1b[8~']) expect(one(s).name).toBe('end')
    expect(one('\x1b[5~').name).toBe('pageup')
    expect(one('\x1b[6~').name).toBe('pagedown')
    expect(one('\x1b[3~').name).toBe('delete')
    expect(short(one('\x1b[3;5~'))).toMatchObject({ name: 'delete', ctrl: true })
  })

  it('Shift+Tab, F2 forms', () => {
    expect(short(one('\x1b[Z'))).toMatchObject({ name: 'backtab', shift: true })
    expect(one('\x1bOQ').name).toBe('f2')
    expect(one('\x1b[12~').name).toBe('f2')
    expect(short(one('\x1b[1;2Q'))).toMatchObject({ name: 'f2', shift: true })
    expect(one('\x1bOP').name).toBe('unknown')
  })

  it('Ctrl+. as CSI-u and modifyOtherKeys', () => {
    expect(short(one('\x1b[46;5u'))).toMatchObject({ name: 'char', ch: '.', ctrl: true, alt: false })
    expect(short(one('\x1b[27;5;46~'))).toMatchObject({ name: 'char', ch: '.', ctrl: true })
    expect(short(one('\x1b[106;5u'))).toMatchObject({ name: 'char', ch: 'j', ctrl: true })
    expect(short(one('\x1b[13;3u'))).toMatchObject({ name: 'enter', alt: true })
    expect(one('\x1b[46;5u').raw).toBe('\x1b[46;5u')
  })

  it('unknown sequences become one unknown event and never leak characters', () => {
    for (const s of ['\x1b[99~', '\x1b[?25h', '\x1b[<0;10;5M', '\x1b[1$x', '\x1bOX']) {
      const ev = parse(s)
      expect(ev).toHaveLength(1)
      expect((ev[0] as KeyEvent).name).toBe('unknown')
    }
    // Over-long: one unknown, then the rest of that sequence skipped, then normal input again.
    const long = '\x1b[' + '1;'.repeat(60) + 'A'
    const ev = parse(long + 'x')
    expect(ev.map(short)).toEqual([
      { name: 'unknown', ch: undefined, ctrl: false, alt: false, shift: false },
      { name: 'char', ch: 'x', ctrl: false, alt: false, shift: false }
    ])
    // A CSI broken by a control byte: unknown, then the control parses.
    expect(parse('\x1b[1\r').map((e) => (e as KeyEvent).name)).toEqual(['unknown', 'enter'])
  })

  it('every sequence split at every byte boundary gives the same events', () => {
    const all =
      'a\x1b[A\x1b[1;5C\x1bOH\x1b[3~\x1b[Z\x1bOQ\x1b[12~\x1b[1;2Q\x1b[46;5u\x1b[27;5;46~\x1bd\x1b[5~\x1b[99~é\r\x1b[200~y\nhi\x1b]52;c;QUFB\x07\x1b[201~z'
    const whole = parse(all)
    expect(whole.length).toBeGreaterThan(10)
    for (let i = 1; i < all.length; i++) {
      const p = new KeyParser({ bracketedPaste: true })
      const ev = [...p.feed(all.slice(0, i)), ...p.feed(all.slice(i)), ...p.flush()]
      expect(ev, `split at ${i}`).toEqual(whole)
    }
  })
})

describe('KeyParser bracketed paste', () => {
  it('one PasteEvent with only the safe text', () => {
    const ev = parse('\x1b[200~y\n\x1b]52;c;ZXZpbA==\x07ok\x1b[31mred‮​x\ttab\r\nline\x1b[201~')
    expect(ev).toHaveLength(1)
    expect(ev[0]).toEqual({ type: 'paste', text: 'y\nokredx  tab\nline' })
  })

  it('handles start and end markers split across chunks', () => {
    const p = new KeyParser({ bracketedPaste: true })
    const ev = [...p.feed('\x1b[20'), ...p.feed('0~hel'), ...p.feed('lo\x1b[2'), ...p.feed('01'), ...p.feed('~k')]
    expect(ev.map(short)).toEqual([{ paste: 'hello' }, { name: 'char', ch: 'k', ctrl: false, alt: false, shift: false }])
  })

  it('a paste waits across flush()', () => {
    const p = new KeyParser({ bracketedPaste: true })
    expect(p.feed('\x1b[200~abc\x1b')).toEqual([])
    expect(p.flush()).toEqual([])
    expect(p.feed('[201~')).toEqual([{ type: 'paste', text: 'abc' }])
  })

  it('drops a nested start marker', () => {
    expect(parse('\x1b[200~a\x1b[200~b\x1b[201~')).toEqual([{ type: 'paste', text: 'ab' }])
  })

  it('a lone CR becomes a newline', () => {
    expect(parse('\x1b[200~a\rb\x1b[201~')).toEqual([{ type: 'paste', text: 'a\nb' }])
    const p = new KeyParser({ bracketedPaste: true })
    const ev = [...p.feed('\x1b[200~a\r'), ...p.feed('\nb\x1b[201~')]
    expect(ev).toEqual([{ type: 'paste', text: 'a\nb' }])
  })

  it('caps a paste at PASTE_MAX_CHARS', () => {
    const p = new KeyParser({ bracketedPaste: true })
    const ev: InputEvent[] = [...p.feed('\x1b[200~')]
    const block = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 20; i++) ev.push(...p.feed(block))
    ev.push(...p.feed('\x1b[201~q'))
    expect(ev).toHaveLength(2)
    expect(ev[0].type).toBe('paste')
    expect((ev[0] as { text: string }).text.length).toBe(PASTE_MAX_CHARS)
    expect((ev[1] as KeyEvent).ch).toBe('q')
  })

  it('without bracketedPaste the bytes parse as keys', () => {
    const ev = parse('\x1b[200~y\n\x1b[201~', false)
    expect(ev.map((e) => (e as KeyEvent).name)).toEqual(['unknown', 'char', 'enter', 'unknown'])
  })
})

describe('isTrayFocusKey', () => {
  it('Alt+D, F2 and Ctrl+.', () => {
    expect(isTrayFocusKey(one('\x1bd'))).toBe(true)
    expect(isTrayFocusKey(one('\x1bOQ'))).toBe(true)
    expect(isTrayFocusKey(one('\x1b[12~'))).toBe(true)
    expect(isTrayFocusKey(one('\x1b[46;5u'))).toBe(true)
    expect(isTrayFocusKey(one('\x1b[27;5;46~'))).toBe(true)
  })

  it('not plain letters, Ctrl+D, Shift+Tab or a paste', () => {
    expect(isTrayFocusKey(one('d'))).toBe(false)
    expect(isTrayFocusKey(one('\x04'))).toBe(false)
    expect(isTrayFocusKey(one('.'))).toBe(false)
    expect(isTrayFocusKey(one('\x1b[Z'))).toBe(false)
    expect(isTrayFocusKey({ type: 'paste', text: 'd' })).toBe(false)
  })
})
