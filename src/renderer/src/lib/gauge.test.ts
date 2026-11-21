import { describe, expect, it } from 'vitest'
import { arcPath, donutSegments, gaugeFraction, polar } from './gauge'

describe('gauge geometry', () => {
  it('places 0 degrees at the top and turns clockwise', () => {
    const top = polar(50, 50, 10, 0)
    expect(top.x).toBeCloseTo(50)
    expect(top.y).toBeCloseTo(40)
    const right = polar(50, 50, 10, 90)
    expect(right.x).toBeCloseTo(60)
    expect(right.y).toBeCloseTo(50)
  })
  it('draws a large-arc flag only past 180 degrees', () => {
    expect(arcPath(50, 50, 10, 0, 90)).toBe('M 50 40 A 10 10 0 0 1 60 50')
    expect(arcPath(50, 50, 10, -135, 270)).toContain(' 0 1 1 ')
  })
  it('clamps fractions and reads unknown as empty', () => {
    expect(gaugeFraction(62)).toBeCloseTo(0.62)
    expect(gaugeFraction(140)).toBe(1)
    expect(gaugeFraction(-3)).toBe(0)
    expect(gaugeFraction(null)).toBe(0)
    expect(gaugeFraction(Number.NaN)).toBe(0)
  })
})

describe('donutSegments', () => {
  it('splits the circle by share with gaps and drops zero values', () => {
    const s = donutSegments([3, 0, 1], 2)
    expect(s.map((x) => x.index)).toEqual([0, 2])
    expect(s[0]!.share).toBeCloseTo(0.75)
    expect(s[0]!.startDeg).toBe(1)
    expect(s[0]!.sweepDeg).toBeCloseTo(268)
    expect(s[1]!.startDeg).toBeCloseTo(271)
  })
  it('one segment has no gap; nothing to draw is empty', () => {
    expect(donutSegments([5])).toEqual([{ index: 0, startDeg: 0, sweepDeg: 360, share: 1 }])
    expect(donutSegments([0, 0])).toEqual([])
    expect(donutSegments([Number.NaN, -1])).toEqual([])
  })
})
