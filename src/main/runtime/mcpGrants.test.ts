import { describe, expect, it } from 'vitest'
import type { HarnessToolAudience } from './harnessTools'
import { agentInstalledServers, isMcpGated, mcpCallDenial, parseMcpToolName, rolesGrantedServer, withoutServerRules } from './mcpGrants'
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

describe('MCP resource tools (review L3)', () => {
  const servers = [mcpSpec({ name: 'github', roles: ['engineer'] }), mcpSpec({ id: 'm2', name: 'docs', roles: undefined })]
  it('are gated on input.server with the same grant check', () => {
    for (const tool of ['ReadMcpResourceTool', 'ReadMcpResourceDirTool', 'ListMcpResourcesTool']) {
      expect(mcpCallDenial(tool, eng, servers, undefined, { server: 'github', uri: 'x://1' })).toBeUndefined()
      expect(mcpCallDenial(tool, rev, servers, undefined, { server: 'github', uri: 'x://1' })).toContain('does not grant the MCP server "github"')
      expect(mcpCallDenial(tool, rev, servers, undefined, { server: 'nope' })).toContain('not configured for this run')
      expect(mcpCallDenial(tool, { role: undefined, isRoot: false }, servers, undefined, { server: 'docs' })).toContain('could not tell which role')
    }
  })
  it('refuses a read without a server', () => {
    expect(mcpCallDenial('ReadMcpResourceTool', eng, servers, undefined, { uri: 'x://1' })).toContain('needs the MCP server name')
    expect(mcpCallDenial('ReadMcpResourceTool', eng, servers, undefined, undefined)).toContain('needs the MCP server name')
  })
  it('lists every server only for a role granted all enabled ones', () => {
    expect(mcpCallDenial('ListMcpResourcesTool', eng, servers, undefined, {})).toBeUndefined()
    expect(mcpCallDenial('ListMcpResourcesTool', rev, servers, undefined, {})).toContain('not available to the Reviewer role (reviewer)')
    const off = [mcpSpec({ name: 'github', roles: ['engineer'], enabled: false }), servers[1]!]
    expect(mcpCallDenial('ListMcpResourcesTool', rev, off, undefined, { server: '' })).toBeUndefined()
  })
  it('lets the harness server through and marks which tools the gate looks at', () => {
    expect(mcpCallDenial('ListMcpResourcesTool', rev, servers, undefined, { server: 'orgai' })).toBeUndefined()
    for (const t of ['mcp__x__y', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool']) expect(isMcpGated(t)).toBe(true)
    for (const t of ['Read', 'Bash', 'Skill', 'mcp_x']) expect(isMcpGated(t)).toBe(false)
  })
})

describe('server-level rules and agent installs (review M3)', () => {
  it('withoutServerRules drops only server-level rules for the named servers', () => {
    const rules = ['mcp__pg', 'mcp__pg__*', 'mcp__pg__query', 'mcp__github', 'Read', 'Bash(npm test:*)']
    expect(withoutServerRules(rules, new Set(['pg']))).toEqual(['mcp__pg__query', 'mcp__github', 'Read', 'Bash(npm test:*)'])
    expect(withoutServerRules(rules, new Set())).toEqual(rules)
  })
  it('agentInstalledServers is the attached set plus run-only agent installs', () => {
    const saved = [mcpSpec({ id: 's1', name: 'old-agent', source: 'agent' })]
    const live = [saved[0]!, mcpSpec({ id: 'r1', name: 'new-agent', source: 'agent' }), mcpSpec({ id: 'u1', name: 'mine', source: 'user' })]
    expect([...agentInstalledServers(live, saved, ['from-registry'])].sort()).toEqual(['from-registry', 'new-agent'])
    expect([...agentInstalledServers(live, undefined, [])].sort()).toEqual(['new-agent', 'old-agent'])
  })
})
