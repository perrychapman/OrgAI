/**
 * McpService and the Wave 7 secret vault (cli-standalone.md 5.4-5.6, round 6 items 4 and 10): explicit clears ask the
 * store first, moves refuse unreadable slots before changing anything, installs store secrets before other stores,
 * OAuth commits wait for prepareWrite and re-read the owner, refreshes prepare before the request and the writes, and
 * status displays say why a value cannot be read. A FixtureVaultStore stands in for the vault; no custodian, no network.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpLibraryEntry, McpServerSpec, Project } from '@shared/types'
import { ProjectStore } from '../store/projects'
import { McpLibraryStore } from '../store/mcpLibrary'
import { mcpLibraryOAuthKey, mcpLibrarySecretKey, mcpOAuthKey, mcpSecretKey } from '../store/secrets'
import { FixtureVaultStore } from '../store/vaultStore.fixture'
import { VAULT_MESSAGES } from '../store/vaultTypes'
import { McpService } from './service'

vi.mock('../log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

const NOW = Date.parse('2026-06-01T00:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()
const PENDING = VAULT_MESSAGES.pendingLegacy

let dir: string
let projects: ProjectStore
let secrets: FixtureVaultStore
let library: McpLibraryStore
let svc: McpService
let pid: string
const runAuthorization = vi.fn()
const refreshTokens = vi.fn()

const spec = (over: Partial<McpServerSpec> = {}): McpServerSpec => ({
  id: 'mcp-1',
  name: 'github',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@x/github@1.4.2'],
  secretEnv: ['GITHUB_TOKEN'],
  enabled: true,
  source: 'user',
  addedAt: '2026-01-01T00:00:00.000Z',
  ...over
})

const remote = (over: Partial<McpLibraryEntry> = {}): McpLibraryEntry => ({
  id: 'mcpl_1',
  name: 'docs',
  transport: 'http',
  url: 'https://docs.test/mcp',
  source: 'user',
  addedAt: '2026-01-01T00:00:00.000Z',
  ...over
})

const flow = (over: Record<string, unknown> = {}) => ({
  config: { resource: 'https://docs.test/mcp', tokenEndpoint: 'https://as.test/token', clientId: 'cid', clientSource: 'dcr' as const, hasClientSecret: true, authorizedAt: iso(NOW), expiresAt: iso(NOW + 3_600_000) },
  tokens: { accessToken: 'AT-1', refreshToken: 'RT-1', expiresAt: iso(NOW + 3_600_000) },
  clientSecret: 'CS-1',
  ...over
})

function build(opts: { lazy?: boolean; mock?: boolean } = {}): void {
  secrets = new FixtureVaultStore(join(dir, 'data'), { lazy: opts.lazy })
  svc = new McpService({
    projects,
    secrets,
    library,
    now: () => NOW,
    openExternal: async () => {},
    oauth: { runAuthorization, refreshTokens },
    ...(opts.mock ? { mock: true } : {})
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-mcpvault-'))
  projects = new ProjectStore(join(dir, 'data'))
  library = new McpLibraryStore(join(dir, 'data'))
  runAuthorization.mockReset()
  refreshTokens.mockReset()
  build()
  pid = projects.create({ name: 'P', path: dir, brief: '' }).id
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const project = (): Project => projects.get(pid)!

describe('explicit clears ask the store first (5.5 Deletes)', () => {
  it('mcp:setSecret / mcpLibrary:setSecret with null or empty are refused before anything changes; values and removals are not', () => {
    svc.upsert({ projectId: pid, spec: spec() })
    svc.libraryUpsert({ ...remote(), secretHeaders: ['X-Key'] })
    const key = mcpSecretKey(pid, 'mcp-1', 'env', 'GITHUB_TOKEN')
    const libKey = mcpLibrarySecretKey('mcpl_1', 'header', 'X-Key')
    svc.setSecret({ projectId: pid, serverId: 'mcp-1', kind: 'env', name: 'GITHUB_TOKEN', value: 'v1' })
    svc.librarySetSecret({ libraryId: 'mcpl_1', kind: 'header', name: 'X-Key', value: 'k1' })
    secrets.clearRefusals.set(key, VAULT_MESSAGES.clearRefusedCorrupt)
    secrets.clearRefusals.set(libKey, VAULT_MESSAGES.clearRefusedLegacyOnly)
    for (const value of [null, '']) {
      expect(() => svc.setSecret({ projectId: pid, serverId: 'mcp-1', kind: 'env', name: 'GITHUB_TOKEN', value })).toThrow(VAULT_MESSAGES.clearRefusedCorrupt)
      expect(() => svc.librarySetSecret({ libraryId: 'mcpl_1', kind: 'header', name: 'X-Key', value })).toThrow(VAULT_MESSAGES.clearRefusedLegacyOnly)
    }
    expect(secrets.get(key)).toBe('v1')
    expect(secrets.get(libKey)).toBe('k1')
    // A new value is never a clear; a removal never asks.
    svc.setSecret({ projectId: pid, serverId: 'mcp-1', kind: 'env', name: 'GITHUB_TOKEN', value: 'v2' })
    expect(secrets.get(key)).toBe('v2')
    svc.remove({ projectId: pid, serverId: 'mcp-1' })
    expect(secrets.has(key)).toBe(false)
  })

  it('connectors:setToken null and revokeAuth are refused with the store sentence; a clear the store allows goes through', async () => {
    const added = svc.connectorsAdd({ connectorId: 'zapier' })
    const id = added.entry.id
    svc.connectorsSetToken({ connectorId: 'zapier', token: 'tok-1' })
    const tokenKey = mcpLibrarySecretKey(id, 'header', added.entry.secretHeaders![0])
    secrets.clearRefusals.set(tokenKey, VAULT_MESSAGES.clearRefusedCorrupt)
    expect(() => svc.connectorsSetToken({ connectorId: 'zapier', token: null })).toThrow(VAULT_MESSAGES.clearRefusedCorrupt)
    expect(secrets.get(tokenKey)).toBe('Bearer tok-1')
    expect(svc.libraryList()[0].entry.connectedAt).toBeDefined()
    secrets.clearRefusals.clear()
    svc.connectorsSetToken({ connectorId: 'zapier', token: null })
    expect(secrets.has(tokenKey)).toBe(false)

    svc.libraryUpsert(remote())
    runAuthorization.mockResolvedValue(flow())
    await svc.authorize({ libraryId: 'mcpl_1' })
    secrets.clearRefusals.set(mcpLibraryOAuthKey('mcpl_1', 'refreshToken'), VAULT_MESSAGES.clearRefusedLegacyOnly)
    expect(() => svc.revokeAuth({ libraryId: 'mcpl_1' })).toThrow(VAULT_MESSAGES.clearRefusedLegacyOnly)
    expect(secrets.get(mcpLibraryOAuthKey('mcpl_1', 'accessToken'))).toBe('AT-1')
    expect(svc.authStatus({ libraryId: 'mcpl_1' }).state).toBe('authorized')
  })
})

describe('moves refuse unreadable secrets before any change (5.4)', () => {
  it('promote names the unreadable slot and changes nothing', () => {
    svc.upsert({ projectId: pid, spec: spec() })
    const key = mcpSecretKey(pid, 'mcp-1', 'env', 'GITHUB_TOKEN')
    svc.setSecret({ projectId: pid, serverId: 'mcp-1', kind: 'env', name: 'GITHUB_TOKEN', value: 'v1' })
    secrets.unreadable.set(key, PENDING)
    const before = JSON.stringify(project())
    expect(() => svc.promote({ projectId: pid, serverId: 'mcp-1' })).toThrow(VAULT_MESSAGES.moveRefused('GITHUB_TOKEN', 'github', PENDING))
    expect(JSON.stringify(project())).toBe(before)
    expect(library.list()).toEqual([])
    expect(secrets.has(key)).toBe(true)
    // An unreadable OAuth slot is named by what it is.
    secrets.unreadable.delete(key)
    secrets.unreadable.set(mcpOAuthKey(pid, 'mcp-1', 'refreshToken'), 'The secret vault is locked: x')
    expect(() => svc.promote({ projectId: pid, serverId: 'mcp-1' })).toThrow('The OAuth refresh token of github cannot be read here (The secret vault is locked: x)')
    secrets.unreadable.clear()
    const moved = svc.promote({ projectId: pid, serverId: 'mcp-1' })
    expect(moved.servers[0].spec.libraryId).toBeDefined()
  })

  it('copyFromLibrary refuses an unreadable entry value with copySecrets, and an unreadable per-project value always', () => {
    library.save({ ...remote({ id: 'mcpl_s', name: 'stdio-lib', transport: 'stdio', url: undefined, command: 'npx', args: ['-y', 'x@1.0.0'], secretEnv: ['TOKEN'] }) })
    const link = svc.linkLibrary({ projectId: pid, libraryId: 'mcpl_s' }).servers[0].spec
    svc.librarySetSecret({ libraryId: 'mcpl_s', kind: 'env', name: 'TOKEN', value: 'lib-v' })
    secrets.unreadable.set(mcpLibrarySecretKey('mcpl_s', 'env', 'TOKEN'), PENDING)
    const before = JSON.stringify(project())
    expect(() => svc.copyFromLibrary({ projectId: pid, serverId: link.id, copySecrets: true })).toThrow(VAULT_MESSAGES.moveRefused('TOKEN', 'stdio-lib', PENDING))
    expect(JSON.stringify(project())).toBe(before)
    // A perProjectSecrets link moves its own values whatever copySecrets says.
    library.save({ ...library.get('mcpl_s')!, perProjectSecrets: true })
    secrets.unreadable.set(mcpSecretKey(pid, link.id, 'env', 'TOKEN'), 'The secret vault is locked: y')
    expect(() => svc.copyFromLibrary({ projectId: pid, serverId: link.id, copySecrets: false })).toThrow('TOKEN of stdio-lib cannot be read here (The secret vault is locked: y)')
    expect(JSON.stringify(project())).toBe(before)

    // Without per-project values and without copySecrets nothing is carried: nothing to refuse.
    library.save({ ...library.get('mcpl_s')!, perProjectSecrets: undefined })
    const copied = svc.copyFromLibrary({ projectId: pid, serverId: link.id, copySecrets: false })
    expect(copied.servers[0].spec.libraryId).toBeUndefined()
  })
})

describe('installs store secrets before other stores (round 6 item 10)', () => {
  const install = (over: Partial<McpServerSpec> = {}) => spec({ id: 'mcp-new', name: 'newsrv', source: 'agent', ...over })

  it('project scope: a failed secret write leaves projects.json and the vault untouched', () => {
    secrets.failSet = (k) => k.endsWith(':B')
    const before = JSON.stringify(project())
    expect(() => svc.persistInstall(pid, install({ secretEnv: ['A', 'B'] }), { A: 'a', B: 'b' }, 'project')).toThrow('could not write')
    expect(JSON.stringify(project())).toBe(before)
    expect(secrets.keys(`mcp:${pid}:mcp-new:`)).toEqual([])
    // Order: the values went first, then the project.
    secrets.failSet = undefined
    secrets.log.length = 0
    const saved = svc.persistInstall(pid, install({ secretEnv: ['A', 'B'] }), { A: 'a', B: 'b' }, 'project')
    expect(saved.mcpServers?.map((s) => s.id)).toEqual(['mcp-new'])
    expect(secrets.storedKeys()).toEqual([mcpSecretKey(pid, 'mcp-new', 'env', 'A'), mcpSecretKey(pid, 'mcp-new', 'env', 'B')])
  })

  it('library scope: a failed secret write saves no entry and no link; a failed project save removes the values', () => {
    secrets.failSet = () => true
    expect(() => svc.persistInstall(pid, install(), { GITHUB_TOKEN: 't' }, 'library')).toThrow('could not write')
    expect(library.list()).toEqual([])
    expect(project().mcpServers ?? []).toEqual([])
    secrets.failSet = undefined
    const spy = vi.spyOn(projects, 'save').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(() => svc.persistInstall(pid, install(), { GITHUB_TOKEN: 't' }, 'library')).toThrow('disk full')
    spy.mockRestore()
    expect(library.list()).toEqual([])
    expect(secrets.keys('mcplib:')).toEqual([])
  })
})

describe('OAuth commits wait for the vault (round 6 item 4)', () => {
  beforeEach(() => {
    build({ lazy: true })
    svc.libraryUpsert(remote())
  })

  it('authorize prepares after the browser step and before the checks, then stores tokens before the config', async () => {
    const order: string[] = []
    runAuthorization.mockImplementation(async () => {
      order.push('browser')
      return flow()
    })
    const realSave = library.save.bind(library)
    vi.spyOn(library, 'save').mockImplementation((e) => {
      if (e.oauth?.authorizedAt) order.push(secrets.has(mcpLibraryOAuthKey('mcpl_1', 'accessToken')) ? 'config after tokens' : 'config before tokens')
      return realSave(e)
    })
    const realPrepare = secrets.prepareWrite.bind(secrets)
    vi.spyOn(secrets, 'prepareWrite').mockImplementation(() => {
      order.push('prepare')
      return realPrepare()
    })
    const status = await svc.authorize({ libraryId: 'mcpl_1' })
    expect(status.state).toBe('authorized')
    expect(order).toEqual(['browser', 'prepare', 'config after tokens'])
    const ops = secrets.log.map((e) => (e.op === 'set' && e.value ? `set:${e.key.split(':').pop()}` : '')).filter(Boolean)
    expect(ops).toEqual(['set:accessToken', 'set:refreshToken', 'set:clientSecret'])
    expect(secrets.violations).toEqual([])
    vi.restoreAllMocks()
  })

  it('a vault that cannot take the tokens fails the sign-in with its reason; nothing is stored', async () => {
    secrets.prepareError = new Error('The secret vault is locked: run security unlock-keychain')
    runAuthorization.mockResolvedValue(flow())
    const status = await svc.authorize({ libraryId: 'mcpl_1' })
    expect(status).toMatchObject({ state: 'error', error: 'The secret vault is locked: run security unlock-keychain' })
    expect(secrets.storedKeys()).toEqual([])
    expect(library.get('mcpl_1')?.oauth).toBeUndefined()
  })

  it('the owner is read again after the wait: removed or retargeted during preparation means no tokens', async () => {
    runAuthorization.mockResolvedValue(flow())
    let release!: () => void
    vi.spyOn(secrets, 'prepareWrite').mockImplementationOnce(() => new Promise<void>((r) => (release = () => {
      secrets.setState('open')
      r()
    })))
    const pending = svc.authorize({ libraryId: 'mcpl_1' })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    svc.libraryUpsert(remote({ url: 'https://elsewhere.test/mcp' }))
    release()
    // The edit aborted the flow (or the re-read caught the new address): either way no token and no config.
    expect(await pending).toMatchObject({ state: 'error' })
    expect(secrets.storedKeys()).toEqual([])
    expect(library.get('mcpl_1')?.oauth?.authorizedAt).toBeUndefined()
    vi.restoreAllMocks()
  })

  it('the mock sign-in prepares before its synthetic token (ORGAI_MOCK=1)', async () => {
    build({ lazy: true, mock: true })
    const added = svc.connectorsAdd({ connectorId: 'notion' })
    const status = await svc.authorize({ libraryId: added.entry.id })
    expect(status.state).toBe('authorized')
    expect(secrets.violations).toEqual([])
    const ops = secrets.log.filter((e) => e.op === 'prepare' || (e.op === 'set' && e.value)).map((e) => e.op)
    expect(ops).toEqual(['prepare', 'set'])
  })

  it('doRefresh prepares before the request (a vault that cannot take tokens never spends a rotation) and before the writes', async () => {
    secrets.setState('open')
    runAuthorization.mockResolvedValue(flow({ config: { ...flow().config, expiresAt: iso(NOW - 1000) } }))
    await svc.authorize({ libraryId: 'mcpl_1' })
    secrets.forgetVault()
    secrets.log.length = 0
    secrets.prepareError = new Error('locked')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await svc.refreshIfNeeded({ libraryId: 'mcpl_1' })
    expect(refreshTokens).not.toHaveBeenCalled()
    expect(warn.mock.calls.join(' ')).toContain('locked')
    secrets.prepareError = undefined
    refreshTokens.mockResolvedValue({ accessToken: 'AT-2', refreshToken: 'RT-2', expiresAt: iso(NOW + 3_600_000) })
    secrets.log.length = 0
    await svc.refreshIfNeeded({ libraryId: 'mcpl_1' })
    expect(secrets.log.map((e) => (e.op === 'set' ? 'set' : e.op))).toEqual(['prepare', 'prepare', 'set', 'set'])
    expect(secrets.get(mcpLibraryOAuthKey('mcpl_1', 'accessToken'))).toBe('AT-2')
    expect(secrets.violations).toEqual([])
    vi.restoreAllMocks()
  })
})

describe('status displays say why (5.4)', () => {
  it('unreadable slots are missing with a reason; set slots are readable ones only', () => {
    svc.upsert({ projectId: pid, spec: spec({ secretEnv: ['A', 'B', 'C'] }) })
    svc.setSecret({ projectId: pid, serverId: 'mcp-1', kind: 'env', name: 'A', value: 'a' })
    svc.setSecret({ projectId: pid, serverId: 'mcp-1', kind: 'env', name: 'B', value: 'b' })
    secrets.unreadable.set(mcpSecretKey(pid, 'mcp-1', 'env', 'B'), PENDING)
    const info = svc.list(pid)[0]
    expect(info.envSet).toEqual(['A'])
    expect(info.missingSecrets).toEqual(['B', 'C'])
    expect(info.unreadableSecrets).toEqual([{ name: 'B', reason: PENDING }])
    expect(JSON.stringify(info)).not.toContain('"a"')

    svc.libraryUpsert({ ...remote(), secretHeaders: ['X-Key'] })
    secrets.unreadable.set(mcpLibrarySecretKey('mcpl_1', 'header', 'X-Key'), 'The secret vault is locked: z')
    const lib = svc.libraryList().find((l) => l.entry.id === 'mcpl_1')!
    expect(lib).toMatchObject({ headersSet: [], missingSecrets: ['X-Key'], unreadableSecrets: [{ name: 'X-Key', reason: 'The secret vault is locked: z' }] })
  })

  it('an unreadable sign-in reads as an error with the reason, never "not authorized"', async () => {
    svc.libraryUpsert(remote())
    runAuthorization.mockResolvedValue(flow())
    await svc.authorize({ libraryId: 'mcpl_1' })
    secrets.unreadable.set(mcpLibraryOAuthKey('mcpl_1', 'accessToken'), PENDING)
    expect(svc.authStatus({ libraryId: 'mcpl_1' })).toMatchObject({ state: 'error', error: PENDING })
  })

  it('secretsRefusal names the vault state, undefined while values can be stored', () => {
    expect(svc.secretsRefusal()).toBeUndefined()
    secrets.setState('corrupt')
    expect(svc.secretsRefusal()).toBe(VAULT_MESSAGES.corrupt)
    secrets.setState('locked')
    expect(svc.secretsRefusal()).toMatch(/locked/)
    secrets.setState('open')
    secrets.unavailable = true
    expect(svc.secretsRefusal()).toMatch(/not available/)
  })
})
