import { describe, expect, it } from 'vitest'
import { CANVAS_PRESETS, DEFAULT_APPEARANCE, applyCanvasPreset } from '@shared/defaults'
import {
  AVAILABLE_PRESETS,
  CANVAS_STYLE_OPTIONS,
  agentNodeSize,
  applyCanvasStyle,
  applyDefaultCanvas,
  shownStyle,
  styleLabel,
  edgeStroke,
  effectiveNodeStyle,
  groupNodeSize,
  handlesFor,
  minimapSize,
  readCanvasOptions,
  reportingLineRole,
  ringStepFor,
  shownPreset,
  stationGeometry,
  stationHandleStyle
} from './canvas'

describe('readCanvasOptions', () => {
  it('falls back to the defaults for missing and unknown values', () => {
    const d = DEFAULT_APPEARANCE.canvas
    expect(readCanvasOptions(() => null)).toEqual({ presentation: 'graph', scenePalette: 'color', pattern: d.pattern, edges: d.edges, layout: d.layout, nodeStyle: 'card', tint: d.tint, minimap: d.minimap })
    expect(readCanvasOptions((n) => (n === 'data-canvas-pattern' ? 'nope' : null)).pattern).toBe(d.pattern)
  })
  it('reads each attribute', () => {
    const attrs: Record<string, string> = {
      'data-canvas-presentation': 'pocket-office',
      'data-canvas-scene-palette': 'green',
      'data-canvas-pattern': 'blueprint',
      'data-canvas-edges': 'straight',
      'data-canvas-layout': 'radial',
      'data-canvas-node-style': 'compact',
      'data-canvas-tint': 'off',
      'data-canvas-minimap': 'on'
    }
    expect(readCanvasOptions((n) => attrs[n] ?? null)).toEqual({ presentation: 'pocket-office', scenePalette: 'green', pattern: 'blueprint', edges: 'straight', layout: 'radial', nodeStyle: 'compact', tint: false, minimap: true })
    expect(readCanvasOptions(() => 'invalid')).toMatchObject({ presentation: 'graph', scenePalette: 'color' })
  })
})

describe('effectiveNodeStyle', () => {
  it('keeps built styles and draws the rest as card', () => {
    expect(effectiveNodeStyle('compact')).toBe('compact')
    expect(effectiveNodeStyle('card')).toBe('card')
    expect(effectiveNodeStyle('hex')).toBe('hex')
    expect(effectiveNodeStyle('station')).toBe('station')
    expect(effectiveNodeStyle('bogus')).toBe('card')
    expect(effectiveNodeStyle(null)).toBe('card')
  })
})

describe('shownPreset', () => {
  it('names every preset once all node styles are built, and Custom otherwise', () => {
    const base = DEFAULT_APPEARANCE.canvas
    expect(shownPreset(applyCanvasPreset(base, 'blueprint'))).toBe('blueprint')
    expect(shownPreset(applyCanvasPreset(base, 'subway'))).toBe('subway')
    expect(shownPreset(applyCanvasPreset(base, 'hive'))).toBe('hive')
    expect(shownPreset({ ...base, pattern: 'grid' })).toBeUndefined()
    expect(AVAILABLE_PRESETS.map((p) => p.id)).toEqual(CANVAS_PRESETS.map((p) => p.id))
  })
})

describe('the Default gallery entry', () => {
  const base = DEFAULT_APPEARANCE.canvas
  it('is first and reads as checked on the default look, with or without the minimap', () => {
    expect(CANVAS_STYLE_OPTIONS[0].id).toBe('default')
    expect(CANVAS_STYLE_OPTIONS.map((o) => o.id)).toEqual(['default', ...CANVAS_PRESETS.map((p) => p.id)])
    expect(shownStyle(base)).toBe('default')
    expect(shownStyle({ ...base, minimap: true })).toBe('default')
  })
  it('is Custom only when neither Default nor a preset matches', () => {
    expect(shownStyle(applyCanvasPreset(base, 'blueprint'))).toBe('blueprint')
    expect(shownStyle({ ...base, pattern: 'grid' })).toBeUndefined()
    expect(shownStyle({ ...base, tint: false })).toBeUndefined()
  })
  it('applyDefaultCanvas restores the five fields and keeps the minimap', () => {
    const blueprint = { ...applyCanvasPreset(base, 'blueprint'), minimap: true }
    const back = applyDefaultCanvas(blueprint)
    expect(back).toEqual({ ...base, minimap: true })
    expect(shownStyle(back)).toBe('default')
    expect(applyCanvasStyle(blueprint, 'default')).toEqual(back)
    expect(applyCanvasStyle(base, 'hive')).toEqual(applyCanvasPreset(base, 'hive'))
    expect(applyCanvasStyle({ ...base, presentation: 'pocket-office', scenePalette: 'green' }, 'hive')).toMatchObject({ presentation: 'graph', scenePalette: 'green' })
  })
  it('names the entries', () => {
    expect(styleLabel('default')).toBe('Default')
    expect(styleLabel('paper')).toBe('Paper')
    expect(styleLabel(undefined)).toBeUndefined()
  })
})

describe('stations and hex tiles', () => {
  it('puts the name beside the station top down and below it otherwise', () => {
    expect(stationGeometry('top-down')).toMatchObject({ width: 160, height: 40, cx: 20, cy: 20, label: 'beside' })
    expect(stationGeometry('left-right')).toMatchObject({ width: 120, height: 64, cx: 60, cy: 18, label: 'below' })
    expect(stationGeometry('radial')).toEqual(stationGeometry('left-right'))
    expect(agentNodeSize('station', 'top-down')).toEqual({ width: 160, height: 40 })
    expect(groupNodeSize('station', 'radial')).toEqual({ width: 120, height: 64 })
  })
  it('places handles on the circle edge', () => {
    const g = stationGeometry('left-right')
    expect(stationHandleStyle(g, 'left')).toEqual({ left: 44, top: 18 })
    expect(stationHandleStyle(g, 'right')).toEqual({ left: 76, top: 18 })
    expect(stationHandleStyle(stationGeometry('top-down'), 'bottom')).toEqual({ left: 20, top: 36 })
  })
  it('sizes hex tiles and steps the radial ring by one cell', () => {
    expect(agentNodeSize('hex')).toEqual({ width: 120, height: 104 })
    expect(groupNodeSize('hex')).toEqual({ width: 120, height: 104 })
    expect(ringStepFor('hex')).toBe(116)
    expect(ringStepFor('station')).toBe(180)
  })
  it('colours a station line by its lead and every other line by its report', () => {
    expect(reportingLineRole('station', '#111111', '#222222')).toBe('#111111')
    expect(reportingLineRole('card', '#111111', '#222222')).toBe('#222222')
    expect(reportingLineRole('hex', '#111111', '#222222')).toBe('#222222')
  })
})

describe('handlesFor and sizes', () => {
  it('puts reporting lines top to bottom, or left to right', () => {
    expect(handlesFor('top-down')).toEqual({ target: 'top', source: 'bottom', msgIn: 'left', msgOut: 'right' })
    expect(handlesFor('radial')).toEqual(handlesFor('top-down'))
    expect(handlesFor('left-right')).toEqual({ target: 'left', source: 'right', msgIn: 'top', msgOut: 'bottom' })
  })
  it('sizes nodes per style', () => {
    expect(agentNodeSize('compact')).toEqual({ width: 160, height: 40 })
    expect(agentNodeSize('card')).toEqual({ width: 240, height: 112 })
    expect(groupNodeSize('compact')).toEqual({ width: 160, height: 40 })
    expect(groupNodeSize('card')).toEqual({ width: 240, height: 56 })
    expect(ringStepFor('card')).toBe(300)
    expect(ringStepFor('compact')).toBe(200)
  })
})

describe('edgeStroke', () => {
  it('returns the ends at 100% and 0%', () => {
    expect(edgeStroke('#7c5cff', 100, '#ffffff')).toBe('#7c5cff')
    expect(edgeStroke('#7c5cff', '0%', '#ffffff')).toBe('#ffffff')
  })
  it('mixes in sRGB and accepts a percent string', () => {
    expect(edgeStroke('#000000', '50%', '#ffffff')).toBe('#808080')
    expect(edgeStroke('#000000', 50, '#ffffff')).toBe('#808080')
    expect(edgeStroke('#ff0000', 85, '#e8ebf3')).toBe('#fc2324')
  })
  it('accepts short hex and rgb() ink', () => {
    expect(edgeStroke('#fff', 50, 'rgb(0, 0, 0)')).toBe('#808080')
  })
  it('returns the role unchanged for colours it cannot read', () => {
    expect(edgeStroke('var(--x)', 50, '#ffffff')).toBe('var(--x)')
    expect(edgeStroke('#112233', 50, 'var(--ink)')).toBe('#112233')
    expect(edgeStroke('#112233', 'lots', '#ffffff')).toBe('#112233')
  })
})

describe('minimapSize', () => {
  it('sizes a 1024 x 640 stage at 120 x 84', () => {
    expect(minimapSize(600, 279)).toEqual({ width: 120, height: 84 })
  })
  it('clamps the width to 200', () => {
    expect(minimapSize(1600, 700)).toEqual({ width: 200, height: 150 })
  })
  it('is null below the thresholds', () => {
    expect(minimapSize(479, 400)).toBeNull()
    expect(minimapSize(600, 239)).toBeNull()
    expect(minimapSize(480, 240)).not.toBeNull()
  })
})

describe('motion helpers', () => {
  it('breathes only the first 12 working nodes, in node order', async () => {
    const { breatheIndex, glideMs, GLIDE_MAX_NODES } = await import('./canvas')
    const nodes = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, working: i % 2 === 0 }))
    const idx = breatheIndex(nodes)
    expect(idx.size).toBe(10)
    expect([...idx.values()]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    const all = breatheIndex(Array.from({ length: 30 }, (_, i) => ({ id: `w${i}`, working: true })))
    expect(all.size).toBe(12)
    expect(all.has('w12')).toBe(false)
    // Above the cap a layout snaps instead of gliding.
    expect(glideMs(GLIDE_MAX_NODES + 1)).toBe(0)
  })
})
