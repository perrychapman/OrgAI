import { describe, expect, it } from 'vitest'
import { exitPoint } from './canvasShapes'

describe('exitPoint', () => {
  it('box: leaves through the nearer side plus the gap', () => {
    const box = { kind: 'box', cx: 0, cy: 0, hw: 100, hh: 50 } as const
    expect(exitPoint(box, 500, 0)).toEqual({ x: 102, y: 0 })
    expect(exitPoint(box, 0, -500)).toEqual({ x: 0, y: -52 })
    const diag = exitPoint(box, 100, 100)
    expect(diag.y).toBeCloseTo(52)
    expect(diag.x).toBeCloseTo(52)
  })
  it('box: a zero ray stays at the centre', () => {
    expect(exitPoint({ kind: 'box', cx: 5, cy: 6, hw: 10, hh: 10 }, 5, 6)).toEqual({ x: 5, y: 6 })
  })
  it('circle: centre plus r + gap along the ray', () => {
    const c = { kind: 'circle', cx: 10, cy: 20, r: 16 } as const
    const p = exitPoint(c, 10, 220)
    expect(p.x).toBeCloseTo(10)
    expect(p.y).toBeCloseTo(38)
    const q = exitPoint(c, 13, 24)
    expect(Math.hypot(q.x - 10, q.y - 20)).toBeCloseTo(18)
  })
  it('hex: hits the flat top at 90 degrees and the point at 0 degrees', () => {
    const h = { kind: 'hex', cx: 0, cy: 0, hw: 60, hh: 52 } as const
    const up = exitPoint(h, 0, -300)
    expect(up.x).toBeCloseTo(0)
    expect(up.y).toBeCloseTo(-54)
    const right = exitPoint(h, 300, 0)
    expect(right.x).toBeCloseTo(62)
    expect(right.y).toBeCloseTo(0)
  })
  it('hex: hits the slanted edge at 30 degrees', () => {
    const h = { kind: 'hex', cx: 0, cy: 0, hw: 60, hh: 52 } as const
    const p = exitPoint(h, Math.cos(Math.PI / 6) * 300, Math.sin(Math.PI / 6) * 300)
    // The outline grown by the gap: 54 * |x| + 31 * |y| = 54 * 62.
    expect(54 * Math.abs(p.x) + 31 * Math.abs(p.y)).toBeCloseTo(54 * 62)
    expect(Math.atan2(p.y, p.x)).toBeCloseTo(Math.PI / 6)
  })
})
