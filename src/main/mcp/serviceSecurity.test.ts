import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpLibraryEntry, McpServerSpec, McpServersProposalPayload } from '@shared/types'
import { ProjectStore } from '../store/projects'
import { McpLibraryStore } from '../store/mcpLibrary'
import { SecretStore, mcpLibraryOAuthKey, mcpLibrarySecretKey, mcpOAuthKey, mcpSecretKey } from '../store/secrets'
import { McpService } from './service'
import type { AuthorizeFlowInput } from './oauth'

// Regression tests for the MCP library + OAuth security review (H1, M3, M5, L8, L10, L12).

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
const runAuthorization = vi.fn()
const refreshTokens = vi.fn()

const REMOTE: McpLibraryEntry = {
  id: 'mcpl_1',
  name: 'docs',
  transport: 'http',
  url: 'https://docs.test/mcp',
  secretHeaders: ['X-Key'],
  source: 'user',
  addedAt: '2026-01-01T00:00:00.000Z'
}

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
const remoteSpec = (over: Partial<McpServerSpec> = {}): McpServerSpec =>
  spec({ transport: 'http', command: undefined, args: undefined, secretEnv: undefined, url: 'https://own.test/mcp', ...over })

const flow = (resource = 'https://docs.test/mcp') => ({
  config: { resource, tokenEndpoint: 'https://as.test/token', clientId: 'cid', clientSource: 'dcr' as const, authorizationServer: 'https://as.test', authorizedAt: iso(NOW), expiresAt: iso(NOW + 3_600_000) },
  tokens: { accessToken: 'AT-1', refreshToken: 'RT-1', expiresAt: iso(NOW + 3_600_000) }
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-mcpsec-'))
  projects = new ProjectStore(join(dir, 'data'))
  secrets = new SecretStore(join(dir, 'data'), cipher)
  library = new McpLibraryStore(join(dir, 'data'))
  runAuthorization.mockReset()
  refreshTokens.mockReset()
  svc = new McpService({ projects, secrets, library, now: () => NOW, openExternal: async () => {}, oauth: { runAuthorization, refreshTokens } })
  pid = projects.create({ name: 'p', path: join(dir, 'repo'), brief: '' }).id
  svc.libraryUpsert(REMOTE)
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('H1: persistInstall', () => {
  it('refuses an id that exists in the project or the library', () => {
    svc.upsert({ projectId: pid, spec: spec({ id: 'mcp-1' }) })
    expect(() => svc.persistInstall(pid, spec({ id: 'mcp-1', name: 'other' }), {})).toThrow(/already exists/)
    expect(() => svc.persistInstall(pid, spec({ id: 'mcpl_1', name: 'other' }), {})).toThrow(/already exists/)
  })

  it('refuses a spec carrying a library link', () => {
    expect(() => svc.persistInstall(pid, spec({ id: 'n1', name: 'n1', libraryId: 'mcpl_1' }), {})).toThrow(/library link/)
  })

  it('drops a renderer-supplied oauth block', () => {
    const p = svc.persistInstall(pid, remoteSpec({ id: 'n2', name: 'n2', oauth: { tokenEndpoint: 'https://attacker.test/token' } }), {})
    expect(p.mcpServers!.find((s) => s.id === 'n2')!.oauth).toBeUndefined()
  })
})

describe('M3: tokens are bound to the server url', () => {
  it('discards tokens when the url changed while the browser was open', async () => {
    runAuthorization.mockImplementation(async () => {
      svc.libraryUpsert({ ...REMOTE, url: 'https://moved.test/mcp' })
      return flow()
    })
    const status = await svc.authorize({ libraryId: 'mcpl_1' })
    expect(status.state).toBe('error')
    expect(secrets.has(mcpLibraryOAuthKey('mcpl_1', 'accessToken'))).toBe(false)
    expect(library.get('mcpl_1')?.oauth).toBeUndefined()
  })

  it('an edit that changes the endpoint aborts the in-flight authorization', async () => {
    let signal: AbortSignal | undefined
    runAuthorization.mockImplementation(async (i: AuthorizeFlowInput) => {
      signal = i.signal
      svc.libraryUpsert({ ...REMOTE, url: 'https://moved.test/mcp' })
      return flow()
    })
    await svc.authorize({ libraryId: 'mcpl_1' })
    expect(signal?.aborted).toBe(true)
  })

  it('a proposal that changes the endpoint aborts the in-flight authorization', async () => {
    let signal: AbortSignal | undefined
    runAuthorization.mockImplementation(async (i: AuthorizeFlowInput) => {
      signal = i.signal
      svc.applyLibraryProposal({ scope: 'library', upsert: [{ ...REMOTE, url: 'https://moved.test/mcp', enabled: true }] } as McpServersProposalPayload)
      return flow()
    })
    await svc.authorize({ libraryId: 'mcpl_1' })
    expect(signal?.aborted).toBe(true)
    expect(secrets.has(mcpLibraryOAuthKey('mcpl_1', 'accessToken'))).toBe(false)
  })

  it('resolve injects the bearer only when the oauth resource matches the server url', async () => {
    runAuthorization.mockResolvedValue(flow())
    await svc.authorize({ libraryId: 'mcpl_1' })
    const link = spec({ id: 'x', name: 'docs', transport: 'http', url: 'https://docs.test/mcp', libraryId: 'mcpl_1', source: 'library' })
    expect(svc.resolve(pid, link).headers.Authorization).toBe('Bearer AT-1')
    // A stored config bound to another resource is never used for this url.
    const cur = library.get('mcpl_1')!
    library.save({ ...cur, oauth: { ...cur.oauth!, resource: 'https://other.test/mcp' } })
    expect(svc.resolve(pid, link).headers.Authorization).toBeUndefined()
  })
})

describe('M5: retargeting through a proposal clears secret values', () => {
  it('library: an apply that changes the url clears values; a user edit keeps them', () => {
    secrets.set(mcpLibrarySecretKey('mcpl_1', 'header', 'X-Key'), 'K')
    svc.libraryUpsert({ ...REMOTE, url: 'https://docs.test/mcp2' })
    expect(secrets.get(mcpLibrarySecretKey('mcpl_1', 'header', 'X-Key'))).toBe('K')
    svc.applyLibraryProposal({ scope: 'library', upsert: [{ ...REMOTE, url: 'https://docs.test/mcp2', enabled: true }] } as McpServersProposalPayload)
    expect(secrets.get(mcpLibrarySecretKey('mcpl_1', 'header', 'X-Key'))).toBe('K')
    svc.applyLibraryProposal({ scope: 'library', upsert: [{ ...REMOTE, url: 'https://elsewhere.test/mcp', enabled: true }] } as McpServersProposalPayload)
    expect(secrets.has(mcpLibrarySecretKey('mcpl_1', 'header', 'X-Key'))).toBe(false)
  })

  it('project: an apply that changes args clears values of a project-only server', () => {
    svc.upsert({ projectId: pid, spec: spec({ id: 'gh', name: 'gh' }) })
    secrets.set(mcpSecretKey(pid, 'gh', 'env', 'GITHUB_TOKEN'), 'T')
    svc.applyProposal(pid, { scope: 'project', upsert: [spec({ id: 'gh', name: 'gh' })] } as McpServersProposalPayload)
    expect(secrets.get(mcpSecretKey(pid, 'gh', 'env', 'GITHUB_TOKEN'))).toBe('T')
    svc.applyProposal(pid, { scope: 'project', upsert: [spec({ id: 'gh', name: 'gh', args: ['-y', '@evil/github@1.0.0'] })] } as McpServersProposalPayload)
    expect(secrets.has(mcpSecretKey(pid, 'gh', 'env', 'GITHUB_TOKEN'))).toBe(false)
  })
})

describe('L8: secret kinds', () => {
  it('setSecret and librarySetSecret refuse anything but env and header', () => {
    svc.upsert({ projectId: pid, spec: remoteSpec({ id: 'own', name: 'own', secretHeaders: ['accessToken'] }) })
    expect(() => svc.setSecret({ projectId: pid, serverId: 'own', kind: 'oauth' as never, name: 'accessToken', value: 'x' })).toThrow(/Unknown secret kind/)
    expect(() => svc.librarySetSecret({ libraryId: 'mcpl_1', kind: 'oauth' as never, name: 'X-Key', value: 'x' })).toThrow(/Unknown secret kind/)
    expect(secrets.has(mcpOAuthKey(pid, 'own', 'accessToken'))).toBe(false)
  })
})

describe('L10: client secrets', () => {
  it('passes the stored secret as storedClientSecret and only an entered one as clientSecret', async () => {
    secrets.set(mcpLibraryOAuthKey('mcpl_1', 'clientSecret'), 'STORED')
    runAuthorization.mockResolvedValue(flow())
    await svc.authorize({ libraryId: 'mcpl_1' })
    let input = runAuthorization.mock.calls.at(-1)![0] as AuthorizeFlowInput
    expect(input.clientSecret).toBeUndefined()
    expect(input.storedClientSecret).toBe('STORED')
    await svc.authorize({ libraryId: 'mcpl_1', clientId: 'mine', clientSecret: 'TYPED' })
    input = runAuthorization.mock.calls.at(-1)![0] as AuthorizeFlowInput
    expect(input.clientSecret).toBe('TYPED')
    expect(input.storedClientSecret).toBeUndefined()
  })
})

describe('L12: promote', () => {
  it('aborts the owner’s in-flight authorization', async () => {
    svc.upsert({ projectId: pid, spec: remoteSpec({ id: 'own', name: 'own' }) })
    let signal: AbortSignal | undefined
    runAuthorization.mockImplementation(async (i: AuthorizeFlowInput) => {
      signal = i.signal
      svc.promote({ projectId: pid, serverId: 'own' })
      return flow('https://own.test/mcp')
    })
    const status = await svc.authorize({ projectId: pid, serverId: 'own' })
    expect(signal?.aborted).toBe(true)
    expect(status.state).toBe('error')
    expect(secrets.has(mcpOAuthKey(pid, 'own', 'accessToken'))).toBe(false)
  })

  it('keeps the source secrets when a save fails', () => {
    svc.upsert({ projectId: pid, spec: spec({ id: 'p2', name: 'p2' }) })
    secrets.set(mcpSecretKey(pid, 'p2', 'env', 'GITHUB_TOKEN'), 'T')
    vi.spyOn(projects, 'save').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(() => svc.promote({ projectId: pid, serverId: 'p2' })).toThrow(/disk full/)
    expect(secrets.get(mcpSecretKey(pid, 'p2', 'env', 'GITHUB_TOKEN'))).toBe('T')
    expect(library.list().some((e) => e.name === 'p2')).toBe(false)
    expect(secrets.keys('mcplib:').some((k) => k.endsWith('GITHUB_TOKEN'))).toBe(false)
  })
})
