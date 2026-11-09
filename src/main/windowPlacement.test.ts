import { describe, expect, it } from 'vitest'
import { centerIn, orderDisplays, parseLargerThanScreen, parseWindowHidden, parseWindowDisplay, parseWindowInactive, pickDisplay, windowPlacement, type DisplayInfo } from './windowPlacement'

const d = (id: number, x: number, y: number, w = 1920, h = 1080): DisplayInfo => ({
  id,
  bounds: { x, y, width: w, height: h },
  workArea: { x, y, width: w, height: h - 40 }
})
const left = d(1, 0, 0)
const right = d(2, 1920, 0)

describe('window placement', () => {
  it('parses only exact forms', () => {
    expect(parseWindowDisplay(undefined)).toBeNull()
    expect(parseWindowDisplay('secondary')).toEqual({ kind: 'secondary' })
    expect(parseWindowDisplay('2')).toEqual({ kind: 'index', index: 2 })
    for (const bad of ['', 'Secondary', ' 2', '2 ', '0', '02', '-1', '1.5', '100', 'second', '1e1']) expect(parseWindowDisplay(bad)).toBeNull()
    expect(parseWindowInactive('1')).toBe(true)
    for (const v of [undefined, '', '0', 'true', ' 1', '11']) expect(parseWindowInactive(v)).toBe(false)
    expect(parseWindowHidden('1')).toBe(true)
    for (const v of [undefined, '', '0', 'true', ' 1']) expect(parseWindowHidden(v)).toBe(false)
    expect(parseLargerThanScreen('1')).toBe(true)
    for (const v of [undefined, '', '0', 'true', ' 1', '11']) expect(parseLargerThanScreen(v)).toBe(false)
  })

  it('orders left to right, top to bottom', () => {
    expect(orderDisplays([right, left]).map((x) => x.id)).toEqual([1, 2])
    const below = d(3, 0, 1080)
    expect(orderDisplays([below, right, left]).map((x) => x.id)).toEqual([1, 3, 2])
  })

  it('picks secondary as the first non-primary and numbers by position', () => {
    expect(pickDisplay({ kind: 'secondary' }, [right, left], 1)?.id).toBe(2)
    expect(pickDisplay({ kind: 'secondary' }, [left], 1)).toBeNull()
    expect(pickDisplay({ kind: 'index', index: 1 }, [right, left], 2)?.id).toBe(1)
    expect(pickDisplay({ kind: 'index', index: 3 }, [right, left], 1)).toBeNull()
  })

  it('centres in the work area and clamps', () => {
    expect(centerIn(right, 1440, 920)).toEqual({ x: 1920 + 240, y: Math.round((1040 - 920) / 2) })
    expect(centerIn(right, 3000, 2000)).toEqual({ x: 1920, y: 0 })
  })

  it('falls back with a note on unknown value or missing display, silently when unset', () => {
    expect(windowPlacement(undefined, [left, right], 1, 100, 100)).toEqual({ position: null })
    expect(windowPlacement('nope', [left, right], 1, 100, 100).note).toMatch(/default placement/)
    expect(windowPlacement('secondary', [left], 1, 100, 100)).toMatchObject({ position: null })
    expect(windowPlacement('secondary', [left], 1, 100, 100).note).toBeTruthy()
    expect(windowPlacement('2', [left, right], 1, 100, 100).position).toEqual(centerIn(right, 100, 100))
  })
})
