import { describe, expect, it } from 'vitest'
import { CLIENT_GROUPS_KEY, groupByClient, readCollapsedClients, writeCollapsedClients } from './clientGroups'

const eng = (id: string, client?: string): { id: string; kind: string; client?: string } => ({ id, kind: 'engagement', client })

describe('groupByClient', () => {
  it('shows no headers for engagements of one client only, or for code projects only', () => {
    expect(groupByClient([eng('a', 'Acme'), eng('b', 'acme')]).showHeaders).toBe(false)
    expect(groupByClient([{ id: 'd' }, { id: 'e' }]).showHeaders).toBe(false)
    expect(groupByClient([eng('c'), eng('d')]).showHeaders).toBe(false)
  })
  it('shows headers when engagements and code projects are both listed, even with one client', () => {
    const one = groupByClient([eng('a', 'Acme'), { id: 'code' }])
    expect(one.showHeaders).toBe(true)
    expect(one.groups.map((x) => x.label)).toEqual(['Acme', 'Code'])
    const none = groupByClient([{ id: 'code' }, eng('n')])
    expect(none.showHeaders).toBe(true)
    expect(none.groups.map((x) => x.label)).toEqual(['Engagements', 'Code'])
  })
  it('groups case-insensitively with the first spelling, then Other, then Code', () => {
    const g = groupByClient([{ id: 'code' }, eng('a', ' Acme '), eng('n'), eng('b', 'Globex'), eng('c', 'ACME')])
    expect(g.showHeaders).toBe(true)
    expect(g.groups.map((x) => [x.label, x.items.map((i) => i.id)])).toEqual([
      ['Acme', ['a', 'c']],
      ['Globex', ['b']],
      ['Other', ['n']],
      ['Code', ['code']]
    ])
  })
  it('treats junk client values and non-engagement kinds safely', () => {
    const g = groupByClient([{ id: 'x', kind: 'code', client: 'Acme' }, { id: 'y', kind: 'engagement', client: 5 }])
    expect(g.groups.map((x) => x.type)).toEqual(['other', 'code'])
  })
})

describe('collapsed state', () => {
  const mem = (initial?: string): { getItem(k: string): string | null; setItem(k: string, v: string): void; v?: string } => {
    const s: { v?: string; getItem(k: string): string | null; setItem(k: string, v: string): void } = {
      v: initial,
      getItem: () => s.v ?? null,
      setItem: (_k, v) => {
        s.v = v
      }
    }
    return s
  }
  it('round-trips and tolerates junk', () => {
    const m = mem()
    writeCollapsedClients(new Set(['acme']), m)
    expect(m.v).toBe(JSON.stringify(['acme']))
    expect([...readCollapsedClients(m)]).toEqual(['acme'])
    expect(readCollapsedClients(mem('{nope')).size).toBe(0)
    expect(readCollapsedClients(mem('{"a":1}')).size).toBe(0)
    expect([...readCollapsedClients(mem('["a",3,null]'))]).toEqual(['a'])
    expect(CLIENT_GROUPS_KEY).toBe('orgai.sidebarClientGroups')
  })
})
