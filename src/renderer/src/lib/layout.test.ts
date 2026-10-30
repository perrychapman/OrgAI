import { describe, expect, it } from 'vitest'
import { acyclicParents, initials, treeLayout } from './layout'

describe('initials', () => {
  it('uses the first letters of the first two words', () => {
    expect(initials('Code reviewer')).toBe('CR')
    expect(initials('frontend-dev')).toBe('FD')
    expect(initials('orchestrator')).toBe('OR')
    expect(initials('')).toBe('?')
  })

  it('keeps the default when nothing collides', () => {
    expect(initials('Reviewer', ['Writer'])).toBe('RE')
  })

  it('takes a later letter of the slug on a collision', () => {
    const names = ['Reviewer', 'Researcher']
    expect(initials('Reviewer', names)).toBe('RV')
    expect(initials('Researcher', names)).toBe('RS')
  })

  it('never collides with a third role', () => {
    const names = ['Reviewer', 'Researcher', 'Release']
    const out = names.map((n) => initials(n, names))
    expect(new Set(out).size).toBe(3)
  })
})

const item = (id: string, parentId: string | null) => ({ id, parentId, width: 100, height: 50 })

describe('treeLayout', () => {
  it('lays out a tree', () => {
    const pos = treeLayout([item('a', null), item('b', 'a'), item('c', 'a')])
    expect(pos.b.y).toBeGreaterThan(pos.a.y)
    expect(pos.b.x).not.toBe(pos.c.x)
  })

  it('survives a cyclic reportsTo graph', () => {
    const items = [item('root', null), item('a', 'b'), item('b', 'a'), item('c', 'c')]
    const pos = treeLayout(items)
    expect(Object.keys(pos).sort()).toEqual(['a', 'b', 'c', 'root'])
    for (const p of Object.values(pos)) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
  })

  it('drops unknown parents and keeps valid ones', () => {
    const parents = acyclicParents([item('r', null), item('a', 'r'), item('b', 'ghost')])
    expect(parents.get('a')).toBe('r')
    expect(parents.has('b')).toBe(false)
  })
})
