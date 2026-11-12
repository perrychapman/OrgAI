import { describe, expect, it } from 'vitest'
import { svgTextSize } from './SvgPreview'

describe('svgTextSize', () => {
  it('reads the root tag only', () => {
    expect(svgTextSize('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><rect/></svg>')).toEqual({ w: 120, h: 80 })
    expect(svgTextSize("<svg width='200' height='100'></svg>")).toEqual({ w: 200, h: 100 })
    expect(svgTextSize('<svg></svg>')).toBeNull()
    expect(svgTextSize('no drawing here')).toBeNull()
  })
})
