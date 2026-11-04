import { describe, expect, it } from 'vitest'
import { exitPoint, messageSides, msgHandleId } from './canvasShapes'

describe('messageSides', () => {
  const box = (x: number, y: number, width = 240, height = 120) => ({ x, y, width, height })
  it('siblings side by side leave by the facing sides', () => {
    expect(messageSides(box(0, 200), box(300, 200))).toEqual({ out: 'right', in: 'left' })
    expect(messageSides(box(300, 200), box(0, 200))).toEqual({ out: 'left', in: 'right' })
  })
  it('a node below or above uses bottom and top', () => {
    expect(messageSides(box(0, 0), box(20, 300))).toEqual({ out: 'bottom', in: 'top' })
    expect(messageSides(box(20, 300), box(0, 0))).toEqual({ out: 'top', in: 'bottom' })
  })
  it('picks the axis with more room between the boxes', () => {
    // 260 right but only 100 down with 120 tall boxes: they overlap vertically, so the gap is sideways.
    expect(messageSides(box(0, 0), box(260, 100))).toEqual({ out: 'right', in: 'left' })
  })
  it('a pair on a reporting line takes the other axis', () => {
    // Top-down: the parent above the child; the line uses bottom to top, the message goes beside it.
    expect(messageSides(box(0, 0), box(300, 300), 'y')).toEqual({ out: 'right', in: 'left' })
    expect(messageSides(box(300, 300), box(0, 0), 'y')).toEqual({ out: 'left', in: 'right' })
    // Left-right: the line uses right to left; the message goes over or under.
    expect(messageSides(box(0, 0), box(400, 300), 'x')).toEqual({ out: 'bottom', in: 'top' })
  })
  it('boxes that overlap on the chosen axis leave and enter by the same side', () => {
    expect(messageSides(box(0, 0), box(40, 300), 'y')).toEqual({ out: 'right', in: 'right' })
  })
  it('names handles per side', () => {
    expect(msgHandleId('out', 'top')).toBe('msg-out-top')
    expect(msgHandleId('in', 'left')).toBe('msg-in-left')
  })
})

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
