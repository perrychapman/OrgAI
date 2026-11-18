import { describe, expect, it } from 'vitest'
import type { Role, RunRosterRole } from '@shared/types'
import { resolveRunRole, rolesForRun, rosterSignature, runRoleColor } from './runRoster'

const project = [
  { id: 'r-lead', slug: 'lead', name: 'Lead', color: '#111111' },
  { id: 'r-dev', slug: 'dev', name: 'Dev', color: '#222222' }
] as Role[]

const roster: RunRosterRole[] = [
  { id: 'r-lead', slug: 'lead', name: 'Lead', color: '#111111', reportsTo: null },
  { id: 'r-tester', slug: 'roster-tester', name: 'Roster Tester', color: '#abcdef', reportsTo: 'r-lead', added: true },
  { id: 'r-gone', slug: 'gone', name: 'Gone', color: '#999999', reportsTo: 'r-lead', removed: true }
]

describe('run roster role resolution', () => {
  it('falls back to the project roles without a roster', () => {
    expect(rolesForRun(undefined, project)).toBe(project)
    expect(rolesForRun([], project)).toBe(project)
    expect(runRoleColor(undefined, project, 'r-dev', 'dev', '#000')).toBe('#222222')
  })

  it('resolves a role added mid-run, by id and by slug', () => {
    expect(resolveRunRole(roster, project, 'r-tester', 'x')?.name).toBe('Roster Tester')
    expect(runRoleColor(roster, project, null, 'roster-tester', '#000')).toBe('#abcdef')
  })

  it('keeps a removed role for agents that started on it', () => {
    expect(resolveRunRole(roster, project, 'r-gone', 'gone')?.name).toBe('Gone')
    expect(runRoleColor(roster, project, 'r-gone', 'gone', '#000')).toBe('#999999')
  })

  it('still resolves a project role the roster does not list', () => {
    expect(runRoleColor(roster, project, 'r-dev', 'dev', '#000')).toBe('#222222')
  })

  it('returns the fallback for an unknown role', () => {
    expect(resolveRunRole(roster, project, 'nope', 'nope')).toBeUndefined()
    expect(runRoleColor(roster, project, 'nope', 'nope', '#fff')).toBe('#fff')
    expect(runRoleColor(undefined, undefined, null, '', '#fff')).toBe('#fff')
  })

  it('prefers the roster over the project for the same id', () => {
    const changed: RunRosterRole[] = [{ id: 'r-dev', slug: 'dev', name: 'Dev', color: '#333333', reportsTo: null }]
    expect(runRoleColor(changed, project, 'r-dev', 'dev', '#000')).toBe('#333333')
  })

  it('signs a roster so a recolour or removal is a change', () => {
    expect(rosterSignature(undefined)).toBe('')
    expect(rosterSignature(roster)).not.toBe(rosterSignature(roster.slice(0, 2)))
  })
})
