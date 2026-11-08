import { describe, expect, it } from 'vitest'
import { withOfficeDepartments } from './departments'

const members = [
  { id: 'root', name: 'Orchestrator', parentId: null },
  { id: 'ui', name: 'UI lead', parentId: 'root' },
  { id: 'engineer', name: 'Engineer', parentId: 'ui' },
  { id: 'review', name: 'Reviewer', parentId: 'root' }
]
describe('office departments', () => {
  it('uses real branch leads for nested and singleton departments, with a central root', () => {
    const result = withOfficeDepartments(members)
    expect(result[0]).toMatchObject({ central: true, departmentId: 'central' })
    expect(result[2]).toMatchObject({ central: false, departmentId: 'ui', departmentName: 'UI lead', departmentLeadId: 'ui' })
    expect(result[3]).toMatchObject({ departmentId: 'review', departmentName: 'Reviewer' })
  })
  it('keeps assignments independent of order or viewport and disambiguates prior sessions', () => {
    const source = [...members, { id: 'old/ui', name: 'UI lead', parentId: 'root', departmentContext: 'Earlier session 1' }]
    const first = withOfficeDepartments(source)
    const reversed = withOfficeDepartments([...source].reverse())
    for (const member of first) expect(reversed.find(other => other.id === member.id)?.departmentId).toBe(member.departmentId)
    expect(first.at(-1)?.departmentName).toBe('Earlier session 1 · UI lead')
  })
  it('handles missing parents and cycles without inventing relationships or looping', () => {
    const result = withOfficeDepartments([
      { id: 'lost', name: 'Lost', parentId: 'missing' },
      { id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }
    ])
    expect(result.map(member => member.departmentId)).toEqual(['lost', 'a', 'a'])
  })
})
