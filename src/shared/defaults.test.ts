import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_SETTINGS, creationConnection, defaultRoles, libraryEntryFromSpec, linkedSpec, mcpSupportsOAuth, newId, newProject, rootRole, slugify, importTierForModel, tierForModel, modelFamily } from './defaults'
import type { McpLibraryEntry } from './types'
import { PERMISSION_MODE_OPTIONS, PERMISSION_MODES, TOOL_CATALOG, isPermissionMode } from './types'

describe('creationConnection', () => {
  const withConn = (defaultConnection: 'anthropic' | 'openai' | 'litellm', over: { openai?: boolean; litellm?: Record<string, unknown> } = {}) => {
    const c = structuredClone(DEFAULT_APP_SETTINGS.connections)
    if (over.openai !== undefined) c.openai.enabled = over.openai
    if (over.litellm) Object.assign(c.litellm, over.litellm)
    return { defaultConnection, connections: c }
  }
  const ready = { enabled: true, baseUrl: 'http://localhost:4000', hasApiKey: true }

  it('anthropic is always usable', () => {
    expect(creationConnection(withConn('anthropic'))).toBe('anthropic')
    expect(creationConnection(undefined)).toBe('anthropic')
  })
  it('openai needs to be enabled', () => {
    expect(creationConnection(withConn('openai', { openai: true }))).toBe('openai')
    expect(creationConnection(withConn('openai', { openai: false }))).toBe('anthropic')
  })
  it('litellm needs enabled, a base URL and an API key', () => {
    expect(creationConnection(withConn('litellm', { litellm: ready }))).toBe('litellm')
    expect(creationConnection(withConn('litellm', { litellm: { ...ready, enabled: false } }))).toBe('anthropic')
    expect(creationConnection(withConn('litellm', { litellm: { ...ready, baseUrl: ' ' } }))).toBe('anthropic')
    expect(creationConnection(withConn('litellm', { litellm: { ...ready, hasApiKey: false } }))).toBe('anthropic')
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
    expect(bare.maxConcurrentSubagents).toBe(8)
    expect(bare.maxSubagentDepth).toBe(3)
    const fromSettings = newProject({ name: 'X', path: '/x', brief: '' }, DEFAULT_APP_SETTINGS)
    expect(DEFAULT_APP_SETTINGS.defaultPermissionMode).toBe('auto')
    expect(fromSettings.permissionMode).toBe('auto')
    expect(fromSettings.maxConcurrentSubagents).toBe(8)
    expect(fromSettings.maxSubagentDepth).toBe(3)
    expect(newProject({ name: 'X', path: '/x', brief: '' }, { ...DEFAULT_APP_SETTINGS, defaultPermissionMode: 'dontAsk' }).permissionMode).toBe('dontAsk')
  })
})

describe('permission modes', () => {
  it('lists every mode once, unattended first', () => {
    expect(PERMISSION_MODES[0]).toBe('auto')
    expect([...PERMISSION_MODES].sort()).toEqual(['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'])
    expect(PERMISSION_MODE_OPTIONS.find((o) => o.value === 'auto')?.label).toBe('Unattended: Claude decides each call, asks only when unsure')
    expect(PERMISSION_MODE_OPTIONS.find((o) => o.value === 'dontAsk')?.label).toBe('Never ask: deny anything that would need approval')
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
