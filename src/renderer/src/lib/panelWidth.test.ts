import { describe, expect, it } from 'vitest'
import { clampWidth, dragWidth, keyWidth, maxWidthFor, STEP_BIG_PX, STEP_PX } from './panelWidth'

describe('panelWidth', () => {
  it('clamps into range', () => {
    expect(clampWidth(100, 200, 400)).toBe(200)
    expect(clampWidth(900, 200, 400)).toBe(400)
    expect(clampWidth(250.4, 200, 400)).toBe(250)
  })
  it('never lets max fall under min', () => {
    expect(clampWidth(300, 280, 100)).toBe(280)
    expect(maxWidthFor(500, 360, 280, 640)).toBe(280)
  })
  it('leaves room for the neighbouring area', () => {
    expect(maxWidthFor(1000, 360, 280, 640)).toBe(640)
    expect(maxWidthFor(800, 360, 280, 640)).toBe(440)
  })
  it('drags in the right direction', () => {
    expect(dragWidth(232, 40, 1, 200, 420)).toBe(272)
    expect(dragWidth(360, 40, -1, 280, 640)).toBe(320)
    expect(dragWidth(360, -400, -1, 280, 640)).toBe(640)
  })
  it('steps with arrows, Shift, Home and End', () => {
    expect(keyWidth(300, 'ArrowRight', false, 1, 200, 420)).toBe(300 + STEP_PX)
    expect(keyWidth(300, 'ArrowLeft', true, 1, 200, 420)).toBe(300 - STEP_BIG_PX)
    expect(keyWidth(400, 'ArrowLeft', false, -1, 280, 640)).toBe(400 + STEP_PX)
    expect(keyWidth(300, 'Home', false, 1, 200, 420)).toBe(200)
    expect(keyWidth(300, 'End', false, 1, 200, 420)).toBe(420)
    expect(keyWidth(300, 'a', false, 1, 200, 420)).toBeNull()
  })
})
