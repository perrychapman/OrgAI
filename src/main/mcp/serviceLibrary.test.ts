import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpLibraryEntry, McpLibraryInfo, McpServerSpec, Project } from '@shared/types'
import { ProjectStore } from '../store/projects'
import { McpLibraryStore } from '../store/mcpLibrary'
import { SecretStore, mcpLibraryOAuthKey, mcpLibrarySecretKey, mcpOAuthKey, mcpSecretKey } from '../store/secrets'
import { McpService } from './service'
import { OAuthError, NEEDS_CLIENT_ID_MESSAGE, type AuthorizeFlowInput } from './oauth'

const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => b.toString().slice(4)
}

const NOW = Date.parse('2026-06-01T00:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

let dir: string
let projects: ProjectStore
let secrets: SecretStore
let library: McpLibraryStore
let svc: McpService
let pid: string
let libEvents: McpLibraryInfo[][]
let projectEvents: Project[]
const runAuthorization = vi.fn()
const refreshTokens = vi.fn()

const entry = (over: Partial<McpLibraryEntry> = {}): McpLibraryEntry => ({
  id: 'mcpl_1',
  name: 'docs',
  transport: 'http',
  url: 'https://docs.test/mcp',
  secretHeaders: ['X-Key'],
  source: 'user',
  addedAt: '2026-01-01T00:00:00.000Z',
  ...over
})

const stdioEntry = (over: Partial<McpLibraryEntry> = {}): McpLibraryEntry => ({
  id: 'mcpl_2',
  name: 'github',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@x/github@1.4.2'],
  secretEnv: ['GITHUB_TOKEN'],
  source: 'user',
  addedAt: '2026-01-01T00:00:00.000Z',
  ...over
})

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

function build(): void {
  svc = new McpService({
    projects,
    secrets,
    library,
    now: () => NOW,
    openExternal: async () => {},
    oauth: { runAuthorization, refreshTokens },
    onLibraryChanged: (e) => libEvents.push(e),
    onProjectChanged: (p) => projectEvents.push(p)
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-mcplib-'))
  projects = new ProjectStore(join(dir, 'data'))
  secrets = new SecretStore(join(dir, 'data'), cipher)
  library = new McpLibraryStore(join(dir, 'data'))
  libEvents = []
  projectEvents = []
  runAuthorization.mockReset()
  refreshTokens.mockReset()
  build()
  pid = projects.create({ name: 'p', path: join(dir, 'repo'), brief: '' }).id
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('McpLibraryStore', () => {
  it('round-trips, persists across instances and removes', () => {
    library.save(entry())
    library.save(stdioEntry())
    library.save(entry({ url: 'https://docs.test/v2' }))
    expect(library.list().map((e) => [e.id, e.url])).toEqual([['mcpl_1', 'https://docs.test/v2'], ['mcpl_2', undefined]])
    const again = new McpLibraryStore(join(dir, 'data'))
    expect(again.get('mcpl_1')?.url).toBe('https://docs.test/v2')
    // copies: mutating a result does not change the store
    again.get('mcpl_1')!.name = 'changed'
    expect(again.get('mcpl_1')?.name).toBe('docs')
    expect(again.remove('mcpl_1')).toBe(true)
    expect(again.remove('mcpl_1')).toBe(false)
    expect(new McpLibraryStore(join(dir, 'data')).list().map((e) => e.id)).toEqual(['mcpl_2'])
  })
})

describe('library entries', () => {
  it('upserts, lists has-flags, missing secrets and the projects that link it', () => {
    const list = svc.libraryUpsert(entry())
    expect(list[0]).toMatchObject({ entry: { name: 'docs' }, envSet: [], headersSet: [], missingSecrets: ['X-Key'], auth: { state: 'notRequired' }, usedBy: [] })
    svc.librarySetSecret({ libraryId: 'mcpl_1', kind: 'header', name: 'X-Key', value: 'sekret' })
    svc.linkLibrary({ projectId: pid, libraryId: 'mcpl_1' })
    const info = svc.libraryList()[0]
    expect(info.headersSet).toEqual(['X-Key'])
    expect(info.missingSecrets).toEqual([])
    expect(info.usedBy).toEqual([{ projectId: pid, projectName: 'p' }])
    expect(JSON.stringify(svc.libraryList())).not.toContain('sekret')
    expect(JSON.stringify(library.list())).not.toContain('sekret')
    expect(libEvents.length).toBeGreaterThan(0)
  })

  it('validates: unique names inside the library, safe ids, pinned versions, a non-library source', () => {
    svc.libraryUpsert(entry())
    expect(() => svc.libraryUpsert(entry({ id: 'mcpl_9' }))).toThrow(/already exists in the MCP library/)
    expect(() => svc.libraryUpsert(entry({ id: '../evil', name: 'other' }))).toThrow(/id must be/)
    expect(() => svc.libraryUpsert(stdioEntry({ args: ['-y', 'pkg@latest'] }))).toThrow(/not pinned/)
    svc.libraryUpsert(stdioEntry({ source: 'library' }))
    expect(library.get('mcpl_2')?.source).toBe('user')
    // replacing an entry under its own name is fine
    svc.libraryUpsert(entry({ description: 'changed' }))
    expect(library.get('mcpl_1')?.description).toBe('changed')
  })

  it('keeps the stored oauth whatever the renderer sends and drops it with its tokens when the url changes', () => {
    svc.libraryUpsert(entry())
    library.save({ ...library.get('mcpl_1')!, oauth: { clientId: 'cid', tokenEndpoint: 'https://as.test/token' } })
    secrets.set(mcpLibraryOAuthKey('mcpl_1', 'accessToken'), 'AT')
    secrets.set(mcpLibraryOAuthKey('mcpl_1', 'refreshToken'), 'RT')
    svc.libraryUpsert(entry({ description: 'x', oauth: { clientId: 'forged' } }))
    expect(library.get('mcpl_1')?.oauth?.clientId).toBe('cid')
    expect(secrets.has(mcpLibraryOAuthKey('mcpl_1', 'accessToken'))).toBe(true)
    svc.libraryUpsert(entry({ url: 'https://elsewhere.test/mcp' }))
    expect(library.get('mcpl_1')?.oauth).toBeUndefined()
    expect(secrets.keys('mcplib:mcpl_1:oauth:')).toEqual([])
  })

  it('drops secret slots an edit removed', () => {
    svc.libraryUpsert(stdioEntry())
    svc.librarySetSecret({ libraryId: 'mcpl_2', kind: 'env', name: 'GITHUB_TOKEN', value: 'v' })
    svc.libraryUpsert(stdioEntry({ secretEnv: [] }))
    expect(secrets.has(mcpLibrarySecretKey('mcpl_2', 'env', 'GITHUB_TOKEN'))).toBe(false)
    expect(() => svc.librarySetSecret({ libraryId: 'mcpl_2', kind: 'env', name: 'OTHER', value: 'x' })).toThrow(/not a secret/)
  })

  it('keeps library and project secrets in separate key spaces', () => {
    expect(mcpLibrarySecretKey('s1', 'env', 'T')).not.toBe(mcpSecretKey('lib', 's1', 'env', 'T'))
    expect(mcpLibraryOAuthKey('s1', 'accessToken').startsWith('mcp:')).toBe(false)
    expect(mcpOAuthKey('p', 's1', 'accessToken').startsWith('mcplib:')).toBe(false)
  })

  it('without a library store the library is empty and read-only', () => {
    const bare = new McpService({ projects, secrets })
    expect(bare.libraryList()).toEqual([])
    expect(() => bare.libraryUpsert(entry())).toThrow(/not available/)
  })
})

describe('links', () => {
  beforeEach(() => {
    svc.libraryUpsert(stdioEntry())
    svc.librarySetSecret({ libraryId: 'mcpl_2', kind: 'env', name: 'GITHUB_TOKEN', value: 'ghp_lib' })
  })
  const link = (): McpServerSpec => svc.list(pid)[0].spec

  it('links by reference: library fields plus the project-owned ones, secrets from the entry', () => {
    const r = svc.linkLibrary({ projectId: pid, libraryId: 'mcpl_2', roles: ['lead'] })
    expect(r.servers[0].spec).toMatchObject({ name: 'github', source: 'library', libraryId: 'mcpl_2', enabled: true, roles: ['lead'] })
    expect(r.servers[0].spec.id).toMatch(/^mcp_/)
    expect(r.servers[0]).toMatchObject({ envSet: ['GITHUB_TOKEN'], missingSecrets: [] })
    expect(svc.resolve(pid, link()).env.GITHUB_TOKEN).toBe('ghp_lib')
    expect(() => svc.linkLibrary({ projectId: pid, libraryId: 'nope' })).toThrow(/not found/)
    expect(() => svc.linkLibrary({ projectId: pid, libraryId: 'mcpl_2' })).toThrow(/already linked/)
  })

  it('rejects a link whose name clashes with a project server', () => {
    svc.upsert({ projectId: pid, spec: spec({ id: 'mine' }) })
    expect(() => svc.linkLibrary({ projectId: pid, libraryId: 'mcpl_2' })).toThrow(/already exists/)
  })

  it('a library edit reaches list, enabledServers and resolve, and the snapshot is re-saved with a project push', () => {
    svc.linkLibrary({ projectId: pid, libraryId: 'mcpl_2' })
    svc.libraryUpsert(stdioEntry({ args: ['-y', '@x/github@2.0.0'] }))
    expect(link().args).toEqual(['-y', '@x/github@2.0.0'])
    expect(svc.enabledServers(projects.get(pid)!)[0].args).toEqual(['-y', '@x/github@2.0.0'])
    expect(svc.resolve(pid, projects.get(pid)!.mcpServers![0]).spec.args).toEqual(['-y', '@x/github@2.0.0'])
    expect(projects.get(pid)!.mcpServers![0].args).toEqual(['-y', '@x/github@2.0.0'])
    expect(projectEvents.at(-1)?.id).toBe(pid)
  })

  it('upsert on a linked server changes enabled and roles only; a new spec with libraryId is rejected', () => {
    svc.linkLibrary({ projectId: pid, libraryId: 'mcpl_2' })
    const l = link()
    const r = svc.upsert({ projectId: pid, spec: { ...l, enabled: false, roles: ['lead'], command: 'evil', args: ['x'], name: 'renamed' } })
    expect(r.servers[0].spec).toMatchObject({ enabled: false, roles: ['lead'], command: 'npx', name: 'github', libraryId: 'mcpl_2' })
    expect(() => svc.upsert({ projectId: pid, spec: spec({ id: 'fresh', name: 'other', libraryId: 'mcpl_2' }) })).toThrow(/mcp:linkLibrary/)
  })

  it('setSecret on a linked server points at the library entry', () => {
    svc.linkLibrary({ projectId: pid, libraryId: 'mcpl_2' })
    expect(() => svc.setSecret({ projectId: pid, serverId: link().id, kind: 'env', name: 'GITHUB_TOKEN', value: 'x' })).toThrow(/library/)
  })

  it('remove on a linked server unlinks only: grants go, the entry and its secrets stay', () => {
    const id = svc.linkLibrary({ projectId: pid, libraryId: 'mcpl_2' }).servers[0].spec.id
    const p = projects.get(pid)!
    projects.save({ ...p, roles: p.roles.map((r, i) => (i === 0 ? { ...r, mcpServers: [id] } : r)) })
    const r = svc.remove({ projectId: pid, serverId: id })
    expect(r.servers).toEqual([])
    expect(r.project.roles.every((x) => !x.mcpServers?.length)).toBe(true)
    expect(library.get('mcpl_2')).toBeTruthy()
    expect(secrets.has(mcpLibrarySecretKey('mcpl_2', 'env', 'GITHUB_TOKEN'))).toBe(true)
  })

  it('removing a library entry unlinks every project, drops the grants and the secrets', () => {
    const id = svc.linkLibrary({ projectId: pid, libraryId: 'mcpl_2' }).servers[0].spec.id
    const p = projects.get(pid)!
    projects.save({ ...p, roles: p.roles.map((r, i) => (i === 0 ? { ...r, mcpServers: [id, 'keep'] } : r)) })
    svc.upsert({ projectId: pid, spec: spec({ id: 'own', name: 'own' }) })
    svc.libraryRemove({ libraryId: 'mcpl_2' })
    const after = projects.get(pid)!
    expect(after.mcpServers?.map((s) => s.id)).toEqual(['own'])
    expect(after.roles[0].mcpServers).toEqual(['keep'])
    expect(library.list()).toEqual([])
    expect(secrets.keys('mcplib:')).toEqual([])
    expect(projectEvents.at(-1)?.id).toBe(pid)
    expect(() => svc.libraryRemove({ libraryId: 'mcpl_2' })).toThrow(/not found/)
  })

  it('a link whose entry vanished is flagged, kept as a snapshot, excluded from runs and disabled by withLibrary', () => {
    svc.linkLibrary({ projectId: pid, libraryId: 'mcpl_2' })
    library.remove('mcpl_2') // behind the service's back (hand-edited file)
    const info = svc.list(pid)[0]
    expect(info.libraryMissing).toBe(true)
    expect(info.spec.name).toBe('github')
    const stored = projects.get(pid)!
    expect(svc.enabledServers(stored)).toEqual([])
    expect(svc.withLibrary(stored).mcpServers![0].enabled).toBe(false)
    expect(stored.mcpServers![0].enabled).toBe(true)
  })

  it('promote moves the secrets to the library, keeps the project server id and its grants', () => {
    svc.upsert({ projectId: pid, spec: spec({ id: 'mcp-9', name: 'local-db', secretEnv: ['DB_URL'], args: ['-y', 'db@1.0.0'] }) })
    svc.setSecret({ projectId: pid, serverId: 'mcp-9', kind: 'env', name: 'DB_URL', value: 'postgres://x' })
    secrets.set(mcpOAuthKey(pid, 'mcp-9', 'accessToken'), 'AT')
    const p = projects.get(pid)!
    projects.save({ ...p, roles: p.roles.map((r, i) => (i === 0 ? { ...r, mcpServers: ['mcp-9'] } : r)) })
    const r = svc.promote({ projectId: pid, serverId: 'mcp-9' })
    const promoted = r.servers.find((s) => s.spec.id === 'mcp-9')!
    expect(promoted.spec).toMatchObject({ libraryId: expect.stringMatching(/^mcpl_/), source: 'library', name: 'local-db' })
    expect(promoted.envSet).toEqual(['DB_URL'])
    const libId = promoted.spec.libraryId!
    expect(secrets.get(mcpLibrarySecretKey(libId, 'env', 'DB_URL'))).toBe('postgres://x')
    expect(secrets.get(mcpLibraryOAuthKey(libId, 'accessToken'))).toBe('AT')
    expect(secrets.keys(`mcp:${pid}:`)).toEqual([])
    expect(r.project.roles[0].mcpServers).toEqual(['mcp-9'])
    expect(library.get(libId)).toMatchObject({ name: 'local-db' })
    expect(library.get(libId)).not.toHaveProperty('enabled')
    expect(() => svc.promote({ projectId: pid, serverId: 'mcp-9' })).toThrow(/already part of/)
  })

  it('promote refuses a library name clash', () => {
    svc.upsert({ projectId: pid, spec: spec({ id: 'mcp-9' }) })
    expect(() => svc.promote({ projectId: pid, serverId: 'mcp-9' })).toThrow(/already exists in the MCP library/)
    expect(projects.get(pid)!.mcpServers![0].libraryId).toBeUndefined()
  })

  it('persistInstall with scope library creates the entry (secrets under the library) and links it under the install id', () => {
    const p = svc.persistInstall(pid, spec({ id: 'mcp-new', name: 'fresh' }), { GITHUB_TOKEN: 'tok' }, 'library')
    const l = p.mcpServers![0]
    expect(l).toMatchObject({ id: 'mcp-new', source: 'library', libraryId: expect.stringMatching(/^mcpl_/) })
    expect(secrets.get(mcpLibrarySecretKey(l.libraryId!, 'env', 'GITHUB_TOKEN'))).toBe('tok')
    expect(library.get(l.libraryId!)?.source).toBe('agent')
    expect(JSON.stringify(p)).not.toContain('tok')
    expect(() => svc.persistInstall(pid, spec({ id: 'other', name: 'fresh' }), {}, 'library')).toThrow(/already exists/)
  })
})

describe('OAuth', () => {
  const REMOTE = entry({ secretHeaders: undefined })
  const flow = (over: Record<string, unknown> = {}) => ({
    config: { resource: 'https://docs.test/mcp', tokenEndpoint: 'https://as.test/token', clientId: 'cid', clientSource: 'dcr' as const, hasClientSecret: true, authorizedAt: iso(NOW), expiresAt: iso(NOW + 3_600_000) },
    tokens: { accessToken: 'AT-1', refreshToken: 'RT-1', expiresAt: iso(NOW + 3_600_000) },
    clientSecret: 'CS-1',
    ...over
  })
  beforeEach(() => {
    svc.libraryUpsert(REMOTE)
  })

  it('authorize stores tokens, config and the client secret, returns only the status', async () => {
    runAuthorization.mockResolvedValue(flow())
    const status = await svc.authorize({ libraryId: 'mcpl_1' })
    expect(status).toEqual({ state: 'authorized', expiresAt: iso(NOW + 3_600_000) })
    expect(JSON.stringify(status)).not.toMatch(/AT-1|RT-1|CS-1/)
    expect(secrets.get(mcpLibraryOAuthKey('mcpl_1', 'accessToken'))).toBe('AT-1')
    expect(secrets.get(mcpLibraryOAuthKey('mcpl_1', 'refreshToken'))).toBe('RT-1')
    expect(secrets.get(mcpLibraryOAuthKey('mcpl_1', 'clientSecret'))).toBe('CS-1')
    expect(library.get('mcpl_1')?.oauth).toMatchObject({ clientId: 'cid', tokenEndpoint: 'https://as.test/token' })
    expect(JSON.stringify(library.list())).not.toMatch(/AT-1|RT-1|CS-1/)
    const input = runAuthorization.mock.calls[0][0] as AuthorizeFlowInput
    expect(input.url).toBe('https://docs.test/mcp')
    expect(input.signal).toBeInstanceOf(AbortSignal)
    expect(libEvents.at(-1)![0].auth.state).toBe('authorized')
    // a later authorize that returns no refresh token deletes the stored one
    runAuthorization.mockResolvedValue(flow({ tokens: { accessToken: 'AT-2' }, clientSecret: undefined }))
    await svc.authorize({ libraryId: 'mcpl_1' })
    expect(secrets.has(mcpLibraryOAuthKey('mcpl_1', 'refreshToken'))).toBe(false)
    expect(secrets.get(mcpLibraryOAuthKey('mcpl_1', 'clientSecret'))).toBe('CS-1')
  })

  it('stores an entered client id and secret before the flow and passes them on', async () => {
    runAuthorization.mockImplementation(async (i: AuthorizeFlowInput) => {
      // already stored while the browser flow runs, so a failed attempt keeps them
      expect(library.get('mcpl_1')?.oauth).toMatchObject({ clientId: 'manual-id', clientSource: 'manual', hasClientSecret: true })
      expect(secrets.get(mcpLibraryOAuthKey('mcpl_1', 'clientSecret'))).toBe('manual-secret')
      expect(i.clientId).toBe('manual-id')
      expect(i.clientSecret).toBe('manual-secret')
      return flow({ clientSecret: undefined })
    })
    await svc.authorize({ libraryId: 'mcpl_1', clientId: ' manual-id ', clientSecret: 'manual-secret' })
    expect(runAuthorization).toHaveBeenCalledTimes(1)
  })

  it('a flow failure resolves as state error; needsClientId asks for a client id; no secret leaks', async () => {
    runAuthorization.mockRejectedValue(new OAuthError('registration', NEEDS_CLIENT_ID_MESSAGE, true))
    const status = await svc.authorize({ libraryId: 'mcpl_1' })
    expect(status).toEqual({ state: 'error', error: NEEDS_CLIENT_ID_MESSAGE, needsClientId: true })
    expect(svc.libraryList()[0].auth).toMatchObject({ state: 'error', needsClientId: true })
    runAuthorization.mockRejectedValue(new OAuthError('token', 'Token request failed: bad secret topsecret99'))
    const redacted = await svc.authorize({ libraryId: 'mcpl_1', clientId: 'id', clientSecret: 'topsecret99' })
    expect(redacted.state).toBe('error')
    expect(redacted.error).not.toContain('topsecret99')
    // success clears the error
    runAuthorization.mockResolvedValue(flow())
    await svc.authorize({ libraryId: 'mcpl_1' })
    expect(svc.libraryList()[0].auth.state).toBe('authorized')
  })

  it('throws for an unknown target and for a stdio server; a stdio library entry never authorizes', async () => {
    await expect(svc.authorize({ libraryId: 'nope' })).rejects.toThrow(/not found/)
    svc.libraryUpsert(stdioEntry())
    await expect(svc.authorize({ libraryId: 'mcpl_2' })).rejects.toThrow(/http and sse/)
    expect(runAuthorization).not.toHaveBeenCalled()
  })

  it('cancelAuthorize aborts the flow; a new authorize aborts the previous one', async () => {
    const waits = (i: AuthorizeFlowInput) =>
      new Promise((_resolve, reject) => {
        i.signal!.addEventListener('abort', () => reject(new OAuthError('callback', 'Authorization was cancelled.')))
      })
    runAuthorization.mockImplementation(waits)
    const first = svc.authorize({ libraryId: 'mcpl_1' })
    svc.cancelAuthorize({ libraryId: 'mcpl_1' })
    expect(await first).toEqual({ state: 'error', error: 'Authorization was cancelled.' })
    expect(svc.libraryList()[0].auth.state).toBe('notRequired') // a cancellation is not remembered as a failure

    const a = svc.authorize({ libraryId: 'mcpl_1' })
    runAuthorization.mockResolvedValue(flow())
    const b = svc.authorize({ libraryId: 'mcpl_1' })
    expect((await a).error).toBe('Authorization was cancelled.')
    expect((await b).state).toBe('authorized')
  })

  it('revokeAuth forgets the tokens but keeps the client registration', async () => {
    runAuthorization.mockResolvedValue(flow())
    await svc.authorize({ libraryId: 'mcpl_1' })
    const status = svc.revokeAuth({ libraryId: 'mcpl_1' })
    expect(status.state).toBe('notAuthorized')
    expect(secrets.has(mcpLibraryOAuthKey('mcpl_1', 'accessToken'))).toBe(false)
    expect(secrets.has(mcpLibraryOAuthKey('mcpl_1', 'refreshToken'))).toBe(false)
    expect(secrets.get(mcpLibraryOAuthKey('mcpl_1', 'clientSecret'))).toBe('CS-1')
    const cfg = library.get('mcpl_1')!.oauth!
    expect(cfg.clientId).toBe('cid')
    expect(cfg.authorizedAt).toBeUndefined()
    expect(cfg.expiresAt).toBeUndefined()
    expect(svc.authStatus({ libraryId: 'mcpl_1' }).state).toBe('notAuthorized')
  })

  it('a linked project server authorizes through its library entry; a project-only one under its own keys', async () => {
    const linkId = svc.linkLibrary({ projectId: pid, libraryId: 'mcpl_1' }).servers[0].spec.id
    runAuthorization.mockResolvedValue(flow())
    await svc.authorize({ projectId: pid, serverId: linkId })
    expect(secrets.has(mcpLibraryOAuthKey('mcpl_1', 'accessToken'))).toBe(true)
    expect(svc.list(pid)[0].auth.state).toBe('authorized')

    svc.upsert({ projectId: pid, spec: spec({ id: 'own', name: 'own', transport: 'http', command: undefined, args: undefined, secretEnv: undefined, url: 'https://own.test/mcp' }) })
    await svc.authorize({ projectId: pid, serverId: 'own' })
    expect(secrets.get(mcpOAuthKey(pid, 'own', 'accessToken'))).toBe('AT-1')
    expect(projects.get(pid)!.mcpServers!.find((s) => s.id === 'own')!.oauth?.clientId).toBe('cid')
    // the renderer cannot overwrite it, and a url change drops it with its tokens
    const kept = svc.upsert({ projectId: pid, spec: spec({ id: 'own', name: 'own', transport: 'http', command: undefined, args: undefined, secretEnv: undefined, url: 'https://own.test/mcp', oauth: { clientId: 'forged' } }) })
    expect(kept.servers.find((s) => s.spec.id === 'own')!.spec.oauth?.clientId).toBe('cid')
    const moved = svc.upsert({ projectId: pid, spec: spec({ id: 'own', name: 'own', transport: 'http', command: undefined, args: undefined, secretEnv: undefined, url: 'https://new.test/mcp' }) })
    expect(moved.servers.find((s) => s.spec.id === 'own')!.spec.oauth).toBeUndefined()
    expect(secrets.keys(`mcp:${pid}:own:oauth:`)).toEqual([])
  })

  describe('refresh and the run bearer', () => {
    async function authorized(expiresInMs: number): Promise<void> {
      runAuthorization.mockResolvedValue(flow({ config: { ...flow().config, expiresAt: iso(NOW + expiresInMs) }, tokens: { accessToken: 'AT-1', refreshToken: 'RT-1' } }))
      await svc.authorize({ libraryId: 'mcpl_1' })
    }
    const resolved = () => svc.resolve(pid, spec({ id: 'x', name: 'docs', transport: 'http', url: 'https://docs.test/mcp', libraryId: 'mcpl_1', source: 'library' }))

    it('resolve injects the bearer token and replaces any authorization header', async () => {
      await authorized(3_600_000)
      svc.libraryUpsert({ ...REMOTE, headers: { authorization: 'old', 'X-A': '1' } })
      const r = resolved()
      expect(r.headers).toEqual({ Authorization: 'Bearer AT-1', 'X-A': '1' })
    })

    it('resolve adds no bearer when the token is expired or revoked', async () => {
      await authorized(-1000)
      expect(resolved().headers).toEqual({})
      await authorized(3_600_000)
      svc.revokeAuth({ libraryId: 'mcpl_1' })
      expect(resolved().headers).toEqual({})
    })

    it('refreshIfNeeded rotates the tokens and stores the new expiry; it skips a fresh token', async () => {
      await authorized(60_000) // inside the skew window
      refreshTokens.mockResolvedValue({ accessToken: 'AT-2', refreshToken: 'RT-2', expiresAt: iso(NOW + 3_600_000) })
      await svc.refreshIfNeeded({ libraryId: 'mcpl_1' })
      expect(refreshTokens).toHaveBeenCalledTimes(1)
      expect(refreshTokens.mock.calls[0][1]).toEqual({ refreshToken: 'RT-1', clientSecret: 'CS-1' })
      expect(secrets.get(mcpLibraryOAuthKey('mcpl_1', 'accessToken'))).toBe('AT-2')
      expect(secrets.get(mcpLibraryOAuthKey('mcpl_1', 'refreshToken'))).toBe('RT-2')
      expect(library.get('mcpl_1')!.oauth!.expiresAt).toBe(iso(NOW + 3_600_000))
      await svc.refreshIfNeeded({ libraryId: 'mcpl_1' })
      expect(refreshTokens).toHaveBeenCalledTimes(1)
    })

    it('dedupes concurrent refreshes per owner', async () => {
      await authorized(-1000)
      let release: (v: unknown) => void = () => {}
      refreshTokens.mockImplementation(() => new Promise((r) => (release = r)))
      const all = [svc.refreshIfNeeded({ libraryId: 'mcpl_1' }), svc.refreshIfNeeded({ libraryId: 'mcpl_1' }), svc.prepareForRun(pid, [resolved().spec])]
      release({ accessToken: 'AT-2', refreshToken: 'RT-2', expiresAt: iso(NOW + 3_600_000) })
      const results = await Promise.all(all)
      expect(refreshTokens).toHaveBeenCalledTimes(1)
      expect(results[2]).toEqual([])
    })

    it('a failed refresh logs a warning without secrets and does not throw', async () => {
      await authorized(-1000)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      refreshTokens.mockRejectedValue(new Error('invalid_grant for RT-1 with client_secret=CS-1'))
      await expect(svc.refreshIfNeeded({ libraryId: 'mcpl_1' })).resolves.toBeUndefined()
      const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(logged).toContain('docs')
      expect(logged).not.toMatch(/RT-1|CS-1/)
    })

    it('prepareForRun names the OAuth servers still unusable', async () => {
      const link = spec({ id: 'x', name: 'docs', transport: 'http', url: 'https://docs.test/mcp', libraryId: 'mcpl_1', source: 'library' })
      expect(await svc.prepareForRun(pid, [link])).toEqual([]) // no oauth config yet: not an OAuth server
      await authorized(-1000)
      refreshTokens.mockRejectedValue(new Error('nope'))
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const linkWithOAuth = svc.linkLibrary({ projectId: pid, libraryId: 'mcpl_1' }).servers[0].spec
      expect(await svc.prepareForRun(pid, [linkWithOAuth])).toEqual(['docs'])
      refreshTokens.mockResolvedValue({ accessToken: 'AT-3', refreshToken: 'RT-3', expiresAt: iso(NOW + 3_600_000) })
      expect(await svc.prepareForRun(pid, [linkWithOAuth])).toEqual([])
      expect(svc.resolve(pid, linkWithOAuth).headers.Authorization).toBe('Bearer AT-3')
    })
  })
})

describe('applyProposal (project scope) and applyLibraryProposal', () => {
  const item = (over: Partial<McpServerSpec> & { projectOnly?: boolean } = {}) => ({ ...spec(), ...over })
  const payload = (upsert: ReturnType<typeof item>[], remove?: string[]) => ({ upsert, ...(remove ? { remove } : {}), rationale: 'r' })

  it('library scope upserts by id then name, removes entries, and saves nothing on any problem', () => {
    svc.libraryUpsert(entry())
    const id = 'mcpl_new'
    svc.applyLibraryProposal({ scope: 'library', ...payload([item({ id, name: 'github', enabled: true }), item({ id: 'zzz', name: 'docs', transport: 'http', command: undefined, args: undefined, secretEnv: undefined, url: 'https://docs.test/v2' })]) })
    expect(library.list().map((e) => [e.id, e.name, e.url])).toEqual([['mcpl_1', 'docs', 'https://docs.test/v2'], [id, 'github', undefined]])
    expect(library.get(id)).not.toHaveProperty('enabled')
    const before = JSON.stringify(library.list())
    expect(() => svc.applyLibraryProposal({ scope: 'library', ...payload([item({ id: 'ok', name: 'fine' }), item({ id: 'bad', name: 'bad', args: ['-y', 'pkg@latest'] })]) })).toThrow(/not pinned/)
    expect(JSON.stringify(library.list())).toBe(before)
    svc.applyLibraryProposal({ scope: 'library', ...payload([], ['mcpl_1']) })
    expect(library.list().map((e) => e.id)).toEqual([id])
  })

  it('project scope: libraryId links (or updates a link), unknown entries are a problem', () => {
    svc.libraryUpsert(stdioEntry())
    const linked = svc.applyProposal(pid, payload([item({ id: 'mcp-1', libraryId: 'mcpl_2', roles: ['lead'] })]))
    expect(linked.mcpServers![0]).toMatchObject({ id: 'mcp-1', libraryId: 'mcpl_2', roles: ['lead'], source: 'library' })
    const updated = svc.applyProposal(pid, payload([item({ id: 'other', libraryId: 'mcpl_2', roles: ['eng'], enabled: false })]))
    expect(updated.mcpServers).toHaveLength(1)
    expect(updated.mcpServers![0]).toMatchObject({ id: 'mcp-1', roles: ['eng'], enabled: false })
    expect(() => svc.applyProposal(pid, payload([item({ libraryId: 'nope' })]))).toThrow(/does not exist/)
  })

  it('project scope: a new server becomes a library entry linked under the item id; projectOnly stays in the project', () => {
    const r = svc.applyProposal(pid, payload([item({ id: 'p-gh' }), item({ id: 'p-db', name: 'local-db', projectOnly: true, args: ['-y', 'db@1.0.0'] })]))
    const gh = r.mcpServers!.find((s) => s.id === 'p-gh')!
    expect(gh.libraryId).toBeTruthy()
    expect(library.get(gh.libraryId!)).toMatchObject({ name: 'github', source: 'user' })
    const db = r.mcpServers!.find((s) => s.id === 'p-db')!
    expect(db.libraryId).toBeUndefined()
    expect(db).not.toHaveProperty('projectOnly')
    expect(library.list().map((e) => e.name)).toEqual(['github'])
  })

  it('project scope: a library name clash with a different definition is a problem; an identical one just links', () => {
    svc.libraryUpsert(stdioEntry())
    expect(() => svc.applyProposal(pid, payload([item({ id: 'p-gh', args: ['-y', '@y/other@1.0.0'] })]))).toThrow(/libraryId, or mark this server projectOnly/)
    expect(projects.get(pid)!.mcpServers ?? []).toEqual([])
    const r = svc.applyProposal(pid, payload([item({ id: 'p-gh' })]))
    expect(r.mcpServers![0].libraryId).toBe('mcpl_2')
    expect(library.list()).toHaveLength(1)
  })

  it('project scope: nothing is saved when any item is invalid (library entries included)', () => {
    expect(() => svc.applyProposal(pid, payload([item({ id: 'a', name: 'good' }), item({ id: 'b', name: 'bad', args: ['-y', 'x@latest'] })]))).toThrow(/Invalid MCP server/)
    expect(library.list()).toEqual([])
    expect(projects.get(pid)!.mcpServers ?? []).toEqual([])
  })

  it('project scope remove: unlinks links, deletes project-only servers and their secrets, drops grants', () => {
    svc.libraryUpsert(stdioEntry())
    svc.librarySetSecret({ libraryId: 'mcpl_2', kind: 'env', name: 'GITHUB_TOKEN', value: 'lib' })
    const linkId = svc.linkLibrary({ projectId: pid, libraryId: 'mcpl_2' }).servers[0].spec.id
    svc.upsert({ projectId: pid, spec: spec({ id: 'own', name: 'own' }) })
    svc.setSecret({ projectId: pid, serverId: 'own', kind: 'env', name: 'GITHUB_TOKEN', value: 'mine' })
    const p = projects.get(pid)!
    projects.save({ ...p, roles: p.roles.map((r, i) => (i === 0 ? { ...r, mcpServers: [linkId, 'own'] } : r)) })
    const r = svc.applyProposal(pid, payload([], [linkId, 'own']))
    expect(r.mcpServers).toEqual([])
    expect(r.roles[0].mcpServers).toEqual([])
    expect(secrets.keys(`mcp:${pid}:`)).toEqual([])
    expect(secrets.has(mcpLibrarySecretKey('mcpl_2', 'env', 'GITHUB_TOKEN'))).toBe(true)
  })

  it('a library-scope payload cannot be applied to a project', () => {
    expect(() => svc.applyProposal(pid, { scope: 'library', ...payload([]) })).toThrow(/library proposal/)
  })
})
