import { describe, expect, it } from 'vitest'
import { svgNaturalSize } from './outputZoom'

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
