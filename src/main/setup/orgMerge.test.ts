import { describe, expect, it } from 'vitest'
import type { Role } from '@shared/types'
import { mcpSpec, project } from '../runtime/testHelpers'
import { mergeOrgChart } from './orgMerge'

const role = (id: string, name: string, over: Partial<Role> = {}): Role => ({
  id,
  slug: name.toLowerCase().replace(/\s+/g, '-'),
  name,
  description: `${name} d`,
  responsibilities: [],
  prompt: `You are ${name}.`,
  tools: ['Read'],
  model: 'sonnet',
  canSpawn: false,
  spawnable: [],
  reportsTo: null,
  position: { x: 0, y: 0 },
  color: '#111',
  ...over
})

function base() {
  const lead = role('r-lead', 'Lead', { canSpawn: true, spawnable: ['r-eng'], color: '#aaa', effort: 'high', mcpServers: ['m1'] })
  const eng = role('r-eng', 'Engineer', { reportsTo: 'r-lead', skills: ['s1'], color: '#bbb' })
  const old = role('r-old', 'Old Role', { reportsTo: 'r-lead' })
  const p = project({
    roles: [lead, eng, old],
    mcpServers: [mcpSpec({ id: 'm1', roles: ['engineer', 'old-role'] }), mcpSpec({ id: 'm2', name: 'b', roles: ['old-role'] }), mcpSpec({ id: 'm3', name: 'c' }), mcpSpec({ id: 'm4', name: 'd', roles: [] })],
    skills: [{ id: 's1', name: 's', description: 'd', enabled: true, source: 'user', digest: 'x', files: [], addedAt: '', updatedAt: '' }]
  })
  return p
}

describe('mergeOrgChart', () => {
  it('a matched role takes the proposed connection, and loses a stored one the proposal leaves out', () => {
    const p = base()
    p.roles[1] = { ...p.roles[1], connection: 'openai' }
    const lead = role('n1', 'Lead', { canSpawn: true, spawnable: ['n2'] })
    const kept = mergeOrgChart(p, [lead, role('n2', 'Engineer', { reportsTo: 'n1', connection: 'proxy-0000abcd' })])
    expect(kept.roles.find((r) => r.id === 'r-eng')?.connection).toBe('proxy-0000abcd')
    const dropped = mergeOrgChart(p, [lead, role('n2', 'Engineer', { reportsTo: 'n1' })])
    expect(dropped.roles.find((r) => r.id === 'r-eng')).not.toHaveProperty('connection')
  })

  it('keeps ids, slugs, colours, effort and grants of matched roles and takes the proposal fields', () => {
    const p = base()
    const proposed = [
      role('n1', 'lead ', { description: 'new', canSpawn: true, spawnable: ['n2'], color: '#zzz', prompt: 'P' }),
      role('n2', 'Engineer', { reportsTo: 'n1', tier: 'deep' })
    ]
    const m = mergeOrgChart(p, proposed)
    const lead = m.roles[0]
    expect(lead).toMatchObject({ id: 'r-lead', slug: 'lead', color: '#aaa', effort: 'high', mcpServers: ['m1'], description: 'new', prompt: 'P', name: 'lead ' })
    expect(lead.spawnable).toEqual(['r-eng'])
    expect(m.roles[1]).toMatchObject({ id: 'r-eng', reportsTo: 'r-lead', skills: ['s1'], tier: 'deep', color: '#bbb' })
    expect(m.kept).toEqual(['lead ', 'Engineer'])
    expect(m.removed).toEqual(['Old Role'])
    expect(m.added).toEqual([])
  })

  it('deletes tier when the proposal has none and lets a proposal set grants (filtered)', () => {
    const p = base()
    p.roles[1].tier = 'deep'
    const m = mergeOrgChart(p, [role('n1', 'Lead', { mcpServers: ['m2', 'gone'], skills: ['nope'] }), role('n2', 'Engineer', { reportsTo: 'n1' })])
    expect(m.roles[1].tier).toBeUndefined()
    expect(m.roles[0].mcpServers).toEqual(['m2'])
    expect(m.roles[0].skills).toEqual([])
  })

  it('matches by slug before name, once per existing role, and by explicit slug despite a different name', () => {
    const p = base()
    const m = mergeOrgChart(p, [role('n1', 'Lead'), role('n2', 'Software Engineer', { slug: 'engineer', reportsTo: 'n1' }), role('n3', 'Engineer', { reportsTo: 'n1' })])
    expect(m.roles[1].id).toBe('r-eng')
    expect(m.roles[1].name).toBe('Software Engineer')
    // the name match is taken by the slug match, so "Engineer" is new and its slug is de-duplicated
    expect(m.roles[2].id).toBe('n3')
    expect(m.roles[2].slug).toBe('engineer-2')
    expect(m.added).toEqual(['Engineer'])
  })

  it('new roles keep their id, remap references to them and de-duplicate slugs against kept ones', () => {
    const p = base()
    const m = mergeOrgChart(p, [role('n1', 'Lead', { spawnable: ['n2', 'n3'] }), role('n2', 'Tester', { slug: 'lead', reportsTo: 'n1' }), role('n3', 'Docs', { reportsTo: 'n1' })])
    expect(m.roles[0].spawnable).toEqual(['n2', 'n3'])
    expect(m.roles[1].slug).toBe('lead-2')
    expect(m.roles[2]).toMatchObject({ id: 'n3', reportsTo: 'r-lead' })
    expect(m.removed.sort()).toEqual(['Engineer', 'Old Role'])
  })

  it('strips removed slugs from server roles, never widens and returns mcpServers only when changed', () => {
    const p = base()
    const m = mergeOrgChart(p, [role('n1', 'Lead'), role('n2', 'Engineer', { reportsTo: 'n1' })])
    const byId = Object.fromEntries((m.mcpServers ?? []).map((s) => [s.id, s.roles]))
    expect(byId).toEqual({ m1: ['engineer'], m2: [], m3: undefined, m4: [] })
    const same = mergeOrgChart(p, [role('n1', 'Lead'), role('n2', 'Engineer', { reportsTo: 'n1' }), role('n3', 'Old Role', { reportsTo: 'n1' })])
    expect(same.mcpServers).toBeUndefined()
  })

  it('does not mutate its inputs', () => {
    const p = base()
    const proposed = [role('n1', 'Lead', { spawnable: ['n2'] }), role('n2', 'Engineer', { reportsTo: 'n1' })]
    const a = JSON.stringify(p)
    const b = JSON.stringify(proposed)
    mergeOrgChart(p, proposed)
    expect(JSON.stringify(p)).toBe(a)
    expect(JSON.stringify(proposed)).toBe(b)
  })

  it('is idempotent against the same project', () => {
    const p = base()
    const proposed = [role('n1', 'Lead', { spawnable: ['n2', 'n3'] }), role('n2', 'Engineer', { reportsTo: 'n1' }), role('n3', 'Docs', { reportsTo: 'n1', slug: 'lead' })]
    const once = mergeOrgChart(p, proposed)
    const twice = mergeOrgChart({ ...p, roles: once.roles, mcpServers: once.mcpServers ?? p.mcpServers }, once.roles)
    expect(twice.roles).toEqual(once.roles)
    const again = mergeOrgChart(p, once.roles)
    expect(again.roles).toEqual(once.roles)
  })
})
