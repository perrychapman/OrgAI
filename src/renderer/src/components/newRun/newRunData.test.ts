import { describe, expect, it } from 'vitest'
import type { RunSummary } from '@shared/types'
import { pickUpRuns, roleNamesLine, teamGroups } from './newRunData'

const role = (id: string, name: string, reportsTo: string | null) => ({ id, name, color: '#123456', reportsTo })

describe('teamGroups', () => {
  it('makes one group per direct report of the root, counting everyone below', () => {
    const roles = [role('o', 'Orchestrator', null), role('b', 'Build lead', 'o'), role('i1', 'Implementer', 'b'), role('i2', 'Tester', 'b'), role('r', 'Researcher', 'o')]
    const groups = teamGroups(roles)
    expect(groups.map((g) => [g.name, g.count])).toEqual([['Build lead', 3], ['Researcher', 1]])
    expect(groups[0].roleNames).toEqual(['Build lead', 'Implementer', 'Tester'])
  })
  it('is empty with no root or no reports', () => {
    expect(teamGroups([])).toEqual([])
    expect(teamGroups([role('o', 'Orchestrator', null)])).toEqual([])
  })
  it('survives a loop in the saved tree', () => {
    expect(teamGroups([role('o', 'O', null), role('a', 'A', 'o'), role('b', 'B', 'a'), role('a2', 'A2', 'b')]).length).toBe(1)
  })
})

describe('roleNamesLine', () => {
  it('caps a long list', () => {
    expect(roleNamesLine(['a', 'b'])).toBe('a, b')
    expect(roleNamesLine(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more')
  })
})

const run = (id: string, over: Partial<RunSummary> = {}): RunSummary =>
  ({ id, projectId: 'p', kind: 'work', prompt: id, status: 'finished', startedAt: Number(id.replace(/\D/g, '')) || 1, ...over }) as RunSummary

describe('pickUpRuns', () => {
  it('lists finished work runs newest first and skips open ones and other kinds', () => {
    const rows = pickUpRuns([run('r1'), run('r2'), run('r3', { status: 'running' }), run('r4', { kind: 'setup' })])
    expect(rows.map((r) => r.id)).toEqual(['r2', 'r1'])
  })
  it('limits the list', () => {
    expect(pickUpRuns([run('r1'), run('r2'), run('r3'), run('r4')], 2)).toHaveLength(2)
  })
})
