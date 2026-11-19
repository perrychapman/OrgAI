import { describe, expect, it } from 'vitest'
import { applyGrantEdits, grantEditsOf, itemEditOf, itemGrantEditsOf, proposedFromEdit, roleEditEmpty, roleEditOf, ungrantsOf } from './hostChange'
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

type Item = { id: string; name: string; libraryId?: string; enabled?: boolean; command?: string; args?: string[]; roles?: string[] }
const it_ = (id: string, name: string, over: Partial<Item> = {}): Item => ({ id, name, enabled: true, command: 'npx', ...over })

describe('itemEditOf', () => {
  it('moves only fields the action changed (before vs saved), never a stored change the run does not have', () => {
    const live = [it_('a', 'alpha'), it_('b', 'beta')]
    const before = [it_('a', 'alpha', { command: 'evil' }), it_('b', 'beta')]
    const saved = [it_('a', 'alpha', { command: 'evil', args: ['x'] }), it_('b', 'beta', { command: 'pulled' })]
    const e = itemEditOf(live, before, saved, { ids: ['a'], names: [] })
    expect(e.widened).toEqual([it_('a', 'alpha', { args: ['x'] }), it_('b', 'beta')])
    expect(e.narrowed).toEqual(live)
    expect(e.widenedIds).toEqual(['a'])
  })

  it('limits the diff to `fields`, splits a turn-off and a smaller roles list into the narrowing part', () => {
    const live = [it_('a', 'alpha', { roles: ['x', 'y'] })]
    const before = [it_('a', 'alpha', { roles: ['x', 'y'] })]
    const saved = [it_('a', 'alpha', { enabled: false, roles: ['x'], args: ['z'] })]
    const e = itemEditOf(live, before, saved, { ids: ['a'], names: [] }, ['enabled', 'roles', 'args'])
    expect(e.narrowed).toEqual([it_('a', 'alpha', { enabled: false, roles: ['x'] })])
    expect(e.widened).toEqual([it_('a', 'alpha', { enabled: false, roles: ['x'], args: ['z'] })])
    expect(itemEditOf(live, before, saved, { ids: ['a'], names: [] }, ['enabled']).widened).toEqual([it_('a', 'alpha', { enabled: false, roles: ['x', 'y'] })])
  })

  it('removes what the action removed, adds what it created, and leaves out a stored item the run lacks', () => {
    const live = [it_('a', 'alpha')]
    const before = [it_('a', 'alpha'), it_('s', 'stored')]
    const saved = [it_('s', 'stored', { args: ['1'] }), it_('n', 'new', { libraryId: 'lib' })]
    const e = itemEditOf(live, before, saved, { ids: ['a', 's', 'lib'], names: [] })
    expect(e.removed.map((x) => x.id)).toEqual(['a'])
    expect(e.added.map((x) => x.id)).toEqual(['n'])
    expect(e.narrowed).toEqual([])
    expect(e.widened!.map((x) => x.id)).toEqual(['n'])
  })
})

describe('itemGrantEditsOf / ungrantsOf', () => {
  it('keeps only grant pairs of the named item inside the input roleIds (granted) or outside it (ungranted)', () => {
    const before = orgChart().map((r) => (r.id === 'r-rev' ? { ...r, skills: ['s1'] } : r))
    // The input set roleIds [r-eng]; a pull also granted s1 to the lead and s2 to the engineer.
    const saved = orgChart().map((r) => (r.id === 'r-eng' ? { ...r, skills: ['s1', 's2'] } : r.id === 'r-lead' ? { ...r, skills: ['s1'] } : { ...r, skills: [] }))
    const items = [it_('s1', 'notes'), it_('s2', 'other')]
    expect(itemGrantEditsOf(before, saved, 'skills', items, [{ item: 'notes', roleIds: ['r-eng'] }])).toEqual([
      { roleId: 'r-eng', field: 'skills', id: 's1', granted: true },
      { roleId: 'r-rev', field: 'skills', id: 's1', granted: false }
    ])
    expect(itemGrantEditsOf(before, saved, 'skills', items, undefined)).toEqual([])
    expect(ungrantsOf(saved, 'skills', new Set(['s1'])).map((e) => e.roleId)).toEqual(['r-lead', 'r-eng'])
  })
})
