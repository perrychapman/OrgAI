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
  mixedFamilyRefusal,
  modelFamily,
  newProject,
  projectConnection,
  tierForModel
} from './defaults'
import type { McpServerSpec, Project, ProviderModel } from './types'
import {
  CONNECTION_IDS,
  DEFAULT_EXEC_STALL_TIMEOUT_MS,
  DEFAULT_HEADLESS_DECISION_POLICY,
  EXEC_OUTCOMES,
  EXEC_OUTCOME_EXIT_CODE,
  HOST_CLIENT_KINDS,
  HOST_IPC,
  HOST_KINDS,
  HOST_KIND_CAPABILITIES,
  HOST_METHODS,
  HOST_SCOPES,
  INSTALL_CHANNELS,
  SECRETS_IPC,
  VAULT_CUSTODY_SCHEMES,
  VAULT_STATES,
  hostCanOpenWindows,
  IPC,
  KIT_IPC,
  KNOWLEDGE_IPC,
  MCP_HARNESS_TOOLS,
  MCP_SCOPE_IPC,
  MODEL_TIERS,
  RPC_BULK_CHANNELS,
  TEMPLATE_ENGAGEMENT_IPC,
  isModelTier
} from './types'

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
    expect(choice).toEqual({ adapter: 'codex', connection: 'litellm', family: 'openai', mismatched: [b.id], bridged: [{ roleId: b.id, connection: 'litellm', adapter: 'claude' }] })
    const claudeRoot = adapterForProject({ provider: { ...p.provider, connection: 'litellm' }, roles: [{ ...root, model: 'team-claude' }] }, catalog)
    expect(claudeRoot.adapter).toBe('claude')
    // A mixed chart on LiteLLM is informational: the root's family picked the adapter, the run may start.
    expect(mixedFamilyRefusal(choice)).toBeNull()
  })

  it('mixedFamilyRefusal: LiteLLM refuses only without a root family; single-family connections always refuse a mix', () => {
    const p = project()
    const [root, a] = p.roles
    const catalog = [litellmModel('team-claude', 'claude'), litellmModel('team-gpt', 'openai')]
    const onLiteLLM = (rootModel: string, reportModel: string) =>
      adapterForProject({ provider: { ...p.provider, connection: 'litellm' }, roles: [{ ...root, model: rootModel }, { ...a, model: reportModel }] }, catalog)
    expect(mixedFamilyRefusal(onLiteLLM('team-claude', 'team-gpt'))).toBeNull()
    expect(mixedFamilyRefusal(onLiteLLM('team-gpt', 'team-claude'))).toBeNull()
    expect(mixedFamilyRefusal(onLiteLLM('team-claude', 'team-claude'))).toBeNull()
    // 'inherit' root: no family, the adapter defaults to Claude and a GPT report cannot be placed.
    const inherit = onLiteLLM('inherit', 'team-gpt')
    expect(inherit).toMatchObject({ adapter: 'claude', family: undefined, mismatched: [a.id] })
    expect(mixedFamilyRefusal(inherit)).toBe('no-root-family')
    expect(mixedFamilyRefusal(onLiteLLM('inherit', 'team-claude'))).toBeNull()
    expect(mixedFamilyRefusal({ connection: 'anthropic', family: 'claude', mismatched: ['r1'] })).toBe('single-family-connection')
    expect(mixedFamilyRefusal({ connection: 'openai', family: 'openai', mismatched: ['r1'] })).toBe('single-family-connection')
    expect(mixedFamilyRefusal({ connection: 'anthropic', family: 'claude', mismatched: [] })).toBeNull()
  })

  it('treats every non-built-in id (proxy-0a1b2c3d) as a proxy, exactly like litellm', () => {
    const p = project()
    const [root, a] = p.roles
    const catalog = [
      { ...litellmModel('team-claude', 'claude'), connection: 'proxy-0a1b2c3d' },
      { ...litellmModel('team-gpt', 'openai'), connection: 'proxy-0a1b2c3d' }
    ]
    const on = (rootModel: string, reportModel: string) =>
      adapterForProject({ provider: { ...p.provider, connection: 'proxy-0a1b2c3d' }, roles: [{ ...root, model: rootModel }, { ...a, model: reportModel }] }, catalog)
    expect(on('team-gpt', 'team-claude')).toMatchObject({ adapter: 'codex', connection: 'proxy-0a1b2c3d', family: 'openai', mismatched: [a.id] })
    expect(on('team-claude', 'team-gpt').adapter).toBe('claude')
    expect(mixedFamilyRefusal(on('team-claude', 'team-gpt'))).toBeNull()
    expect(mixedFamilyRefusal(on('inherit', 'team-gpt'))).toBe('no-root-family')
    expect(mixedFamilyRefusal({ connection: 'proxy-0a1b2c3d', family: 'claude', mismatched: ['r1'] })).toBeNull()
  })

  it('keeps the anthropic and openai catalogs single-family, so a chart picked from them never mixes', () => {
    expect(new Set(builtinModels('anthropic').map((m) => m.family))).toEqual(new Set(['claude']))
    expect(new Set(builtinModels('openai').map((m) => m.family))).toEqual(new Set(['openai']))
    for (const connection of ['anthropic', 'openai'] as const) {
      const models = builtinModels(connection)
      const p = project()
      const roles = p.roles.map((r, i) => ({ ...r, model: models[i % models.length].id }))
      const choice = adapterForProject({ provider: { ...p.provider, connection }, roles }, models)
      expect(choice.mismatched).toEqual([])
      expect(mixedFamilyRefusal(choice)).toBeNull()
    }
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

describe('Wave 7 (standalone CLI) contracts', () => {
  it('SECRETS_IPC values are unique and collide with no IPC, HOST_IPC channel or host.* method', () => {
    const names = Object.values(SECRETS_IPC)
    expect(names.sort()).toEqual(['secrets:confirmDelete', 'secrets:init', 'secrets:reset', 'secrets:status', 'secrets:undelete'])
    const taken = new Set<string>([IPC, TEMPLATE_ENGAGEMENT_IPC, KNOWLEDGE_IPC, MCP_SCOPE_IPC, KIT_IPC, HOST_IPC, HOST_METHODS].flatMap((o) => Object.values(o)))
    for (const n of names) expect(taken.has(n), n).toBe(false)
  })

  it('host kinds: every kind has capabilities; only desktop opens windows', () => {
    expect([...HOST_KINDS].sort()).toEqual(Object.keys(HOST_KIND_CAPABILITIES).sort())
    expect([...HOST_KINDS]).toEqual(['desktop', 'inproc'])
    expect(HOST_KINDS.filter((k) => hostCanOpenWindows(k)).sort()).toEqual(['desktop'])
    expect(HOST_KINDS.filter((k) => HOST_KIND_CAPABILITIES[k].inProcess)).toEqual(['inproc'])
    expect(hostCanOpenWindows('__proto__' as never)).toBe(false)
    expect(HOST_CLIENT_KINDS).toEqual(['cli', 'tui'])
  })

  it('enums are unique', () => {
    for (const list of [VAULT_STATES, VAULT_CUSTODY_SCHEMES, INSTALL_CHANNELS] as readonly (readonly string[])[]) {
      expect(new Set(list).size).toBe(list.length)
    }
    expect(INSTALL_CHANNELS).toEqual(['npm', 'app', 'archive', 'dev'])
  })
})

describe('CLI and host contracts (cli-spec Wave 0)', () => {
  const existing = new Set<string>([IPC, TEMPLATE_ENGAGEMENT_IPC, KNOWLEDGE_IPC, MCP_SCOPE_IPC, KIT_IPC].flatMap((o) => Object.values(o)))

  it('HOST_IPC values are unique and collide with no IPC channel', () => {
    const names = Object.values(HOST_IPC)
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) expect(existing.has(n)).toBe(false)
    expect(Object.values(IPC)).not.toContain('runs:subscribe')
  })

  it('RPC_BULK_CHANNELS are unique and every one is a known channel', () => {
    expect(new Set(RPC_BULK_CHANNELS).size).toBe(RPC_BULK_CHANNELS.length)
    const known = new Set<string>([...existing, ...Object.values(HOST_IPC)])
    for (const c of RPC_BULK_CHANNELS) expect(known.has(c)).toBe(true)
  })

  it('EXEC_OUTCOME_EXIT_CODE covers every EXEC_OUTCOMES entry', () => {
    expect(new Set(EXEC_OUTCOMES).size).toBe(EXEC_OUTCOMES.length)
    expect(Object.keys(EXEC_OUTCOME_EXIT_CODE).sort()).toEqual([...EXEC_OUTCOMES].sort())
    for (const o of EXEC_OUTCOMES) expect(Number.isInteger(EXEC_OUTCOME_EXIT_CODE[o])).toBe(true)
    expect(EXEC_OUTCOME_EXIT_CODE).toMatchObject({ completed: 0, 'completed-unplanned': 0, 'rate-limited': 4, 'auth-error': 5, failed: 1, stalled: 1, interrupted: 130 })
    for (const o of ['unmerged-conflicts', 'blocked', 'incomplete-plan', 'needs-decision', 'budget-exceeded'] as const) expect(EXEC_OUTCOME_EXIT_CODE[o]).toBe(3)
  })

  it('DEFAULT_HEADLESS_DECISION_POLICY matches the spec defaults', () => {
    expect(DEFAULT_HEADLESS_DECISION_POLICY).toEqual({
      permission: 'deny',
      rules: 'deny',
      mcpInstall: 'deny',
      question: 'fail',
      proposal: 'decline',
      merge: 'hold',
      maxAutoDenials: 5,
      waitTimeoutMs: 900_000,
      humanGraceMs: 60_000
    })
    expect(DEFAULT_EXEC_STALL_TIMEOUT_MS).toBe(300_000)
    expect(HOST_SCOPES).toEqual(['read', 'operate', 'decide', 'configure'])
  })
})
