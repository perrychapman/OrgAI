import { describe, expect, it } from 'vitest'
import { toRoles, type DraftPayload, type DraftRole } from './draft'

function draft(name: string, over: Partial<DraftRole> = {}): DraftRole {
  return {
    name,
    description: `${name} description`,
    responsibilities: ['do things'],
    prompt: `You are ${name}.`,
    tools: ['Read'],
    model: 'sonnet',
    canSpawn: false,
    spawnable: [],
    reportsTo: null,
    ...over
  }
}

const payload = (roles: DraftRole[]): DraftPayload => ({ rationale: 'because', roles })

describe('toRoles', () => {
  it('maps a well-formed draft into roles with ids, slugs and colors', () => {
    const roles = toRoles(
      payload([
        draft('Tech Lead', { canSpawn: true, spawnable: ['Implementer'], model: 'opus' }),
        draft('Implementer', { reportsTo: 'Tech Lead', tools: ['Read', 'Edit', 'Bash'] })
      ])
    )
    expect(roles).toHaveLength(2)
    const [lead, impl] = roles
    expect(lead.slug).toBe('tech-lead')
    expect(lead.reportsTo).toBeNull()
    expect(lead.model).toBe('opus')
    expect(lead.spawnable).toEqual([impl.id])
    expect(impl.reportsTo).toBe(lead.id)
    expect(impl.tools).toEqual(['Read', 'Edit', 'Bash'])
    expect(new Set(roles.map((r) => r.id)).size).toBe(2)
    expect(lead.color).not.toBe(impl.color)
  })

  it('guarantees exactly one root', () => {
    const roles = toRoles(payload([draft('A'), draft('B'), draft('C', { reportsTo: 'Nobody' })]))
    const roots = roles.filter((r) => r.reportsTo === null)
    expect(roots).toHaveLength(1)
    expect(roots[0].name).toBe('A')
    for (const r of roles.slice(1)) expect(r.reportsTo).toBe(roots[0].id)
  })

  it('breaks a reporting cycle by picking a root', () => {
    const roles = toRoles(payload([draft('A', { reportsTo: 'B' }), draft('B', { reportsTo: 'A' })]))
    expect(roles.filter((r) => r.reportsTo === null)).toHaveLength(1)
  })

  it('ignores a role reporting to itself', () => {
    const roles = toRoles(payload([draft('Lead'), draft('Solo', { reportsTo: 'Solo' })]))
    expect(roles[1].reportsTo).toBe(roles[0].id)
  })

  it('de-duplicates slugs', () => {
    const roles = toRoles(payload([draft('Lead'), draft('Implementer', { reportsTo: 'lead' }), draft('implementer!', { reportsTo: 'Lead' }), draft('IMPLEMENTER', { reportsTo: 'Lead' })]))
    expect(roles.map((r) => r.slug)).toEqual(['lead', 'implementer', 'implementer-2', 'implementer-3'])
  })

  it('resolves spawnable by name case-insensitively and drops unknown names and self', () => {
    const roles = toRoles(
      payload([
        draft('Lead', { spawnable: ['  reviewer ', 'Ghost', 'Lead'] }),
        draft('Reviewer', { reportsTo: 'Lead' }),
        draft('Helper', { reportsTo: 'Reviewer', spawnable: [] })
      ])
    )
    const [lead, reviewer, helper] = roles
    expect(lead.spawnable).toEqual([reviewer.id])
    // Listing spawnable roles implies canSpawn even if the draft said false.
    expect(lead.canSpawn).toBe(true)
    expect(helper.reportsTo).toBe(reviewer.id)
  })

  it('filters invalid tools and falls back to sonnet for unknown models', () => {
    const roles = toRoles(payload([draft('Lead', { tools: ['Read', 'Teleport', 'Agent', 'Grep'], model: 'gpt-9' })]))
    expect(roles[0].tools).toEqual(['Read', 'Grep'])
    expect(roles[0].model).toBe('sonnet')
  })

  it('tolerates missing arrays and blank names', () => {
    const bad = { ...draft(''), tools: undefined, responsibilities: undefined, spawnable: undefined } as unknown as DraftRole
    const roles = toRoles(payload([bad]))
    expect(roles[0].name).toBe('Role 1')
    expect(roles[0].slug).toBe('role')
    expect(roles[0].tools).toEqual([])
    expect(roles[0].responsibilities).toEqual([])
  })

  it('lets managers implicitly spawn their direct reports', () => {
    const roles = toRoles(
      payload([
        draft('Lead', { canSpawn: false, spawnable: [] }),
        draft('Frontend Lead', { reportsTo: 'Lead' }),
        draft('UI Dev', { reportsTo: 'Frontend Lead' }),
        draft('Tester', { reportsTo: 'Lead' })
      ])
    )
    const [lead, fe, ui, tester] = roles
    expect(lead.canSpawn).toBe(true)
    expect(lead.spawnable.sort()).toEqual([fe.id, tester.id].sort())
    expect(fe.canSpawn).toBe(true)
    expect(fe.spawnable).toEqual([ui.id])
    expect(ui.canSpawn).toBe(false)
    expect(ui.spawnable).toEqual([])
  })

  it('lays roles out by depth, centered per level', () => {
    const roles = toRoles(
      payload([draft('Lead'), draft('A', { reportsTo: 'Lead' }), draft('B', { reportsTo: 'Lead' }), draft('C', { reportsTo: 'A' })])
    )
    const [lead, a, b, c] = roles
    expect(lead.position).toEqual({ x: 0, y: 0 })
    expect(a.position).toEqual({ x: -150, y: 210 })
    expect(b.position).toEqual({ x: 150, y: 210 })
    expect(c.position).toEqual({ x: 0, y: 420 })
  })
})
