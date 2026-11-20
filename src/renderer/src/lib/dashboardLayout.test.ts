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
  setHidden,
  togglePin,
  writeLayout,
  type DashboardLayout
} from './dashboardLayout'

const base = (): DashboardLayout => normalizeLayout(DEFAULT_LAYOUT)

describe('normalizeLayout', () => {
  it('returns the default for anything that is not a version-1 object', () => {
    for (const raw of [undefined, null, 'x', 42, [], { v: 2, order: ['today'] }, { order: ['today'] }]) {
      expect(normalizeLayout(raw)).toEqual(DEFAULT_LAYOUT)
    }
  })
  it('drops unknown ids, duplicates and non-strings, and appends missing ids in default order', () => {
    const l = normalizeLayout({ v: 1, order: ['week', 'nope', 3, 'week', 'today'], hidden: ['today', 'today', 'x', null], pinned: [] })
    expect(l.order).toEqual(['week', 'today', 'resume', 'working', 'projects'])
    expect(l.hidden).toEqual(['today'])
  })
  it('keeps pins in order, drops duplicates, empties and non-strings, and stops at the limit', () => {
    const many = Array.from({ length: PIN_LIMIT + 5 }, (_, i) => `p${i}`)
    expect(normalizeLayout({ v: 1, order: [], hidden: [], pinned: ['b', 'a', 'b', '', 7] }).pinned).toEqual(['b', 'a'])
    expect(normalizeLayout({ v: 1, pinned: many }).pinned).toHaveLength(PIN_LIMIT)
  })
  it('never shares arrays with the default', () => {
    const l = normalizeLayout(null)
    l.order.reverse()
    expect(DEFAULT_LAYOUT.order).toEqual([...DASH_SECTIONS])
  })
})

describe('moves, hiding and reset', () => {
  it('moves one place and is a no-op at the ends', () => {
    const l = base()
    expect(moveSection(l, 'today', 'up').order).toEqual(['today', 'resume', 'working', 'week', 'projects'])
    expect(moveSection(l, 'resume', 'up')).toBe(l)
    expect(moveSection(l, 'projects', 'down')).toBe(l)
  })
  it('hides and shows', () => {
    const l = setHidden(base(), 'working', true)
    expect(l.hidden).toEqual(['working'])
    expect(setHidden(l, 'working', true)).toBe(l)
    expect(setHidden(l, 'working', false).hidden).toEqual([])
  })
  it('reset restores order and hidden and keeps pins', () => {
    let l = togglePin(base(), 'p1')
    l = setHidden(moveSection(l, 'week', 'up'), 'today', true)
    expect(isDefaultArrangement(l)).toBe(false)
    const r = resetLayout(l)
    expect(r.order).toEqual([...DASH_SECTIONS])
    expect(r.hidden).toEqual([])
    expect(r.pinned).toEqual(['p1'])
    expect(isDefaultArrangement(r)).toBe(true)
  })
  it('announces moves and ends', () => {
    expect(movedText(moveSection(base(), 'today', 'up'), 'today', 'up')).toBe('Today moved up. Position 1 of 5.')
    expect(atEndText('today', 'up')).toBe('Today is already first.')
    expect(atEndText('projects', 'down')).toBe('Projects is already last.')
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
    expect(placeSections(['resume', 'today'], false)).toEqual([
      { id: 'resume', span: 'full' },
      { id: 'today', span: 'full' }
    ])
  })
  it('pairs the default order and puts Projects across', () => {
    expect(placeSections([...DASH_SECTIONS], true).map((p) => p.span)).toEqual(['half', 'half', 'half', 'half', 'full'])
  })
  it('a hidden middle section leaves the unpartnered half full', () => {
    expect(placeSections(['resume', 'today', 'week', 'projects'], true)).toEqual([
      { id: 'resume', span: 'half' },
      { id: 'today', span: 'half' },
      { id: 'week', span: 'full' },
      { id: 'projects', span: 'full' }
    ])
  })
  it('one half section is full; Projects first breaks no pair', () => {
    expect(placeSections(['today'], true)).toEqual([{ id: 'today', span: 'full' }])
    expect(placeSections(['projects', 'resume', 'today', 'working'], true).map((p) => p.span)).toEqual(['full', 'half', 'half', 'full'])
    expect(placeSections(['resume', 'projects', 'today'], true).map((p) => p.span)).toEqual(['full', 'full', 'full'])
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
    const l = togglePin(setHidden(base(), 'today', true), 'p')
    writeLayout(s, l)
    expect(readLayout(s)).toEqual(l)
    for (const bad of ['x', '"x"', '{"v":2}', '[1,2]']) {
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
