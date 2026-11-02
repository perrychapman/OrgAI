import { describe, expect, it } from 'vitest'
import { CANVAS_MIN_PX, PANEL_W, panelBudget } from './panelWidth'

describe('panelBudget', () => {
  it('keeps the canvas minimum and clamps the saved width', () => {
    const b = panelBudget(800, 640)
    expect(b.fits).toBe(true)
    expect(b.width).toBe(800 - CANVAS_MIN_PX)
    expect(b.max).toBe(800 - CANVAS_MIN_PX)
  })
  it('has no fixed upper cap: a wide window lets the panel pass 640 px', () => {
    expect(panelBudget(2000, 900).width).toBe(900)
    expect(panelBudget(2000, null).max).toBe(2000 - CANVAS_MIN_PX)
  })
  it('reports no fit when the panel minimum would squeeze the canvas', () => {
    expect(panelBudget(CANVAS_MIN_PX + PANEL_W.min - 1, 400).fits).toBe(false)
    expect(panelBudget(CANVAS_MIN_PX + PANEL_W.min, 400).fits).toBe(true)
  })
  it('re-applies the saved width when space returns', () => {
    expect(panelBudget(650, 500).width).toBe(370)
    expect(panelBudget(1400, 500).width).toBe(500)
  })
  it('treats an unmeasured parent as fitting and null as the CSS default', () => {
    expect(panelBudget(0, null)).toMatchObject({ fits: true, width: null })
  })
})
