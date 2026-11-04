import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE, applyCanvasPreset } from '@shared/defaults'
import {
  AVAILABLE_PRESETS,
  agentNodeSize,
  edgeStroke,
  effectiveNodeStyle,
  groupNodeSize,
  handlesFor,
  minimapSize,
  readCanvasOptions,
  ringStepFor,
  shownPreset
} from './canvas'

describe('readCanvasOptions', () => {
  it('falls back to the defaults for missing and unknown values', () => {
    const d = DEFAULT_APPEARANCE.canvas
    expect(readCanvasOptions(() => null)).toEqual({ pattern: d.pattern, edges: d.edges, layout: d.layout, nodeStyle: 'card', tint: d.tint, minimap: d.minimap })
    expect(readCanvasOptions((n) => (n === 'data-canvas-pattern' ? 'nope' : null)).pattern).toBe(d.pattern)
  })
  it('reads each attribute', () => {
    const attrs: Record<string, string> = {
      'data-canvas-pattern': 'blueprint',
      'data-canvas-edges': 'straight',
      'data-canvas-layout': 'radial',
      'data-canvas-node-style': 'compact',
      'data-canvas-tint': 'off',
      'data-canvas-minimap': 'on'
    }
    expect(readCanvasOptions((n) => attrs[n] ?? null)).toEqual({ pattern: 'blueprint', edges: 'straight', layout: 'radial', nodeStyle: 'compact', tint: false, minimap: true })
  })
})

describe('effectiveNodeStyle', () => {
  it('keeps built styles and draws the rest as card', () => {
    expect(effectiveNodeStyle('compact')).toBe('compact')
    expect(effectiveNodeStyle('card')).toBe('card')
    expect(effectiveNodeStyle('hex')).toBe('card')
    expect(effectiveNodeStyle('station')).toBe('card')
    expect(effectiveNodeStyle('bogus')).toBe('card')
    expect(effectiveNodeStyle(null)).toBe('card')
  })
})

describe('shownPreset', () => {
  it('names an available preset and hides unavailable and custom ones', () => {
    const base = DEFAULT_APPEARANCE.canvas
    expect(shownPreset(applyCanvasPreset(base, 'blueprint'))).toBe('blueprint')
    expect(shownPreset(applyCanvasPreset(base, 'subway'))).toBeUndefined()
    expect(shownPreset({ ...base, pattern: 'grid' })).toBeUndefined()
    expect(AVAILABLE_PRESETS.some((p) => p.id === 'hive')).toBe(false)
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
