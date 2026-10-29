import { describe, expect, it } from 'vitest'
import { defaultRoles, newId, newProject, rootRole, slugify } from './defaults'

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Tech Lead')).toBe('tech-lead')
    expect(slugify('  QA / Release  Engineer!! ')).toBe('qa-release-engineer')
    expect(slugify('Front-end (React)')).toBe('front-end-react')
  })

  it('falls back to "role" when nothing usable remains', () => {
    expect(slugify('')).toBe('role')
    expect(slugify('***')).toBe('role')
    expect(slugify('日本語')).toBe('role')
  })

  it('caps the length at 48 characters', () => {
    expect(slugify('a'.repeat(100))).toHaveLength(48)
  })
})

describe('newId', () => {
  it('prefixes and is unique', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId('role')))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).toMatch(/^role_[a-z0-9]+$/)
    expect(newId()).not.toContain('_')
  })
})

describe('newProject', () => {
  it('creates a project with default roles and no setup', () => {
    const p = newProject({ name: 'Demo', path: 'C:\\code\\demo', brief: 'A demo' })
    expect(p.id).toMatch(/^proj_/)
    expect(p.name).toBe('Demo')
    expect(p.path).toBe('C:\\code\\demo')
    expect(p.brief).toBe('A demo')
    expect(p.provider.id).toBe('claude')
    expect(p.isolateWriters).toBe(true)
    expect(p.setup).toBeUndefined()
    expect(p.roles.map((r) => r.slug)).toEqual(['orchestrator', 'implementer', 'reviewer', 'researcher'])
    expect(p.createdAt).toBe(p.updatedAt)
    expect(Number.isNaN(Date.parse(p.createdAt))).toBe(false)
  })

  it('records a pending setup of the requested kind', () => {
    expect(newProject({ name: 'X', path: '/x', brief: '', setupKind: 'existing' }).setup).toEqual({ kind: 'existing', state: 'pending' })
    expect(newProject({ name: 'X', path: '/x', brief: '', setupKind: 'new' }).setup).toEqual({ kind: 'new', state: 'pending' })
  })

  it('wires the default org chart to one orchestrator', () => {
    const roles = defaultRoles()
    const [orch, ...reports] = roles
    expect(orch.reportsTo).toBeNull()
    expect(orch.canSpawn).toBe(true)
    expect(orch.spawnable).toEqual(reports.map((r) => r.id))
    for (const r of reports) expect(r.reportsTo).toBe(orch.id)
    // Read-only roles cannot write.
    for (const slug of ['reviewer', 'researcher']) {
      const r = roles.find((x) => x.slug === slug)!
      expect(r.tools).not.toContain('Edit')
      expect(r.tools).not.toContain('Write')
    }
  })
})

describe('rootRole', () => {
  it('returns the role without a manager', () => {
    const p = newProject({ name: 'X', path: '/x', brief: '' })
    const reordered = { ...p, roles: [...p.roles.slice(1), p.roles[0]] }
    expect(rootRole(reordered)?.slug).toBe('orchestrator')
  })

  it('falls back to the first role, or undefined when there are none', () => {
    const p = newProject({ name: 'X', path: '/x', brief: '' })
    const noRoot = { ...p, roles: p.roles.slice(1) }
    expect(rootRole(noRoot)?.id).toBe(noRoot.roles[0].id)
    expect(rootRole({ ...p, roles: [] })).toBeUndefined()
  })
})
