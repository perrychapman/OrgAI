import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_SETTINGS, connectionConfigured, connectionIds, connectionName, connectionProviderLabel, connectionRecord, connectionInUse, isConnectionId, isKnownConnection, proxyModelFamily, proxyModelsUrl, proxyOf, proxyOpenAIBase, creationConnection, effectiveSubagentLimits, planGuardOf, defaultRoles, libraryEntryFromSpec, linkedSpec, mcpSupportsOAuth, newId, newProject, rootRole, slugify, importTierForModel, tierForModel, modelFamily, modelForTier, resolveModelSetting, settingTier, preferEverydayNearLimit, quickRunTools, quickRunPermissionMode, QUICK_ASSISTANT_SLUG, singleRunProject } from './defaults'
import type { Project, ProviderModel, ProxyConnection } from './types'
import { RUN_KIND_LABELS, VIRTUAL_PROJECT_IDS, VIRTUAL_PROJECT_LABELS, isVirtualProjectId } from './types'
import { isSafeId, cleanRequiredReports } from './defaults'
import type { Role } from './types'

describe('virtual projects (Assistants)', () => {
  it('recognises exactly the three virtual ids, which still pass SAFE_ID', () => {
    expect([...VIRTUAL_PROJECT_IDS]).toEqual(['harness', 'quick', 'skills'])
    for (const id of VIRTUAL_PROJECT_IDS) {
      expect(isVirtualProjectId(id)).toBe(true)
      expect(isSafeId(id)).toBe(true)
      expect(VIRTUAL_PROJECT_LABELS[id]).toBeTruthy()
    }
    for (const id of ['', 'Quick', 'harness ', 'project-1', 'skill']) expect(isVirtualProjectId(id)).toBe(false)
    expect(VIRTUAL_PROJECT_LABELS).toEqual({ harness: 'MCP assistant', quick: 'Chat', skills: 'Skill assistant' })
  })

  it('labels every run kind in plain words', () => {
    expect(RUN_KIND_LABELS).toEqual({ work: 'Run', setup: 'Setup', 'mcp-assist': 'MCP assistant', 'skill-assist': 'Skill assistant' })
  })
})

describe('tier-based model defaults', () => {
  const catalog: ProviderModel[] = [
    { id: 'gpt-x-mini', label: 'm', connection: 'openai', family: 'openai', adapter: 'codex', tier: 'everyday', source: 'discovered' },
    { id: 'gpt-x-old', label: 'o', connection: 'openai', family: 'openai', adapter: 'codex', tier: 'deep', source: 'discovered' },
    { id: 'gpt-x', label: 'x', connection: 'openai', family: 'openai', adapter: 'codex', tier: 'deep', source: 'discovered', recommended: true }
  ]

  it('maps a tier through the connection, then its catalog suggestion (recommended first), then the nearest tier', () => {
    expect(modelForTier('deep', { connection: 'openai', tierModels: { deep: 'chosen' }, catalog })).toEqual({ model: 'chosen', tier: 'deep' })
    expect(modelForTier('deep', { connection: 'openai', tierModels: {}, catalog })).toEqual({ model: 'gpt-x', tier: 'deep' })
    expect(modelForTier('fast', { connection: 'openai', tierModels: {}, catalog })).toEqual({ model: 'gpt-x-mini', tier: 'everyday' })
    expect(modelForTier('deep', { connection: 'litellm', tierModels: {}, catalog: [] })).toBeUndefined()
    expect(modelForTier('deep', { connection: 'anthropic', tierModels: {} })).toEqual({ model: 'opus', tier: 'deep' })
  })

  it('resolves model settings: tiers, legacy aliases as tiers, concrete ids kept', () => {
    expect(settingTier('Deep')).toBe('deep')
    expect(settingTier('opus')).toBe('deep')
    expect(settingTier('gpt-5')).toBeUndefined()
    expect(resolveModelSetting('deep', { connection: 'litellm', tierModels: { deep: 'my-big' } })).toEqual({ model: 'my-big', tier: 'deep' })
    expect(resolveModelSetting('opus', { connection: 'litellm', tierModels: { deep: 'my-big' } })).toEqual({ model: 'my-big', tier: 'deep' })
    expect(resolveModelSetting('deep', { connection: 'litellm', tierModels: {} })).toBeUndefined()
    expect(resolveModelSetting('gpt-x', { connection: 'openai', tierModels: {}, catalog })).toEqual({ model: 'gpt-x', tier: 'deep' })
    expect(resolveModelSetting('inherit', { connection: 'openai', tierModels: {} })).toEqual({ model: 'inherit' })
  })

  it('builds the default chart from tiers on the given connection', () => {
    const roles = defaultRoles({ connection: 'litellm', tierModels: { deep: 'big', everyday: 'mid', fast: 'small' } })
    expect(roles.map((r) => [r.model, r.tier])).toEqual([['big', 'deep'], ['mid', 'everyday'], ['mid', 'everyday'], ['small', 'fast']])
    expect(defaultRoles({ connection: 'litellm', tierModels: {} }).every((r) => r.model === 'inherit' && !r.tier)).toBe(true)
  })

  it('new projects take tier settings through the anthropic tier mapping', () => {
    const anthropic = { ...DEFAULT_APP_SETTINGS.connections.anthropic, tierModels: { deep: 'claude-opus-9', everyday: 'sonnet' } }
    const settings = { ...DEFAULT_APP_SETTINGS, connections: { ...DEFAULT_APP_SETTINGS.connections, anthropic } }
    const p = newProject({ name: 'x', path: '/x', brief: '' }, settings)
    expect(p.roles[0]).toMatchObject({ model: 'claude-opus-9', tier: 'deep' })
    expect(p.roles[1]).toMatchObject({ model: 'sonnet', tier: 'everyday' })
    expect(p.preferEverydayNearLimit).toBeUndefined()
  })

  it('reads the near-limit flag with the legacy field as fallback', () => {
    expect(preferEverydayNearLimit({ preferSonnetNearLimit: true })).toBe(true)
    expect(preferEverydayNearLimit({ preferEverydayNearLimit: false, preferSonnetNearLimit: true })).toBe(false)
    expect(preferEverydayNearLimit(undefined)).toBe(false)
  })
})
import type { McpLibraryEntry } from './types'
import { PERMISSION_MODE_OPTIONS, PERMISSION_MODES, TOOL_CATALOG, isPermissionMode } from './types'

const proxyRec = (over: Partial<ProxyConnection> = {}): ProxyConnection => ({
  id: 'litellm',
  name: 'Gateway',
  kind: 'litellm',
  anthropicBaseUrl: 'http://localhost:4000',
  enabled: true,
  hasApiKey: true,
  tierModels: {},
  ...over
})

describe('creationConnection', () => {
  const withConn = (defaultConnection: string, over: { openai?: boolean; proxy?: Partial<ProxyConnection> } = {}) => {
    const c = structuredClone(DEFAULT_APP_SETTINGS.connections)
    if (over.openai !== undefined) c.openai.enabled = over.openai
    return { defaultConnection, connections: c, proxies: over.proxy ? [proxyRec(over.proxy)] : [] }
  }

  it('anthropic is always usable', () => {
    expect(creationConnection(withConn('anthropic'))).toBe('anthropic')
    expect(creationConnection(undefined)).toBe('anthropic')
  })
  it('openai needs to be enabled', () => {
    expect(creationConnection(withConn('openai', { openai: true }))).toBe('openai')
    expect(creationConnection(withConn('openai', { openai: false }))).toBe('anthropic')
  })
  it('a proxy needs enabled, a base URL and an API key, and must exist', () => {
    expect(creationConnection(withConn('litellm', { proxy: {} }))).toBe('litellm')
    expect(creationConnection(withConn('litellm', { proxy: { enabled: false } }))).toBe('anthropic')
    expect(creationConnection(withConn('litellm', { proxy: { anthropicBaseUrl: ' ' } }))).toBe('anthropic')
    expect(creationConnection(withConn('litellm', { proxy: { hasApiKey: false } }))).toBe('anthropic')
    expect(creationConnection(withConn('proxy-0a1b2c3d', { proxy: {} }))).toBe('anthropic')
    expect(creationConnection(withConn('proxy-0a1b2c3d', { proxy: { id: 'proxy-0a1b2c3d' } }))).toBe('proxy-0a1b2c3d')
  })
})

describe('connectionInUse', () => {
  const settings = (defaultConnection: string, enabled: { openai?: boolean; litellm?: boolean } = {}) => {
    const c = structuredClone(DEFAULT_APP_SETTINGS.connections)
    c.openai.enabled = enabled.openai ?? false
    return { defaultConnection, connections: c, proxies: [proxyRec({ enabled: enabled.litellm ?? false })] }
  }
  const on = (connection: string) => ({ provider: { id: 'claude' as const, label: 'x', auth: { kind: 'subscription' as const }, connection } })
  const mock = { provider: { id: 'mock' as const, label: 'Mock', auth: { kind: 'subscription' as const } } }
  const legacyCodex = { provider: { id: 'codex' as const, label: 'Codex', auth: { kind: 'subscription' as const } } }

  it('an enabled connection is in use as the default or through a project', () => {
    expect(connectionInUse('openai', settings('openai', { openai: true }), [])).toBe(true)
    expect(connectionInUse('openai', settings('anthropic', { openai: true }), [on('anthropic'), on('openai')])).toBe(true)
    expect(connectionInUse('litellm', settings('anthropic', { litellm: true }), [on('litellm')])).toBe(true)
    expect(connectionInUse('openai', settings('anthropic', { openai: true }), [legacyCodex])).toBe(true) // saved before connections
  })
  it('an enabled connection nothing uses is not in use', () => {
    expect(connectionInUse('openai', settings('anthropic', { openai: true }), [on('anthropic'), mock])).toBe(false)
    expect(connectionInUse('litellm', settings('openai', { openai: true, litellm: true }), [on('openai')])).toBe(false)
  })
  it('a disabled connection is never in use', () => {
    expect(connectionInUse('openai', settings('openai'), [on('openai')])).toBe(false)
    expect(connectionInUse('litellm', settings('litellm'), [on('litellm')])).toBe(false)
  })
  it('anthropic counts as enabled; mock projects are on anthropic', () => {
    const s = settings('openai', { openai: true })
    s.connections.anthropic.enabled = false
    expect(connectionInUse('anthropic', s, [])).toBe(false)
    expect(connectionInUse('anthropic', s, [mock])).toBe(true)
    expect(connectionInUse('anthropic', settings('anthropic'), [])).toBe(true)
  })
})

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

describe('run defaults', () => {
  it('starts new projects unattended with room for parallel, layered work', () => {
    const bare = newProject({ name: 'X', path: '/x', brief: '' })
    expect(bare.permissionMode).toBe('auto')
    // Subagent limits are automatic: nothing is stored, effectiveSubagentLimits derives them from the chart.
    expect(bare.maxConcurrentSubagents).toBeUndefined()
    expect(bare.maxSubagentDepth).toBeUndefined()
    expect(effectiveSubagentLimits(bare)).toEqual({ depth: 2, concurrency: 8, explicit: { depth: false, concurrency: false } })
    const fromSettings = newProject({ name: 'X', path: '/x', brief: '' }, DEFAULT_APP_SETTINGS)
    expect(DEFAULT_APP_SETTINGS.defaultPermissionMode).toBe('auto')
    expect(fromSettings.permissionMode).toBe('auto')
    expect(fromSettings.maxConcurrentSubagents).toBeUndefined()
    expect(fromSettings.maxSubagentDepth).toBeUndefined()
    expect(fromSettings.preferEverydayNearLimit).toBeUndefined()
    expect(fromSettings.preferSonnetNearLimit).toBeUndefined()
    expect(planGuardOf(fromSettings)).toBe('auto')
    // The deprecated app default no longer reaches new projects.
    expect(newProject({ name: 'X', path: '/x', brief: '' }, { ...DEFAULT_APP_SETTINGS, defaultPreferEverydayNearLimit: true }).preferEverydayNearLimit).toBeUndefined()
    expect(newProject({ name: 'X', path: '/x', brief: '' }, { ...DEFAULT_APP_SETTINGS, defaultPermissionMode: 'dontAsk' }).permissionMode).toBe('dontAsk')
    // An engagement starts on 'default' whatever the app default is; code keeps the app default.
    const auto = { ...DEFAULT_APP_SETTINGS, defaultPermissionMode: 'auto' as const }
    expect(newProject({ name: 'X', path: '/x', brief: '', kind: 'engagement' }, auto).permissionMode).toBe('default')
    expect(newProject({ name: 'X', path: '/x', brief: '', kind: 'engagement' }).permissionMode).toBe('default')
    expect(newProject({ name: 'X', path: '/x', brief: '' }, auto).permissionMode).toBe('auto')
  })
})

describe('permission modes', () => {
  it('lists every mode once, unattended first', () => {
    expect(PERMISSION_MODES[0]).toBe('auto')
    expect([...PERMISSION_MODES].sort()).toEqual(['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'])
    expect(PERMISSION_MODE_OPTIONS.find((o) => o.value === 'auto')?.label).toBe("Unattended: the model's safety check approves routine calls and asks when unsure")
    expect(PERMISSION_MODE_OPTIONS.find((o) => o.value === 'dontAsk')?.label).toBe('Never ask: deny anything that would need approval')
  })

  it('names no vendor or model in any label', () => {
    for (const o of PERMISSION_MODE_OPTIONS) expect(o.label).not.toMatch(/claude|codex|anthropic|openai|gpt|opus|sonnet/i)
  })

  it('recognizes modes', () => {
    expect(isPermissionMode('auto')).toBe(true)
    expect(isPermissionMode('dontAsk')).toBe(true)
    expect(isPermissionMode('yolo')).toBe(false)
    expect(isPermissionMode(undefined)).toBe(false)
  })

  it('offers the messaging tools in the catalog', () => {
    expect(TOOL_CATALOG).toContain('SendMessage')
    expect(TOOL_CATALOG).toContain('ListAgents')
  })
})

describe('MCP library links', () => {
  const entry: McpLibraryEntry = {
    id: 'mcpl_1',
    name: 'github',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    source: 'registry',
    oauth: { clientId: 'abc', clientSource: 'manual' },
    addedAt: '2026-01-01T00:00:00.000Z'
  }

  it('builds the project copy from the entry plus project-owned fields', () => {
    const spec = linkedSpec(entry, { id: 'mcp_9', enabled: false, roles: ['dev'], addedAt: '2026-02-02T00:00:00.000Z' })
    expect(spec).toMatchObject({ id: 'mcp_9', libraryId: 'mcpl_1', source: 'library', enabled: false, roles: ['dev'], name: 'github', url: entry.url, addedAt: '2026-02-02T00:00:00.000Z' })
    expect(spec.oauth).toEqual(entry.oauth)
    expect(linkedSpec(entry, { id: 'mcp_9', enabled: true, addedAt: 'x' }).roles).toBeUndefined()
  })

  it('turns a project server into a library entry without project fields', () => {
    const spec = linkedSpec(entry, { id: 'mcp_9', enabled: true, roles: ['dev'], addedAt: 'x' })
    const back = libraryEntryFromSpec(spec, 'mcpl_2')
    expect(back).not.toHaveProperty('enabled')
    expect(back).not.toHaveProperty('roles')
    expect(back).not.toHaveProperty('libraryId')
    expect(back).toMatchObject({ id: 'mcpl_2', source: 'user', name: 'github' })
  })

  it('offers OAuth on remote transports only', () => {
    expect(mcpSupportsOAuth({ transport: 'http' })).toBe(true)
    expect(mcpSupportsOAuth({ transport: 'sse' })).toBe(true)
    expect(mcpSupportsOAuth({ transport: 'stdio' })).toBe(false)
  })
})

describe('importTierForModel', () => {
  it('maps Claude aliases, full ids, prefixes and the [1m] suffix', () => {
    expect(importTierForModel('fable')).toBe('top')
    expect(importTierForModel('best')).toBe('top')
    expect(importTierForModel('opus')).toBe('deep')
    expect(importTierForModel('opusplan')).toBe('deep')
    expect(importTierForModel('sonnet[1m]')).toBe('everyday')
    expect(importTierForModel('claude-sonnet-4-5[1m]')).toBe('everyday')
    expect(importTierForModel('anthropic/claude-haiku-4-5')).toBe('fast')
    expect(importTierForModel('bedrock/anthropic.claude-opus-4-1')).toBe('deep')
  })
  it('uses OpenAI and Gemini naming heuristics', () => {
    expect(importTierForModel('openai/gpt-5-nano')).toBe('fast')
    expect(importTierForModel('gpt-5-mini')).toBe('everyday')
    expect(importTierForModel('o4-mini')).toBe('everyday')
    expect(importTierForModel('gpt-5-pro')).toBe('top')
    expect(importTierForModel('gpt-5.1-codex-max')).toBe('top')
    expect(importTierForModel('gpt-5')).toBe('deep')
    expect(importTierForModel('o3')).toBe('deep')
    expect(importTierForModel('google/gemini-2.5-pro')).toBe('deep')
    expect(importTierForModel('gemini-2.5-flash')).toBe('everyday')
    expect(importTierForModel('gemini-2.5-flash-lite')).toBe('fast')
  })
  it('gives undefined for inherit, empty and unknown ids', () => {
    expect(importTierForModel('inherit')).toBeUndefined()
    expect(importTierForModel('')).toBeUndefined()
    expect(importTierForModel(42)).toBeUndefined()
    expect(importTierForModel('llama-3-70b')).toBeUndefined()
  })
  it('tierForModel keeps its behaviour and now tolerates the [1m] suffix', () => {
    expect(tierForModel('opus[1m]')).toBe('deep')
    expect(tierForModel('gpt-5')).toBeUndefined()
    expect(tierForModel('best')).toBeUndefined()
    expect(modelFamily('sonnet[1m]')).toBe('claude')
  })
})

describe('quick run tools and permissions', () => {
  it('gives the single assistant read, web and edit tools: edits ask instead of being missing', () => {
    expect(quickRunTools('single')).toEqual({ [QUICK_ASSISTANT_SLUG]: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Edit', 'Write', 'Bash', 'NotebookEdit'] })
  })

  it('gives each default role its own tools for the default team', () => {
    const t = quickRunTools('default')
    expect(Object.keys(t).sort()).toEqual(['implementer', 'orchestrator', 'researcher', 'reviewer'])
    for (const role of defaultRoles()) expect(t[role.slug]).toEqual(role.tools)
  })

  it('always uses permission mode default', () => {
    expect(quickRunPermissionMode(false)).toBe('default')
    expect(quickRunPermissionMode(true)).toBe('default')
  })

  it('defaults the assistant models', () => {
    expect(DEFAULT_APP_SETTINGS.skillAssistModel).toBe('deep')
    expect(DEFAULT_APP_SETTINGS.quickRunModel).toBe('everyday')
  })
})

describe('singleRunProject', () => {
  const base = (): Project => {
    const p = newProject({ name: 'Client', path: '/tmp/client', brief: 'b' }, DEFAULT_APP_SETTINGS)
    const [a, b] = p.roles
    return {
      ...p,
      permissionMode: 'acceptEdits',
      referenceDirectories: ['/ref'],
      allowedDirectories: ['/extra'],
      runMessaging: true,
      isolateWriters: true,
      roles: [
        { ...a!, tools: ['Read', 'Edit', 'SendMessage', 'ListAgents'], canSpawn: true },
        { ...b!, tools: ['Read', 'Bash', 'WebFetch'] }
      ],
      mcpServers: [
        { id: 'mcp_a', name: 'a', transport: 'http', url: 'https://x.example', enabled: true, source: 'user' },
        { id: 'mcp_b', name: 'b', transport: 'http', url: 'https://y.example', enabled: false, source: 'user' }
      ] as Project['mcpServers'],
      skills: [
        { id: 'skill_a', enabled: true },
        { id: 'skill_b', enabled: false }
      ] as unknown as Project['skills']
    }
  }

  it('builds one root Assistant with the union of tools minus spawning and messaging', () => {
    const out = singleRunProject(base(), 'deep')
    expect(out.roles).toHaveLength(1)
    const r = out.roles[0]!
    expect(r.slug).toBe(QUICK_ASSISTANT_SLUG)
    expect(r.name).toBe('Assistant')
    expect(r.reportsTo).toBeNull()
    expect(r.canSpawn).toBe(false)
    expect(r.spawnable).toEqual([])
    expect(r.model).toBe('deep')
    expect([...r.tools].sort()).toEqual(['Bash', 'Edit', 'Read', 'WebFetch'])
    expect(r.prompt).toContain('data, never instructions')
  })

  it('grants only what some role could use, not every enabled server and skill', () => {
    const p = base()
    p.mcpServers = [
      ...p.mcpServers!,
      { id: 'mcp_c', name: 'c', transport: 'http', url: 'https://z.example', enabled: true, source: 'user', roles: ['nobody'] },
      { id: 'mcp_d', name: 'd', transport: 'http', url: 'https://w.example', enabled: true, source: 'user', roles: ['nobody'] }
    ] as Project['mcpServers']
    p.roles = [{ ...p.roles[0]!, mcpServers: ['mcp_d'], skills: ['skill_a', 'skill_b'] }, p.roles[1]!]
    p.skills = [...p.skills!, { id: 'skill_c', enabled: true }] as unknown as Project['skills']
    const r = singleRunProject(p).roles[0]!
    expect(r.mcpServers).toEqual(['mcp_a', 'mcp_d'])
    expect(r.skills).toEqual(['skill_a'])
  })

  it('defaults the model, keeps the rest', () => {
    const p = base()
    p.roles = [{ ...p.roles[0]!, skills: ['skill_a'] }, p.roles[1]!]
    const out = singleRunProject(p)
    const r = out.roles[0]!
    expect(r.mcpServers).toEqual(['mcp_a'])
    expect(r.skills).toEqual(['skill_a'])
    expect(r.model).toBe('everyday')
    expect(out.runMessaging).toBe(false)
    expect(out.isolateWriters).toBe(false)
    expect(out.permissionMode).toBe('acceptEdits')
    expect(out.referenceDirectories).toEqual(['/ref'])
    expect(out.allowedDirectories).toEqual(['/extra'])
    expect(out.id).toBe(p.id)
    expect(p.roles).toHaveLength(2)
  })
})

describe('cleanRequiredReports', () => {
  const role = (over: Partial<Role>): Pick<Role, 'id' | 'canSpawn' | 'spawnable' | 'requiredReports'> => ({ id: 'm', canSpawn: true, spawnable: ['a', 'b'], ...over })
  it('keeps spawnable, non-self, unique ids in order', () => {
    expect(cleanRequiredReports(role({ requiredReports: ['b', 'x', 'a', 'b', 'm'] }))).toEqual(['b', 'a'])
    expect(cleanRequiredReports(role({ spawnable: ['a', 'm'], requiredReports: ['m', 'a'] }))).toEqual(['a'])
  })
  it('is undefined when empty, missing or the role cannot spawn', () => {
    expect(cleanRequiredReports(role({}))).toBeUndefined()
    expect(cleanRequiredReports(role({ requiredReports: [] }))).toBeUndefined()
    expect(cleanRequiredReports(role({ requiredReports: ['x'] }))).toBeUndefined()
    expect(cleanRequiredReports(role({ canSpawn: false, requiredReports: ['a'] }))).toBeUndefined()
  })
})
