import { describe, expect, it } from 'vitest'
import type { Role } from '@shared/types'
import { addRoleUnder, nextRoleName, removeRole, restoreRole, setReportsTo, spawnNotice, withRequiredReport, withSpawnableToggled, wouldCycle } from './roleOps'

const role = (id: string, reportsTo: string | null, spawnable: string[] = []): Role =>
  ({ id, name: id, slug: id, reportsTo, spawnable, canSpawn: spawnable.length > 0, tools: [], responsibilities: [] }) as unknown as Role

describe('roleOps', () => {
  const roles = [role('root', null, ['a']), role('a', 'root', ['b']), role('b', 'a')]

  it('names new roles uniquely only when needed', () => {
    expect(nextRoleName(roles)).toBe('New role')
    expect(nextRoleName([...roles, role('New role', 'root')])).toBe('New role 2')
  })

  it('removes a role, re-parents its reports and restores it on undo', () => {
    const { roles: after, removed } = removeRole(roles, 'a')
    expect(after.find((r) => r.id === 'b')?.reportsTo).toBe('root')
    expect(after.find((r) => r.id === 'root')?.spawnable).toEqual([])
    const back = restoreRole(after, removed!)
    expect(back.map((r) => r.id)).toEqual(['root', 'a', 'b'])
    expect(back.find((r) => r.id === 'b')?.reportsTo).toBe('a')
    expect(back.find((r) => r.id === 'root')?.spawnable).toEqual(['a'])
  })

  it('re-parents to root and detects cycles', () => {
    const next = setReportsTo(roles, 'b', 'root')
    expect(next.find((r) => r.id === 'b')?.reportsTo).toBe('root')
    expect(next.find((r) => r.id === 'a')?.spawnable).toEqual([])
    expect(wouldCycle(roles, 'a', 'b')).toBe(true)
    expect(wouldCycle(roles, 'b', 'root')).toBe(false)
  })
})

describe('spawn rights follow delegation (D1)', () => {
  const base = (): Role[] => [role('root', null, ['a', 'b']), role('a', 'root'), role('b', 'root')]
  const get = (rs: Role[], id: string): Role => rs.find((r) => r.id === id)!
  const fresh = role('n', 'a')

  it('adding a role under a manager grants it spawn rights and says so', () => {
    const before = base()
    const after = addRoleUnder(before, fresh)
    expect(get(after, 'a')).toMatchObject({ canSpawn: true, spawnable: ['n'] })
    expect(after.map((r) => r.id)).toEqual(['root', 'a', 'b', 'n'])
    expect(spawnNotice(before, after, 'n')).toBe('a can now create subagents, because n reports to it.')
  })

  it('moving the only report away takes the right back, and moving it back grants it again', () => {
    const added = addRoleUnder(base(), fresh)
    const moved = setReportsTo(added, 'n', 'b')
    expect(get(moved, 'a')).toMatchObject({ canSpawn: false, spawnable: [] })
    expect(get(moved, 'b')).toMatchObject({ canSpawn: true, spawnable: ['n'] })
    expect(spawnNotice(added, moved, 'n')).toBe('b can now create subagents, because n reports to it. a can no longer create subagents: nobody it may delegate to is left.')
    const back = setReportsTo(moved, 'n', 'a')
    expect(get(back, 'a')).toMatchObject({ canSpawn: true, spawnable: ['n'] })
    expect(get(back, 'b')).toMatchObject({ canSpawn: false, spawnable: [] })
  })

  it('keeps a hand-ticked right on a role with no delegates until a change empties its list', () => {
    const roles = base().map((r) => (r.id === 'b' ? { ...r, canSpawn: true } : r))
    const moved = setReportsTo(roles, 'a', 'root')
    expect(get(moved, 'b').canSpawn).toBe(true)
    expect(spawnNotice(roles, moved, 'a')).toBeNull()
  })

  it('a manager that keeps other delegates keeps its right', () => {
    const moved = setReportsTo(base(), 'a', 'b')
    expect(get(moved, 'root')).toMatchObject({ canSpawn: true, spawnable: ['b'] })
  })

  it('removing the last report takes the right back; Undo restores canSpawn, spawnable and Required exactly', () => {
    const roles = addRoleUnder(base(), fresh).map((r) => (r.id === 'a' ? { ...r, requiredReports: ['n'] } : r))
    const { roles: after, removed } = removeRole(roles, 'n')
    expect(get(after, 'a')).toMatchObject({ canSpawn: false, spawnable: [] })
    expect(get(after, 'a').requiredReports).toBeUndefined()
    expect(spawnNotice(roles, after, 'n')).toBe('a can no longer create subagents: nobody it may delegate to is left.')
    const back = restoreRole(after, removed!)
    expect(back).toEqual(roles)
  })

  it('Undo after a later edit to the manager adds the role back without undoing that edit', () => {
    const roles = addRoleUnder(base(), fresh)
    const { roles: after, removed } = removeRole(roles, 'n')
    const edited = after.map((r) => (r.id === 'a' ? { ...r, spawnable: ['b'], canSpawn: true } : r))
    const back = restoreRole(edited, removed!)
    expect(get(back, 'a')).toMatchObject({ canSpawn: true, spawnable: ['b', 'n'] })
  })
})

describe('requiredReports', () => {
  const mgr = (over: Partial<Role> = {}): Role => ({ ...role('mgr', 'root', ['p', 'e']), requiredReports: ['p'], ...over })

  it('marks and unmarks a spawnable report as required', () => {
    expect(withRequiredReport(mgr({ requiredReports: undefined }), 'e', true).requiredReports).toEqual(['e'])
    expect(withRequiredReport(mgr(), 'e', true).requiredReports).toEqual(['p', 'e'])
    expect(withRequiredReport(mgr(), 'p', false).requiredReports).toBeUndefined()
  })

  it('ignores a report outside spawnable', () => {
    expect(withRequiredReport(mgr(), 'zzz', true).requiredReports).toEqual(['p'])
  })

  it('unchecking spawnable also removes the report from requiredReports', () => {
    const patch = withSpawnableToggled(mgr(), 'p')
    expect(patch.spawnable).toEqual(['e'])
    expect(patch.requiredReports).toBeUndefined()
    expect(withSpawnableToggled(mgr(), 'e').requiredReports).toEqual(['p'])
  })

  it('removing a role or re-parenting it drops it from a manager requirement', () => {
    const roles = [role('root', null, ['mgr']), mgr(), role('p', 'mgr'), role('e', 'mgr')]
    expect(removeRole(roles, 'p').roles.find((r) => r.id === 'mgr')?.requiredReports).toBeUndefined()
    expect(setReportsTo(roles, 'p', 'root').find((r) => r.id === 'mgr')?.requiredReports).toBeUndefined()
  })
})
