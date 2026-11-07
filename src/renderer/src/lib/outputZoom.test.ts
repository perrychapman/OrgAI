import { describe, expect, it } from 'vitest'
import { FIT_MAX, ZOOM_MAX, ZOOM_MIN, clampZoom, fitScale, scaleOf, stepZoom, svgNaturalSize, zoomKeyAction, zoomPercent } from './outputZoom'

describe('zoom maths', () => {
  it('clamps to 0.25 and 4 and rounds to hundredths', () => {
    expect(clampZoom(0.01)).toBe(ZOOM_MIN)
    expect(clampZoom(99)).toBe(ZOOM_MAX)
    expect(clampZoom(1.2345)).toBe(1.23)
    expect(clampZoom(Number.NaN)).toBe(1)
  })
  it('steps by 25% and stops at the ends', () => {
    expect(stepZoom(1, 'in')).toBe(1.25)
    expect(stepZoom(1, 'out')).toBe(0.8)
    expect(stepZoom(ZOOM_MAX, 'in')).toBe(ZOOM_MAX)
    expect(stepZoom(ZOOM_MIN, 'out')).toBe(ZOOM_MIN)
  })
  it('fits the drawing into the box by the tighter side', () => {
    expect(fitScale({ w: 800, h: 400 }, { w: 400, h: 400 })).toBe(0.5)
    expect(fitScale({ w: 400, h: 800 }, { w: 400, h: 400 })).toBe(0.5)
    // never past FIT_MAX, never below the minimum
    expect(fitScale({ w: 10, h: 10 }, { w: 1000, h: 1000 })).toBe(FIT_MAX)
    expect(fitScale({ w: 10000, h: 10000 }, { w: 100, h: 100 })).toBe(ZOOM_MIN)
    // unusable sizes read as 100%
    expect(fitScale({ w: 0, h: 10 }, { w: 100, h: 100 })).toBe(1)
    expect(fitScale({ w: 10, h: 10 }, { w: 0, h: 0 })).toBe(1)
  })
  it('resolves Fit against the box and a number against the clamp', () => {
    expect(scaleOf('fit', { w: 200, h: 100 }, { w: 100, h: 100 })).toBe(0.5)
    expect(scaleOf(3, { w: 1, h: 1 }, { w: 1, h: 1 })).toBe(3)
    expect(scaleOf(10, { w: 1, h: 1 }, { w: 1, h: 1 })).toBe(ZOOM_MAX)
  })
  it('maps + - 0 and nothing else', () => {
    expect(zoomKeyAction({ key: '+' })).toBe('in')
    expect(zoomKeyAction({ key: '=' })).toBe('in')
    expect(zoomKeyAction({ key: '-' })).toBe('out')
    expect(zoomKeyAction({ key: '0' })).toBe('actual')
    expect(zoomKeyAction({ key: 'a' })).toBeNull()
    expect(zoomKeyAction({ key: '+', ctrlKey: true })).toBeNull()
  })
  it('formats a percent', () => {
    expect(zoomPercent(1.25)).toBe('125%')
    expect(zoomPercent(0.25)).toBe('25%')
  })
  it('reads the drawing size from the viewBox, else plain width and height', () => {
    expect(svgNaturalSize('0 0 300 150', null, null)).toEqual({ w: 300, h: 150 })
    expect(svgNaturalSize('-10,-10,200,100', '100%', null)).toEqual({ w: 200, h: 100 })
    expect(svgNaturalSize(null, '120px', '60')).toEqual({ w: 120, h: 60 })
    expect(svgNaturalSize(null, '100%', '100%')).toBeNull()
    expect(svgNaturalSize('0 0 0 0', null, null)).toBeNull()
    expect(svgNaturalSize(null, null, null)).toBeNull()
  })
})
