import { describe, expect, it } from 'vitest'
import { diffOrgChart, nameSimilarity, type DiffRole } from './orgDiff'

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
    expect(d.changed[0].changes).toEqual([{ field: 'model', label: 'model', from: 'sonnet', to: 'opus' }])
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

  it('scores name similarity', () => {
    expect(nameSimilarity('Lead', 'lead')).toBe(1)
    expect(nameSimilarity('Backend Dev', 'Backend Developer')).toBeGreaterThanOrEqual(0.7)
    expect(nameSimilarity('Researcher', 'QA')).toBeLessThan(0.7)
  })
})
