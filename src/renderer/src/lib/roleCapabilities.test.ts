import { describe, expect, it } from 'vitest'
import {
  accessLabel,
  accessSentence,
  grantableServers,
  grantedServers,
  needsSignIn,
  revokePlan,
  roleSkillSplit,
  toolsSummary,
  capabilityCounts,
  countsSummary,
  grantServerRoles,
  revokeServerRoles,
  serverGranted,
  skillRoleIds,
  toggleSkillRoleIds,
  withoutRoleServer
} from './roleCapabilities'

const role = { slug: 'reviewer', tools: ['Read', 'Grep'], mcpServers: undefined as string[] | undefined, skills: ['s1'] }

describe('server grants', () => {
  it('knows who is granted', () => {
    expect(serverGranted({ id: 'a', roles: undefined }, role)).toBe(true)
    expect(serverGranted({ id: 'a', roles: ['lead'] }, role)).toBe(false)
    expect(serverGranted({ id: 'a', roles: ['lead'] }, { ...role, mcpServers: ['a'] })).toBe(true)
  })
  it('grants by appending the slug once', () => {
    expect(grantServerRoles({ roles: ['lead'] }, role)).toEqual(['lead', 'reviewer'])
    expect(grantServerRoles({ roles: ['reviewer'] }, role)).toEqual(['reviewer'])
    expect(grantServerRoles({ roles: undefined }, role)).toBeUndefined()
  })
  it('revokes, expanding "every role"', () => {
    const all = [{ slug: 'lead' }, { slug: 'reviewer' }]
    expect(revokeServerRoles({ roles: undefined }, all, role)).toEqual(['lead'])
    expect(revokeServerRoles({ roles: ['lead', 'reviewer'] }, all, role)).toEqual(['lead'])
  })
  it('drops a role-level grant', () => {
    expect(withoutRoleServer({ mcpServers: ['a', 'b'] }, 'a')).toEqual(['b'])
    expect(withoutRoleServer({ mcpServers: undefined }, 'a')).toBeUndefined()
  })
})

describe('skill grants', () => {
  it('lists and toggles role ids', () => {
    expect(skillRoleIds([{ id: 'r1', skills: ['s1'] }, { id: 'r2', skills: [] }, { id: 'r3' }], 's1')).toEqual(['r1'])
    expect(toggleSkillRoleIds(['r1'], 'r2', true)).toEqual(['r1', 'r2'])
    expect(toggleSkillRoleIds(['r1', 'r2'], 'r1', false)).toEqual(['r2'])
    expect(toggleSkillRoleIds(['r1'], 'r1', true)).toEqual(['r1'])
  })
})

describe('counts and sentences', () => {
  const project = {
    mcpServers: [
      { id: 'a', enabled: true, roles: undefined },
      { id: 'b', enabled: false, roles: undefined },
      { id: 'c', enabled: true, roles: ['lead'] }
    ],
    skills: [
      { id: 's1', enabled: true },
      { id: 's2', enabled: true }
    ]
  } as never
  it('counts enabled grants', () => {
    expect(capabilityCounts(project, role as never)).toEqual({ tools: 2, connections: 1, skills: 1 })
  })
  it('summarises and omits zeros', () => {
    expect(countsSummary({ tools: 3, connections: 1, skills: 2 })).toBe('3 tools, 1 connection, 2 skills')
    expect(countsSummary({ tools: 1, connections: 0, skills: 0 })).toBe('1 tool')
  })
  it('writes the least-privilege sentence', () => {
    expect(accessSentence('Reviewer', 'GitHub', true)).toBe('Reviewer can read GitHub.')
    expect(accessSentence('Reviewer', 'GitHub', false)).toBe('Reviewer can read and change GitHub.')
    expect(accessSentence('Reviewer', 'my-server', null)).toContain('can use the tools')
  })
})

describe('role editor helpers', () => {
  const catalog = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']
  it('summarises tools in catalog order', () => {
    expect(toolsSummary(['Bash', 'Grep', 'Read', 'Glob', 'Edit'], catalog)).toBe('Read, Glob, Grep + 2')
    expect(toolsSummary(['Read'], catalog)).toBe('Read')
    expect(toolsSummary([], catalog)).toBe('No tools')
  })
  it('words access', () => {
    expect(accessLabel(true)).toBe('Can read')
    expect(accessLabel(false)).toBe('Can read and change')
    expect(accessLabel(null)).toBeNull()
  })
  it('splits servers by grant', () => {
    const a = { spec: { id: 'a', roles: undefined } }
    const b = { spec: { id: 'b', roles: ['lead'] } }
    expect(grantedServers([a, b], role)).toEqual([a])
    expect(grantableServers([a, b], role)).toEqual([b])
  })
  it('detects needs sign in', () => {
    const base = { spec: { enabled: true }, auth: { state: 'notRequired' }, missingSecrets: [] as string[] }
    expect(needsSignIn(base)).toBe(false)
    expect(needsSignIn({ ...base, auth: { state: 'expired' } })).toBe(true)
    expect(needsSignIn({ ...base, missingSecrets: ['TOKEN'] })).toBe(true)
    expect(needsSignIn({ ...base, auth: { state: 'notAuthorized' }, spec: { enabled: false } })).toBe(false)
    expect(needsSignIn({ ...base, auth: { state: 'notAuthorized' }, libraryMissing: true })).toBe(false)
  })
  it('plans a revoke', () => {
    const all = [{ slug: 'lead' }, { slug: 'reviewer' }]
    expect(revokePlan({ id: 'a', roles: undefined }, all, role)).toEqual({ roles: ['lead'] })
    expect(revokePlan({ id: 'a', roles: ['reviewer'] }, all, { ...role, mcpServers: ['a', 'z'] })).toEqual({ roles: [], roleMcpServers: ['z'] })
  })
  it('splits skills', () => {
    expect(roleSkillSplit([{ id: 's1' }, { id: 's2' }], role)).toEqual({ granted: [{ id: 's1' }], available: [{ id: 's2' }] })
  })
})
