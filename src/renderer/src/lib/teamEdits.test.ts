import { describe, expect, it } from 'vitest'
import type { Role } from '@shared/types'
import { addRoleUnder, setReportsTo } from './roleOps'
import { snapshotAdd, snapshotReparent, undoAdd, undoReparent } from './teamEdits'

const role = (id: string, reportsTo: string | null, spawnable: string[] = [], extra: Partial<Role> = {}): Role =>
  ({ id, name: id, slug: id, reportsTo, spawnable, canSpawn: spawnable.length > 0, tools: [], responsibilities: [], ...extra }) as unknown as Role

const get = (rs: Role[], id: string): Role => rs.find((r) => r.id === id)!

describe('undo of an added role', () => {
  const team = (): Role[] => [role('root', null, ['a']), role('a', 'root'), role('b', 'root')]

  it('removes the role and puts the manager back exactly as it was', () => {
    const before = team()
    const after = addRoleUnder(before, role('n', 'a'))
    expect(get(after, 'a')).toMatchObject({ canSpawn: true, spawnable: ['n'] })
    const undone = undoAdd(after, snapshotAdd(before, after, 'n'))
    expect(undone).toEqual(before)
  })

  it('restores a manager that already delegated to others, and its Always uses list', () => {
    const before = [role('root', null, ['a', 'b'], { requiredReports: ['b'] }), role('a', 'root'), role('b', 'root')]
    const after = addRoleUnder(before, role('n', 'root'))
    expect(get(after, 'root').spawnable).toEqual(['a', 'b', 'n'])
    expect(undoAdd(after, snapshotAdd(before, after, 'n'))).toEqual(before)
  })

  it('a field the user changed since keeps the user value', () => {
    const before = team()
    const added = addRoleUnder(before, role('n', 'a'))
    const edit = snapshotAdd(before, added, 'n')
    // The user unticked delegation on "a" after the add: spawnable and canSpawn are theirs now.
    const touched = added.map((r) => (r.id === 'a' ? { ...r, canSpawn: false, spawnable: [] } : r))
    const undone = undoAdd(touched, edit)
    expect(get(undone, 'a')).toMatchObject({ canSpawn: false, spawnable: [] })
    expect(undone.some((r) => r.id === 'n')).toBe(false)
  })

  it('roles later put under the added role move up to its manager', () => {
    const before = team()
    const added = addRoleUnder(before, role('n', 'a'))
    const edit = snapshotAdd(before, added, 'n')
    const nested = [...added, role('m', 'n')]
    const undone = undoAdd(nested, edit)
    expect(get(undone, 'm').reportsTo).toBe('a')
    expect(undone.some((r) => r.id === 'n')).toBe(false)
  })

  it('the first role of an empty team undoes to an empty team; a missing role changes nothing', () => {
    const first = addRoleUnder([], role('n', null))
    expect(undoAdd(first, snapshotAdd([], first, 'n'))).toEqual([])
    const roles = team()
    expect(undoAdd(roles, { roleId: 'gone', managerId: null })).toBe(roles)
  })
})

describe('undo of a changed reporting line', () => {
  const team = (): Role[] => [role('root', null, ['a', 'b']), role('a', 'root', ['x']), role('b', 'root'), role('x', 'a')]

  it('puts the previous line and the delegation of both managers back', () => {
    const before = team()
    const after = setReportsTo(before, 'x', 'b')
    expect(get(after, 'a')).toMatchObject({ canSpawn: false, spawnable: [] })
    expect(get(after, 'b')).toMatchObject({ canSpawn: true, spawnable: ['x'] })
    const undone = undoReparent(after, snapshotReparent(before, after, 'x'))
    expect(undone).toEqual(before)
  })

  it('records the line before and after', () => {
    const before = team()
    const edit = snapshotReparent(before, setReportsTo(before, 'x', 'b'), 'x')
    expect(edit).toMatchObject({ roleId: 'x', from: 'a', to: 'b' })
    expect(Object.keys(edit.delegation).sort()).toEqual(['a', 'b'])
  })

  it('a delegation field changed since keeps the user value while the line still goes back', () => {
    const before = team()
    const after = setReportsTo(before, 'x', 'b')
    const edit = snapshotReparent(before, after, 'x')
    const touched = after.map((r) => (r.id === 'b' ? { ...r, canSpawn: false } : r))
    const undone = undoReparent(touched, edit)
    expect(get(undone, 'x').reportsTo).toBe('a')
    expect(get(undone, 'b').canSpawn).toBe(false)
    expect(get(undone, 'a')).toMatchObject({ canSpawn: true, spawnable: ['x'] })
  })

  it('does nothing once the role was moved again', () => {
    const before = team()
    const after = setReportsTo(before, 'x', 'b')
    const edit = snapshotReparent(before, after, 'x')
    const moved = setReportsTo(after, 'x', 'root')
    expect(undoReparent(moved, edit)).toBe(moved)
  })

  it('refuses an undo that would loop', () => {
    const before = [role('root', null, ['a']), role('a', 'root', ['b']), role('b', 'a')]
    const after = setReportsTo(before, 'b', 'root')
    const edit = snapshotReparent(before, after, 'b')
    // "a" now sits under "b": putting "b" back under "a" would loop.
    const loop = setReportsTo(after, 'a', 'b')
    expect(undoReparent(loop, edit)).toBe(loop)
  })
})
