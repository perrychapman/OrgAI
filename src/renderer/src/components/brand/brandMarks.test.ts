import { describe, expect, it } from 'vitest'
import { BRAND_MARKS } from './brandMarks'

const lum = (hex: string): number => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const ratio = (a: string, b: string): number => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}

describe('brand marks on the dark tile', () => {
  it('lifts Atlassian to at least 3:1', () => {
    const m = BRAND_MARKS.atlassian
    expect(ratio(m.darkHex ?? m.hex!, '#20263a')).toBeGreaterThanOrEqual(3)
  })
  it('every mark colour is at least 3:1 on the dark tile', () => {
    for (const [id, m] of Object.entries(BRAND_MARKS)) {
      const colours = [m.darkHex ?? m.hex, ...(m.extra ?? []).map((p) => p.hex)]
      for (const c of colours) if (c !== null) expect(ratio(c, '#20263a'), `${id} ${c}`).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('brand marks on the light tile', () => {
  it('Intercom and Exa are at least 3:1 on the light tile', () => {
    for (const id of ['intercom', 'exa']) expect(ratio(BRAND_MARKS[id].hex!, '#e9ecf4'), id).toBeGreaterThanOrEqual(3)
  })
  it('Exa keeps a strong tint on the dark tile (thin outline mark)', () => {
    const m = BRAND_MARKS.exa
    expect(ratio(m.darkHex ?? m.hex!, '#20263a')).toBeGreaterThanOrEqual(6)
  })
})
