import { describe, expect, it } from 'vitest'
import type { RunSummary } from '@shared/types'
import { parseRunLimit, pickUpRuns, roleNamesLine, scheduleSeed, shortScheduleName, teamGroups, validExcluded, whoCountText } from './newRunData'

describe('schedule seed', () => {
  const base = { projectId: 'p', prompt: 'Check the dependencies for known problems and open a summary', single: false, projectMode: 'default' as const, pickedMode: null, pickedModel: null, limitUsd: null, excludedCount: 0, pickedEffort: false, pickedGoal: false }
  it('names the schedule with a short clamp of the first line', () => {
    expect(shortScheduleName('Fix the flaky test\nthen more')).toBe('Fix the flaky test')
    const name = shortScheduleName('Check the dependencies for known problems and open a summary of what needs an update')
    expect(name.length).toBeLessThanOrEqual(49)
    expect(name.endsWith('…')).toBe(true)
    expect(name).not.toMatch(/\s…$/)
  })
  it('carries the limit, the model and a narrower mode', () => {
    const s = scheduleSeed({ ...base, limitUsd: 0.25, pickedMode: 'plan', pickedModel: { model: 'm', connection: 'anthropic' } })
    expect(s).toMatchObject({ budgetUsd: 0.25, permissionMode: 'plan', model: { model: 'm', connection: 'anthropic' }, notKept: [] })
  })
  it('drops a wider mode and Bypass, and names what it cannot hold', () => {
    const wide = scheduleSeed({ ...base, pickedMode: 'auto', excludedCount: 2, pickedEffort: true, pickedGoal: true })
    expect(wide.permissionMode).toBeNull()
    expect(wide.notKept).toEqual(['the roles you left out', 'the effort you chose', 'the goal you chose', 'a permission mode that asks less than the project’s'])
    expect(scheduleSeed({ ...base, projectMode: 'bypassPermissions', pickedMode: 'bypassPermissions' }).permissionMode).toBeNull()
    expect(scheduleSeed({ ...base, projectMode: 'auto', pickedMode: 'bypassPermissions' }).permissionMode).toBeNull()
  })
})

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
