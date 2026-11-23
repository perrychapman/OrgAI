import { describe, expect, it } from 'vitest'
import {
  applyGrantEdits,
  cardRolesForStore,
  grantEditsOf,
  slugsForStore,
  terminalUpsertField,
  upsertFieldsOf,
  itemEditOf,
  itemGrantEditsOf,
  keepRunSlugs,
  mcpRolesForRun,
  staleSlugTexts,
  MCP_LINK_OWN,
  proposedFromEdit,
  roleEditEmpty,
  roleEditOf,
  SKILL_LINK_OWN,
  ungrantsOf
} from './hostChange'
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

describe('keepRunSlugs (rename of a running role)', () => {
  it("takes a running role's slug change out of the edit and keeps the rest; new roles keep their slug", () => {
    const run = orgChart()
    const before = orgChart()
    const request = [
      ...before.map((r) => (r.id === 'r-eng' ? { ...r, name: 'Engineer Prime', slug: 'engineer-prime', prompt: 'P' } : r.id === 'r-rev' ? { ...r, slug: 'checker' } : r)),
      role({ id: 'r-qa', slug: 'qa' })
    ]
    const { edit, kept } = keepRunSlugs(roleEditOf(before, request, request), run)
    expect([...edit.changed.entries()]).toEqual([['r-eng', { name: 'Engineer Prime', prompt: 'P' }]])
    expect(edit.added.map((r) => r.slug)).toEqual(['qa'])
    expect(kept).toEqual([
      { id: 'r-eng', runSlug: 'engineer', savedSlug: 'engineer-prime', newName: 'Engineer Prime' },
      { id: 'r-rev', runSlug: 'reviewer', savedSlug: 'checker' }
    ])
    // A role the run does not have keeps its slug edit.
    const { edit: e2, kept: k2 } = keepRunSlugs(roleEditOf(before, request, request), run.filter((r) => r.id !== 'r-rev'))
    expect(e2.changed.get('r-rev')).toEqual({ slug: 'checker' })
    expect(k2.map((k) => k.id)).toEqual(['r-eng'])
  })
})

describe('staleSlugTexts (N1, third review)', () => {
  const srv = (id: string, roles?: string[]) => ({ id, name: id, ...(roles ? { roles } : {}) })
  const run = orgChart()
  const renamed = orgChart().map((r) => (r.id === 'r-eng' ? { ...r, slug: 'builder' } : r))
  it('a kept old slug the saved server no longer lists leaves the run: by id when the saved role holds it, else lost', () => {
    const saved = { roles: renamed.map((r) => (r.id === 'r-eng' ? { ...r, mcpServers: ['docs'] } : r)), mcpServers: [srv('docs', ['engineer']), srv('wiki', ['engineer', 'reviewer'])] }
    const r = staleSlugTexts([srv('docs', ['engineer']), srv('wiki', ['engineer', 'reviewer'])], [{ roleId: 'r-eng', itemId: 'docs' }, { roleId: 'r-eng', itemId: 'wiki' }], run, saved)
    expect(r.items).toEqual([srv('docs', []), srv('wiki', ['reviewer'])])
    expect(r.convert).toEqual([{ roleId: 'r-eng', field: 'mcpServers', id: 'docs', granted: true }])
    expect(r.lost).toEqual([{ roleId: 'r-eng', field: 'mcpServers', id: 'wiki', granted: false }])
  })
  it('review Low 1: two running roles sharing the dropped text are both accounted for, never silently', () => {
    const dupRun = orgChart().map((r) => (r.id === 'r-rev' ? { ...r, slug: 'engineer' } : r))
    const saved = { roles: dupRun.map((r) => (r.id === 'r-eng' ? { ...r, slug: 'builder' } : r.id === 'r-rev' ? { ...r, mcpServers: ['docs'] } : r)), mcpServers: [srv('docs', ['engineer'])] }
    // r-eng was renamed; the saved list still names "engineer", which the reviewer holds too, but not "builder".
    const r = staleSlugTexts([srv('docs', ['engineer'])], [{ roleId: 'r-eng', itemId: 'docs' }], dupRun, saved)
    expect(r.items).toEqual([srv('docs', [])])
    expect(r.lost).toEqual([{ roleId: 'r-eng', field: 'mcpServers', id: 'docs', granted: false }])
    expect(r.convert).toEqual([{ roleId: 'r-rev', field: 'mcpServers', id: 'docs', granted: true }])
  })
  it('keeps text the saved project still backs (its new slug, or every role) and returns the same list', () => {
    const items = [srv('docs', ['engineer']), srv('all', ['engineer'])]
    const saved = { roles: renamed, mcpServers: [srv('docs', ['builder']), srv('all')] }
    const r = staleSlugTexts(items, [{ roleId: 'r-eng', itemId: 'docs' }, { roleId: 'r-eng', itemId: 'all' }], run, saved)
    expect(r.items).toBe(items)
    expect(r.convert).toEqual([])
    expect(r.lost).toEqual([])
  })
})

describe('mcpRolesForRun (slug-keyed MCP grants as the run names its roles)', () => {
  const spec = (roles?: string[]) => ({ id: 'm', name: 'docs', ...(roles ? { roles } : {}) })
  it("maps a renamed role's new slug to the slug the run kept, by id; no list and unknown slugs stay", () => {
    const run = orgChart()
    const stored = orgChart().map((r) => (r.id === 'r-eng' ? { ...r, slug: 'engineer-prime' } : r))
    expect(mcpRolesForRun([spec(['engineer-prime', 'reviewer']), spec(), spec(['ghost'])], stored, run)).toEqual([spec(['engineer', 'reviewer']), spec(), spec(['ghost'])])
    // N1 (third review): the old slug names no stored role now; the running role holding that text is not the role it
    // names by id, so it is not carried (the role keeps access through its new slug or an id grant, never stale text).
    expect(mcpRolesForRun([spec(['engineer'])], stored, run)).toEqual([spec([])])
  })
  it('N1: a slug no stored role has is carried only while no running role holds that text; duplicates map to every running holder', () => {
    const run = orgChart()
    // "ghost" names nobody anywhere: kept (a role joining under it later is the role the store also grants).
    expect(mcpRolesForRun([spec(['ghost'])], orgChart(), run)).toEqual([spec(['ghost'])])
    // A running role removed from the store still holds "reviewer" in the run: the stored text grants it nothing.
    expect(mcpRolesForRun([spec(['reviewer'])], orgChart().filter((r) => r.id !== 'r-rev'), run)).toEqual([spec([])])
    // Two stored roles share "engineer" (projects:save does not refuse duplicates): both running holders get it by id.
    const dup = orgChart().map((r) => (r.id === 'r-rev' ? { ...r, slug: 'engineer' } : r))
    expect(mcpRolesForRun([spec(['engineer'])], dup, run)).toEqual([spec(['engineer', 'reviewer'])])
  })
  it('a stored role the run does not have, holding the slug the run kept for another role, never grants that role', () => {
    const run = orgChart()
    const stored = [...orgChart().map((r) => (r.id === 'r-eng' ? { ...r, slug: 'engineer-prime' } : r)), role({ id: 'r-new', slug: 'engineer' })]
    expect(mcpRolesForRun([spec(['engineer'])], stored, run)).toEqual([spec([])])
  })
  it('returns the list unchanged when slugs agree', () => {
    const items = [spec(['engineer'])]
    expect(mcpRolesForRun(items, orgChart(), orgChart())).toEqual(items)
    expect(mcpRolesForRun(undefined, orgChart(), orgChart())).toBeUndefined()
  })
  it("H1: a waiting role's slug grant reaches no running role that kept the same slug; a free waiting slug is remembered", () => {
    const running = orgChart()
    const stored = [...orgChart().map((r) => (r.id === 'r-eng' ? { ...r, slug: 'builder' } : r)), role({ id: 'r-new', slug: 'engineer' }), role({ id: 'r-qa', slug: 'qa' })]
    expect(mcpRolesForRun([spec(['engineer']), spec(['qa']), spec(['builder'])], stored, running)).toEqual([spec([]), spec(['qa']), spec(['engineer'])])
  })
})

describe('slugsForStore (rename follow-up a: agent slugs to the stored roles)', () => {
  const running = orgChart()
  it("maps a running role's kept slug to its stored slug by id; other slugs stay", () => {
    const stored = orgChart().map((r) => (r.id === 'r-eng' ? { ...r, slug: 'builder' } : r))
    expect(slugsForStore(['engineer', 'reviewer', 'ghost'], running, stored)).toEqual(['builder', 'reviewer', 'ghost'])
  })
  it('never lands on another stored role holding the kept slug; identity when nothing differs', () => {
    const stored = [...orgChart().map((r) => (r.id === 'r-eng' ? { ...r, slug: 'builder' } : r)), role({ id: 'r-new', slug: 'engineer' })]
    expect(slugsForStore(['engineer'], running, stored)).toEqual(['builder'])
    expect(slugsForStore(['engineer', 'lead'], running, orgChart())).toEqual(['engineer', 'lead'])
    // A running role the store no longer has: its slug is dropped only when another stored role holds it.
    const gone = [...orgChart().filter((r) => r.id !== 'r-eng'), role({ id: 'r-other', slug: 'engineer' })]
    expect(slugsForStore(['engineer'], running, gone)).toEqual([])
    expect(slugsForStore(['engineer'], running, orgChart().filter((r) => r.id !== 'r-eng'))).toEqual(['engineer'])
  })
})

describe('cardRolesForStore (rename follow-up b: a run card never reverts a rename)', () => {
  const running = orgChart()
  it('gives a running role its stored slug, and its stored name when the card left the name as the run had it', () => {
    const stored = orgChart().map((r) => (r.id === 'r-eng' ? { ...r, slug: 'builder', name: 'Builder' } : r))
    const card = orgChart().map((r) => (r.id === 'r-rev' ? { ...r, prompt: 'P' } : r))
    const out = cardRolesForStore(card, running, running, stored)
    expect(out.find((r) => r.id === 'r-eng')).toMatchObject({ slug: 'builder', name: 'Builder' })
    expect(out.find((r) => r.id === 'r-rev')).toBe(card.find((r) => r.id === 'r-rev'))
  })
  it("keeps the card's own rename, matches fresh ids by slug and never touches a waiting role sharing the kept slug", () => {
    const stored = [...orgChart().map((r) => (r.id === 'r-eng' ? { ...r, slug: 'builder', name: 'Builder' } : r)), role({ id: 'r-new', slug: 'engineer', name: 'New' })]
    const card = [
      ...orgChart().map((r) => (r.id === 'r-eng' ? { ...r, id: 'fresh-1', name: 'Card Name' } : r)),
      role({ id: 'r-new', slug: 'engineer', name: 'New' })
    ]
    const out = cardRolesForStore(card, running, running, stored)
    expect(out.find((r) => r.id === 'fresh-1')).toMatchObject({ slug: 'builder', name: 'Card Name' })
    expect(out.find((r) => r.id === 'r-new')).toMatchObject({ slug: 'engineer', name: 'New' })
  })
  it('returns the same array when nothing differs', () => {
    const card = orgChart()
    expect(cardRolesForStore(card, running, running, orgChart())).toBe(card)
  })
})

describe('upsertFieldsOf (review L4: mcp:upsert fields of a linked server)', () => {
  const entry = { id: 'lib1', name: 'docs', transport: 'stdio', command: 'npx', args: ['-y', 'docs@2'] }
  const stored = { id: 'm1', name: 'docs', transport: 'stdio', command: 'npx', args: ['-y', 'docs@1'], libraryId: 'lib1', source: 'library', enabled: true }
  it('drops library-sourced keys the input left out or set to the library value; keeps own keys and real edits', () => {
    expect(upsertFieldsOf({ id: 'm1', name: 'docs', libraryId: 'lib1', enabled: false, args: ['-y', 'docs@2'] }, stored, entry).sort()).toEqual(['enabled', 'id', 'libraryId', 'source'])
    expect(upsertFieldsOf({ id: 'm1', libraryId: 'lib1', command: 'node' }, stored, entry)).toContain('command')
  })
  it('keeps every key for an unlinked server, an unknown entry or a server relinked elsewhere', () => {
    const plain = { id: 'm1', name: 'docs', command: 'npx' }
    expect(upsertFieldsOf(plain, { ...plain, args: [] }, undefined).sort()).toEqual(['args', 'command', 'id', 'name'])
    expect(upsertFieldsOf({ ...stored, libraryId: 'lib2' }, stored, entry).sort()).toEqual(Object.keys(stored).sort())
  })
})

describe('itemEditOf with linkOwn (review L-f: library-linked items)', () => {
  type Spec = { id: string; name: string; libraryId?: string; enabled?: boolean; command?: string; envOverrides?: Record<string, string> }
  const raw: Spec = { id: 'm1', name: 'docs', libraryId: 'lib1', enabled: true, command: 'old-snapshot' }
  it('a library-sourced field that differs only because the saved copy was refreshed does not move', () => {
    const saved: Spec = { ...raw, command: 'fresh-from-library' }
    const e = itemEditOf<Spec>([raw], [raw], [saved], { ids: ['m1'], names: [] }, undefined, MCP_LINK_OWN)
    expect(e.widenedIds).toEqual([])
    expect(e.narrowedIds).toEqual([])
    // Without linkOwn (the old behaviour) it looked like the user's edit.
    expect(itemEditOf<Spec>([raw], [raw], [saved], { ids: ['m1'], names: [] }).widenedIds).toEqual(['m1'])
  })
  it('a field the project owns still moves; a library field the input named still moves', () => {
    const saved: Spec = { ...raw, command: 'fresh', enabled: false, envOverrides: { R: 'eu' } }
    const e = itemEditOf<Spec>([raw], [raw], [saved], { ids: ['m1'], names: [] }, undefined, MCP_LINK_OWN)
    expect(e.narrowed).toEqual([{ ...raw, enabled: false }])
    expect(e.widened).toEqual([{ ...raw, enabled: false, envOverrides: { R: 'eu' } }])
    const named = itemEditOf<Spec>([raw], [raw], [saved], { ids: ['m1'], names: [] }, ['command'], MCP_LINK_OWN)
    expect(named.widened).toEqual([{ ...raw, command: 'fresh' }])
  })
  it('an item unlinked by the save (no libraryId after) is compared field by field', () => {
    const saved: Spec = { id: 'm1', name: 'docs', enabled: true, command: 'own' }
    expect(itemEditOf<Spec>([raw], [raw], [saved], { ids: ['m1'], names: [] }, undefined, MCP_LINK_OWN).widenedIds).toEqual(['m1'])
    expect(SKILL_LINK_OWN.has('files')).toBe(false)
  })
})

describe('terminalUpsertField (mcp:upsert on the terminal host: exactly one of enabled / roles)', () => {
  const shown = { id: 'm1', name: 'docs', transport: 'stdio', command: 'npx', args: ['-y', 'docs'], enabled: true }

  it('names the one field the terminal UI changed', () => {
    expect(terminalUpsertField({ ...shown, enabled: false }, shown)).toBe('enabled')
    expect(terminalUpsertField({ ...shown, roles: ['engineer'] }, shown)).toBe('roles')
    expect(terminalUpsertField({ ...shown, roles: ['engineer'] }, { ...shown, roles: ['engineer', 'reviewer'] })).toBe('roles')
    // A roles list dropped again (every role).
    expect(terminalUpsertField(shown, { ...shown, roles: [] })).toBe('roles')
  })

  it('answers nothing for an unchanged spec, a second differing field, another field, or an unknown server', () => {
    expect(terminalUpsertField({ ...shown }, shown)).toBeUndefined()
    expect(terminalUpsertField({ ...shown, enabled: false, roles: [] }, shown)).toBeUndefined()
    // A stale copy: the command changed in the store after the client read it.
    expect(terminalUpsertField({ ...shown, enabled: false }, { ...shown, command: 'node' })).toBeUndefined()
    expect(terminalUpsertField({ ...shown, command: 'node' }, shown)).toBeUndefined()
    expect(terminalUpsertField({ ...shown, args: ['-y', 'other'] }, shown)).toBeUndefined()
    expect(terminalUpsertField({ ...shown, enabled: false }, undefined)).toBeUndefined()
    expect(terminalUpsertField(undefined, shown)).toBeUndefined()
  })
})
