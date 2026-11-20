import { describe, expect, it } from 'vitest'
import { addedRoleLines, diffOrgChart, nameSimilarity, orgDiffBase, type DiffRole } from './orgDiff'

const role = (slug: string, over: Partial<DiffRole> = {}): DiffRole => ({
  id: `id-${slug}`,
  slug,
  name: slug,
  model: 'sonnet',
  reportsTo: null,
  description: 'd',
  tools: ['Read'],
  canSpawn: false,
  spawnable: [],
  prompt: 'p',
  ...over
})

describe('diffOrgChart', () => {
  it('reports no changes for identical charts, even with new ids', () => {
    const cur = [role('lead'), role('dev', { reportsTo: 'id-lead' })]
    const prop = [role('lead', { id: 'n1' }), role('dev', { id: 'n2', reportsTo: 'n1' })]
    const d = diffOrgChart(cur, prop)
    expect(d.summary).toBe('No changes')
    expect(d.unchanged).toHaveLength(2)
  })

  it('third review L-1: two roles sharing a slug (a kept slug and a waiting role) pair by id with their own rows', () => {
    const cur = [role('lead'), role('engineer', { id: 'r-eng', name: 'Builder', reportsTo: 'id-lead' }), role('engineer', { id: 'r-new', name: 'New Engineer', reportsTo: 'id-lead' })]
    const prop = [role('lead'), role('engineer', { id: 'r-eng', name: 'Builder', reportsTo: 'id-lead' }), role('engineer', { id: 'r-new', name: 'New Engineer', reportsTo: 'id-lead', prompt: 'changed' })]
    const d = diffOrgChart(cur, prop)
    expect(d.changed.map((c) => [c.role.id, c.before.id])).toEqual([['r-new', 'r-new']])
    expect(d.unchanged.map((r) => r.id)).toEqual(['id-lead', 'r-eng'])
    expect(d.removed).toEqual([])
    // A role renamed away from a slug that a new role takes is not paired with the new role by slug.
    const swap = diffOrgChart([role('lead'), role('engineer', { id: 'r-eng', name: 'Engineer' })], [role('lead'), role('builder', { id: 'r-eng', name: 'Engineer' }), role('engineer', { id: 'r-x', name: 'Tester' })])
    expect(swap.added.map((r) => r.id)).toEqual(['r-x'])
    expect(swap.changed.map((c) => [c.role.id, c.before.id, c.renamed])).toEqual([['r-eng', 'r-eng', true]])
  })

  it('treats everything as added against an empty chart', () => {
    const d = diffOrgChart([], [role('lead'), role('dev')])
    expect(d.added).toHaveLength(2)
    expect(d.summary).toBe('2 added')
  })

  it('finds added, removed and changed with a summary', () => {
    const cur = [role('lead'), role('dev', { reportsTo: 'id-lead' }), role('res', { name: 'Researcher', reportsTo: 'id-lead' })]
    const prop = [
      role('lead'),
      role('dev', { reportsTo: 'id-lead', model: 'opus' }),
      role('rev', { name: 'Reviewer', reportsTo: 'id-lead' }),
      role('qa', { name: 'QA', reportsTo: 'id-lead' })
    ]
    const d = diffOrgChart(cur, prop)
    expect(d.added.map((r) => r.slug)).toEqual(['rev', 'qa'])
    expect(d.removed.map((r) => r.slug)).toEqual(['res'])
    expect(d.changed).toHaveLength(1)
    expect(d.changed[0].changes).toEqual([{ field: 'model', label: 'model', from: 'Everyday', to: 'Deep' }])
    expect(d.summary).toBe('2 added, 1 removed, 1 changed')
  })

  it('shows a rename as changed and resolves reportsTo to names', () => {
    const cur = [role('lead', { name: 'Lead' }), role('dev', { name: 'Dev', reportsTo: 'id-lead' })]
    const prop = [role('lead', { name: 'Orchestrator' }), role('dev', { name: 'Dev', reportsTo: 'id-lead' })]
    const d = diffOrgChart(cur, prop)
    const lead = d.changed.find((c) => c.role.slug === 'lead')
    expect(lead?.changes).toEqual([{ field: 'name', label: 'name', from: 'Lead', to: 'Orchestrator' }])
    const dev = d.changed.find((c) => c.role.slug === 'dev')
    expect(dev?.changes).toEqual([{ field: 'reportsTo', label: 'reports to', from: 'Lead', to: 'Orchestrator' }])
  })

  it('reports prompt changes without the text and ignores tool order', () => {
    const cur = [role('a', { tools: ['Read', 'Edit'], prompt: 'old secret' })]
    const prop = [role('a', { tools: ['Edit', 'Read'], prompt: 'new secret' })]
    const d = diffOrgChart(cur, prop)
    expect(d.changed[0].changes).toEqual([{ field: 'prompt', label: 'prompt', from: '', to: 'prompt changed' }])
    // The texts travel separately so the card can show the new prompt (review M3).
    expect(d.changed[0].prompt).toEqual({ before: 'old secret', after: 'new secret' })
  })

  it('carries no prompt change when the prompt is kept or left out', () => {
    const cur = [role('a', { prompt: 'same', model: 'fast' }), role('b', { prompt: 'kept', model: 'fast' })]
    const prop = [role('a', { prompt: 'same', model: 'deep' }), { ...role('b', { model: 'deep' }), prompt: undefined }]
    const d = diffOrgChart(cur, prop)
    expect(d.changed).toHaveLength(2)
    expect(d.changed.every((c) => c.prompt === undefined)).toBe(true)
  })

  it('carries the new prompt on a renamed role and from an empty prompt', () => {
    const d = diffOrgChart([role('dev', { name: 'Dev', prompt: '' })], [role('developer', { name: 'Developer', prompt: 'Write code' })])
    expect(d.changed[0].renamed).toBe(true)
    expect(d.changed[0].prompt).toEqual({ before: '', after: 'Write code' })
  })

  it('falls back to id without a slug and compares spawn rights and skills', () => {
    const cur = [{ ...role('a'), slug: undefined, id: 'x' }]
    const prop = [{ ...role('a'), slug: undefined, id: 'x', canSpawn: true, skills: ['s1'] }]
    const d = diffOrgChart(cur, prop)
    expect(d.changed[0].changes.map((c) => c.field)).toEqual(['canSpawn', 'skills'])
  })

  it('reads a slug change as one role removed and one added, not a rename', () => {
    const d = diffOrgChart([role('dev', { name: 'Dev' })], [role('engineer', { name: 'Engineer' })])
    expect(d.added.map((r) => r.slug)).toEqual(['engineer'])
    expect(d.removed.map((r) => r.slug)).toEqual(['dev'])
    expect(d.changed).toHaveLength(0)
    expect(d.summary).toBe('1 added, 1 removed')
  })

  it('shows a name-only rename with a stable slug as one changed role', () => {
    const d = diffOrgChart([role('dev', { name: 'Dev' })], [role('dev', { name: 'Developer' })])
    expect(d.changed[0].changes).toEqual([{ field: 'name', label: 'name', from: 'Dev', to: 'Developer' }])
    expect(d.summary).toBe('1 changed')
  })

  it('does not call a field changed when the proposal leaves it out', () => {
    const cur = [role('a', { tools: ['Read', 'Edit'], description: 'Does things', skills: ['s1'], canSpawn: true, spawnable: ['id-b'], prompt: 'old' }), role('b')]
    const prop: DiffRole[] = [
      { id: 'a', slug: 'a', name: 'a', model: 'sonnet', reportsTo: null },
      { id: 'b', slug: 'b', name: 'b', model: 'sonnet', reportsTo: null }
    ]
    const d = diffOrgChart(cur, prop)
    expect(d.changed).toEqual([])
    expect(d.unchanged).toHaveLength(2)
  })

  it('still reports a stated field that differs when others are omitted', () => {
    const cur = [role('a', { tools: ['Read'] })]
    const prop: DiffRole[] = [{ id: 'a', slug: 'a', name: 'a', model: 'opus', reportsTo: null, tools: ['Read', 'Edit'] }]
    expect(diffOrgChart(cur, prop).changed[0].changes.map((c) => c.field)).toEqual(['model', 'tools'])
  })

  it('shows a rename that also changes the slug as one renamed row', () => {
    const cur = [role('lead'), role('backend-dev', { name: 'Backend Dev', reportsTo: 'id-lead' })]
    const prop = [role('lead'), role('backend-developer', { name: 'Backend Developer', reportsTo: 'id-lead' })]
    const d = diffOrgChart(cur, prop)
    expect(d.added).toEqual([])
    expect(d.removed).toEqual([])
    expect(d.changed).toHaveLength(1)
    expect(d.changed[0].renamed).toBe(true)
    expect(d.changed[0].changes.map((c) => c.field)).toEqual(['name', 'slug'])
    expect(d.summary).toBe('1 changed')
  })

  it('keeps removed and added when the names are not alike', () => {
    const cur = [role('lead'), role('researcher', { name: 'Researcher', reportsTo: 'id-lead' })]
    const prop = [role('lead'), role('qa', { name: 'QA', reportsTo: 'id-lead' })]
    const d = diffOrgChart(cur, prop)
    expect(d.added.map((r) => r.slug)).toEqual(['qa'])
    expect(d.removed.map((r) => r.slug)).toEqual(['researcher'])
    expect(d.changed).toEqual([])
  })

  it('pairs each removed role with at most one added role', () => {
    const cur = [role('dev-a', { name: 'Developer' })]
    const prop = [role('dev-b', { name: 'Developer B' }), role('dev-c', { name: 'Developer' })]
    const d = diffOrgChart(cur, prop)
    expect(d.changed).toHaveLength(1)
    expect(d.changed[0].role.slug).toBe('dev-c')
    expect(d.added.map((r) => r.slug)).toEqual(['dev-b'])
  })

  it('lands a responsibilities-only change in changed, compared in order (review M-a)', () => {
    const cur = [role('a', { responsibilities: ['Write code', 'Run tests'] }), role('b', { responsibilities: ['x', 'y'] }), role('c', { responsibilities: ['k'] })]
    const prop = [
      role('a', { responsibilities: ['Write code', 'Run tests', 'Approve every change'] }),
      role('b', { responsibilities: ['y', 'x'] }),
      { ...role('c'), responsibilities: undefined }
    ]
    const d = diffOrgChart(cur, prop)
    expect(d.changed.map((c) => c.role.slug)).toEqual(['a', 'b'])
    expect(d.changed[0].changes).toEqual([{ field: 'responsibilities', label: 'responsibilities', from: '', to: 'responsibilities changed' }])
    expect(d.changed[0].responsibilities).toEqual({ before: ['Write code', 'Run tests'], after: ['Write code', 'Run tests', 'Approve every change'] })
    expect(d.changed[0].prompt).toBeUndefined()
    // A field the proposal leaves out is not a change.
    expect(d.unchanged.map((r) => r.slug)).toEqual(['c'])
    expect(d.summary).toBe('2 changed')
  })

  it('shows a tier change the model line does not (review M-a)', () => {
    // An explicit model pick on the deep tier proposed back with its own tier: the model reads the same, remaps differ.
    const cur = [role('a', { model: 'claude-sonnet-4-5', tier: 'deep' }), role('b', { model: 'gpt-5', tier: 'deep' }), role('c', { model: 'sonnet', tier: 'everyday' })]
    const prop = [
      role('a', { model: 'claude-sonnet-4-5', tier: 'everyday' }),
      role('b', { model: 'gpt-5', tier: undefined }),
      role('c', { model: 'opus', tier: 'deep' })
    ]
    const d = diffOrgChart(cur, prop)
    const by = (slug: string) => d.changed.find((c) => c.role.slug === slug)?.changes
    expect(by('a')).toEqual([{ field: 'tier', label: 'tier', from: 'Deep', to: 'Everyday' }])
    expect(by('b')).toEqual([{ field: 'tier', label: 'tier', from: 'Deep', to: 'none' }])
    // The model line already says Everyday -> Deep, so the tier is not repeated.
    expect(by('c')).toEqual([{ field: 'model', label: 'model', from: 'Everyday', to: 'Deep' }])
  })

  it('shows a tier-only change when both sides read the same tier', () => {
    const one = (from: Partial<DiffRole>, to: Partial<DiffRole>) => diffOrgChart([role('a', from)], [role('a', to)]).changed[0]?.changes
    const m = { model: 'claude-sonnet-4-5' }
    expect(one(m, { ...m, tier: 'everyday' })).toEqual([{ field: 'tier', label: 'tier', from: 'none (fixed)', to: 'Everyday' }])
    expect(one({ ...m, tier: 'everyday' }, m)).toEqual([{ field: 'tier', label: 'tier', from: 'Everyday', to: 'none (fixed)' }])
    expect(one({ ...m, tier: 'everyday' }, { ...m, tier: 'everyday' })).toBeUndefined()
    expect(one({ ...m, tier: 'everyday' }, { ...m, tier: 'deep' })).toEqual([{ field: 'tier', label: 'tier', from: 'Everyday', to: 'Deep' }])
  })

  describe('addedRoleLines', () => {
    const all = [role('lead'), role('dev', { name: 'Dev' }), role('qa', { name: 'QA' })]
    it('names spawn targets and required reports from the proposed chart, falling back to the id', () => {
      const r = role('helper', { canSpawn: true, spawnable: ['id-qa', 'id-dev', 'gone'], requiredReports: ['id-dev'] })
      expect(addedRoleLines(r, all)).toEqual(['spawns: Dev, QA, gone', 'must delegate to: Dev'])
    })
    it('says any for an open spawn list and nothing when there is nothing to say', () => {
      expect(addedRoleLines(role('h', { canSpawn: true, spawnable: [] }), all)).toEqual(['spawns: none listed'])
      expect(addedRoleLines(role('h', { canSpawn: false, spawnable: [] }), all)).toEqual([])
    })
    it('does not claim a role that cannot spawn leads its listed roles', () => {
      expect(addedRoleLines(role('h', { canSpawn: false, spawnable: ['id-dev'] }), all)).toEqual(['spawns: cannot spawn (the listed roles are ignored)'])
    })
  })

  it('shows the ids when a model change keeps its tier label (review M1)', () => {
    const d = diffOrgChart([role('a', { model: 'claude-sonnet-4-5' })], [role('a', { model: 'claude-sonnet-4-6' })])
    expect(d.changed[0].changes).toEqual([{ field: 'model', label: 'model', from: 'Everyday (claude-sonnet-4-5)', to: 'Everyday (claude-sonnet-4-6)' }])
  })

  it('treats a legacy role without a tier as the tier its model stands for', () => {
    const d = diffOrgChart([role('a', { model: 'sonnet' })], [role('a', { model: 'sonnet', tier: 'everyday' })])
    expect(d.unchanged).toHaveLength(1)
  })

  it('diffs effort, staffing and connection, with a missing value read as none', () => {
    const one = (from: Partial<DiffRole>, to: Partial<DiffRole>) => diffOrgChart([role('a', from)], [role('a', to)]).changed[0]?.changes
    expect(one({}, { effort: 'high' })).toEqual([{ field: 'effort', label: 'effort', from: 'none', to: 'high' }])
    expect(one({ effort: 'low' }, { effort: 'low' })).toBeUndefined()
    expect(one({ staffing: { mode: 'auto', maxEffort: 'high' } }, { staffing: { mode: 'fixed' } })).toEqual([
      { field: 'staffing', label: 'staffing', from: 'auto (up to high effort)', to: 'fixed' }
    ])
    expect(one({}, { staffing: { mode: 'auto', minTier: 'fast' } })).toEqual([{ field: 'staffing', label: 'staffing', from: 'none', to: 'auto (from Fast)' }])
    expect(one({}, { connection: 'openai' })).toEqual([{ field: 'connection', label: 'connection', from: 'project default', to: 'openai' }])
    expect(one({ connection: 'openai' }, {})).toEqual([{ field: 'connection', label: 'connection', from: 'openai', to: 'project default' }])
  })

  it('diffs against the run baseline when present (stored prompt equals proposed, run differs)', () => {
    const stored = [role('x', { prompt: 'pulled' })]
    const baseline = [role('x', { prompt: 'running' })]
    const proposed = [role('x', { prompt: 'pulled' }), role('qa', { name: 'QA' })]
    const withBase = diffOrgChart(orgDiffBase({ runBaseline: baseline }, stored), proposed)
    expect(withBase.changed.map((c) => c.role.slug)).toEqual(['x'])
    expect(withBase.changed[0].changes.map((c) => c.field)).toEqual(['prompt'])
    expect(withBase.added.map((r) => r.slug)).toEqual(['qa'])
    const without = diffOrgChart(orgDiffBase({}, stored), proposed)
    expect(without.unchanged.map((r) => r.slug)).toEqual(['x'])
    expect(without.added.map((r) => r.slug)).toEqual(['qa'])
  })

  it('picks the diff base: present wins, absent falls back, an empty baseline is present', () => {
    const stored = [role('s')]
    const base = [role('b')]
    expect(orgDiffBase({ runBaseline: base }, stored)).toBe(base)
    expect(orgDiffBase({}, stored)).toBe(stored)
    const empty: DiffRole[] = []
    expect(orgDiffBase({ runBaseline: empty }, stored)).toBe(empty)
  })

  it('lists a role the run keeps as it is as unchanged even when the stored project differs', () => {
    const stored = [role('x', { prompt: 'stored' })]
    const baseline = [role('x', { prompt: 'running' })]
    const d = diffOrgChart(orgDiffBase({ runBaseline: baseline }, stored), [role('x', { prompt: 'running' })])
    expect(d.unchanged).toHaveLength(1)
    expect(d.changed).toHaveLength(0)
  })

  it('scores name similarity', () => {
    expect(nameSimilarity('Lead', 'lead')).toBe(1)
    expect(nameSimilarity('Backend Dev', 'Backend Developer')).toBeGreaterThanOrEqual(0.7)
    expect(nameSimilarity('Researcher', 'QA')).toBeLessThan(0.7)
  })
})
