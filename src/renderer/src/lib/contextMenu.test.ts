import { describe, expect, it } from 'vitest'
import { isMenuKey, nativeMenuWins, nextMenuIndex, placeAtAnchor, placeAtPoint, typeAheadIndex } from './contextMenu'

const VP = { w: 1024, h: 640 }
const MENU = { w: 200, h: 120 }

describe('placeAtPoint', () => {
  it('puts the corner at the pointer when it fits', () => {
    expect(placeAtPoint({ x: 100, y: 100 }, MENU, VP)).toEqual({ x: 100, y: 100 })
  })
  it('flips left and up near the right and bottom edges', () => {
    expect(placeAtPoint({ x: 1000, y: 600 }, MENU, VP)).toEqual({ x: 800, y: 480 })
  })
  it('clamps into the viewport when neither side fits', () => {
    const p = placeAtPoint({ x: 50, y: 50 }, { w: 2000, h: 2000 }, VP)
    expect(p).toEqual({ x: 8, y: 8 })
  })
  it('never goes past the top left margin', () => {
    expect(placeAtPoint({ x: 0, y: 0 }, MENU, VP)).toEqual({ x: 8, y: 8 })
  })
})

describe('placeAtAnchor', () => {
  const rect = { left: 100, top: 100, right: 300, bottom: 130 }
  it('opens under the element, start aligned', () => {
    expect(placeAtAnchor(rect, MENU, VP)).toEqual({ x: 100, y: 134 })
  })
  it('aligns to the end edge when asked', () => {
    expect(placeAtAnchor(rect, MENU, VP, 'end')).toEqual({ x: 100, y: 134 })
    expect(placeAtAnchor({ ...rect, right: 500 }, MENU, VP, 'end')).toEqual({ x: 300, y: 134 })
  })
  it('opens above when there is no room below', () => {
    expect(placeAtAnchor({ left: 100, top: 560, right: 300, bottom: 590 }, MENU, VP)).toEqual({ x: 100, y: 436 })
  })
  it('keeps inside the right edge', () => {
    expect(placeAtAnchor({ left: 950, top: 10, right: 1010, bottom: 30 }, MENU, VP).x).toBe(1024 - 200 - 8)
  })
})

describe('nextMenuIndex', () => {
  it('wraps both ways', () => {
    expect(nextMenuIndex(2, 'ArrowDown', 3)).toBe(0)
    expect(nextMenuIndex(0, 'ArrowUp', 3)).toBe(2)
  })
  it('Home and End go to the ends', () => {
    expect(nextMenuIndex(1, 'Home', 4)).toBe(0)
    expect(nextMenuIndex(1, 'End', 4)).toBe(3)
  })
  it('enters from nothing focused', () => {
    expect(nextMenuIndex(-1, 'ArrowDown', 3)).toBe(0)
    expect(nextMenuIndex(-1, 'ArrowUp', 3)).toBe(2)
  })
  it('returns -1 for an empty menu', () => {
    expect(nextMenuIndex(0, 'ArrowDown', 0)).toBe(-1)
  })
})

describe('typeAheadIndex', () => {
  const labels = ['Open', 'Open in new window', 'Hide', 'Delete']
  it('finds the next match after the current item, wrapping', () => {
    expect(typeAheadIndex(0, 'o', labels)).toBe(1)
    expect(typeAheadIndex(1, 'o', labels)).toBe(0)
    expect(typeAheadIndex(0, 'D', labels)).toBe(3)
  })
  it('returns -1 with no match or a blank key', () => {
    expect(typeAheadIndex(0, 'z', labels)).toBe(-1)
    expect(typeAheadIndex(0, ' ', labels)).toBe(-1)
  })
})

describe('isMenuKey', () => {
  const k = (key: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods })
  it('accepts the Menu key and Shift+F10', () => {
    expect(isMenuKey(k('ContextMenu'))).toBe(true)
    expect(isMenuKey(k('F10', { shiftKey: true }))).toBe(true)
  })
  it('rejects plain F10 and modified keys', () => {
    expect(isMenuKey(k('F10'))).toBe(false)
    expect(isMenuKey(k('F10', { shiftKey: true, ctrlKey: true }))).toBe(false)
    expect(isMenuKey(k('ContextMenu', { altKey: true }))).toBe(false)
  })
})

describe('nativeMenuWins', () => {
  it('lets the native menu win in fields, on links and over a selection', () => {
    expect(nativeMenuWins({ editable: true, link: false, selectedText: '' })).toBe(true)
    expect(nativeMenuWins({ editable: false, link: true, selectedText: '' })).toBe(true)
    expect(nativeMenuWins({ editable: false, link: false, selectedText: 'hello' })).toBe(true)
  })
  it('lets the custom menu open otherwise (a whitespace selection does not count)', () => {
    expect(nativeMenuWins({ editable: false, link: false, selectedText: '' })).toBe(false)
    expect(nativeMenuWins({ editable: false, link: false, selectedText: '  \n' })).toBe(false)
  })
})
