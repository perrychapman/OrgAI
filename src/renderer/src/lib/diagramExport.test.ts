import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPORT,
  MAX_PIXELS,
  MAX_SIDE,
  backgroundRect,
  downloadName,
  exportNotice,
  exportSize,
  exportTheme,
  mermaidConfig,
  parseExportOptions,
  standaloneAttrs,
  stripMaxWidth,
  svgToDataUrl,
  viewBoxOf,
  viewerTheme
} from './diagramExport'

describe('options', () => {
  it('defaults to light, white, 2x', () => {
    expect(DEFAULT_EXPORT).toEqual({ theme: 'light', background: 'white', scale: 2 })
    expect(parseExportOptions(null)).toEqual(DEFAULT_EXPORT)
    expect(parseExportOptions('nope')).toEqual(DEFAULT_EXPORT)
  })
  it('keeps valid fields and drops junk per field', () => {
    expect(parseExportOptions('{"theme":"shown","background":"transparent","scale":3}')).toEqual({ theme: 'shown', background: 'transparent', scale: 3 })
    expect(parseExportOptions('{"theme":"x","background":5,"scale":9}')).toEqual(DEFAULT_EXPORT)
    expect(parseExportOptions('[1]')).toEqual(DEFAULT_EXPORT)
  })
})

describe('exportSize', () => {
  it('multiplies when it fits', () => {
    expect(exportSize({ w: 400, h: 200 }, 2)).toEqual({ width: 800, height: 400, scale: 2, reduced: false })
  })
  it('caps a side at 8,192 px', () => {
    const s = exportSize({ w: 4000, h: 100 }, 3)
    expect(s.reduced).toBe(true)
    expect(s.width).toBeLessThanOrEqual(MAX_SIDE)
    expect(s.height).toBeLessThanOrEqual(MAX_SIDE)
    expect(s.scale).toBe(2.04)
  })
  it('caps the pixel count at 64 megapixels', () => {
    const s = exportSize({ w: 6000, h: 6000 }, 2)
    expect(s.reduced).toBe(true)
    expect(s.width * s.height).toBeLessThanOrEqual(MAX_PIXELS)
    expect(s.width).toBeLessThanOrEqual(MAX_SIDE)
  })
  it('shrinks a drawing that is already past the caps below 1x', () => {
    const s = exportSize({ w: 20000, h: 20000 }, 1)
    expect(s.reduced).toBe(true)
    expect(s.scale).toBeLessThan(1)
    expect(s.width * s.height).toBeLessThanOrEqual(MAX_PIXELS)
  })
  it('never returns an empty size', () => {
    expect(exportSize({ w: 0, h: 0 }, 1).width).toBe(1)
  })
})

describe('notices', () => {
  it('says a plain line, a copy line or the saved smaller line', () => {
    const ok = exportSize({ w: 100, h: 100 }, 2)
    expect(exportNotice(2, ok, false)).toBe('Your browser is saving the file.')
    expect(exportNotice(2, ok, true)).toBe('Copied the image.')
    const big = exportSize({ w: 4000, h: 100 }, 3)
    expect(exportNotice(3, big, false)).toBe('Saved at 2.04x. The diagram is large, so it was saved smaller.')
  })
})

describe('svg file', () => {
  it('reads a viewBox', () => {
    expect(viewBoxOf('0 0 120.5 80')).toEqual({ x: 0, y: 0, w: 120.5, h: 80 })
    expect(viewBoxOf('0 0 0 80')).toBeNull()
    expect(viewBoxOf(null)).toBeNull()
  })
  it('sets xmlns, width and height from the size', () => {
    expect(standaloneAttrs({ w: 120.4, h: 79.6 })).toMatchObject({ xmlns: 'http://www.w3.org/2000/svg', width: '120', height: '80' })
  })
  it('drops only the max-width of the inline style', () => {
    expect(stripMaxWidth('max-width: 981px; background-color: white;')).toBe('background-color: white')
    expect(stripMaxWidth('max-width: 5px')).toBeNull()
    expect(stripMaxWidth(null)).toBeNull()
  })
  it('builds the white rectangle from the viewBox', () => {
    expect(backgroundRect('-8 -8 100 50', { w: 1, h: 1 })).toEqual({ x: '-8', y: '-8', width: '100', height: '50', fill: '#ffffff' })
    expect(backgroundRect(null, { w: 10, h: 20 })).toMatchObject({ width: '10', height: '20' })
  })
  it('makes a data url that cannot end the attribute early', () => {
    const u = svgToDataUrl('<svg a="1"/>')
    expect(u.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(u).not.toContain('<')
    expect(u).not.toContain('"')
  })
})

describe('names and themes', () => {
  it('cleans file names', () => {
    expect(downloadName('Architecture / v2: draft?', 'png')).toBe('Architecture v2 draft.png')
    expect(downloadName('  ...  ', '.svg')).toBe('diagram.svg')
    expect(downloadName('a‮b\u0000c', 'png')).toBe('a b c.png')
    expect(downloadName('x'.repeat(200), 'png').length).toBe(84)
  })
  it('follows the app theme unless light drawing is on', () => {
    expect(viewerTheme('dark', false)).toBe('dark')
    expect(viewerTheme('dark', true)).toBe('default')
    expect(viewerTheme('light', false)).toBe('default')
  })
  it('exports in default unless "As shown"', () => {
    expect(exportTheme('light', 'dark')).toBe('default')
    expect(exportTheme('shown', 'dark')).toBe('dark')
  })
  it('keeps mermaid strict with SVG text labels', () => {
    const c = mermaidConfig('dark')
    expect(c.securityLevel).toBe('strict')
    expect(c.htmlLabels).toBe(false)
    expect(c.flowchart.htmlLabels).toBe(false)
    expect(c.startOnLoad).toBe(false)
  })
})

describe('saveImage helpers', () => {
  it('encodes bytes and text as base64', async () => {
    const { bytesToBase64, textToBase64, savedImageNotice } = await import('./diagramExport')
    expect(bytesToBase64(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('iVBORw==')
    expect(textToBase64('<svg/>')).toBe(btoa('<svg/>'))
    expect(bytesToBase64(new Uint8Array(100000)).length).toBeGreaterThan(100000)
    expect(savedImageNotice({ path: 'C:/x/a.png' })).toBe('Saved a copy to C:/x/a.png.')
    expect(savedImageNotice({ path: '/a.png' }, 'Smaller.')).toBe('Saved a copy to /a.png. Smaller.')
    expect(savedImageNotice({ cancelled: true })).toBe('Nothing was saved.')
  })
})
