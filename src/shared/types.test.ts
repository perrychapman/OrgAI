import { describe, expect, it } from 'vitest'
import {
  ANTHROPIC_BUILTIN_MODELS,
  DEFAULT_APP_SETTINGS,
  adapterForProject,
  builtinModels,
  defaultConnections,
  defaultTierModels,
  isValidMcpServerName,
  mcpSecretNames,
  mcpServersForRole,
  modelFamily,
  newProject,
  projectConnection,
  tierForModel
} from './defaults'
import type { McpServerSpec, Project, ProviderModel } from './types'
import { CONNECTION_IDS, IPC, MCP_HARNESS_TOOLS, MODEL_TIERS, isModelTier } from './types'

const project = (over: Partial<Project> = {}): Project => ({ ...newProject({ name: 'X', path: '/x', brief: '' }), ...over })

const litellmModel = (id: string, family: ProviderModel['family']): ProviderModel => ({
  id,
  label: id,
  connection: 'litellm',
  family,
  adapter: family === 'claude' ? 'claude' : 'codex',
  source: 'discovered'
})

describe('tiers', () => {
  it('maps Claude aliases and full ids to tiers', () => {
    expect(tierForModel('fable')).toBe('top')
    expect(tierForModel('opus')).toBe('deep')
    expect(tierForModel('sonnet')).toBe('everyday')
    expect(tierForModel('haiku')).toBe('fast')
    expect(tierForModel('claude-opus-4-1-20250805')).toBe('deep')
    expect(tierForModel('anthropic/claude-sonnet-4-5')).toBe('everyday')
  })

  it('gives inherit and unknown models no tier', () => {
    expect(tierForModel('inherit')).toBeUndefined()
    expect(tierForModel('gpt-5')).toBeUndefined()
    expect(tierForModel('')).toBeUndefined()
    expect(tierForModel('constructor')).toBeUndefined()
  })

  it('recognizes tiers', () => {
    expect(MODEL_TIERS).toEqual(['top', 'deep', 'everyday', 'fast'])
    expect(isModelTier('deep')).toBe(true)
    expect(isModelTier('opus')).toBe(false)
  })

  it('tags new projects with tiers and the anthropic connection', () => {
    const p = newProject({ name: 'X', path: '/x', brief: '' }, DEFAULT_APP_SETTINGS)
    expect(p.provider.connection).toBe('anthropic')
    for (const r of p.roles) expect(r.tier).toBe(tierForModel(r.model))
    const bare = newProject({ name: 'X', path: '/x', brief: '' })
    expect(bare.roles.map((r) => r.tier)).toEqual(['deep', 'everyday', 'everyday', 'fast'])
  })
})

describe('catalog', () => {
  it('ships one Anthropic alias per tier and fills tierModels from it', () => {
    expect(defaultTierModels(ANTHROPIC_BUILTIN_MODELS)).toEqual({ top: 'fable', deep: 'opus', everyday: 'sonnet', fast: 'haiku' })
    for (const m of builtinModels('anthropic')) expect(m).toMatchObject({ connection: 'anthropic', family: 'claude', adapter: 'claude', source: 'builtin' })
    for (const m of builtinModels('openai')) expect(m).toMatchObject({ connection: 'openai', adapter: 'codex' })
    expect(builtinModels('litellm')).toEqual([])
  })

  it('guesses families from ids', () => {
    expect(modelFamily('sonnet')).toBe('claude')
    expect(modelFamily('anthropic/claude-3-5-haiku')).toBe('claude')
    expect(modelFamily('openai/gpt-5')).toBe('openai')
    expect(modelFamily('o3-mini')).toBe('openai')
    expect(modelFamily('llama-3.1-70b')).toBe('other')
  })

  it('defaults connections with the legacy auth and no secrets', () => {
    const c = defaultConnections({ kind: 'apiKey', envVar: 'KEY' })
    expect(c.anthropic.auth).toEqual({ kind: 'apiKey', envVar: 'KEY' })
    expect(c.litellm).toEqual({ id: 'litellm', enabled: false, baseUrl: '', hasApiKey: false, tierModels: {} })
    expect(Object.keys(c)).toEqual([...CONNECTION_IDS])
    expect(structuredClone(DEFAULT_APP_SETTINGS)).toEqual(DEFAULT_APP_SETTINGS)
  })
})

describe('projectConnection and adapterForProject', () => {
  it('treats projects without a connection as anthropic', () => {
    const p = project()
    const legacy = { ...p, provider: { id: 'claude' as const, label: 'Claude', auth: { kind: 'subscription' as const } } }
    expect(projectConnection(legacy)).toBe('anthropic')
    expect(projectConnection({ provider: { ...legacy.provider, id: 'codex' } })).toBe('openai')
    expect(adapterForProject(legacy, [])).toMatchObject({ adapter: 'claude', connection: 'anthropic', mismatched: [] })
  })

  it('runs openai projects on codex', () => {
    const p = project()
    const openai = { ...p, provider: { ...p.provider, connection: 'openai' as const }, roles: p.roles.map((r) => ({ ...r, model: 'gpt-5' })) }
    expect(adapterForProject(openai, [])).toMatchObject({ adapter: 'codex', mismatched: [] })
  })

  it('picks the litellm adapter from the root model family and lists mismatched roles', () => {
    const p = project()
    const catalog = [litellmModel('team-claude', 'claude'), litellmModel('team-gpt', 'openai')]
    const [root, a, b, c] = p.roles
    const roles = [
      { ...root, model: 'team-gpt' },
      { ...a, model: 'team-gpt' },
      { ...b, model: 'team-claude' },
      { ...c, model: 'inherit' }
    ]
    const choice = adapterForProject({ provider: { ...p.provider, connection: 'litellm' }, roles }, catalog)
    expect(choice).toEqual({ adapter: 'codex', connection: 'litellm', family: 'openai', mismatched: [b.id] })
    const claudeRoot = adapterForProject({ provider: { ...p.provider, connection: 'litellm' }, roles: [{ ...root, model: 'team-claude' }] }, catalog)
    expect(claudeRoot.adapter).toBe('claude')
  })

  it('keeps mock projects on the mock adapter', () => {
    const p = project()
    expect(adapterForProject({ ...p, provider: { ...p.provider, id: 'mock' } }, []).adapter).toBe('mock')
  })
})

describe('MCP helpers', () => {
  const spec = (over: Partial<McpServerSpec>): McpServerSpec => ({
    id: 'mcp_1',
    name: 'github',
    transport: 'stdio',
    enabled: true,
    source: 'user',
    addedAt: '2026-01-01T00:00:00.000Z',
    ...over
  })

  it('validates kebab-case names', () => {
    expect(isValidMcpServerName('github')).toBe(true)
    expect(isValidMcpServerName('my-db-2')).toBe(true)
    expect(isValidMcpServerName('My_DB')).toBe(false)
    expect(isValidMcpServerName('-x')).toBe(false)
    expect(isValidMcpServerName('')).toBe(false)
    expect(isValidMcpServerName('a'.repeat(49))).toBe(false)
  })

  it('lists secret slots', () => {
    expect(mcpSecretNames(spec({ secretEnv: ['TOKEN'], secretHeaders: ['Authorization'] }))).toEqual(['TOKEN', 'Authorization'])
    expect(mcpSecretNames(spec({}))).toEqual([])
  })

  it('grants servers by roles list, explicit role grant, or to everyone', () => {
    const servers = [
      spec({ id: 'all', name: 'all' }),
      spec({ id: 'scoped', name: 'scoped', roles: ['reviewer'] }),
      spec({ id: 'off', name: 'off', enabled: false })
    ]
    const ids = (slug: string, grants?: string[]): string[] => mcpServersForRole({ mcpServers: servers }, { slug, mcpServers: grants }).map((s) => s.id)
    expect(ids('reviewer')).toEqual(['all', 'scoped'])
    expect(ids('implementer')).toEqual(['all'])
    expect(ids('implementer', ['scoped', 'off'])).toEqual(['all', 'scoped'])
    expect(mcpServersForRole({}, { slug: 'x' })).toEqual([])
  })

  it('names the harness tools', () => {
    expect(Object.values(MCP_HARNESS_TOOLS).sort()).toEqual(['list_mcp_servers', 'propose_mcp_servers', 'request_mcp_install', 'search_mcp_registry'])
  })
})

describe('IPC names', () => {
  it('are unique', () => {
    const names = Object.values(IPC)
    expect(new Set(names).size).toBe(names.length)
  })
})
