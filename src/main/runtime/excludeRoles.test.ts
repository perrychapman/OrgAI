import { describe, expect, it } from 'vitest'
import { excludeRoles, excludedObligationProblems, rootRole } from './excludeRoles'
import { role } from './testHelpers'

/** Lead -> engineer (-> tester), reviewer. The engineer must report to the tester; the lead must report to the reviewer. */
function team() {
  return [
    role({ id: 'r-lead', slug: 'lead', name: 'Lead', canSpawn: true, spawnable: ['r-eng', 'r-rev'], requiredReports: ['r-rev'] }),
    role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', canSpawn: true, spawnable: ['r-test'], requiredReports: ['r-test'], reportsTo: 'r-lead' }),
    role({ id: 'r-test', slug: 'tester', name: 'Tester', reportsTo: 'r-eng' }),
    role({ id: 'r-rev', slug: 'reviewer', name: 'Reviewer', reportsTo: 'r-lead' })
  ]
}

describe('excludeRoles', () => {
  it('removes the role and every role below it, and cleans the spawn lists of the roles that stay', () => {
    const r = excludeRoles(team(), ['r-eng'])
    expect([...r.removed].sort()).toEqual(['r-eng', 'r-test'])
    expect(r.ids).toEqual(['r-eng'])
    expect(r.roles.map((x) => x.id)).toEqual(['r-lead', 'r-rev'])
    expect(r.roles[0].spawnable).toEqual(['r-rev'])
    expect(r.roles[0].requiredReports).toEqual(['r-rev'])
  })

  it('drops requiredReports entirely when every required role is gone, and never mutates its input', () => {
    const input = team()
    const r = excludeRoles(input, ['r-rev'])
    expect(r.roles[0].spawnable).toEqual(['r-eng'])
    expect(r.roles[0].requiredReports).toBeUndefined()
    expect(input[0].spawnable).toEqual(['r-eng', 'r-rev'])
    expect(input[0].requiredReports).toEqual(['r-rev'])
  })

  it('de-duplicates ids and keeps the order the user gave', () => {
    expect(excludeRoles(team(), ['r-rev', 'r-eng', 'r-rev']).ids).toEqual(['r-rev', 'r-eng'])
  })

  it('refuses the root, unknown ids and a non-list, changing nothing', () => {
    expect(() => excludeRoles(team(), ['r-lead'])).toThrow('Lead leads the team and cannot be left out of the run.')
    expect(() => excludeRoles(team(), ['nope'])).toThrow('not on this team any more')
    for (const bad of ['r-eng', 5, null, undefined, [1], ['']]) expect(() => excludeRoles(team(), bad)).toThrow('Choose which roles to leave out')
    expect(() => excludeRoles(team(), Array.from({ length: 201 }, (_, i) => `r${i}`))).toThrow('Choose which roles to leave out')
  })

  it('a continuation (lenient) drops ids that are gone or now the root', () => {
    const r = excludeRoles(team(), ['gone', 'r-lead', 'r-rev'], { lenient: true })
    expect(r.ids).toEqual(['r-rev'])
  })

  it('finds the root as the role reporting to nobody', () => {
    expect(rootRole(team())?.id).toBe('r-lead')
    expect(rootRole([])).toBeUndefined()
  })

  it('terminates on a reportsTo cycle', () => {
    const roles = [role({ id: 'a', slug: 'a', reportsTo: null }), role({ id: 'b', slug: 'b', reportsTo: 'c' }), role({ id: 'c', slug: 'c', reportsTo: 'b' })]
    expect([...excludeRoles(roles, ['b']).removed].sort()).toEqual(['b', 'c'])
  })
})

describe('excludedObligationProblems', () => {
  it('names an obligation that pointed at a role left out, in the preflight style', () => {
    const roles = team()
    const { removed } = excludeRoles(roles, ['r-rev'])
    expect(excludedObligationProblems(roles, removed, false)).toEqual(['Lead must delegate to Reviewer, which is left out of this run, so that report will not be made.'])
  })

  it('does not name obligations of a role that is itself left out, nor roles that were never required', () => {
    const roles = team()
    const { removed } = excludeRoles(roles, ['r-eng'])
    // the engineer's own obligation (to the tester) leaves with it; the lead's (reviewer) is untouched
    expect(excludedObligationProblems(roles, removed, false)).toEqual([])
  })

  it('strict delegation counts every spawnable role as required', () => {
    const roles = team()
    const { removed } = excludeRoles(roles, ['r-eng'])
    expect(excludedObligationProblems(roles, removed, true)).toEqual(['Lead must delegate to Engineer, which is left out of this run, so that report will not be made.'])
  })

  it('nothing left out, nothing to say', () => {
    expect(excludedObligationProblems(team(), new Set(), true)).toEqual([])
  })
})
