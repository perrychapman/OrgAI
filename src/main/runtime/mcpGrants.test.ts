import { describe, expect, it } from 'vitest'
import type { HarnessToolAudience } from './harnessTools'
import { mcpCallDenial, parseMcpToolName, rolesGrantedServer } from './mcpGrants'
import { mcpSpec, orgChart } from './testHelpers'

const [lead, engineer, reviewer] = orgChart()
const root = { role: lead, isRoot: true }
const eng = { role: engineer, isRoot: false }
const rev = { role: reviewer, isRoot: false }

describe('parseMcpToolName', () => {
  it('splits server and tool at the first double underscore', () => {
    expect(parseMcpToolName('mcp__github__create_issue')).toEqual({ server: 'github', tool: 'create_issue' })
    expect(parseMcpToolName('mcp__my-server__a__b')).toEqual({ server: 'my-server', tool: 'a__b' })
  })
  it('rejects non-MCP and malformed names', () => {
    for (const n of ['Read', 'mcp__', 'mcp__github', 'mcp__github__', 'mcp____tool', 'mcp_github__x']) expect(parseMcpToolName(n)).toBeUndefined()
  })
})

describe('mcpCallDenial', () => {
  it('lets non-MCP tools through', () => {
    expect(mcpCallDenial('Bash', eng, [])).toBeUndefined()
  })

  it('a server without roles is granted to every role, root included', () => {
    const servers = [mcpSpec({ name: 'github', roles: undefined })]
    for (const c of [root, eng, rev]) expect(mcpCallDenial('mcp__github__list', c, servers)).toBeUndefined()
  })

  it('a run-scoped install restricted on the card denies the roles it leaves out, root included', () => {
    const servers = [mcpSpec({ id: 'mcp-run', name: 'github', roles: ['engineer'] })]
    expect(mcpCallDenial('mcp__github__list', eng, servers)).toBeUndefined()
    const denied = mcpCallDenial('mcp__github__list', rev, servers)
    expect(denied).toContain('does not grant the MCP server "github" to the Reviewer role (reviewer)')
    expect(mcpCallDenial('mcp__github__list', root, servers)).toContain('Lead role (lead)')
  })

  it('a role-side grant (Role.mcpServers holds the id) counts', () => {
    const servers = [mcpSpec({ id: 'mcp-x', name: 'pg', roles: [] })]
    expect(mcpCallDenial('mcp__pg__query', { role: { ...reviewer, mcpServers: ['mcp-x'] }, isRoot: false }, servers)).toBeUndefined()
    expect(mcpCallDenial('mcp__pg__query', rev, servers)).toBeDefined()
  })

  it('follows the live list: a card edit that widens or narrows roles applies at once', () => {
    const before = [mcpSpec({ name: 'github', roles: ['engineer'] })]
    const after = [mcpSpec({ name: 'github', roles: ['engineer', 'reviewer'] })]
    expect(mcpCallDenial('mcp__github__list', rev, before)).toBeDefined()
    expect(mcpCallDenial('mcp__github__list', rev, after)).toBeUndefined()
  })

  it('denies an unknown server, a disabled one and an unknown caller', () => {
    expect(mcpCallDenial('mcp__nope__x', root, [])).toBe('The MCP server "nope" is not configured for this run.')
    expect(mcpCallDenial('mcp__github__x', root, [mcpSpec({ name: 'github', enabled: false })])).toContain('turned off')
    expect(mcpCallDenial('mcp__github__x', { role: undefined, isRoot: false }, [mcpSpec({ name: 'github' })])).toContain('could not tell which role')
  })

  it('harness tools follow their audience when the audiences are given, and pass otherwise', () => {
    const audiences = new Map<string, HarnessToolAudience>([
      ['set_plan', 'root'],
      ['request_mcp_install', 'spawners'],
      ['request_permission_rules', 'all']
    ])
    expect(mcpCallDenial('mcp__orgai__set_plan', root, [], audiences)).toBeUndefined()
    expect(mcpCallDenial('mcp__orgai__set_plan', eng, [], audiences)).toContain('not available to the Engineer role')
    expect(mcpCallDenial('mcp__orgai__request_mcp_install', { role: { ...engineer, canSpawn: true }, isRoot: false }, [], audiences)).toBeUndefined()
    expect(mcpCallDenial('mcp__orgai__request_mcp_install', eng, [], audiences)).toBeDefined()
    expect(mcpCallDenial('mcp__orgai__request_permission_rules', rev, [], audiences)).toBeUndefined()
    expect(mcpCallDenial('mcp__orgai__made_up', root, [], audiences)).toContain('no harness tool')
    expect(mcpCallDenial('mcp__orgai__set_plan', eng, [])).toBeUndefined()
  })
})

describe('rolesGrantedServer', () => {
  it('lists the roles the live spec grants', () => {
    const roles = orgChart()
    expect(rolesGrantedServer(roles, [mcpSpec({ name: 'github', roles: ['engineer'] })], 'github').map((r) => r.slug)).toEqual(['engineer'])
    expect(rolesGrantedServer(roles, [mcpSpec({ name: 'github' })], 'github')).toHaveLength(3)
    expect(rolesGrantedServer(roles, [], 'github')).toEqual([])
  })
})
