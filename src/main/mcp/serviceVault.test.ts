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
import type { McpLibraryEntry, McpServerSpec, McpServersProposalPayload, Project } from '@shared/types'
import { proposalSecretKey } from '@shared/types'
import { ProjectStore } from '../store/projects'
import { McpLibraryStore } from '../store/mcpLibrary'
import { mcpLibraryOAuthKey, mcpLibrarySecretKey, mcpOAuthKey, mcpSecretKey } from '../store/secrets'
import { FixtureVaultStore } from '../store/vaultStore.fixture'
import { VAULT_MESSAGES } from '../store/vaultTypes'
import { McpService } from './service'
import { ProposalSecretsNotSaved } from './proposalSecrets'

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

describe('an overlay value is never written back by a rollback', () => {
  it('priorOf reports an overlay-backed key as not restorable, so putBack never persists it', () => {
    const key = mcpSecretKey(pid, 'mcp-1', 'env', 'GITHUB_TOKEN')
    ;(secrets as unknown as { overlay: Map<string, string> }).overlay.set(key, 'from-env')
    const prior = (svc as unknown as { priorOf(k: string): unknown; putBack(k: string, p: unknown, w: string): void }).priorOf(key)
    expect(prior).toEqual({ unreadable: true })
    ;(svc as unknown as { putBack(k: string, p: unknown, w: string): void }).putBack(key, prior, 'test')
    expect((secrets as unknown as { overlay: Map<string, string> }).overlay.has(key)).toBe(true)
    secrets.clear(key)
    expect(secrets.has(key)).toBe(false)
  })
})

describe('revokeAuth is an explicit clear', () => {
  it('a failed save of the removal throws and leaves the sign-in recorded', async () => {
    svc.libraryUpsert(remote())
    runAuthorization.mockResolvedValue(flow())
    await svc.authorize({ libraryId: 'mcpl_1' })
    vi.spyOn(secrets, 'clear').mockImplementation(() => {
      throw new Error('disk full')
    })
    expect(() => svc.revokeAuth({ libraryId: 'mcpl_1' })).toThrow('disk full')
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
    secrets.opLog.length = 0
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

describe('approved proposals store the typed values before other stores (round 6 item 10)', () => {
  const slot = (serverId: string, name: string) => ({ serverId, kind: 'env' as const, name })
  const payload = (upsert: McpServersProposalPayload['upsert'], secrets: McpServersProposalPayload['secrets'], over: Partial<McpServersProposalPayload> = {}): McpServersProposalPayload => ({
    scope: 'project',
    upsert,
    secrets,
    rationale: 'r',
    ...over
  })
  const typed = (...pairs: [ReturnType<typeof slot>, string][]): Record<string, string> => Object.fromEntries(pairs.map(([sl, v]) => [proposalSecretKey(sl), v]))

  /** The order of secret writes and record saves during one call. */
  function trace(): string[] {
    const order: string[] = []
    const realSet = secrets.set.bind(secrets)
    vi.spyOn(secrets, 'set').mockImplementation((k, v) => {
      order.push(v ? `secret ${k.split(':').pop()}` : `clear ${k.split(':').pop()}`)
      realSet(k, v)
    })
    const realProject = projects.save.bind(projects)
    vi.spyOn(projects, 'save').mockImplementation((p) => {
      order.push('projects.json')
      return realProject(p)
    })
    const realLib = library.save.bind(library)
    vi.spyOn(library, 'save').mockImplementation((e) => {
      order.push('mcp-library.json')
      return realLib(e)
    })
    return order
  }

  it('a new server: the values are stored before mcp-library.json and projects.json change', () => {
    const order = trace()
    const sa = slot('mcp-new', 'A')
    svc.applyProposal(pid, payload([spec({ id: 'mcp-new', name: 'newsrv', secretEnv: ['A'] })], [sa]), { secrets: typed([sa, 'va']) })
    vi.restoreAllMocks()
    expect(order).toEqual(['secret A', 'mcp-library.json', 'projects.json'])
    const saved = project().mcpServers![0]
    expect(saved.libraryId).toBeDefined()
    expect(secrets.get(mcpLibrarySecretKey(saved.libraryId!, 'env', 'A'))).toBe('va')
  })

  it('a store that refuses a value changes no record and puts back every value the call wrote', () => {
    svc.upsert({ projectId: pid, spec: spec({ secretEnv: ['A', 'B'] }) })
    svc.setSecret({ projectId: pid, serverId: 'mcp-1', kind: 'env', name: 'A', value: 'old-a' })
    const before = JSON.stringify(project())
    secrets.failSet = (k) => k.endsWith(':B')
    const sa = slot('mcp-1', 'A')
    const sb = slot('mcp-1', 'B')
    const redefine = payload([spec({ args: ['-y', '@x/github@2.0.0'], secretEnv: ['A', 'B'] })], [sa, sb])
    expect(() => svc.applyProposal(pid, redefine, { projectOnly: true, secrets: typed([sa, 'new-a'], [sb, 'new-b']) })).toThrow(ProposalSecretsNotSaved)
    expect(JSON.stringify(project())).toBe(before)
    expect(secrets.get(mcpSecretKey(pid, 'mcp-1', 'env', 'A'))).toBe('old-a')
    expect(secrets.has(mcpSecretKey(pid, 'mcp-1', 'env', 'B'))).toBe(false)
  })

  it('a redefinition that changes the launch keeps the new values through its retarget; the other old values go', () => {
    svc.upsert({ projectId: pid, spec: spec({ secretEnv: ['A', 'B'] }) })
    svc.setSecret({ projectId: pid, serverId: 'mcp-1', kind: 'env', name: 'A', value: 'old-a' })
    svc.setSecret({ projectId: pid, serverId: 'mcp-1', kind: 'env', name: 'B', value: 'old-b' })
    const sa = slot('mcp-1', 'A')
    svc.applyProposal(pid, payload([spec({ args: ['-y', '@x/github@2.0.0'], secretEnv: ['A', 'B'] })], [sa, slot('mcp-1', 'B')]), { projectOnly: true, secrets: typed([sa, 'new-a']) })
    expect(project().mcpServers![0].args).toEqual(['-y', '@x/github@2.0.0'])
    expect(secrets.get(mcpSecretKey(pid, 'mcp-1', 'env', 'A'))).toBe('new-a')
    // B was not typed: the old value does not follow the server to its new launch.
    expect(secrets.has(mcpSecretKey(pid, 'mcp-1', 'env', 'B'))).toBe(false)
    expect(svc.storeProposalSecrets(pid, payload([spec({ secretEnv: ['A', 'B'] })], []), undefined)).toEqual(['github'])
  })

  it('a failed projects.json save puts the values back and removes the library entries it created', () => {
    svc.upsert({ projectId: pid, spec: spec({ secretEnv: ['A'] }) })
    svc.setSecret({ projectId: pid, serverId: 'mcp-1', kind: 'env', name: 'A', value: 'old-a' })
    const before = JSON.stringify(project())
    vi.spyOn(projects, 'save').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const sa = slot('mcp-1', 'A')
    const sn = slot('mcp-new', 'N')
    const p2 = payload([spec({ args: ['-y', '@x/github@2.0.0'], secretEnv: ['A'] }), spec({ id: 'mcp-new', name: 'newsrv', secretEnv: ['N'] })], [sa, sn])
    expect(() => svc.applyProposal(pid, p2, { secrets: typed([sa, 'new-a'], [sn, 'new-n']) })).toThrow('disk full')
    vi.restoreAllMocks()
    expect(JSON.stringify(project())).toBe(before)
    expect(library.list()).toEqual([])
    expect(secrets.get(mcpSecretKey(pid, 'mcp-1', 'env', 'A'))).toBe('old-a')
    expect(secrets.keys('mcplib:')).toEqual([])
  })

  it('library sessions: a refused value leaves the library untouched; an entry removed and added back keeps its new value', () => {
    library.save(remote({ id: 'mcpl_s', name: 'stdio-lib', transport: 'stdio', url: undefined, command: 'npx', args: ['-y', 'x@1.0.0'], secretEnv: ['TOKEN'] }))
    svc.librarySetSecret({ libraryId: 'mcpl_s', kind: 'env', name: 'TOKEN', value: 'old' })
    const before = JSON.stringify(library.list())
    const st = slot('mcpl_s', 'TOKEN')
    const lp = payload([{ ...library.get('mcpl_s')!, args: ['-y', 'x@2.0.0'], enabled: true } as McpServerSpec], [st], { scope: 'library' })
    secrets.failSet = () => true
    expect(() => svc.applyLibraryProposal(lp, { secrets: typed([st, 'new']) })).toThrow(ProposalSecretsNotSaved)
    expect(JSON.stringify(library.list())).toBe(before)
    expect(secrets.get(mcpLibrarySecretKey('mcpl_s', 'env', 'TOKEN'))).toBe('old')
    secrets.failSet = undefined
    svc.applyLibraryProposal({ ...lp, remove: ['mcpl_s'] }, { secrets: typed([st, 'new']) })
    expect(library.get('mcpl_s')?.args).toEqual(['-y', 'x@2.0.0'])
    expect(secrets.get(mcpLibrarySecretKey('mcpl_s', 'env', 'TOKEN'))).toBe('new')
  })

  it('library sessions: a later entry that fails to save gets its old value back; an entry already saved keeps its new one', () => {
    for (const id of ['mcpl_a', 'mcpl_b']) {
      library.save(remote({ id, name: id.replace('mcpl_', 'srv-'), transport: 'stdio', url: undefined, command: 'npx', args: ['-y', `${id}@1.0.0`], secretEnv: ['TOKEN'] }))
      svc.librarySetSecret({ libraryId: id, kind: 'env', name: 'TOKEN', value: `old-${id}` })
    }
    const sa = slot('mcpl_a', 'TOKEN')
    const sb = slot('mcpl_b', 'TOKEN')
    const realSave = library.save.bind(library)
    vi.spyOn(library, 'save').mockImplementation((e) => {
      if (e.id === 'mcpl_b') throw new Error('disk full')
      return realSave(e)
    })
    const lp = payload(['mcpl_a', 'mcpl_b'].map((id) => ({ ...library.get(id)!, args: ['-y', `${id}@1.0.1`], enabled: true }) as McpServerSpec), [sa, sb], { scope: 'library' })
    expect(() => svc.applyLibraryProposal(lp, { secrets: typed([sa, 'new-a'], [sb, 'new-b']) })).toThrow('disk full')
    vi.restoreAllMocks()
    expect(library.get('mcpl_a')?.args).toEqual(['-y', 'mcpl_a@1.0.1'])
    expect(secrets.get(mcpLibrarySecretKey('mcpl_a', 'env', 'TOKEN'))).toBe('new-a')
    expect(library.get('mcpl_b')?.args).toEqual(['-y', 'mcpl_b@1.0.0'])
    expect(secrets.get(mcpLibrarySecretKey('mcpl_b', 'env', 'TOKEN'))).toBe('old-mcpl_b')
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
    const ops = secrets.opLog.map((e) => (e.op === 'set' && e.value ? `set:${e.key.split(':').pop()}` : '')).filter(Boolean)
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
    const ops = secrets.opLog.filter((e) => e.op === 'prepare' || (e.op === 'set' && e.value)).map((e) => e.op)
    expect(ops).toEqual(['prepare', 'set'])
  })

  it('doRefresh prepares before the request (a vault that cannot take tokens never spends a rotation) and before the writes', async () => {
    secrets.setState('open')
    runAuthorization.mockResolvedValue(flow({ config: { ...flow().config, expiresAt: iso(NOW - 1000) } }))
    await svc.authorize({ libraryId: 'mcpl_1' })
    secrets.forgetVault()
    secrets.opLog.length = 0
    secrets.prepareError = new Error('locked')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await svc.refreshIfNeeded({ libraryId: 'mcpl_1' })
    expect(refreshTokens).not.toHaveBeenCalled()
    expect(warn.mock.calls.join(' ')).toContain('locked')
    secrets.prepareError = undefined
    refreshTokens.mockResolvedValue({ accessToken: 'AT-2', refreshToken: 'RT-2', expiresAt: iso(NOW + 3_600_000) })
    secrets.opLog.length = 0
    await svc.refreshIfNeeded({ libraryId: 'mcpl_1' })
    expect(secrets.opLog.map((e) => (e.op === 'set' ? 'set' : e.op))).toEqual(['prepare', 'prepare', 'set', 'set'])
    expect(secrets.get(mcpLibraryOAuthKey('mcpl_1', 'accessToken'))).toBe('AT-2')
    expect(secrets.violations).toEqual([])
    vi.restoreAllMocks()
  })
})

describe('OAuth commits never mix two sign-ins', () => {
  beforeEach(() => {
    svc.libraryUpsert(remote())
  })
  const oauthKeys = (): Record<string, string | undefined> =>
    Object.fromEntries((['accessToken', 'refreshToken', 'clientSecret'] as const).map((k) => [k, secrets.get(mcpLibraryOAuthKey('mcpl_1', k))]))

  it('a configuration save that fails puts back the tokens and client secret of the earlier sign-in', async () => {
    runAuthorization.mockResolvedValue(flow())
    await svc.authorize({ libraryId: 'mcpl_1' })
    const config = library.get('mcpl_1')!.oauth
    const realSave = library.save.bind(library)
    vi.spyOn(library, 'save').mockImplementation((e) => {
      if (e.oauth?.clientId === 'cid-2') throw new Error('disk full')
      return realSave(e)
    })
    runAuthorization.mockResolvedValue(flow({ config: { ...flow().config, clientId: 'cid-2', tokenEndpoint: 'https://as2.test/token' }, tokens: { accessToken: 'AT-2', refreshToken: 'RT-2' }, clientSecret: 'CS-2' }))
    const status = await svc.authorize({ libraryId: 'mcpl_1' })
    vi.restoreAllMocks()
    expect(status).toMatchObject({ state: 'error', error: expect.stringContaining('disk full') })
    expect(oauthKeys()).toEqual({ accessToken: 'AT-1', refreshToken: 'RT-1', clientSecret: 'CS-1' })
    expect(library.get('mcpl_1')!.oauth).toEqual(config)
  })

  it('a first sign-in whose configuration cannot be saved leaves no token behind', async () => {
    vi.spyOn(library, 'save').mockImplementation(() => {
      throw new Error('disk full')
    })
    runAuthorization.mockResolvedValue(flow())
    expect((await svc.authorize({ libraryId: 'mcpl_1' })).state).toBe('error')
    vi.restoreAllMocks()
    expect(oauthKeys()).toEqual({ accessToken: undefined, refreshToken: undefined, clientSecret: undefined })
  })

  it('the mock sign-in rolls its synthetic token back the same way (ORGAI_MOCK=1)', async () => {
    build({ mock: true })
    const added = svc.connectorsAdd({ connectorId: 'notion' })
    const realSave = library.save.bind(library)
    vi.spyOn(library, 'save').mockImplementation((e) => {
      if (e.oauth?.authorizedAt) throw new Error('disk full')
      return realSave(e)
    })
    expect((await svc.authorize({ libraryId: added.entry.id })).state).toBe('error')
    vi.restoreAllMocks()
    expect(secrets.has(mcpLibraryOAuthKey(added.entry.id, 'accessToken'))).toBe(false)
  })

  it('a sign-out or a new sign-in during a refresh wins: the refresh result is discarded', async () => {
    runAuthorization.mockResolvedValue(flow({ config: { ...flow().config, expiresAt: iso(NOW - 1000) } }))
    await svc.authorize({ libraryId: 'mcpl_1' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let answer!: (t: unknown) => void
    refreshTokens.mockImplementation(() => new Promise((r) => (answer = r)))
    const signedOut = svc.refreshIfNeeded({ libraryId: 'mcpl_1' })
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'))
    svc.revokeAuth({ libraryId: 'mcpl_1' })
    answer({ accessToken: 'AT-2', refreshToken: 'RT-2', expiresAt: iso(NOW + 3_600_000) })
    await signedOut
    expect(oauthKeys()).toMatchObject({ accessToken: undefined, refreshToken: undefined })
    expect(library.get('mcpl_1')!.oauth?.authorizedAt).toBeUndefined()
    expect(svc.authStatus({ libraryId: 'mcpl_1' }).state).not.toBe('authorized')

    // Signed in again (RT-3) while an older refresh was in flight: the sign-in's tokens stay.
    runAuthorization.mockResolvedValue(flow({ config: { ...flow().config, expiresAt: iso(NOW - 1000) }, tokens: { accessToken: 'AT-3', refreshToken: 'RT-3' } }))
    await svc.authorize({ libraryId: 'mcpl_1' })
    answer = undefined as unknown as (t: unknown) => void
    const reauthorized = svc.refreshIfNeeded({ libraryId: 'mcpl_1' })
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'))
    runAuthorization.mockResolvedValue(flow({ tokens: { accessToken: 'AT-4', refreshToken: 'RT-4' } }))
    await svc.authorize({ libraryId: 'mcpl_1' })
    answer({ accessToken: 'AT-stale', refreshToken: 'RT-stale', expiresAt: iso(NOW + 3_600_000) })
    await reauthorized
    expect(oauthKeys()).toMatchObject({ accessToken: 'AT-4', refreshToken: 'RT-4' })
    expect(warn.mock.calls.join(' ')).toContain('the sign-in changed during the refresh')
    vi.restoreAllMocks()
  })

  it('a refresh on an open vault prepares once, right before its writes (no extra custodian round trip)', async () => {
    runAuthorization.mockResolvedValue(flow({ config: { ...flow().config, expiresAt: iso(NOW - 1000) } }))
    await svc.authorize({ libraryId: 'mcpl_1' })
    refreshTokens.mockResolvedValue({ accessToken: 'AT-2', refreshToken: 'RT-2', expiresAt: iso(NOW + 3_600_000) })
    secrets.opLog.length = 0
    await svc.refreshIfNeeded({ libraryId: 'mcpl_1' })
    expect(secrets.opLog.map((e) => (e.op === 'set' ? 'set' : e.op))).toEqual(['prepare', 'set', 'set'])
    expect(oauthKeys()).toMatchObject({ accessToken: 'AT-2', refreshToken: 'RT-2' })
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

  it("a proposal the vault cannot take now is refused with the store's own reason (the custodian's for a lock), nothing applied", () => {
    svc.upsert({ projectId: pid, spec: spec({ secretEnv: ['A'] }) })
    const before = JSON.stringify(project())
    const sa = { serverId: 'mcp-1', kind: 'env' as const, name: 'A' }
    const p = { scope: 'project' as const, upsert: [spec({ args: ['-y', '@x/github@2.0.0'], secretEnv: ['A'] })], secrets: [sa], rationale: 'r' }
    secrets.lockReason = 'Run `security unlock-keychain` in this SSH session, or set ORGAI_VAULT_KEY_FILE'
    for (const [state, sentence] of [
      ['locked', VAULT_MESSAGES.locked(secrets.lockReason)],
      ['corrupt', VAULT_MESSAGES.corrupt],
      ['missing-key', VAULT_MESSAGES.missingKey],
      ['key-mismatch', VAULT_MESSAGES.keyMismatch]
    ] as const) {
      secrets.setState(state)
      expect(() => svc.applyProposal(pid, p, { secrets: { [proposalSecretKey(sa)]: 'v' } }), state).toThrow(`The secret values could not be saved: ${sentence}`)
      expect(JSON.stringify(project()), state).toBe(before)
    }
    secrets.setState('open')
    secrets.unavailable = true
    expect(() => svc.applyProposal(pid, p, { secrets: { [proposalSecretKey(sa)]: 'v' } })).toThrow(/^The secret values could not be saved: Secure storage is not available/)
    expect(JSON.stringify(project())).toBe(before)
    // A typed value for a slot of a server the proposal does not upsert is dropped, so nothing is refused.
    const stray = { serverId: 'mcp-other', kind: 'env' as const, name: 'A' }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => svc.applyProposal(pid, { ...p, secrets: [stray] }, { secrets: { [proposalSecretKey(stray)]: 'v' } })).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })
})

describe('a rollback never deletes a value this host could not read (5.5 Deletes)', () => {
  it("a failed proposal apply keeps the new value over the app's pending-legacy one instead of deleting both", async () => {
    build({ lazy: true })
    svc.upsert({ projectId: pid, spec: spec({ secretEnv: ['A', 'B'] }) })
    const keyA = mcpSecretKey(pid, 'mcp-1', 'env', 'A')
    const keyB = mcpSecretKey(pid, 'mcp-1', 'env', 'B')
    secrets.seedAppValue(keyA, 'app-a')
    await secrets.prepareWrite()
    secrets.set(keyB, 'old-b')
    expect(secrets.status(keyA)).toEqual({ unreadable: PENDING })
    const before = JSON.stringify(project())
    vi.spyOn(projects, 'save').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const sa = { serverId: 'mcp-1', kind: 'env' as const, name: 'A' }
    const sb = { serverId: 'mcp-1', kind: 'env' as const, name: 'B' }
    const p = { scope: 'project' as const, upsert: [spec({ args: ['-y', '@x/github@2.0.0'], secretEnv: ['A', 'B'] })], secrets: [sa, sb], rationale: 'r' }
    secrets.opLog.length = 0
    expect(() => svc.applyProposal(pid, p, { secrets: { [proposalSecretKey(sa)]: 'new-a', [proposalSecretKey(sb)]: 'new-b' } })).toThrow('disk full')
    vi.restoreAllMocks()
    expect(JSON.stringify(project())).toBe(before)
    // The readable one goes back; the unreadable one keeps the value just written (never deleted).
    expect(secrets.get(keyB)).toBe('old-b')
    expect(secrets.get(keyA)).toBe('new-a')
    expect(secrets.opLog.some((e) => (e.op === 'delete' && e.key === keyA) || (e.op === 'set' && e.key === keyA && !e.value))).toBe(false)
  })

  it("a failed sign-in save keeps the new tokens over the app's pending-legacy ones; slots that held nothing are cleared", async () => {
    build({ lazy: true })
    svc.libraryUpsert(remote())
    const at = mcpLibraryOAuthKey('mcpl_1', 'accessToken')
    const rt = mcpLibraryOAuthKey('mcpl_1', 'refreshToken')
    const cs = mcpLibraryOAuthKey('mcpl_1', 'clientSecret')
    secrets.seedAppValue(at, 'AT-app')
    secrets.seedAppValue(rt, 'RT-app')
    const realSave = library.save.bind(library)
    vi.spyOn(library, 'save').mockImplementation((e) => {
      if (e.oauth?.authorizedAt) throw new Error('disk full')
      return realSave(e)
    })
    runAuthorization.mockResolvedValue(flow())
    secrets.opLog.length = 0
    expect(await svc.authorize({ libraryId: 'mcpl_1' })).toMatchObject({ state: 'error', error: expect.stringContaining('disk full') })
    vi.restoreAllMocks()
    expect(secrets.get(at)).toBe('AT-1')
    expect(secrets.get(rt)).toBe('RT-1')
    expect(secrets.has(cs)).toBe(false)
    const dropped = secrets.opLog.filter((e) => e.op === 'delete' || (e.op === 'set' && !e.value)).map((e) => ('key' in e ? e.key : ''))
    expect(dropped).toEqual([cs])
  })
})
