import { describe, expect, it } from 'vitest'
import { cutSegs, segText, styleFor, type Seg } from './lines'
import { env } from './testUtil'
import { textWidth } from './text'

const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe('cutSegs', () => {
  const e = env()
  const family = '👨‍👩‍👧'

  it('re-splits the cut over the segments without breaking a cluster or surrogate pair', () => {
    const segs: Seg[] = [{ text: 'ab', tone: 'ok' }, { text: `${family}😀`, bold: true }, { text: 'tail', dim: true }]
    for (let w = 0; w <= 12; w++) {
      const out = cutSegs(segs, w, e)
      const text = segText(out)
      expect(textWidth(text)).toBeLessThanOrEqual(w)
      expect(text).not.toMatch(lone)
    }
    // Width 5: "ab" + family (2) leaves 1 column, which is the ellipsis: the emoji after it does not fit.
    expect(segText(cutSegs(segs, 5, e))).toBe(`ab${family}…`)
    // A cut inside the second segment keeps that segment's style on its part and on the ellipsis.
    const out = cutSegs(segs, 5, e)
    expect(out[0]).toMatchObject({ text: 'ab', tone: 'ok' })
    expect(out[1]).toMatchObject({ text: family, bold: true })
  })

  it('does not take a cluster whose first code unit matches the cut text', () => {
    const out = cutSegs([{ text: '😀😀😀😀' }], 5, e)
    expect(segText(out)).toBe('😀😀…')
    expect(segText(out)).not.toMatch(lone)
  })

  it('returns the segments untouched when they fit, and pads when asked', () => {
    const segs: Seg[] = [{ text: 'ok' }]
    expect(cutSegs(segs, 10, e)).toBe(segs)
    expect(segText(cutSegs(segs, 5, e, true))).toBe('ok   ')
  })
})

describe('styleFor', () => {
  it('dim is dimColor only (no grey foreground) and nothing at all with colour off', () => {
    expect(styleFor({ tone: 'dim' }, env())).toEqual({ dimColor: true })
    expect(styleFor({ dim: true }, env())).toEqual({ dimColor: true })
    expect(styleFor({ tone: 'dim', bold: true, inverse: true }, env({ color: false }))).toEqual({})
  })

  it('does not dim readable semantic text twice and keeps accessible output plain', () => {
    expect(styleFor({ tone: 'muted', dim: true }, env())).toEqual({ color: '#a3adc2' })
    for (const mode of [{ color: false }, { screenReader: true }, { dumbTerminal: true }]) {
      expect(styleFor({ tone: 'identity', dim: true, bold: true, inverse: true }, env(mode))).toEqual({})
    }
  })
})
