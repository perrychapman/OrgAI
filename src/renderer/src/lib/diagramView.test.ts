import { describe, expect, it } from 'vitest'
import {
  FIT_MAX,
  ZOOM_MAX,
  ZOOM_MIN,
  actualView,
  byteLength,
  centerOnOverview,
  clampK,
  clampView,
  diagramText,
  errorLine,
  errorSentence,
  fitScale,
  fitView,
  hintText,
  isLargeDiagram,
  largeNote,
  lineColumn,
  lineRange,
  overviewRects,
  panBy,
  percentLabel,
  sizeLabel,
  sourceStatus,
  viewKey,
  wheelFactor,
  zoomAt,
  zoomDataValue,
  zoomSpeech
} from './diagramView'

describe('fit', () => {
  it('fits by the tighter side with padding, never above 1.5', () => {
    expect(fitScale({ w: 432, h: 432 }, { w: 800, h: 400 })).toBeCloseTo(0.5)
    expect(fitScale({ w: 1000, h: 1000 }, { w: 10, h: 10 })).toBe(FIT_MAX)
  })
  it('has no floor: a huge drawing still fits', () => {
    const k = fitScale({ w: 300, h: 300 }, { w: 3922, h: 5020 })
    expect(k).toBeGreaterThan(0)
    expect(k).toBeLessThan(0.06)
    const v = fitView({ w: 300, h: 300 }, { w: 3922, h: 5020 })
    expect(v.y).toBeCloseTo(16)
    expect(3922 * v.k + v.x * 2).toBeCloseTo(300)
  })
  it('reads an unusable size as 100%', () => {
    expect(fitScale({ w: 0, h: 0 }, { w: 10, h: 10 })).toBe(1)
    expect(fitScale({ w: 10, h: 10 }, { w: 0, h: 5 })).toBe(1)
  })
  it('centres a small drawing', () => {
    const v = fitView({ w: 400, h: 300 }, { w: 100, h: 50 })
    expect(v.k).toBe(FIT_MAX)
    expect(v.x).toBeCloseTo((400 - 150) / 2)
    expect(v.y).toBeCloseTo((300 - 75) / 2)
  })
})

describe('zoom and pan', () => {
  it('keeps the point under the pointer fixed', () => {
    const v = { k: 1, x: 10, y: 20 }
    const p = { x: 100, y: 80 }
    const z = zoomAt(v, p, 2)
    expect(z.k).toBe(2)
    // the drawing point under p before and after
    expect((p.x - v.x) / v.k).toBeCloseTo((p.x - z.x) / z.k)
    expect((p.y - v.y) / v.k).toBeCloseTo((p.y - z.y) / z.k)
  })
  it('stops at the range ends', () => {
    expect(clampK(0.001)).toBe(ZOOM_MIN)
    expect(clampK(99)).toBe(ZOOM_MAX)
    expect(zoomAt({ k: ZOOM_MAX, x: 0, y: 0 }, { x: 5, y: 5 }, 2)).toEqual({ k: ZOOM_MAX, x: 0, y: 0 })
    expect(clampK(Number.NaN)).toBe(1)
  })
  it('pans', () => {
    expect(panBy({ k: 2, x: 1, y: 2 }, 3, -4)).toEqual({ k: 2, x: 4, y: -2 })
  })
  it('keeps at least 64 px of the drawing inside, or all of a small one', () => {
    const box = { w: 400, h: 300 }
    const nat = { w: 1000, h: 800 }
    const far = clampView({ k: 1, x: -5000, y: 9000 }, box, nat)
    expect(far.x).toBe(64 - 1000)
    expect(far.y).toBe(300 - 64)
    const small = clampView({ k: 1, x: -500, y: 0 }, box, { w: 40, h: 40 })
    expect(small.x).toBe(0)
    expect(clampView({ k: 1, x: 9000, y: 0 }, box, { w: 40, h: 40 }).x).toBe(400 - 40)
  })
  it('actual size centres a drawing that fits, else zooms about the point', () => {
    const box = { w: 400, h: 300 }
    expect(actualView({ k: 3, x: 0, y: 0 }, box, { w: 100, h: 100 })).toEqual({ k: 1, x: 150, y: 100 })
    const big = actualView({ k: 0.5, x: 0, y: 0 }, box, { w: 2000, h: 2000 }, { x: 100, y: 100 })
    expect(big.k).toBe(1)
    expect(big.x).toBeCloseTo(-100)
  })
})

describe('overview', () => {
  it('is at most 168x120 or a quarter of the smaller side', () => {
    const big = overviewRects({ k: 1, x: 0, y: 0 }, { w: 1600, h: 900 }, { w: 3000, h: 2000 })
    expect(big.panel.w).toBeLessThanOrEqual(168)
    expect(big.panel.h).toBeLessThanOrEqual(120)
    const small = overviewRects({ k: 1, x: 0, y: 0 }, { w: 300, h: 200 }, { w: 3000, h: 2000 })
    expect(Math.max(small.panel.w, small.panel.h)).toBeLessThanOrEqual(50.01)
  })
  it('draws the viewport rectangle clipped to the panel', () => {
    const r = overviewRects({ k: 1, x: -100, y: -100 }, { w: 200, h: 100 }, { w: 1000, h: 500 })
    expect(r.rect.x).toBeCloseTo(100 * r.scale)
    expect(r.rect.w).toBeCloseTo(200 * r.scale)
    const off = overviewRects({ k: 1, x: 5000, y: 0 }, { w: 200, h: 100 }, { w: 1000, h: 500 })
    expect(off.rect.w).toBe(0)
  })
  it('centres the view on a clicked point', () => {
    const box = { w: 400, h: 300 }
    const nat = { w: 2000, h: 1000 }
    const o = overviewRects({ k: 1, x: 0, y: 0 }, box, nat)
    const v = centerOnOverview({ k: 1, x: 0, y: 0 }, box, nat, { x: o.panel.w / 2, y: o.panel.h / 2 })
    expect(v.x).toBeCloseTo(200 - 1000)
    expect(v.y).toBeCloseTo(150 - 500)
  })
})

describe('wheel and keys', () => {
  it('is 1.1 per notch and continuous for a pinch', () => {
    expect(wheelFactor(-100, 0, false)).toBeCloseTo(1.1)
    expect(wheelFactor(100, 0, false)).toBeCloseTo(1 / 1.1)
    expect(wheelFactor(-3, 0, true)).toBeCloseTo(Math.exp(0.03))
    expect(wheelFactor(-3, 1, false)).toBeGreaterThan(1)
    expect(wheelFactor(0, 0, false)).toBe(1)
    expect(wheelFactor(Number.NaN, 0, false)).toBe(1)
  })
  it('maps keys', () => {
    expect(viewKey({ key: 'ArrowRight' })).toEqual({ type: 'pan', dx: -48, dy: 0 })
    expect(viewKey({ key: 'ArrowUp', shiftKey: true })).toEqual({ type: 'pan', dx: 0, dy: 192 })
    expect(viewKey({ key: '+' })).toEqual({ type: 'zoom', factor: 1.25 })
    expect(viewKey({ key: '-' })).toEqual({ type: 'zoom', factor: 0.8 })
    expect(viewKey({ key: '0' })).toEqual({ type: 'fit' })
    expect(viewKey({ key: 'Home' })).toEqual({ type: 'fit' })
    expect(viewKey({ key: '1' })).toEqual({ type: 'actual' })
    expect(viewKey({ key: 'o' })?.type).toBe('overview')
    expect(viewKey({ key: 'S' })?.type).toBe('source')
    expect(viewKey({ key: 'f' })?.type).toBe('full')
    expect(viewKey({ key: 'Tab' })).toBeNull()
    expect(viewKey({ key: '+', ctrlKey: true })).toBeNull()
  })
})

describe('wording', () => {
  it('speaks zoom and labels it', () => {
    expect(percentLabel(0.6)).toBe('60%')
    expect(zoomSpeech(0.6, false)).toBe('Zoom 60 percent')
    expect(zoomSpeech(0.6, true)).toBe('Fit to window')
    expect(zoomDataValue(0.123456, false)).toBe('0.12')
    expect(zoomDataValue(1, true)).toBe('fit')
  })
  it('flags large diagrams', () => {
    expect(isLargeDiagram(41, 1)).toBe(true)
    expect(isLargeDiagram(10, 0.39)).toBe(true)
    expect(isLargeDiagram(40, 0.4)).toBe(false)
    expect(largeNote(80)).toBe('Large diagram, 80 shapes. Zoom in to read, or open the larger view.')
  })
  it('lists labels for up to 60 shapes, else points at the source', () => {
    expect(diagramText(['Web app', 'API', 'API', ' Data  base '], 4)).toBe('Contains: Web app, API, Data base.')
    expect(diagramText([], 80)).toBe('80 shapes; read the source for the full text.')
    expect(diagramText([], 0)).toBe('')
  })
  it('has one hint per context', () => {
    expect(hintText('detail')).toContain('Ctrl + scroll')
    expect(hintText('dialog')).toContain('Scroll or pinch')
  })
})

describe('source', () => {
  it('finds line and column', () => {
    const t = 'abc\ndefgh\ni'
    expect(lineColumn(t, 0)).toEqual({ line: 1, column: 1 })
    expect(lineColumn(t, 4)).toEqual({ line: 2, column: 1 })
    expect(lineColumn(t, 7)).toEqual({ line: 2, column: 4 })
    expect(lineColumn(t, 99)).toEqual({ line: 3, column: 2 })
  })
  it('formats sizes and the status line', () => {
    expect(sizeLabel(812)).toBe('812 B')
    expect(sizeLabel(2765)).toBe('2.7 KB')
    expect(sizeLabel(3 * 1024 * 1024)).toBe('3.0 MB')
    expect(byteLength('é')).toBe(2)
    expect(sourceStatus('ab\ncd', 4)).toBe('Line 2, column 2 · 5 B')
  })
  it('reads the error line from mermaid text', () => {
    expect(errorLine('Parse error on line 2')).toBe(2)
    expect(errorLine('Something broke')).toBeNull()
    expect(errorSentence('Parse error on line 2')).toBe('This diagram has a syntax error on line 2, so it cannot be drawn. The source is below.')
    expect(errorSentence('Lexical failure')).toBe('This diagram cannot be drawn: Lexical failure.')
  })
  it('gives the range of a line, clamped', () => {
    const t = 'one\ntwo\nthree'
    expect(lineRange(t, 1)).toEqual({ start: 0, end: 3 })
    expect(lineRange(t, 2)).toEqual({ start: 4, end: 7 })
    expect(lineRange(t, 3)).toEqual({ start: 8, end: 13 })
    expect(lineRange(t, 9)).toEqual({ start: 8, end: 13 })
  })
})
