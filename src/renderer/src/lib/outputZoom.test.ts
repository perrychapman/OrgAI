import { describe, expect, it } from 'vitest'
import { DIAGRAM_OPEN_MAX, IMAGE_OPEN_MAX, SVG_OPEN_MAX, VECTOR_FLOOR, initialView, svgNaturalSize } from './outputZoom'

describe('svgNaturalSize', () => {
  it('reads the drawing size from the viewBox, else plain width and height', () => {
    expect(svgNaturalSize('0 0 300 150', null, null)).toEqual({ w: 300, h: 150 })
    expect(svgNaturalSize('-10,-10,200,100', '100%', null)).toEqual({ w: 200, h: 100 })
    expect(svgNaturalSize(null, '120px', '60')).toEqual({ w: 120, h: 60 })
    expect(svgNaturalSize(null, '100%', '100%')).toBeNull()
    expect(svgNaturalSize('0 0 0 0', null, null)).toBeNull()
    expect(svgNaturalSize(null, null, null)).toBeNull()
  })
})

describe('initialView', () => {
  const panel = { w: 340, h: 500 }
  const opts = { floor: VECTOR_FLOOR, max: DIAGRAM_OPEN_MAX, pad: 16 }
  it('opens a wide, short diagram at the floor, aligned to the start and centred vertically', () => {
    const v = initialView({ w: 1200, h: 100 }, panel, opts)
    expect(v.k).toBe(VECTOR_FLOOR)
    expect(v.x).toBe(16)
    expect(v.y).toBeCloseTo((500 - 100 * VECTOR_FLOOR) / 2)
  })
  it('contains a tall diagram whose floor size would not fit the height', () => {
    const v = initialView({ w: 300, h: 1200 }, panel, opts)
    expect(v.k).toBeCloseTo((500 - 32) / 1200)
    expect(v.k).toBeLessThan(VECTOR_FLOOR)
    expect(v.x).toBeCloseTo((340 - 300 * v.k) / 2)
    expect(v.y).toBeCloseTo(16)
  })
  it('contains a drawing that fits above the floor, centred', () => {
    const v = initialView({ w: 400, h: 300 }, panel, opts)
    expect(v.k).toBeCloseTo((340 - 32) / 400)
    expect(v.x).toBeCloseTo(16)
    expect(v.y).toBeCloseTo((500 - 300 * v.k) / 2)
  })
  it('enlarges a tiny svg up to its max and no further, centred', () => {
    const v = initialView({ w: 40, h: 40 }, panel, { floor: VECTOR_FLOOR, max: SVG_OPEN_MAX })
    expect(v.k).toBe(SVG_OPEN_MAX)
    expect(v.x).toBeCloseTo((340 - 160) / 2)
    expect(v.y).toBeCloseTo((500 - 160) / 2)
  })
  it('opens a big photo shrunk to the box with no floor, and a small one at 100%', () => {
    const big = initialView({ w: 4000, h: 3000 }, panel, { max: IMAGE_OPEN_MAX })
    expect(big.k).toBeCloseTo((340 - 32) / 4000)
    expect(big.k).toBeLessThan(VECTOR_FLOOR)
    const small = initialView({ w: 200, h: 100 }, panel, { max: IMAGE_OPEN_MAX })
    expect(small.k).toBe(1)
    expect(small.x).toBeCloseTo(70)
    expect(small.y).toBeCloseTo(200)
  })
  it('fills the Larger view for a small svg', () => {
    const v = initialView({ w: 400, h: 240 }, { w: 1534, h: 793 }, { floor: VECTOR_FLOOR, max: SVG_OPEN_MAX })
    expect(v.k).toBeCloseTo(Math.min(SVG_OPEN_MAX, (793 - 32) / 240, (1534 - 32) / 400))
    expect(400 * v.k).toBeGreaterThan(1000)
  })
  it('gives 100% at the origin for an unusable box or size', () => {
    expect(initialView({ w: 100, h: 100 }, { w: 0, h: 0 }, opts)).toEqual({ k: 1, x: 0, y: 0 })
    expect(initialView({ w: 0, h: 100 }, panel, opts)).toEqual({ k: 1, x: 0, y: 0 })
    expect(initialView({ w: NaN, h: 100 }, panel, opts)).toEqual({ k: 1, x: 0, y: 0 })
  })
  it('never opens above max even when the floor is higher', () => {
    const v = initialView({ w: 3000, h: 100 }, { w: 200, h: 400 }, { floor: 2, max: 1 })
    expect(v.k).toBe(1)
  })
})
