import { describe, expect, it } from 'vitest'
import { diffOrgChart, type DiffRole } from './orgDiff'

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
    const cur = [role('lead'), role('dev', { reportsTo: 'id-lead' }), role('res', { reportsTo: 'id-lead' })]
    const prop = [
      role('lead'),
      role('dev', { reportsTo: 'id-lead', model: 'opus' }),
      role('rev', { reportsTo: 'id-lead' }),
      role('qa', { reportsTo: 'id-lead' })
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
})
