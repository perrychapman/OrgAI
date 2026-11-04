import { describe, expect, it } from 'vitest'
import { CANVAS_PRESETS, DEFAULT_APPEARANCE, activeCanvasPreset, applyCanvasPreset } from './defaults'
import { CANVAS_EDGE_STYLES, CANVAS_LAYOUTS, CANVAS_NODE_STYLES, CANVAS_PATTERNS } from './types'

describe('canvas presets', () => {
  it('lists the patterns in contract order', () => {
    expect(CANVAS_PATTERNS).toEqual(['dots', 'grid', 'none', 'blueprint', 'paper', 'isometric', 'circuit', 'terminal', 'starfield'])
  })

  it('uses only known axis values, unique ids and plain labels', () => {
    expect(new Set(CANVAS_PRESETS.map((p) => p.id)).size).toBe(CANVAS_PRESETS.length)
    for (const p of CANVAS_PRESETS) {
      expect(CANVAS_PATTERNS).toContain(p.canvas.pattern)
      expect(CANVAS_EDGE_STYLES).toContain(p.canvas.edges)
      expect(CANVAS_LAYOUTS).toContain(p.canvas.layout)
      expect(CANVAS_NODE_STYLES).toContain(p.canvas.nodeStyle)
      expect(p.canvas.tint).toBe(false)
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.description.length).toBeGreaterThan(0)
    }
  })

  it('round-trips through applyCanvasPreset and keeps the minimap', () => {
    for (const p of CANVAS_PRESETS) {
      for (const minimap of [true, false]) {
        const next = applyCanvasPreset({ ...DEFAULT_APPEARANCE.canvas, minimap }, p.id)
        expect(next.minimap).toBe(minimap)
        expect(activeCanvasPreset(next)).toBe(p.id)
      }
    }
  })

  it('reports no preset for the default canvas or a tweaked preset', () => {
    expect(activeCanvasPreset(DEFAULT_APPEARANCE.canvas)).toBeUndefined()
    const blueprint = applyCanvasPreset(DEFAULT_APPEARANCE.canvas, 'blueprint')
    expect(activeCanvasPreset({ ...blueprint, edges: 'straight' })).toBeUndefined()
  })
})
