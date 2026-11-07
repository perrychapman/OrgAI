import { describe, expect, it } from 'vitest'
import { env } from './testUtil'
import { build, type RowCache } from '../TranscriptPane'
import type { TranscriptRow } from '../types'
import { graphemes, sliceToWidth, textWidth, wrapText } from './text'

/** The pre-#35 implementation, kept as the reference the single-pass wrap must agree with. */
function referenceWrap(text: string, width: number): string[] {
  const w = Math.floor(width)
  if (w <= 0) return []
  const out: string[] = []
  for (const logical of text.split('\n')) {
    let rest = logical
    if (rest === '') {
      out.push('')
      continue
    }
    while (textWidth(rest) > w) {
      const head = sliceToWidth(rest, w)
      if (head.length === 0) {
        const first = graphemes(rest)[0] ?? ' '
        rest = rest.slice(first.length)
        continue
      }
      const space = head.lastIndexOf(' ')
      if (space > 0 && rest[head.length] !== ' ') {
        out.push(head.slice(0, space))
        rest = rest.slice(space + 1)
      } else {
        out.push(head)
        rest = rest.slice(head.length)
        if (rest.startsWith(' ')) rest = rest.slice(1)
      }
    }
    out.push(rest)
  }
  return out
}

const best = (f: () => unknown): number => {
  let m = Infinity
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    f()
    m = Math.min(m, performance.now() - t0)
  }
  return m
}

describe('wrapText single pass (issue #35 M1)', () => {
  it('agrees with the old implementation on mixed ASCII, CJK, emoji, flag, ZWJ and combining text', () => {
    const atoms = ['a', 'bb', ' ', ' ', 'word', '漢', '字', '🇩🇪', '👨‍👩‍👧', '❤️', 'é', '​', '1️⃣', '\n', 'xyz']
    let seed = 12345
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (let i = 0; i < 400; i++) {
      let text = ''
      const n = 1 + Math.floor(rnd() * 30)
      for (let j = 0; j < n; j++) text += atoms[Math.floor(rnd() * atoms.length)]
      for (const w of [1, 2, 3, 5, 8, 20]) expect(wrapText(text, w), JSON.stringify([text, w])).toEqual(referenceWrap(text, w))
    }
  })

  it('wraps a 64 KB ASCII line and a 64 KB CJK line in time linear in their size', () => {
    const ascii = 'lorem ipsum dolor sit amet '.repeat(Math.ceil(65536 / 27)).slice(0, 65536)
    const cjk = '漢字かな交じり文'.repeat(Math.ceil(65536 / 8)).slice(0, 65536)
    const baseline = best(() => wrapText('x'.repeat(4096), 80))
    for (const input of [ascii, cjk]) {
      const lines = wrapText(input, 80)
      expect(lines.length).toBeGreaterThan(100)
      for (const l of lines) expect(textWidth(l)).toBeLessThanOrEqual(80)
      const ms = best(() => wrapText(input, 80))
      // 16x the size of the baseline input; a generous multiple keeps slow runners green, the old code needed seconds.
      expect(ms).toBeLessThan(2000)
      expect(ms).toBeLessThan(Math.max(200, baseline * 16 * 40))
    }
  })
})

describe('TranscriptPane row cache (issue #35 M1)', () => {
  const row = (key: string, text: string): TranscriptRow => ({ key, runId: 'r', kind: 'text', text })

  it('wraps only the changed or new rows when a row is appended or streams', () => {
    const e = env()
    const cache: RowCache = { width: 40, env: e, rows: new Map() }
    const a = row('a', 'first row '.repeat(20))
    build([a], 0, 40, e, cache)
    const cachedA = cache.rows.get('a')
    build([{ ...a }, row('b', 'second')], 0, 40, e, cache)
    expect(cache.rows.get('a')).toBe(cachedA)
    const cachedB = cache.rows.get('b')
    build([a, row('b', 'second grows')], 0, 40, e, cache)
    expect(cache.rows.get('a')).toBe(cachedA)
    expect(cache.rows.get('b')).not.toBe(cachedB)
    // A new width re-wraps everything; a row that left is forgotten.
    build([a], 0, 30, e, cache)
    expect(cache.rows.get('a')).not.toBe(cachedA)
    expect(cache.rows.has('b')).toBe(false)
  })
})
