import { describe, expect, it } from 'vitest'
import type { McpServerSpec } from '@shared/types'
import { agentMcpServerNames, buildAgents, buildEnv, collectSecrets, redactSecrets, toClaudeMcpServers, toClaudePlugins, usesProxy } from './claude'
import { fakeCtx, orgChart, project, role, runSummary } from './testHelpers'
import type { ResolvedMcpServer } from './types'

function spec(over: Partial<McpServerSpec> & { id: string; name: string }): McpServerSpec {
  return { transport: 'stdio', enabled: true, source: 'user', addedAt: '2026-01-01T00:00:00.000Z', ...over }
}

const fs = spec({ id: 'm1', name: 'fs', command: 'npx', args: ['-y', 'fs'], secretEnv: ['TOKEN'], roles: ['lead'] })
const web = spec({ id: 'm2', name: 'web', transport: 'http', url: 'https://x.test/mcp', secretHeaders: ['Authorization'] })

describe('toClaudeMcpServers', () => {
  it('maps stdio and http specs, keyed by name, with resolved secrets', () => {
    const resolved: ResolvedMcpServer[] = [
      { spec: fs, env: { TOKEN: 'sekrit-token' }, headers: {} },
      { spec: web, env: {}, headers: { Authorization: 'Bearer abc' } }
    ]
    expect(toClaudeMcpServers(resolved)).toEqual({
      fs: { type: 'stdio', command: 'npx', args: ['-y', 'fs'], env: { TOKEN: 'sekrit-token' } },
      web: { type: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer abc' } }
    })
  })

  it('skips entries without a command or url', () => {
    const bad = [{ spec: spec({ id: 'x', name: 'x' }), env: {}, headers: {} }]
    expect(toClaudeMcpServers(bad)).toEqual({})
  })
})

describe('agentMcpServerNames and buildAgents', () => {
  const p = project({ mcpServers: [fs, web, spec({ id: 'm3', name: 'off', command: 'x', enabled: false })] })

  it('lists the servers a role may use', () => {
    expect(agentMcpServerNames(p, role({ id: 'r-lead', slug: 'lead' }))).toEqual(['fs', 'web'])
    expect(agentMcpServerNames(p, role({ id: 'r-eng', slug: 'engineer' }))).toEqual(['web'])
    expect(agentMcpServerNames(p, role({ id: 'r-eng', slug: 'engineer', mcpServers: ['m1'] }))).toEqual(['fs', 'web'])
  })

  it('gives each role its servers and tool rules, and harness tools by audience', () => {
    const ctx = fakeCtx({ project: p })
    const agents = buildAgents(ctx, [
      { name: 'set_plan', audience: 'root' },
      { name: 'list_mcp_servers', audience: 'spawners' }
    ], false)
    expect(agents.lead.mcpServers).toEqual(['fs', 'web'])
    expect(agents.lead.tools).toEqual(expect.arrayContaining(['mcp__fs', 'mcp__web', 'mcp__orgai__set_plan', 'mcp__orgai__list_mcp_servers']))
    expect(agents.engineer.mcpServers).toEqual(['web'])
    expect(agents.engineer.tools).toContain('mcp__web')
    expect(agents.engineer.tools).not.toContain('mcp__fs')
    expect(agents.engineer.tools?.some((t) => t.startsWith('mcp__orgai__'))).toBe(false)
  })

  it('gives a non-root spawner the spawners tools only', () => {
    const roles = [
      role({ id: 'a', slug: 'a', canSpawn: true, spawnable: ['b'] }),
      role({ id: 'b', slug: 'b', reportsTo: 'a', canSpawn: true, spawnable: [] })
    ]
    const ctx = fakeCtx({ project: project({ roles }), roles })
    const agents = buildAgents(ctx, [
      { name: 'set_plan', audience: 'root' },
      { name: 'request_mcp_install', audience: 'spawners' }
    ], false)
    expect(agents.b.tools).toContain('mcp__orgai__request_mcp_install')
    expect(agents.b.tools).not.toContain('mcp__orgai__set_plan')
    expect(agents.b.mcpServers).toBeUndefined()
  })

  it('never puts Skill in a tool list and omits mcpServers when none are granted', () => {
    const ctx = fakeCtx({ project: project({ roles: orgChart() }) })
    const agents = buildAgents(ctx, [], false)
    expect(agents.lead.mcpServers).toBeUndefined()
    expect(agents.lead.tools).not.toContain('Skill')
  })

  it('treats mcp-assist runs like setup (no messaging tools for leads)', () => {
    const ctx = fakeCtx({ run: runSummary({ kind: 'mcp-assist' }) })
    const agents = buildAgents(ctx, [], false)
    expect(agents.lead.tools).not.toContain('SendMessage')
  })
})

describe('toClaudePlugins', () => {
  it('keeps enabled plugins as local paths', () => {
    expect(
      toClaudePlugins([
        { id: '1', name: 'a', path: '/p/a', enabled: true },
        { id: '2', name: 'b', path: '/p/b', enabled: false }
      ])
    ).toEqual([{ type: 'local', path: '/p/a' }])
    expect(toClaudePlugins(undefined)).toEqual([])
  })
})

describe('buildEnv', () => {
  const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'inherited-key', MY_KEY: 'from-env' }

  it('keeps the project api key on the anthropic path and merges connection env', () => {
    const p = project({ provider: { id: 'claude', label: 'Claude', auth: { kind: 'apiKey', envVar: 'MY_KEY' } } })
    const env = buildEnv(fakeCtx({ project: p, connection: { connection: 'anthropic', adapter: 'claude', env: { EXTRA: '1' } } }), base)
    expect(env.ANTHROPIC_API_KEY).toBe('from-env')
    expect(env.EXTRA).toBe('1')
    expect(env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS).toBe('1')
  })

  it('on LiteLLM drops the inherited and project api key and sets the proxy env', () => {
    const p = project({ provider: { id: 'claude', label: 'Claude', auth: { kind: 'apiKey', envVar: 'MY_KEY' } } })
    const ctx = fakeCtx({
      project: p,
      connection: {
        connection: 'litellm',
        adapter: 'claude',
        env: { ANTHROPIC_BASE_URL: 'http://localhost:4000', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_DEFAULT_SONNET_MODEL: 'gpt-x' }
      }
    })
    const env = buildEnv(ctx, base)
    expect('ANTHROPIC_API_KEY' in env).toBe(false)
    expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:4000')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('tok')
    expect(usesProxy(ctx)).toBe(true)
  })
})

describe('secret redaction', () => {
  it('collects MCP and connection secrets and masks them in lines', () => {
    const secrets = collectSecrets(
      [
        { spec: fs, env: { TOKEN: 'sekrit-token' }, headers: {} },
        { spec: web, env: {}, headers: { Authorization: 'Bearer abc123' } }
      ],
      { connection: 'litellm', adapter: 'claude', env: { ANTHROPIC_AUTH_TOKEN: 'proxy-token', ANTHROPIC_BASE_URL: 'http://x' } }
    )
    expect(secrets.sort()).toEqual(['Bearer abc123', 'proxy-token', 'sekrit-token'].sort())
    expect(redactSecrets('start fs TOKEN=sekrit-token via proxy-token; Authorization: Bearer abc123', secrets)).toBe(
      'start fs TOKEN=*** via ***; Authorization: ***'
    )
  })
})
