import { describe, expect, it } from 'vitest'
import { applyGrantEdits, grantEditsOf, proposedFromEdit, roleEditEmpty, roleEditOf } from './hostChange'
import { orgChart, role } from './testHelpers'

describe('roleEditOf', () => {
  it('names only fields the request changed against the stored project and the save kept', () => {
    const before = orgChart()
    const request = before.map((r) => (r.id === 'r-eng' ? { ...r, prompt: 'New', position: { x: 9, y: 9 }, mcpServers: ['m'] } : r))
    // The save also pulled a reviewer prompt; it is in neither side of the diff.
    const saved = request.map((r) => (r.id === 'r-rev' ? { ...r, prompt: 'PULLED' } : r))
    const edit = roleEditOf(before, request, saved)
    expect([...edit.changed.entries()]).toEqual([['r-eng', { prompt: 'New' }]])
    expect(edit.added).toEqual([])
    expect(edit.removed).toEqual([])
  })

  it('drops a change the save did not keep; adds and removes only when the save agrees', () => {
    const before = orgChart()
    const request = [...before.filter((r) => r.id !== 'r-rev').map((r) => (r.id === 'r-eng' ? { ...r, prompt: 'New' } : r)), role({ id: 'r-qa', slug: 'qa' })]
    const saved = [...before]
    const edit = roleEditOf(before, request, saved)
    expect(roleEditEmpty(edit)).toBe(true)
  })
})

describe('proposedFromEdit', () => {
  it('applies the edit to the run baseline, never the stored values', () => {
    const baseline = orgChart().map((r) => (r.id === 'r-rev' ? { ...r, prompt: 'Run value' } : r))
    const edit = { changed: new Map([['r-eng', { prompt: 'New', description: undefined }]]), added: [role({ id: 'r-qa', slug: 'qa', mcpServers: ['m'] })], removed: ['r-lead-x'] }
    const out = proposedFromEdit(baseline, edit)
    expect(out.find((r) => r.id === 'r-eng')).toMatchObject({ prompt: 'New' })
    expect(out.find((r) => r.id === 'r-eng')!.description).toBeUndefined()
    expect(out.find((r) => r.id === 'r-rev')!.prompt).toBe('Run value')
    expect(out.find((r) => r.id === 'r-qa')!.mcpServers).toBeUndefined()
  })
})

describe('grant edits', () => {
  it('pairs confirmed by the save, applied only to items the run has', () => {
    const before = orgChart()
    const request = before.map((r) => (r.id === 'r-eng' ? { ...r, mcpServers: ['a', 'b'], skills: ['s'] } : r))
    const saved = request.map((r) => (r.id === 'r-eng' ? { ...r, mcpServers: ['a', 'b', 'pulled'], skills: [] } : r))
    const edits = grantEditsOf(before, request, saved)
    expect(edits).toEqual([
      { roleId: 'r-eng', field: 'mcpServers', id: 'a', granted: true },
      { roleId: 'r-eng', field: 'mcpServers', id: 'b', granted: true }
    ])
    const r = applyGrantEdits(before, edits, (_f, id) => id === 'a')
    expect(r.roles.find((x) => x.id === 'r-eng')!.mcpServers).toEqual(['a'])
    expect(r.skipped.map((e) => e.id)).toEqual(['b'])
    expect(before.find((x) => x.id === 'r-eng')!.mcpServers).toBeUndefined()
  })
})
