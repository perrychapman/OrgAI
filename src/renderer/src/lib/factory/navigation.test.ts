import { describe, expect, it } from 'vitest'
import { EMPTY_LAYOUT_MEMORY, layoutFloor } from './layout'
import { PLAN_BOARD_ID, floorKeyAction, nextFocus, tabStop, type FocusKey } from './navigation'
import type { FactoryAgentInput } from './types'

function agent(id: string, parentId: string | null, startedAt: number): FactoryAgentInput {
  return { id, name: id, parentId, roleKey: 'r', state: 'thinking', statusWord: 'Running', activity: '', toolCalls: 0, startedAt, session: 'current' }
}

// Row 0: A (6), B (10), C (14). Row 1: a1..a4 (6..18). Row 2: b1, b2 (6, 10); b3 left (vacant at 14).
const all = [
  agent('root', null, 0),
  agent('A', 'root', 1),
  agent('B', 'root', 2),
  agent('C', 'root', 3),
  agent('a1', 'A', 4),
  agent('a2', 'A', 5),
  agent('a3', 'A', 6),
  agent('a4', 'A', 7),
  agent('b1', 'B', 8),
  agent('b2', 'B', 9),
  agent('b3', 'B', 10)
]
const first = layoutFloor({ runKey: 'r', agents: all }, EMPTY_LAYOUT_MEMORY)
const layout = layoutFloor({ runKey: 'r', agents: all.filter((a) => a.id !== 'b3') }, first.memory).layout

describe('nextFocus (section 6.3)', () => {
  it('reading order skips vacant slots', () => {
    expect(layout.order).toEqual(['root', 'A', 'B', 'C', 'a1', 'a2', 'a3', 'a4', 'b1', 'b2'])
    expect(layout.vacant.map((v) => v.id)).toEqual(['b3'])
  })

  const table: [string, FocusKey, string | null][] = [
    ['A', 'ArrowRight', 'B'],
    ['C', 'ArrowRight', 'a1'],
    ['a1', 'ArrowLeft', 'C'],
    ['A', 'ArrowLeft', 'root'],
    ['root', 'ArrowLeft', null],
    ['root', 'ArrowRight', 'A'],
    ['b2', 'ArrowRight', null],
    ['root', 'ArrowDown', 'A'],
    ['root', 'ArrowUp', null],
    ['A', 'ArrowUp', 'root'],
    ['C', 'ArrowUp', 'root'],
    ['C', 'ArrowDown', 'a3'],
    ['a4', 'ArrowUp', 'C'],
    ['a4', 'ArrowDown', 'b2'],
    ['a3', 'ArrowDown', 'b2'],
    ['b1', 'ArrowDown', null],
    ['b2', 'ArrowUp', 'a2'],
    ['a2', 'Home', 'root'],
    ['a2', 'End', 'b2'],
    ['missing', 'ArrowRight', null]
  ]
  for (const [from, key, to] of table) {
    it(`${from} ${key} -> ${to}`, () => expect(nextFocus(layout, from, key)).toBe(to))
  }

  it('the plan board sits above the booth when it exists', () => {
    expect(nextFocus(layout, 'root', 'ArrowUp', { board: true })).toBe(PLAN_BOARD_ID)
    expect(nextFocus(layout, PLAN_BOARD_ID, 'ArrowDown', { board: true })).toBe('root')
    expect(nextFocus(layout, PLAN_BOARD_ID, 'ArrowUp', { board: true })).toBeNull()
    expect(nextFocus(layout, PLAN_BOARD_ID, 'Home', { board: true })).toBe('root')
  })

  it('ties on Up / Down go west', () => {
    // a2 (x 10) up: row 0 has A 6, B 10, C 14: exact B. From b1 (6) up: a1 (6).
    expect(nextFocus(layout, 'a2', 'ArrowUp')).toBe('B')
    expect(nextFocus(layout, 'b1', 'ArrowUp')).toBe('a1')
  })

  it('an empty floor goes nowhere', () => {
    const empty = layoutFloor({ runKey: 'x', agents: [] }, EMPTY_LAYOUT_MEMORY).layout
    expect(nextFocus(empty, 'root', 'Home')).toBeNull()
    expect(nextFocus(empty, 'root', 'End')).toBeNull()
  })
})

describe('tabStop', () => {
  it('the selected worker, else the booth, else the first station', () => {
    expect(tabStop(layout, 'a3')).toBe('a3')
    expect(tabStop(layout, 'b3')).toBe('root')
    expect(tabStop(layout)).toBe('root')
    const rootless = { ...layout, order: layout.order.slice(1), stations: Object.fromEntries(Object.entries(layout.stations).filter(([id]) => id !== 'root')) }
    expect(tabStop(rootless)).toBe('A')
    expect(tabStop({ ...layout, order: [], stations: {} })).toBeNull()
  })
})

describe('floorKeyAction', () => {
  it('arrows move focus; Shift+Arrow pans 4 m', () => {
    expect(floorKeyAction({ key: 'ArrowLeft' }, 'live')).toEqual({ type: 'focus', key: 'ArrowLeft' })
    expect(floorKeyAction({ key: 'ArrowUp', shiftKey: true }, 'live')).toEqual({ type: 'pan', dx: 0, dz: -4 })
    expect(floorKeyAction({ key: 'ArrowRight', shiftKey: true }, 'team')).toEqual({ type: 'pan', dx: 4, dz: 0 })
    expect(floorKeyAction({ key: 'Home' }, 'live')).toEqual({ type: 'focus', key: 'Home' })
    expect(floorKeyAction({ key: 'End' }, 'live')).toEqual({ type: 'focus', key: 'End' })
  })

  it('+ and = zoom in, - zooms out, 0 fits (Shift allowed for +)', () => {
    expect(floorKeyAction({ key: '+', shiftKey: true }, 'live')).toEqual({ type: 'zoom', direction: 'in' })
    expect(floorKeyAction({ key: '=' }, 'live')).toEqual({ type: 'zoom', direction: 'in' })
    expect(floorKeyAction({ key: '-' }, 'live')).toEqual({ type: 'zoom', direction: 'out' })
    expect(floorKeyAction({ key: '0' }, 'live')).toEqual({ type: 'fit' })
  })

  it('Delete or Backspace removes in team mode only, never in live', () => {
    expect(floorKeyAction({ key: 'Delete' }, 'team')).toEqual({ type: 'remove' })
    expect(floorKeyAction({ key: 'Backspace' }, 'team')).toEqual({ type: 'remove' })
    expect(floorKeyAction({ key: 'Delete' }, 'live')).toBeNull()
    expect(floorKeyAction({ key: 'Backspace' }, 'live')).toBeNull()
  })

  it('leaves Enter, Space, Tab and app shortcuts to the browser', () => {
    for (const key of ['Enter', ' ', 'Tab', 'a', 'Escape']) expect(floorKeyAction({ key }, 'live')).toBeNull()
    expect(floorKeyAction({ key: '0', ctrlKey: true }, 'live')).toBeNull()
    expect(floorKeyAction({ key: '=', metaKey: true }, 'live')).toBeNull()
    expect(floorKeyAction({ key: 'ArrowLeft', altKey: true }, 'live')).toBeNull()
  })
})
