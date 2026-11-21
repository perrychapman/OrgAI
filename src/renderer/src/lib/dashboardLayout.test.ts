import { describe, expect, it } from 'vitest'
import {
  DASH_SECTIONS,
  DEFAULT_LAYOUT,
  LAYOUT_KEY,
  PIN_LIMIT,
  atEndText,
  isDefaultArrangement,
  moveSection,
  movedText,
  normalizeLayout,
  placeSections,
  pruneLayoutPins,
  readLayout,
  resetLayout,
  setFocus,
  setHidden,
  setMotionPaused,
  togglePin,
  writeLayout,
  type DashboardLayout,
  type FocusFigure
} from './dashboardLayout'

const base = (): DashboardLayout => normalizeLayout(DEFAULT_LAYOUT)

describe('normalizeLayout', () => {
  it('returns the default for anything that is not a version-1 or version-2 object', () => {
    for (const raw of [undefined, null, 'x', 42, [], { v: 3, order: ['week'] }, { order: ['week'] }]) {
      expect(normalizeLayout(raw)).toEqual(DEFAULT_LAYOUT)
    }
  })
  it('drops unknown ids, duplicates and non-strings, and inserts missing ids before their first present default successor', () => {
    const l = normalizeLayout({ v: 2, order: ['upnext', 'nope', 3, 'upnext', 'week'], hidden: ['week', 'week', 'x', null], pinned: [] })
    expect(l.order).toEqual(['pickup', 'upnext', 'week', 'projects', 'engagements', 'commits', 'todos'])
    expect(l.hidden).toEqual(['week'])
  })
  it('keeps pins in order, drops duplicates, empties and non-strings, and stops at the limit', () => {
    const many = Array.from({ length: PIN_LIMIT + 5 }, (_, i) => `p${i}`)
    expect(normalizeLayout({ v: 2, order: [], hidden: [], pinned: ['b', 'a', 'b', '', 7] }).pinned).toEqual(['b', 'a'])
    expect(normalizeLayout({ v: 2, pinned: many }).pinned).toHaveLength(PIN_LIMIT)
  })
  it('reads the focus figure and Pause motion, defaulting anything else', () => {
    expect(normalizeLayout({ v: 2, focus: 'runs', motionPaused: true })).toMatchObject({ focus: 'runs', motionPaused: true })
    expect(normalizeLayout({ v: 2, focus: 'cost', motionPaused: 'yes' })).toMatchObject({ focus: 'spend', motionPaused: false })
  })
  it('never shares arrays with the default', () => {
    const l = normalizeLayout(null)
    l.order.reverse()
    expect(DEFAULT_LAYOUT.order).toEqual([...DASH_SECTIONS])
  })
})

describe('version-1 migration', () => {
  it('maps resume to Pick up, today to Up next and To-dos, drops working and keeps the rest in order', () => {
    const l = normalizeLayout({ v: 1, order: ['projects', 'week', 'today', 'resume', 'working', 'engagements'], hidden: ['today', 'working'], pinned: ['p'] })
    expect(l.v).toBe(2)
    expect(l.order).toEqual(['projects', 'week', 'upnext', 'todos', 'pickup', 'engagements', 'commits'])
    expect(l.hidden).toEqual(['upnext', 'todos'])
    expect(l.pinned).toEqual(['p'])
    expect(l.focus).toBe('spend')
  })
  it('the version-1 default becomes the version-2 default', () => {
    expect(normalizeLayout({ v: 1, order: ['resume', 'today', 'working', 'week', 'engagements', 'projects'], hidden: [], pinned: [] }).order).toEqual([...DASH_SECTIONS])
  })
  it('ignores prototype keys in a version-1 order', () => {
    expect(normalizeLayout({ v: 1, order: ['constructor', '__proto__', 'toString'] }).order).toEqual([...DASH_SECTIONS])
  })
})

describe('moves, hiding, focus and reset', () => {
  it('moves one place and is a no-op at the ends', () => {
    const l = base()
    expect(moveSection(l, 'pickup', 'up').order).toEqual(['pickup', 'week', 'upnext', 'projects', 'engagements', 'commits', 'todos'])
    expect(moveSection(l, 'week', 'up')).toBe(l)
    expect(moveSection(l, 'todos', 'down')).toBe(l)
  })
  it('hides and shows', () => {
    const l = setHidden(base(), 'upnext', true)
    expect(l.hidden).toEqual(['upnext'])
    expect(setHidden(l, 'upnext', true)).toBe(l)
    expect(setHidden(l, 'upnext', false).hidden).toEqual([])
  })
  it('sets the focus figure and refuses unknown ones', () => {
    const l = setFocus(base(), 'time')
    expect(l.focus).toBe('time')
    expect(setFocus(l, 'time')).toBe(l)
    expect(setFocus(l, 'cost' as FocusFigure)).toBe(l)
  })
  it('sets Pause motion', () => {
    const l = setMotionPaused(base(), true)
    expect(l.motionPaused).toBe(true)
    expect(setMotionPaused(l, true)).toBe(l)
  })
  it('reset restores order, hidden and focus and keeps pins and Pause motion', () => {
    let l = togglePin(base(), 'p1')
    l = setMotionPaused(setFocus(setHidden(moveSection(l, 'pickup', 'up'), 'upnext', true), 'runs'), true)
    expect(isDefaultArrangement(l)).toBe(false)
    const r = resetLayout(l)
    expect(r.order).toEqual([...DASH_SECTIONS])
    expect(r.hidden).toEqual([])
    expect(r.focus).toBe('spend')
    expect(r.pinned).toEqual(['p1'])
    expect(r.motionPaused).toBe(true)
    expect(isDefaultArrangement(r)).toBe(true)
  })
  it('announces moves and ends', () => {
    expect(movedText(moveSection(base(), 'pickup', 'up'), 'pickup', 'up')).toBe('Pick up moved up. Position 1 of 7.')
    expect(atEndText('week', 'up')).toBe('Your week is already first.')
    expect(atEndText('todos', 'down')).toBe('To-dos is already last.')
  })
})

describe('pins', () => {
  it('appends, removes and refuses past the limit', () => {
    let l = base()
    l = togglePin(togglePin(l, 'a'), 'b')
    expect(l.pinned).toEqual(['a', 'b'])
    expect(togglePin(l, 'a').pinned).toEqual(['b'])
    let full = base()
    for (let i = 0; i < PIN_LIMIT; i++) full = togglePin(full, `p${i}`)
    expect(full.pinned).toHaveLength(PIN_LIMIT)
    expect(togglePin(full, 'one-more')).toBe(full)
    expect(togglePin(full, 'p3').pinned).toHaveLength(PIN_LIMIT - 1)
  })
  it('prunes pins of deleted projects', () => {
    const l = togglePin(togglePin(base(), 'a'), 'gone')
    expect(pruneLayoutPins(l, ['a', 'b']).pinned).toEqual(['a'])
    const same = togglePin(base(), 'a')
    expect(pruneLayoutPins(same, ['a'])).toBe(same)
  })
})

describe('placeSections', () => {
  it('is all full in one track', () => {
    expect(placeSections(['pickup', 'upnext'], false)).toEqual([
      { id: 'pickup', span: 'full' },
      { id: 'upnext', span: 'full' }
    ])
  })
  it('pairs Pick up with Up next and keeps Your week and Projects across', () => {
    expect(placeSections([...DASH_SECTIONS], true).map((p) => p.span)).toEqual(['full', 'half', 'half', 'full', 'half', 'half', 'full'])
  })
  it('a hidden partner leaves the other half full', () => {
    expect(placeSections(['pickup', 'week', 'projects'], true)).toEqual([
      { id: 'pickup', span: 'full' },
      { id: 'week', span: 'full' },
      { id: 'projects', span: 'full' }
    ])
  })
})

describe('storage', () => {
  const mem = (): Storage & { data: Map<string, string> } => {
    const data = new Map<string, string>()
    return {
      data,
      get length() {
        return data.size
      },
      clear: () => data.clear(),
      key: () => null,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k)
    }
  }
  it('round-trips and reads corrupt values as the default', () => {
    const s = mem()
    const l = setFocus(togglePin(setHidden(base(), 'upnext', true), 'p'), 'decisions')
    writeLayout(s, l)
    expect(readLayout(s)).toEqual(l)
    for (const bad of ['x', '"x"', '{"v":3}', '[1,2]']) {
      s.setItem(LAYOUT_KEY, bad)
      expect(readLayout(s)).toEqual(DEFAULT_LAYOUT)
    }
    expect(readLayout(null)).toEqual(DEFAULT_LAYOUT)
  })
  it('never throws when storage throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      }
    }
    expect(readLayout(throwing)).toEqual(DEFAULT_LAYOUT)
    expect(() => writeLayout(throwing, base())).not.toThrow()
  })
})
