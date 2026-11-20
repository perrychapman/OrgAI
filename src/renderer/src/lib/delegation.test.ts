import { describe, expect, it } from 'vitest'
import type { Role } from '@shared/types'
import { ancestorsOf, delegationView } from './delegation'

const role = (id: string, reportsTo: string | null, spawnable: string[] = []): Role =>
  ({ id, name: id, slug: id, reportsTo, spawnable, canSpawn: spawnable.length > 0, tools: [], responsibilities: [] }) as unknown as Role

const ids = (rs: Role[]): string[] => rs.map((r) => r.id)

describe('delegationView', () => {
  //  root
  //   mid            other
  //    me   cousin    otherKid
  //     kid  kid2
  //      grand
  const roles = [
    role('root', null),
    role('mid', 'root'),
    role('me', 'mid'),
    role('kid', 'me'),
    role('kid2', 'me'),
    role('cousin', 'mid'),
    role('other', 'root'),
    role('otherKid', 'other'),
    role('grand', 'kid')
  ]
  const me = roles[2]

  it('lists direct reports first and groups the rest by branch head', () => {
    const v = delegationView(roles, me)
    expect(ids(v.direct)).toEqual(['kid', 'kid2'])
    // grand sits under the direct report kid, so kid heads that branch even though kid is not offered again.
    expect(v.branches.map((g) => [g.head.id, ids(g.roles)])).toEqual([
      ['cousin', ['cousin']],
      ['other', ['other', 'otherKid']],
      ['kid', ['grand']]
    ])
    expect(v.otherCount).toBe(4)
    expect(v.otherTicked).toBe(0)
    expect(ancestorsOf(roles, me).map((r) => r.id)).toEqual(['mid', 'root'])
  })

  it('never lists the manager or the manager chain, and keeps a ticked one apart', () => {
    const v = delegationView(roles, { ...me, spawnable: ['mid', 'root', 'cousin'] })
    expect(v.branches.flatMap((g) => ids(g.roles))).not.toContain('mid')
    expect(v.branches.flatMap((g) => ids(g.roles))).not.toContain('root')
    expect(ids(v.tickedAncestors)).toEqual(['mid', 'root'])
    expect(v.otherTicked).toBe(1)
  })

  it('has no ticked ancestors when none is ticked', () => {
    expect(delegationView(roles, me).tickedAncestors).toEqual([])
  })

  it('counts ticked roles on other branches', () => {
    const v = delegationView(roles, { ...me, spawnable: ['kid', 'otherKid', 'cousin'] })
    expect(v.otherTicked).toBe(2)
    expect(v.otherCount).toBe(4)
  })

  it('a root sees its direct reports and the branches under them', () => {
    const v = delegationView(roles, roles[0])
    expect(ids(v.direct)).toEqual(['mid', 'other'])
    expect(v.branches.map((g) => [g.head.id, ids(g.roles)])).toEqual([
      ['mid', ['me', 'kid', 'kid2', 'cousin', 'grand']],
      ['other', ['otherKid']]
    ])
    expect(v.tickedAncestors).toEqual([])
  })

  it('a leaf with no reports still sees the other branches', () => {
    const v = delegationView(roles, roles[8])
    expect(v.direct).toEqual([])
    expect(v.otherCount).toBeGreaterThan(0)
    expect(ids(v.tickedAncestors)).toEqual([])
  })

  it('a team of one has nothing to offer', () => {
    const v = delegationView([roles[0]], roles[0])
    expect(v).toEqual({ direct: [], branches: [], otherCount: 0, otherTicked: 0, tickedAncestors: [] })
  })

  it('survives a loop in the data', () => {
    const loop = [role('a', 'b'), role('b', 'a'), role('c', 'a')]
    expect(() => delegationView(loop, loop[0])).not.toThrow()
  })
})
