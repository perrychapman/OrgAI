import { describe, expect, it } from 'vitest'
import type { Role } from '@shared/types'
import { nextRoleName, removeRole, restoreRole, setReportsTo, wouldCycle } from './roleOps'

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
