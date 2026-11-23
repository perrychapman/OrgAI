import { describe, expect, it } from 'vitest'
import { patchedMcpSpec } from './toolsApi'

describe('patchedMcpSpec', () => {
  it('changes only enabled and returns a new object (the input is not mutated)', () => {
    const spec = { id: 'm1', name: 'docs', enabled: true, roles: ['x'], command: 'npx' }
    const result = patchedMcpSpec(spec, { enabled: false })
    expect(result).not.toBe(spec)
    expect(result.enabled).toBe(false)
    expect(result.roles).toEqual(['x'])
    expect(result.id).toBe('m1')
    expect(result.name).toBe('docs')
    expect(result.command).toBe('npx')
    expect(spec.enabled).toBe(true)
  })

  it('sets roles to a copy of the array', () => {
    const spec = { id: 'm1', name: 'docs', enabled: true, roles: ['x'], command: 'npx' }
    const roles = ['a']
    const result = patchedMcpSpec(spec, { roles })
    expect(result.roles).toEqual(['a'])
    expect(result.roles).not.toBe(roles)
    expect(result.enabled).toBe(true)
    expect(result.id).toBe('m1')
    expect(result.name).toBe('docs')
    expect(result.command).toBe('npx')
    expect(spec.roles).toEqual(['x'])
  })

  it('removes the roles key entirely and leaves the other fields equal', () => {
    const spec = { id: 'm1', name: 'docs', enabled: true, roles: ['x'], command: 'npx' }
    const result = patchedMcpSpec(spec, { roles: undefined })
    expect('roles' in result).toBe(false)
    expect(result.enabled).toBe(true)
    expect(result.id).toBe('m1')
    expect(result.name).toBe('docs')
    expect(result.command).toBe('npx')
  })
})
