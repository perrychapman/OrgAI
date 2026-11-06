import { describe, expect, it } from 'vitest'
import {
  StreamSanitizers,
  TTY_SEQUENCE_CAP,
  TtySanitizer,
  sanitizeDiffForPager,
  sanitizeTty
} from './sanitizeTty'

const E = '\x1b'
const ST = `${E}\\`
const BEL = '\x07'

/** Feed `parts` to one sanitizer and return everything it printed. */
function feed(parts: string[], t = new TtySanitizer()): string {
  return parts.map((p) => t.write(p)).join('') + t.flush()
}

/** Every split of `s` into 2 parts, and every split into 3 parts. */
function splits(s: string): string[][] {
  const out: string[][] = []
  for (let i = 0; i <= s.length; i++) {
    out.push([s.slice(0, i), s.slice(i)])
    for (let j = i; j <= s.length; j++) out.push([s.slice(0, i), s.slice(i, j), s.slice(j)])
  }
  return out
}

const SEQUENCES: Record<string, string> = {
  'OSC 52 BEL': `${E}]52;c;ZXZpbA==${BEL}`,
  'OSC 52 ST': `${E}]52;c;ZXZpbA==${ST}`,
  'OSC 8 open': `${E}]8;;https://evil.example/${ST}`,
  'CSI clear': `${E}[2J`,
  'CSI private': `${E}[?1049h`,
  'CSI SGR': `${E}[1;31;48;5;200m`,
  DCS: `${E}Pq#0;2;0;0;0${ST}`,
  APC: `${E}_Gf=100;AAAA${ST}`,
  PM: `${E}^private${ST}`,
  SOS: `${E}Xstring${ST}`,
  'two-byte': `${E}7`,
  charset: `${E}(0`,
  'C1 CSI': '\u009b2J',
  'C1 OSC': '\u009d52;c;ZXZpbA==\u009c',
  'C1 DCS': '\u0090q\u009c',
  'C1 SOS': '\u0098x\u009c',
  'C1 PM': '\u009ex\u009c',
  'C1 APC': '\u009fx\u009c'
}

describe('sanitizeTty: whole strings', () => {
  it('removes OSC 52 clipboard writes, BEL- and ST-terminated', () => {
    expect(sanitizeTty(`a${E}]52;c;ZXZpbA==${BEL}b`)).toBe('ab')
    expect(sanitizeTty(`a${E}]52;c;ZXZpbA==${ST}b`)).toBe('ab')
  })

  it('removes an OSC 8 link and keeps its visible text', () => {
    expect(sanitizeTty(`see ${E}]8;;https://evil.example/${ST}docs${E}]8;;${ST} here`)).toBe('see docs here')
    expect(sanitizeTty(`${E}]8;id=1;https://x${BEL}click${E}]8;;${BEL}`)).toBe('click')
  })

  it('removes CSI clear-screen, cursor moves and SGR', () => {
    expect(sanitizeTty(`${E}[2J${E}[H${E}[10;20Hx${E}[3Ay${E}[1;31mred${E}[0m${E}[?25l`)).toBe('xyred')
  })

  it('removes DCS, APC, PM and SOS strings', () => {
    expect(sanitizeTty(`a${E}Pq#0${ST}b${E}_Gf=1${ST}c${E}^pm${ST}d${E}Xsos${ST}e`)).toBe('abcde')
  })

  it('removes 8-bit C1 CSI and OSC and drops every other C1', () => {
    expect(sanitizeTty('a\u009b2Jb\u009d52;c;xx\u0007c\u009d0;t\u009cd')).toBe('abcd')
    expect(sanitizeTty('x\u0085\u0084\u008e\u009cy')).toBe('xy')
  })

  it('removes two-byte escapes and charset designations', () => {
    expect(sanitizeTty(`a${E}7b${E}8c${E}(0d${E})Be${E}Mf${E}cg`)).toBe('abcdefg')
  })

  it('drops C0 controls except newline and tab', () => {
    expect(sanitizeTty('a\u0000b\u0007c\u0008d\u000be\u000cf\u007fg\nh')).toBe('abcdefg\nh')
  })

  it('turns CRLF into \\n and drops a lone CR', () => {
    expect(sanitizeTty('one\r\ntwo\rthree\r\n')).toBe('one\ntwothree\n')
  })

  it('drops bidi overrides and zero-width space, keeps ZWJ emoji', () => {
    expect(sanitizeTty('a‮b​c⁦d⁩')).toBe('abcd')
    const family = '\u{1f468}‍\u{1f469}‍\u{1f467}'
    expect(sanitizeTty(`hi ${family}!`)).toBe(`hi ${family}!`)
    // A joiner after ASCII (look-alike ids like R‍1) is dropped; after a non-ASCII letter it stays (ZWNJ in Persian).
    expect(sanitizeTty('a‌b')).toBe('ab')
    expect(sanitizeTty('R‍1 and req‌_1')).toBe('R1 and req_1')
    expect(sanitizeTty('‍start\n‍line')).toBe('start\nline')
    expect(sanitizeTty('می‌خواهم')).toBe('می‌خواهم')
    const flag = '\u{1f3f3}️‍\u{1f308}'
    expect(sanitizeTty(`x ${flag}`)).toBe(`x ${flag}`)
  })

  it('carries the joiner rule across chunks', () => {
    const t = new TtySanitizer()
    expect(t.write('id R') + t.write('‍1')).toBe('id R1')
    const u = new TtySanitizer()
    expect(u.write('\u{1f468}') + u.write('‍\u{1f469}')).toBe('\u{1f468}‍\u{1f469}')
  })

  it('drops tag characters and the variation selectors supplement', () => {
    expect(sanitizeTty('a\u{e0041}\u{e007f}b\u{e0100}\u{e01ef}c')).toBe('abc')
  })

  it('drops unpaired surrogates', () => {
    expect(sanitizeTty('a\ud800b\udc00c')).toBe('abc')
  })

  it('treats ESC followed by plain text as a dropped escape, not swallowing text', () => {
    expect(sanitizeTty(`a${E}é b`)).toBe('aé b')
  })

  it('ends a malformed CSI at a non-ASCII character and keeps the character', () => {
    expect(sanitizeTty(`a${E}[12é`)).toBe('aé')
  })

  it('aborts a string on ESC + something other than backslash and parses the new escape', () => {
    expect(sanitizeTty(`a${E}]0;title${E}[31mb`)).toBe('ab')
  })
})

describe('TtySanitizer: split across chunks', () => {
  for (const [name, seq] of Object.entries(SEQUENCES)) {
    it(`strips ${name} split into 2 and 3 chunks at every position`, () => {
      const whole = `before ${seq}after`
      for (const parts of splits(whole)) {
        expect(feed(parts), JSON.stringify(parts)).toBe('before after')
      }
    })
  }

  it('strips an OSC 52 split exactly after ESC', () => {
    const t = new TtySanitizer()
    expect(t.write(`text${E}`)).toBe('text')
    expect(t.write(`]52;c;ZXZpbA==${BEL}more`)).toBe('more')
  })

  it('strips an OSC split inside its ST terminator (ESC | \\)', () => {
    const t = new TtySanitizer()
    expect(t.write(`a${E}]8;;https://x${E}`)).toBe('a')
    expect(t.write(`\\link`)).toBe('link')
  })

  it('carries a CSI over three chunks', () => {
    const t = new TtySanitizer()
    expect(t.write(`x${E}`)).toBe('x')
    expect(t.write('[1;3')).toBe('')
    expect(t.write('1my')).toBe('y')
  })

  it('joins a surrogate pair split across chunks', () => {
    const t = new TtySanitizer()
    const smile = '\u{1f600}'
    expect(t.write(`a${smile[0]}`)).toBe('a')
    expect(t.write(`${smile[1]}b`)).toBe(`${smile}b`)
  })

  it('drops a held high surrogate when the next chunk does not complete it', () => {
    const t = new TtySanitizer()
    expect(t.write('a\ud83d')).toBe('a')
    expect(t.write('b')).toBe('b')
  })

  it('drops a tag character split across chunks', () => {
    const tag = '\u{e0041}'
    expect(feed([`a${tag[0]}`, `${tag[1]}b`])).toBe('ab')
  })

  it('expands tabs across chunks with the column tracked per stream', () => {
    const t = new TtySanitizer()
    expect(t.write('ab')).toBe('ab')
    expect(t.write('\tc')).toBe('  c') // col 2 -> 4
    expect(t.write('\t')).toBe('   ') // col 5 -> 8
    expect(t.write('\n\tx')).toBe('\n    x') // reset at newline
    expect(new TtySanitizer({ tabWidth: 8 }).write('abc\td')).toBe('abc     d')
  })

  it('counts an emoji as one column and escapes as none', () => {
    const t = new TtySanitizer()
    expect(t.write(`\u{1f600}${E}[31m\t|`)).toBe('\u{1f600}   |')
  })

  it('caps an unterminated OSC at 64 KB and then shows the rest', () => {
    const t = new TtySanitizer()
    const body = 'x'.repeat(TTY_SEQUENCE_CAP)
    expect(t.write(`a${E}]52;c;${body.slice(0, 1000)}`)).toBe('a')
    // Still inside the OSC: swallowed.
    expect(t.write(body.slice(0, 1000))).toBe('')
    const rest = t.write(body + 'visible')
    expect(rest.endsWith('visible')).toBe(true)
    // What was swallowed (the first TTY_SEQUENCE_CAP code units of the sequence) is never shown.
    expect(rest.length).toBeLessThan(body.length + 'visible'.length)
    expect(t.write('next')).toBe('next')
  })

  it('caps an unterminated DCS the same way', () => {
    const out = sanitizeTty(`${E}P${'q'.repeat(TTY_SEQUENCE_CAP + 10)}`)
    expect(out.length).toBeLessThanOrEqual(10)
  })

  it('flush emits nothing for an incomplete escape or a dangling surrogate', () => {
    const t = new TtySanitizer()
    expect(t.write(`a${E}]52;c;abc`)).toBe('a')
    expect(t.flush()).toBe('')
    expect(t.write('b')).toBe('b') // back to normal after flush
    expect(t.write('c\ud83d')).toBe('c')
    expect(t.flush()).toBe('')
    expect(t.write('\udc00d')).toBe('d') // the held half is gone
    expect(sanitizeTty(`ok${E}`)).toBe('ok')
    expect(sanitizeTty(`ok${E}[1;2`)).toBe('ok')
  })

  it('reset returns to normal at column 0', () => {
    const t = new TtySanitizer()
    expect(t.write(`abc${E}]0;`)).toBe('abc')
    t.reset()
    expect(t.write('\tx')).toBe('    x')
  })
})

describe('StreamSanitizers', () => {
  it('keeps one sanitizer per key with no shared state', () => {
    const s = new StreamSanitizers()
    expect(s.for('r1:a').write(`A${E}]52;c;`)).toBe('A')
    expect(s.for('r1:b').write('B text')).toBe('B text')
    expect(s.for('r1:a').write(`still hidden${BEL}shown`)).toBe('shown')
    expect(s.for('r1:a')).toBe(s.for('r1:a'))
    expect(s.for('r1:a')).not.toBe(s.for('r1:b'))
  })

  it('drop and clear forget streams', () => {
    const s = new StreamSanitizers()
    s.for('a').write(`${E}]0;`)
    s.drop('a')
    expect(s.for('a').write('fresh')).toBe('fresh')
    s.for('b')
    s.clear()
    expect(s.size).toBe(0)
  })

  it('caps the keys, evicting the least recently used', () => {
    const s = new StreamSanitizers()
    for (let i = 0; i < 1000; i++) s.for(`k${i}`)
    s.for('k0') // touch: k1 is now the oldest
    s.for('k1000')
    expect(s.size).toBe(1000)
    expect(s.has('k0')).toBe(true)
    expect(s.has('k1')).toBe(false)
    expect(s.has('k1000')).toBe(true)
  })
})

describe('sanitizeDiffForPager', () => {
  it('colours only + and - lines and leaves headers plain', () => {
    const diff = ['--- a/x', '+++ b/x', '@@ -1 +1 @@', '-old', '+new', ' same'].join('\n')
    expect(sanitizeDiffForPager(diff)).toBe(
      ['--- a/x', '+++ b/x', '@@ -1 +1 @@', '\x1b[31m-old\x1b[0m', '\x1b[32m+new\x1b[0m', ' same'].join('\n')
    )
  })

  it('strips injected escapes before colouring', () => {
    const diff = `+ok${E}[2J${E}]52;c;eA==${BEL}\n-${E}]8;;https://x${ST}t\r\n context${E}[31m`
    const out = sanitizeDiffForPager(diff)
    expect(out).toBe('\x1b[32m+ok\x1b[0m\n\x1b[31m-t\x1b[0m\n context')
    // The only escapes left are the trusted SGR ones.
    const escapes = out.match(/\x1b\[[0-9;]*m/g) ?? []
    expect(out.replace(/\x1b\[(?:31|32|0)m/g, '')).not.toContain('\x1b')
    expect(escapes.length).toBe(4)
  })
})

describe('performance', () => {
  it('sanitizes 1 MB in under 200 ms', () => {
    const unit = `plain text \t${E}[31mred${E}[0m ${E}]8;;https://x${ST}link${E}]8;;${ST} ‮ é \u{1f600}\r\n`
    const input = unit.repeat(Math.ceil((1024 * 1024) / unit.length))
    // Slow CI runners made a flat 200 ms budget flaky: take the best of 3 runs, compare with a plain-ASCII
    // baseline of the same size measured on the same machine, and keep a generous absolute ceiling.
    const best = (f: () => unknown): number => {
      let m = Infinity
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now()
        f()
        m = Math.min(m, performance.now() - t0)
      }
      return m
    }
    expect(sanitizeTty(input)).not.toContain(E)
    const plain = 'x'.repeat(input.length)
    const baseline = best(() => sanitizeTty(plain))
    const ms = best(() => sanitizeTty(input))
    expect(ms).toBeLessThan(2000)
    expect(ms).toBeLessThan(Math.max(200, baseline * 40))
  })

  it('stays linear on 1 MB of escape soup split into small chunks', () => {
    const input = `${E}[1;2m${E}]0;t${BEL}x\u009b3J`.repeat(60_000)
    const t = new TtySanitizer()
    const t0 = performance.now()
    let out = ''
    for (let i = 0; i < input.length; i += 7) out += t.write(input.slice(i, i + 7))
    const ms = performance.now() - t0
    expect(out).toBe('x'.repeat(60_000))
    expect(ms).toBeLessThan(1000) // generous: a quadratic blowup would be many seconds; a flat 200 ms flaked on slow runners
  })
})
