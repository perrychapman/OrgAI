import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpLibraryEntry, McpLibraryInfo, McpServerSpec } from '@shared/types'
import { MCP_OVERRIDE_VALUE_MAX, USER_CONNECTOR_PRESETS_MAX } from '@shared/types'
import { CONNECTORS } from '@shared/connectors'
import { ProjectStore } from '../store/projects'
import { McpLibraryStore } from '../store/mcpLibrary'
import { SecretStore, mcpLibrarySecretKey } from '../store/secrets'
import { McpService } from './service'
import { ConnectorPresetStore } from './presets'

const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => b.toString().slice(4)
}
const NOW = Date.parse('2026-10-01T00:00:00.000Z')

let dir: string
let projects: ProjectStore
let secrets: SecretStore
let library: McpLibraryStore
let pid: string
let libEvents: McpLibraryInfo[][]

function build(mock = false, withStore = true): McpService {
  return new McpService({
    projects,
    secrets,
    library,
    now: () => NOW,
    openExternal: async () => {},
    onLibraryChanged: (e) => libEvents.push(e),
    ...(withStore ? { presets: new ConnectorPresetStore(join(dir, 'data')) } : {}),
    mock
  })
}

const httpVariant = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'api',
  label: 'API token',
  transport: 'http',
  url: 'https://mcp.acme.test/mcp',
  headers: { 'X-Region': 'eu' },
  readOnly: true,
  auth: { kind: 'token', header: 'Authorization', prefix: 'Bearer ', label: 'API token', help: 'Read scope.' },
  ...over
})
const stdioVariant = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'local',
  label: 'Local server',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@acme/mcp@1.2.3'],
  env: { ACME_REGION: 'eu' },
  readOnly: false,
  auth: { kind: 'token', header: 'ACME_KEY', label: 'API key', help: '' },
  ...over
})
const preset = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'acme-crm',
  name: 'Acme CRM',
  vendor: 'Acme',
  category: 'crm',
  description: 'Reads Acme records.',
  variants: [httpVariant(), stdioVariant()],
  defaultVariant: 'api',
  ...over
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-presets-svc-'))
  projects = new ProjectStore(join(dir, 'data'))
  secrets = new SecretStore(join(dir, 'data'), cipher)
  library = new McpLibraryStore(join(dir, 'data'))
  libEvents = []
  pid = projects.create({ name: 'p', path: join(dir, 'repo'), brief: '' }).id
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const infoOf = (svc: McpService, id: string) => svc.connectorsList().find((c) => c.connector.id === id)!

describe('wiring as index.ts does it', () => {
  it('a service built with only dataDir (no presets store) can save a preset', () => {
    const svc = new McpService({ projects, secrets, library, dataDir: join(dir, 'data'), openExternal: async () => {} })
    expect(svc.connectorPresetsUpsert(preset()).map((p) => p.id)).toEqual(['acme-crm'])
  })

  it('warns once at construction when dataDir is missing', async () => {
    const log = await import('../log')
    const warn = vi.spyOn(log.log, 'warn').mockImplementation(() => {})
    new McpService({ projects, secrets, library })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toMatch(/dataDir.*built MCP servers.*presets/)
    warn.mockClear()
    new McpService({ projects, secrets, library, dataDir: join(dir, 'data') })
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('connectorPresets list / upsert / remove', () => {
  it('stores, lists, edits and removes a preset and broadcasts', () => {
    const svc = build()
    expect(svc.connectorPresetsList()).toEqual([])
    const out = svc.connectorPresetsUpsert({ ...preset(), publisher: 'official', verified: true })
    expect(out.map((p) => p.id)).toEqual(['acme-crm'])
    expect(out[0]).toMatchObject({ publisher: 'user', verified: false })
    expect(libEvents).toHaveLength(1)
    expect(svc.connectorPresetsUpsert(preset({ name: 'Acme CRM 2' }))[0].name).toBe('Acme CRM 2')
    // survives a restart
    expect(build().connectorPresetsList().map((p) => p.name)).toEqual(['Acme CRM 2'])
    expect(svc.connectorPresetsRemove({ id: 'acme-crm' })).toEqual([])
    expect(libEvents).toHaveLength(3)
    expect(() => svc.connectorPresetsRemove({ id: 'acme-crm' })).toThrow('Custom connector not found.')
    expect(() => svc.connectorPresetsRemove({ id: 5 } as unknown as { id: string })).toThrow('Custom connector not found.')
  })

  it('refuses invalid input, curated ids and a missing store', () => {
    const svc = build()
    expect(() => svc.connectorPresetsUpsert(preset({ id: 'github' }))).toThrow('That id belongs to a built-in connector.')
    expect(() => svc.connectorPresetsUpsert('nope')).toThrow(/object/)
    expect(svc.connectorPresetsList()).toEqual([])
    const bare = build(false, false)
    expect(bare.connectorPresetsList()).toEqual([])
    expect(() => bare.connectorPresetsUpsert(preset())).toThrow('Custom connectors are not available.')
    expect(() => bare.connectorPresetsRemove({ id: 'acme-crm' })).toThrow('Custom connector not found.')
  })

  it('caps new presets but still lets an existing one be edited', () => {
    const svc = build()
    for (let i = 0; i < USER_CONNECTOR_PRESETS_MAX; i++) svc.connectorPresetsUpsert(preset({ id: `p-${i}`, name: `P ${i}` }))
    expect(() => svc.connectorPresetsUpsert(preset({ id: 'one-more' }))).toThrow(/at most 100/)
    expect(svc.connectorPresetsUpsert(preset({ id: 'p-3', name: 'Renamed' }))).toHaveLength(USER_CONNECTOR_PRESETS_MAX)
  })

  it('refuses removal while a library entry exists, then allows it', () => {
    const svc = build()
    svc.connectorPresetsUpsert(preset())
    svc.connectorsAdd({ connectorId: 'acme-crm' })
    expect(() => svc.connectorPresetsRemove({ id: 'acme-crm' })).toThrow('Acme CRM is in your MCP library. Remove it there first.')
    svc.libraryRemove({ libraryId: svc.libraryEntries()[0].id })
    expect(svc.connectorPresetsRemove({ id: 'acme-crm' })).toEqual([])
  })
})

describe('connectors:list with custom presets', () => {
  it('lists curated presets first, then custom ones in store order', () => {
    const svc = build()
    svc.connectorPresetsUpsert(preset({ id: 'zeta', name: 'Zeta' }))
    svc.connectorPresetsUpsert(preset({ id: 'alpha', name: 'Alpha' }))
    const list = svc.connectorsList()
    expect(list.slice(0, CONNECTORS.length).map((c) => c.connector.id)).toEqual(CONNECTORS.map((c) => c.id))
    expect(list.slice(0, CONNECTORS.length).some((c) => c.custom)).toBe(false)
    const custom = list.slice(CONNECTORS.length)
    expect(custom.map((c) => c.connector.id)).toEqual(['zeta', 'alpha'])
    expect(custom[0]).toMatchObject({ custom: true, state: 'available', connector: { publisher: 'user', status: 'stable', docsUrl: '' } })
    expect(custom[0].preset?.id).toBe('zeta')
  })

  it('a custom entry never shows on a curated tile, and the reverse', () => {
    const svc = build()
    svc.connectorPresetsUpsert(preset({ id: 'acme-crm' }))
    svc.connectorsAdd({ connectorId: 'acme-crm' })
    // A hand-made curated lookalike: an entry with a curated id but connectorCustom.
    library.save({ id: 'mcpl_fake', name: 'linear-fake', transport: 'http', url: 'https://x.test/mcp', source: 'user', addedAt: '2026-01-01T00:00:00.000Z', connectorId: 'linear', connectorCustom: true })
    expect(infoOf(svc, 'linear').state).toBe('available')
    expect(infoOf(svc, 'acme-crm').state).toBe('needsSetup')
  })
})

describe('connectors:add and setToken for custom presets', () => {
  it('adds an http token variant, stores the token in the header slot with its prefix', () => {
    const svc = build()
    svc.connectorPresetsUpsert(preset())
    const added = svc.connectorsAdd({ connectorId: 'acme-crm' })
    expect(added.entry).toMatchObject({
      name: 'acme-crm',
      transport: 'http',
      url: 'https://mcp.acme.test/mcp',
      headers: { 'X-Region': 'eu' },
      secretHeaders: ['Authorization'],
      connectorId: 'acme-crm',
      connectorVariant: 'api',
      connectorCustom: true
    })
    expect(infoOf(svc, 'acme-crm')).toMatchObject({ state: 'needsSetup', variant: 'api', custom: true })
    // Idempotent.
    expect(svc.connectorsAdd({ connectorId: 'acme-crm' }).entry.id).toBe(added.entry.id)
    expect(svc.libraryEntries()).toHaveLength(1)
    svc.connectorsSetToken({ connectorId: 'acme-crm', token: ' abc123 ' })
    expect(secrets.get(mcpLibrarySecretKey(added.entry.id, 'header', 'Authorization'))).toBe('Bearer abc123')
    const after = infoOf(svc, 'acme-crm')
    expect(after.state).toBe('connected')
    expect(after.connectedAt).toBe(NOW)
    expect(JSON.stringify(svc.connectorsList())).not.toContain('abc123')
    svc.connectorsSetToken({ connectorId: 'acme-crm', token: null })
    expect(secrets.has(mcpLibrarySecretKey(added.entry.id, 'header', 'Authorization'))).toBe(false)
    expect(infoOf(svc, 'acme-crm')).toMatchObject({ state: 'needsSetup' })
    expect(infoOf(svc, 'acme-crm').connectedAt).toBeUndefined()
  })

  it('adds a stdio token variant and writes the env slot', () => {
    const svc = build()
    svc.connectorPresetsUpsert(preset())
    const added = svc.connectorsAdd({ connectorId: 'acme-crm', variant: 'local' })
    expect(added.entry).toMatchObject({ transport: 'stdio', command: 'npx', args: ['-y', '@acme/mcp@1.2.3'], env: { ACME_REGION: 'eu' }, secretEnv: ['ACME_KEY'], connectorCustom: true })
    expect(added.entry.url).toBeUndefined()
    svc.connectorsSetToken({ connectorId: 'acme-crm', token: 'k-1' })
    expect(secrets.get(mcpLibrarySecretKey(added.entry.id, 'env', 'ACME_KEY'))).toBe('k-1')
    expect(secrets.has(mcpLibrarySecretKey(added.entry.id, 'header', 'ACME_KEY'))).toBe(false)
    expect(infoOf(svc, 'acme-crm').state).toBe('connected')
  })

  it('stamps connectedAt for a none variant and refuses a token for it', () => {
    const svc = build()
    svc.connectorPresetsUpsert(preset({ variants: [httpVariant({ id: 'open', auth: { kind: 'none' }, headers: undefined })], defaultVariant: 'open' }))
    const added = svc.connectorsAdd({ connectorId: 'acme-crm' })
    expect(added.entry.connectedAt).toBe(NOW)
    expect(infoOf(svc, 'acme-crm').state).toBe('connected')
    expect(() => svc.connectorsSetToken({ connectorId: 'acme-crm', token: 'x' })).toThrow(/needs no sign-in/)
  })

  it('switches the variant of an unconnected entry in place and keeps a connected one', () => {
    const svc = build()
    svc.connectorPresetsUpsert(preset())
    const a = svc.connectorsAdd({ connectorId: 'acme-crm' })
    svc.connectorsSetToken({ connectorId: 'acme-crm', token: 'tok' })
    // Connected: the variant stays.
    expect(svc.connectorsAdd({ connectorId: 'acme-crm', variant: 'local' }).entry.connectorVariant).toBe('api')
    svc.connectorsSetToken({ connectorId: 'acme-crm', token: null })
    const b = svc.connectorsAdd({ connectorId: 'acme-crm', variant: 'local' })
    expect(b.entry.id).toBe(a.entry.id)
    expect(b.entry).toMatchObject({ transport: 'stdio', command: 'npx', secretEnv: ['ACME_KEY'], connectorVariant: 'local', connectorCustom: true })
    expect(b.entry).not.toHaveProperty('url')
    expect(b.entry).not.toHaveProperty('headers')
    expect(b.entry).not.toHaveProperty('secretHeaders')
    // And back to http: the command side is gone.
    const c = svc.connectorsAdd({ connectorId: 'acme-crm', variant: 'api' })
    expect(c.entry).toMatchObject({ transport: 'http', url: 'https://mcp.acme.test/mcp', secretHeaders: ['Authorization'] })
    expect(c.entry).not.toHaveProperty('command')
    expect(c.entry).not.toHaveProperty('secretEnv')
  })

  it('refuses unknown ids and leaves curated behaviour alone', () => {
    const svc = build()
    expect(() => svc.connectorsAdd({ connectorId: 'nope' })).toThrow('Unknown connector.')
    expect(() => svc.connectorsSetToken({ connectorId: 'nope', token: 'x' })).toThrow('Unknown connector.')
    expect(() => svc.connectorsAdd({ connectorId: 5 } as unknown as { connectorId: string })).toThrow('Unknown connector.')
    expect(svc.connectorsAdd({ connectorId: 'linear' }).entry.connectorCustom).toBeUndefined()
  })

  it('a custom OAuth variant authorizes in mock mode with scopes only', async () => {
    const svc = build(true)
    svc.connectorPresetsUpsert(preset({ variants: [httpVariant({ id: 'sso', headers: undefined, auth: { kind: 'oauth', scopes: ['read'] } })], defaultVariant: 'sso' }))
    const added = svc.connectorsAdd({ connectorId: 'acme-crm' })
    expect(infoOf(svc, 'acme-crm').state).toBe('needsSetup')
    const status = await svc.authorize({ libraryId: added.entry.id })
    expect(status.state).toBe('authorized')
    const after = infoOf(svc, 'acme-crm')
    expect(after.state).toBe('connected')
    expect(after.library?.entry.oauth?.scopes).toEqual(['read'])
    const test = await svc.libraryTest({ libraryId: added.entry.id })
    expect(test.ok).toBe(true)
  })
})

describe('editing and removing the preset behind an entry', () => {
  it('an edit never rewrites the library entry', () => {
    const svc = build()
    svc.connectorPresetsUpsert(preset())
    const added = svc.connectorsAdd({ connectorId: 'acme-crm' })
    svc.connectorsSetToken({ connectorId: 'acme-crm', token: 'tok' })
    const before = library.get(added.entry.id)!
    svc.connectorPresetsUpsert(preset({ name: 'Acme Renamed', variants: [httpVariant({ url: 'https://mcp.acme.test/v2' }), stdioVariant()] }))
    expect(library.get(added.entry.id)).toEqual(before)
    expect(secrets.get(mcpLibrarySecretKey(added.entry.id, 'header', 'Authorization'))).toBe('Bearer tok')
    expect(infoOf(svc, 'acme-crm')).toMatchObject({ state: 'connected', connector: { name: 'Acme Renamed' } })
  })

  it('derives the state from the entry when its variant left the preset', () => {
    const svc = build(true)
    svc.connectorPresetsUpsert(preset())
    const added = svc.connectorsAdd({ connectorId: 'acme-crm' })
    // Variant "api" is dropped from the preset.
    svc.connectorPresetsUpsert(preset({ variants: [stdioVariant()], defaultVariant: 'local' }))
    expect(infoOf(svc, 'acme-crm')).toMatchObject({ state: 'needsSetup', variant: 'api' })
    expect(() => svc.connectorsSetToken({ connectorId: 'acme-crm', token: 'x' })).toThrow(/no longer has the variant/)
    // Secret set by the library route: connected.
    svc.librarySetSecret({ libraryId: added.entry.id, kind: 'header', name: 'Authorization', value: 'Bearer z' })
    expect(infoOf(svc, 'acme-crm').state).toBe('connected')
    // The entry no longer behaves as a connector: a plain library entry (mock test is not the connector's).
    expect(svc.libraryEntries()[0].connectorCustom).toBe(true)
  })

  it('derives an OAuth entry\'s state from its authorization', async () => {
    const svc = build(true)
    svc.connectorPresetsUpsert(preset({ variants: [httpVariant({ id: 'sso', headers: undefined, auth: { kind: 'oauth' } })], defaultVariant: 'sso' }))
    const added = svc.connectorsAdd({ connectorId: 'acme-crm' })
    await svc.authorize({ libraryId: added.entry.id })
    svc.connectorPresetsUpsert(preset({ variants: [stdioVariant()], defaultVariant: 'local' }))
    expect(infoOf(svc, 'acme-crm').state).toBe('connected')
  })

  it('a never-authorized OAuth entry whose variant left the preset is not connected', () => {
    const svc = build(true)
    svc.connectorPresetsUpsert(preset({ variants: [httpVariant({ id: 'sso', headers: undefined, auth: { kind: 'oauth' } })], defaultVariant: 'sso' }))
    svc.connectorsAdd({ connectorId: 'acme-crm' })
    svc.connectorPresetsUpsert(preset({ variants: [stdioVariant()], defaultVariant: 'local' }))
    expect(infoOf(svc, 'acme-crm').state).toBe('needsSetup')
  })

  it('a removed preset leaves the entry a plain library entry that no tile shows', () => {
    const svc = build()
    svc.connectorPresetsUpsert(preset())
    const added = svc.connectorsAdd({ connectorId: 'acme-crm' })
    // Remove the preset behind the service's back (the store, not the guarded method).
    new ConnectorPresetStore(join(dir, 'data')).remove('acme-crm')
    const fresh = build()
    expect(fresh.connectorsList().some((c) => c.connector.id === 'acme-crm')).toBe(false)
    expect(fresh.libraryEntries().map((e) => e.id)).toEqual([added.entry.id])
  })
})

describe('mcp:setProjectOverrides', () => {
  const vendor = (over: Partial<McpLibraryEntry> = {}): McpLibraryEntry => ({
    id: 'mcpl_s',
    name: 'vendor',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@x/vendor@1.0.0'],
    env: { BASE_URL: 'https://default.test' },
    secretEnv: ['VENDOR_KEY'],
    perProjectSecrets: true,
    perProjectEnv: ['BASE_URL', 'REGION'],
    source: 'user',
    addedAt: '2026-01-01T00:00:00.000Z',
    ...over
  })
  const remote = (): McpLibraryEntry => ({
    id: 'mcpl_h',
    name: 'remote',
    transport: 'http',
    url: 'https://remote.test/mcp',
    headers: { 'X-Tenant': 'default' },
    perProjectEnv: ['X-Tenant'],
    source: 'user',
    addedAt: '2026-01-01T00:00:00.000Z'
  })
  const link = (svc: McpService, libraryId: string): McpServerSpec => svc.linkLibrary({ projectId: pid, libraryId }).project.mcpServers!.find((s) => s.libraryId === libraryId)!

  it('replaces, keeps and clears, dropping names outside the list', () => {
    const svc = build()
    svc.libraryUpsert(vendor())
    const l = link(svc, 'mcpl_s')
    let r = svc.setProjectOverrides({ projectId: pid, serverId: l.id, env: { BASE_URL: 'https://a.test', REGION: 'eu', EVIL: 'x', NODE_OPTIONS: '--require x' } })
    expect(r.project.mcpServers![0].envOverrides).toEqual({ BASE_URL: 'https://a.test', REGION: 'eu' })
    expect(projects.get(pid)!.mcpServers![0].envOverrides).toEqual({ BASE_URL: 'https://a.test', REGION: 'eu' })
    // Omitted map keeps.
    r = svc.setProjectOverrides({ projectId: pid, serverId: l.id })
    expect(r.project.mcpServers![0].envOverrides).toEqual({ BASE_URL: 'https://a.test', REGION: 'eu' })
    // Replace.
    r = svc.setProjectOverrides({ projectId: pid, serverId: l.id, env: { BASE_URL: 'https://b.test' } })
    expect(r.project.mcpServers![0].envOverrides).toEqual({ BASE_URL: 'https://b.test' })
    // The resolved server picks it up.
    expect(svc.resolve(pid, projects.get(pid)!.mcpServers![0]).env.BASE_URL).toBe('https://b.test')
    // {} clears, with no empty object stored.
    r = svc.setProjectOverrides({ projectId: pid, serverId: l.id, env: {} })
    expect(r.project.mcpServers![0]).not.toHaveProperty('envOverrides')
    expect('envOverrides' in projects.get(pid)!.mcpServers![0]).toBe(false)
    expect(svc.resolve(pid, projects.get(pid)!.mcpServers![0]).env.BASE_URL).toBe('https://default.test')
  })

  it('uses headers for http entries and refuses the wrong map', () => {
    const svc = build()
    svc.libraryUpsert(remote())
    svc.libraryUpsert(vendor())
    const h = link(svc, 'mcpl_h')
    const s = link(svc, 'mcpl_s')
    const r = svc.setProjectOverrides({ projectId: pid, serverId: h.id, headers: { 'X-Tenant': 'acme', Authorization: 'Bearer x' } })
    expect(r.project.mcpServers!.find((x) => x.id === h.id)!.headerOverrides).toEqual({ 'X-Tenant': 'acme' })
    expect(() => svc.setProjectOverrides({ projectId: pid, serverId: h.id, env: {} })).toThrow('This server takes headers, not env.')
    expect(() => svc.setProjectOverrides({ projectId: pid, serverId: s.id, headers: { 'X-Tenant': 'a' } })).toThrow('This server takes env, not headers.')
    expect(() => svc.setProjectOverrides({ projectId: pid, serverId: h.id, headers: { 'X-Tenant': 'a\r\nHost: evil' } })).toThrow(/single line/)
  })

  it('refuses bad values without echoing them', () => {
    const svc = build()
    svc.libraryUpsert(vendor())
    const l = link(svc, 'mcpl_s')
    expect(() => svc.setProjectOverrides({ projectId: pid, serverId: l.id, env: { BASE_URL: 'https://a\nb' } })).toThrow(/control or hidden/)
    expect(() => svc.setProjectOverrides({ projectId: pid, serverId: l.id, env: { BASE_URL: 'x'.repeat(MCP_OVERRIDE_VALUE_MAX + 1) } })).toThrow(/too long/)
    let message = ''
    try {
      svc.setProjectOverrides({ projectId: pid, serverId: l.id, env: { BASE_URL: 'topsecret‮' } })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).not.toBe('')
    expect(message).not.toContain('topsecret')
    expect(projects.get(pid)!.mcpServers![0].envOverrides).toBeUndefined()
  })

  it('refuses a project-only server, a missing link and a removed entry', () => {
    const svc = build()
    projects.save({
      ...projects.get(pid)!,
      mcpServers: [{ id: 'mcp-own', name: 'own', transport: 'stdio', command: 'npx', args: ['-y', 'own@1.0.0'], enabled: true, source: 'user', addedAt: '2026-01-01T00:00:00.000Z' }]
    })
    expect(() => svc.setProjectOverrides({ projectId: pid, serverId: 'mcp-own', env: {} })).toThrow('own is project-only: edit its env and headers directly.')
    expect(() => svc.setProjectOverrides({ projectId: pid, serverId: 'nope', env: {} })).toThrow('MCP server not found')
    expect(() => svc.setProjectOverrides({ projectId: 'nope', serverId: 'x', env: {} })).toThrow('Project not found')
    svc.libraryUpsert(vendor())
    const l = link(svc, 'mcpl_s')
    library.remove('mcpl_s')
    expect(() => svc.setProjectOverrides({ projectId: pid, serverId: l.id, env: {} })).toThrow('vendor was removed from your MCP library.')
  })
})
