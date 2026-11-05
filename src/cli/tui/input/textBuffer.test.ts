import { describe, expect, it } from 'vitest'
import {
  backspace,
  cursorPosition,
  deleteForward,
  EMPTY_BUFFER,
  graphemeWidth,
  insertText,
  killToLineEnd,
  killToLineStart,
  killWordBack,
  lineEnd,
  lineHome,
  moveDown,
  moveLeft,
  moveRight,
  moveUp,
  wrapBuffer,
  type TextBuffer
} from './textBuffer'

const buf = (text: string, cursor = text.length): TextBuffer => ({ text, cursor })

describe('textBuffer edits', () => {
  it('inserts at the cursor', () => {
    expect(insertText(buf('ac', 1), 'b')).toEqual(buf('abc', 2))
    expect(insertText(EMPTY_BUFFER, 'x\ny')).toEqual(buf('x\ny'))
  })

  it('backspace and delete step by grapheme', () => {
    expect(backspace(buf('a😀'))).toEqual(buf('a'))
    expect(backspace(buf('a👨‍👩‍👧'))).toEqual(buf('a'))
    expect(backspace(buf('', 0))).toEqual(buf('', 0))
    expect(deleteForward(buf('😀b', 0))).toEqual(buf('b', 0))
    expect(deleteForward(buf('ab'))).toEqual(buf('ab'))
    expect(backspace(buf('a\nb', 2))).toEqual(buf('ab', 1))
  })

  it('left / right / home / end', () => {
    expect(moveLeft(buf('a😀'))).toEqual(buf('a😀', 1))
    expect(moveRight(buf('a😀', 1))).toEqual(buf('a😀', 3))
    expect(moveLeft(buf('a', 0)).cursor).toBe(0)
    expect(lineHome(buf('ab\ncd', 4)).cursor).toBe(3)
    expect(lineEnd(buf('ab\ncd', 0)).cursor).toBe(2)
  })

  it('up / down keep the column, null at the edges', () => {
    const b = buf('abcd\nxy\nlonger', 3)
    const d = moveDown(b)!
    expect(cursorPosition(d)).toEqual({ line: 1, col: 2 })
    const d2 = moveDown(d)!
    expect(cursorPosition(d2)).toEqual({ line: 2, col: 2 })
    expect(moveDown(d2)).toBeNull()
    expect(cursorPosition(moveUp(d2)!)).toEqual({ line: 1, col: 2 })
    expect(moveUp(b)).toBeNull()
  })

  it('readline kills', () => {
    expect(killToLineStart(buf('ab\ncdef', 5))).toEqual(buf('ab\nef', 3))
    expect(killToLineEnd(buf('ab\ncdef', 4))).toEqual(buf('ab\nc', 4))
    expect(killWordBack(buf('one two  '))).toEqual(buf('one '))
    expect(killWordBack(buf('one'))).toEqual(buf(''))
  })
})

describe('wrapBuffer', () => {
  it('wraps by width with the cursor on one row', () => {
    const rows = wrapBuffer(buf('abcdefg', 7), 3)
    expect(rows.map((r) => r.cells.join(''))).toEqual(['abc', 'def', 'g'])
    expect(rows.map((r) => r.cursorAt)).toEqual([undefined, undefined, 1])
  })

  it('a cursor at the end of a full row goes to a fresh row', () => {
    const rows = wrapBuffer(buf('abc', 3), 3)
    expect(rows.map((r) => r.cells.join(''))).toEqual(['abc', ''])
    expect(rows[1].cursorAt).toBe(0)
  })

  it('keeps hard lines and the cursor on a wrapped boundary', () => {
    const rows = wrapBuffer(buf('abcd\nx', 3), 3)
    expect(rows.map((r) => r.cells.join(''))).toEqual(['abc', 'd', 'x'])
    expect(rows.filter((r) => r.cursorAt !== undefined)).toHaveLength(1)
    expect(rows[1].cursorAt).toBe(0)
  })

  it('counts wide characters as two columns', () => {
    expect(graphemeWidth('😀')).toBe(2)
    expect(graphemeWidth('漢')).toBe(2)
    expect(graphemeWidth('a')).toBe(1)
    const rows = wrapBuffer(buf('😀😀😀', 0), 4)
    expect(rows.map((r) => r.cells.length)).toEqual([2, 1])
    expect(rows[0].cursorAt).toBe(0)
  })

  it('an empty buffer is one row with the cursor', () => {
    expect(wrapBuffer(EMPTY_BUFFER, 10)).toEqual([{ cells: [], cursorAt: 0 }])
  })
})
