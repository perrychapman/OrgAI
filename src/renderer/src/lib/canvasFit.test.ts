import { describe, expect, it } from 'vitest'
import { fitOptions } from './canvasFit'

describe('fitOptions', () => {
  it('top-down and left-right keep the plain fit', () => {
    expect(fitOptions({ stageHeight: 600, radial: false, nodeStyle: 'card', duration: 0 })).toEqual({ padding: 0.25, maxZoom: 1, duration: 0 })
  })
  it('a short stage keeps zoom at 0.8 or more', () => {
    expect(fitOptions({ stageHeight: 280, radial: false, nodeStyle: 'card', duration: 150 }).minZoom).toBe(0.8)
  })
  it('radial cards never fit below the zoom that keeps names about 9 px', () => {
    const o = fitOptions({ stageHeight: 500, radial: true, nodeStyle: 'card', duration: 0 })
    expect(o.padding).toBe(0.12)
    expect(o.minZoom).toBe(0.7)
    expect(13 * (o.minZoom ?? 0)).toBeGreaterThanOrEqual(9)
    expect(fitOptions({ stageHeight: 500, radial: true, duration: 0 }).minZoom).toBe(0.7)
  })
  it('radial name tags, stations and hexes fit as they are', () => {
    expect(fitOptions({ stageHeight: 500, radial: true, nodeStyle: 'compact', duration: 0 }).minZoom).toBeUndefined()
    expect(fitOptions({ stageHeight: 500, radial: true, nodeStyle: 'hex', duration: 0 }).minZoom).toBeUndefined()
  })
  it('a short radial card stage takes the larger floor', () => {
    expect(fitOptions({ stageHeight: 250, radial: true, nodeStyle: 'card', duration: 0 }).minZoom).toBe(0.8)
  })
})
