import { describe, expect, it } from 'vitest'
import type { McpServerSpec } from '@shared/types'
import { HarnessCallerTracker, authFailureDetail, authFailureFrom, agentMcpServerNames, buildAgents, buildCompletionOptions, buildEnv, collectSecrets, completionEnv, linkAbortSignal, redactSecrets, toClaudeMcpServers, toClaudePlugins, usesProxy } from './claude'
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

describe('OAuth bearer headers', () => {
  const oauthWeb = spec({ id: 'm3', name: 'oa', transport: 'http', url: 'https://o.test/mcp' })
  const resolved = [{ spec: oauthWeb, env: {}, headers: { Authorization: 'Bearer oauth-tok-1' } }]
  it('passes the resolved Authorization header to the SDK config', () => {
    expect(toClaudeMcpServers(resolved)).toEqual({ oa: { type: 'http', url: 'https://o.test/mcp', headers: { Authorization: 'Bearer oauth-tok-1' } } })
  })
  it('redacts it even though it is not in secretHeaders', () => {
    expect(collectSecrets(resolved, undefined)).toEqual(['Bearer oauth-tok-1'])
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

describe('HarnessCallerTracker', () => {
  const T = 'mcp__orgai__request_mcp_install'
  it('matches by tool_use_id from _meta', () => {
    const t = new HarnessCallerTracker()
    t.record(T, 'a', 'sub-1')
    t.record(T, 'b', undefined)
    expect(t.resolve(T, { 'claudecode/toolUseId': 'b' })).toBeUndefined()
    expect(t.resolve(T, { 'claudecode/toolUseId': 'a' })).toBe('sub-1')
  })
  it('falls back to FIFO per tool name', () => {
    const t = new HarnessCallerTracker()
    t.record(T, 'a', 'sub-1')
    t.record(T, 'b', 'sub-2')
    t.record('mcp__orgai__other', 'c', 'sub-3')
    expect(t.resolve(T)).toBe('sub-1')
    expect(t.resolve(T, {})).toBe('sub-2')
    expect(t.resolve('mcp__orgai__other')).toBe('sub-3')
  })
  it('never throws and omits unknown callers', () => {
    const t = new HarnessCallerTracker()
    expect(t.resolve(T, 5)).toBeUndefined()
    expect(t.resolve(T, { 'claudecode/toolUseId': 'zzz' })).toBeUndefined()
  })
})

describe('completionEnv', () => {
  const base = { ANTHROPIC_API_KEY: 'k', PATH: 'p', ANTHROPIC_BASE_URL: 'leak', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' }
  it('without a connection is isolated but keeps the legacy ANTHROPIC_API_KEY', () => {
    expect(completionEnv(undefined, base)).toEqual({ ANTHROPIC_API_KEY: 'k', PATH: 'p', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' })
  })
  it('merges litellm env and drops the inherited key, routing vars and oauth token', () => {
    const env = completionEnv({ connection: 'litellm', adapter: 'claude', env: { ANTHROPIC_BASE_URL: 'u' } }, base)
    expect(env).toEqual({ PATH: 'p', ANTHROPIC_BASE_URL: 'u' })
  })
  it('takes the anthropic key from connection.env, not from base', () => {
    const env = completionEnv({ connection: 'anthropic', adapter: 'claude', env: { ANTHROPIC_API_KEY: 'from-conn' } }, base)
    expect(env.ANTHROPIC_API_KEY).toBe('from-conn')
    expect('ANTHROPIC_BASE_URL' in env).toBe(false)
    expect(completionEnv({ connection: 'anthropic', adapter: 'claude', env: {} }, base).ANTHROPIC_API_KEY).toBeUndefined()
  })
})

describe('env isolation in buildEnv', () => {
  const leaky = { PATH: '/bin', ANTHROPIC_BASE_URL: 'http://mine', ANTHROPIC_MODEL: 'x', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'stray', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' }
  it('never lets leaked routing vars through on anthropic or litellm', () => {
    for (const connection of ['anthropic', 'litellm'] as const) {
      const env = buildEnv(fakeCtx({ connection: { connection, adapter: 'claude', env: {} } }), leaky)
      expect(env.PATH).toBe('/bin')
      expect('ANTHROPIC_BASE_URL' in env).toBe(false)
      expect('ANTHROPIC_MODEL' in env).toBe(false)
      expect('CLAUDE_CODE_USE_BEDROCK' in env).toBe(false)
    }
  })
  it('a subscription project drops an inherited ANTHROPIC_API_KEY but keeps the oauth token', () => {
    const env = buildEnv(fakeCtx({ connection: { connection: 'anthropic', adapter: 'claude', env: {} } }), leaky)
    expect('ANTHROPIC_API_KEY' in env).toBe(false)
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth')
  })
  it('litellm drops CLAUDE_CODE_OAUTH_TOKEN', () => {
    const env = buildEnv(fakeCtx({ connection: { connection: 'litellm', adapter: 'claude', env: { ANTHROPIC_AUTH_TOKEN: 't' } } }), leaky)
    expect('CLAUDE_CODE_OAUTH_TOKEN' in env).toBe(false)
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('t')
  })
})

describe('authFailureDetail', () => {
  it('masks echoed key fragments and exact secrets, one line, capped', () => {
    const out = authFailureDetail('401 Received API Key = sk-...1234\nBearer abc.def exact-secret', ['exact-secret'])
    expect(out).not.toMatch(/sk-|abc\.def|exact-secret|\n/)
    expect(authFailureDetail('x'.repeat(900), [])).toHaveLength(400)
  })
})

describe('authFailureFrom', () => {
  const assistant = (text: string, error?: string): never => ({ type: 'assistant', error, message: { content: [{ type: 'text', text }] } }) as never
  it('detects the error code and the CLI wording on assistant messages', () => {
    expect(authFailureFrom(assistant('Invalid API key · Please run /login'))).toBe('Invalid API key · Please run /login')
    expect(authFailureFrom(assistant('', 'authentication_failed'))).toBe('')
    expect(authFailureFrom(assistant('Here is how to rotate an API key safely.'))).toBeNull()
  })
  it('detects an error result and ignores a normal one', () => {
    expect(authFailureFrom({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' } as never)).not.toBeNull()
    expect(authFailureFrom({ type: 'result', subtype: 'success', is_error: false, result: 'Done.' } as never)).toBeNull()
    expect(authFailureFrom({ type: 'system', subtype: 'init' } as never)).toBeNull()
  })
})

describe('linkAbortSignal', () => {
  it('aborts the controller when the signal aborts', () => {
    const ac = new AbortController()
    const { controller } = linkAbortSignal(ac.signal)
    expect(controller.signal.aborted).toBe(false)
    ac.abort()
    expect(controller.signal.aborted).toBe(true)
  })
  it('stops listening after dispose', () => {
    const ac = new AbortController()
    const { controller, dispose } = linkAbortSignal(ac.signal)
    dispose()
    ac.abort()
    expect(controller.signal.aborted).toBe(false)
  })
  it('throws when already aborted', () => {
    const ac = new AbortController()
    ac.abort()
    expect(() => linkAbortSignal(ac.signal)).toThrow('Completion cancelled')
  })
})

describe('buildCompletionOptions', () => {
  it('blocks ambient MCP servers', () => {
    const o = buildCompletionOptions({ cwd: process.cwd(), system: 's', prompt: 'p' } as Parameters<typeof buildCompletionOptions>[0])
    expect(o.strictMcpConfig).toBe(true)
    expect(o.mcpServers).toEqual({})
  })
})
