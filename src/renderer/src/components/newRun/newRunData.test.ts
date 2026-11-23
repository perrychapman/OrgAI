import { describe, expect, it } from 'vitest'
import type { RunSummary } from '@shared/types'
import { parseRunLimit, pickUpRuns, roleNamesLine, teamGroups, validExcluded, whoCountText } from './newRunData'

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

describe('teamGroups roleIds and agents', () => {
  const r = (id: string, reportsTo: string | null, maxConcurrent?: number) => ({ id, name: id, color: '#111111', reportsTo, ...(maxConcurrent ? { maxConcurrent } : {}) })
  it('lists every role of a group and sums caps only when each role has one', () => {
    const g = teamGroups([r('o', null), r('b', 'o', 1), r('i', 'b', 3), r('x', 'o')])
    expect(g[0].roleIds).toEqual(['b', 'i'])
    expect(g[0].agents).toBe(4)
    expect(g[1].agents).toBeNull()
  })
})

describe('whoCountText', () => {
  const r = (id: string, reportsTo: string | null, maxConcurrent?: number) => ({ id, name: id, color: '#111111', reportsTo, ...(maxConcurrent ? { maxConcurrent } : {}) })
  it('says roles when agents are not bounded', () => {
    expect(whoCountText([r('o', null), r('a', 'o'), r('b', 'a')], [])).toBe('3 roles')
    expect(whoCountText([r('o', null), r('a', 'o'), r('b', 'a')], ['a'])).toBe('up to 1 agent')
  })
  it('says agents when every role has a cap, or the project caps agents per run', () => {
    const roles = [r('o', null), r('a', 'o', 2), r('b', 'a', 3), r('c', 'o', 1)]
    expect(whoCountText(roles, [])).toBe('up to 7 agents')
    expect(whoCountText(roles, ['a'])).toBe('up to 2 agents')
    expect(whoCountText([r('o', null), r('a', 'o')], [], 4)).toBe('up to 5 agents')
    expect(whoCountText(roles, [], 2)).toBe('up to 3 agents')
  })
})

describe('validExcluded', () => {
  it('drops ids that are no group', () => {
    const g = teamGroups([role('o', 'O', null), role('a', 'A', 'o')])
    expect(validExcluded(g, ['a', 'gone'])).toEqual(['a'])
  })
})

describe('parseRunLimit', () => {
  it('treats empty as the project default', () => {
    expect(parseRunLimit('  ')).toEqual({ ok: true, usd: null })
  })
  it('accepts an amount up to the project limit and refuses more', () => {
    expect(parseRunLimit('2.5', 5)).toEqual({ ok: true, usd: 2.5 })
    expect(parseRunLimit('$5', 5)).toEqual({ ok: true, usd: 5 })
    expect(parseRunLimit('6', 5).ok).toBe(false)
  })
  it('refuses zero, negative and text', () => {
    for (const t of ['0', '-1', 'abc', '0.001']) expect(parseRunLimit(t).ok).toBe(false)
  })
})

describe('pickUpRuns', () => {
  it('lists finished work runs newest first and skips open ones and other kinds', () => {
    const rows = pickUpRuns([run('r1'), run('r2'), run('r3', { status: 'running' }), run('r4', { kind: 'setup' })])
    expect(rows.map((r) => r.id)).toEqual(['r2', 'r1'])
  })
  it('limits the list', () => {
    expect(pickUpRuns([run('r1'), run('r2'), run('r3'), run('r4')], 2)).toHaveLength(2)
  })
})
