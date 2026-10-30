import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpLibraryEntry, McpLibraryInfo, McpServerSpec } from '@shared/types'
import { CONNECTORS, CONNECTOR_REDIRECT_PORT } from '@shared/connectors'
import { ProjectStore } from '../store/projects'
import { McpLibraryStore } from '../store/mcpLibrary'
import { SecretStore, mcpLibraryOAuthKey, mcpLibrarySecretKey } from '../store/secrets'
import { McpService } from './service'
import type { AuthorizeFlowInput } from './oauth'
import { MOCK_CONNECTOR_ACCOUNT } from './connectors'
import { toClaudeMcpServers } from '../runtime/claude'
import { buildLaunchConfig } from '../runtime/codexProtocol'

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
const runAuthorization = vi.fn()
const refreshTokens = vi.fn()
const openExternal = vi.fn(async () => {})
const fetchSpy = vi.fn(async () => {
  throw new Error('network is off in tests')
})

function build(mock = false): McpService {
  return new McpService({
    projects,
    secrets,
    library,
    now: () => NOW,
    fetch: fetchSpy as unknown as typeof fetch,
    openExternal,
    oauth: { runAuthorization, refreshTokens },
    onLibraryChanged: (e) => libEvents.push(e),
    mock
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-conn-'))
  projects = new ProjectStore(join(dir, 'data'))
  secrets = new SecretStore(join(dir, 'data'), cipher)
  library = new McpLibraryStore(join(dir, 'data'))
  libEvents = []
  runAuthorization.mockReset()
  refreshTokens.mockReset()
  openExternal.mockClear()
  fetchSpy.mockClear()
  pid = projects.create({ name: 'p', path: join(dir, 'repo'), brief: '' }).id
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('connectors:list and connectors:add', () => {
  it('lists every preset as available until added', () => {
    const list = build().connectorsList()
    expect(list.map((c) => c.connector.id)).toEqual(CONNECTORS.map((c) => c.id))
    expect(list.every((c) => c.state === 'available' && !c.library)).toBe(true)
  })

  it('builds the entry from the catalog only and broadcasts', () => {
    const svc = build()
    const input = { connectorId: 'linear', variant: 'full', url: 'https://evil.example/mcp', transport: 'stdio', command: 'calc' } as unknown as Parameters<McpService['connectorsAdd']>[0]
    const info = svc.connectorsAdd(input)
    expect(info.entry).toMatchObject({ name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp', connectorId: 'linear', connectorVariant: 'full' })
    expect(info.entry.command).toBeUndefined()
    expect(libEvents).toHaveLength(1)
    const card = svc.connectorsList().find((c) => c.connector.id === 'linear')!
    expect(card).toMatchObject({ variant: 'full', state: 'needsSetup' })
    expect(card.library!.entry.id).toBe(info.entry.id)
  })

  it('is idempotent per connector, whatever the variant', () => {
    const svc = build()
    const a = svc.connectorsAdd({ connectorId: 'linear' })
    const b = svc.connectorsAdd({ connectorId: 'linear', variant: 'full' })
    expect(b.entry.id).toBe(a.entry.id)
    expect(b.entry.url).toBe('https://mcp.linear.app/mcp/readonly')
    expect(library.list()).toHaveLength(1)
    expect(libEvents).toHaveLength(1)
  })

  it('rejects unknown connectors and avoids a custom entry name clash', () => {
    const svc = build()
    expect(() => svc.connectorsAdd({ connectorId: 'nope' })).toThrow(/Unknown connector/)
    expect(() => svc.connectorsAdd(null as unknown as { connectorId: string })).toThrow(/Unknown connector/)
    library.save({ id: 'mcpl_custom', name: 'github', transport: 'http', url: 'https://gh.example/mcp', source: 'user', addedAt: '2026-01-01T00:00:00.000Z' })
    expect(svc.connectorsAdd({ connectorId: 'github' }).entry.name).toBe('github-2')
  })
})

describe('connector fields are main-process only', () => {
  it('mcpLibrary:upsert cannot forge a connector id on a custom entry', () => {
    const svc = build()
    const forged: McpLibraryEntry = { id: 'mcpl_f', name: 'forged', transport: 'http', url: 'https://evil.example/mcp', source: 'user', addedAt: '2026-01-01T00:00:00.000Z', connectorId: 'gmail', connectorVariant: 'readonly' }
    svc.libraryUpsert(forged)
    expect(library.get('mcpl_f')!.connectorId).toBeUndefined()
    expect(svc.connectorsList().find((c) => c.connector.id === 'gmail')!.state).toBe('available')
  })

  it('a connector entry keeps its id on a same-target edit and refuses a retarget', () => {
    const svc = build()
    const { entry } = svc.connectorsAdd({ connectorId: 'gmail' })
    svc.libraryUpsert({ ...entry, description: 'mine' })
    expect(library.get(entry.id)).toMatchObject({ connectorId: 'gmail', description: 'mine' })
    expect(() => svc.libraryUpsert({ ...entry, url: 'https://evil.example/mcp' })).toThrow(/is a connector/)
    expect(() => svc.libraryUpsert({ ...entry, headers: { 'X-Extra': '1' } })).toThrow(/is a connector/)
    expect(library.get(entry.id)!.url).toBe('https://gmailmcp.googleapis.com/mcp/v1')
  })

  it('a proposal that redefines a connector entry drops the connector id and its OAuth state', async () => {
    const svc = build(true)
    const { entry } = svc.connectorsAdd({ connectorId: 'notion' })
    await svc.authorize({ libraryId: entry.id })
    svc.applyLibraryProposal({ scope: 'library', upsert: [{ ...entry, enabled: true, headers: { 'X-Extra': '1' } } as McpServerSpec] } as Parameters<McpService['applyLibraryProposal']>[0])
    const after = library.get(entry.id)!
    expect(after.connectorId).toBeUndefined()
    expect(after.oauth).toBeUndefined()
    expect(secrets.get(mcpLibraryOAuthKey(entry.id, 'accessToken'))).toBeUndefined()
  })

  it('a project-only server and an install never carry a connector id', () => {
    const svc = build()
    const spec: McpServerSpec = { id: 'mcp-x', name: 'x', transport: 'http', url: 'https://x.example/mcp', enabled: true, source: 'user', addedAt: '2026-01-01T00:00:00.000Z', connectorId: 'slack' }
    const r = svc.upsert({ projectId: pid, spec })
    expect(r.project.mcpServers![0].connectorId).toBeUndefined()
    const p = svc.persistInstall(pid, { ...spec, id: 'mcp-y', name: 'y', connectorId: 'gmail' }, {}, 'library')
    expect(p.mcpServers!.find((s) => s.id === 'mcp-y')!.connectorId).toBeUndefined()
    expect(library.list().every((e) => !e.connectorId)).toBe(true)
  })
})

describe('connectors:setToken', () => {
  it('stores the token with its prefix, flips the state, clears with null', () => {
    const svc = build()
    expect(() => svc.connectorsSetToken({ connectorId: 'github', token: 'x' })).toThrow(/Add GitHub first/)
    const { entry } = svc.connectorsAdd({ connectorId: 'github' })
    const info = svc.connectorsSetToken({ connectorId: 'github', token: ' ghp_123 ' })
    expect(info.missingSecrets).toEqual([])
    expect(secrets.get(mcpLibrarySecretKey(entry.id, 'header', 'Authorization'))).toBe('Bearer ghp_123')
    expect(svc.connectorsList().find((c) => c.connector.id === 'github')!.state).toBe('connected')
    // A link resolves the header like any library entry.
    svc.linkLibrary({ projectId: pid, libraryId: entry.id })
    const link = projects.get(pid)!.mcpServers![0]
    expect(svc.resolve(pid, link).headers).toEqual({ 'X-MCP-Readonly': 'true', Authorization: 'Bearer ghp_123' })
    svc.connectorsSetToken({ connectorId: 'github', token: null })
    expect(secrets.get(mcpLibrarySecretKey(entry.id, 'header', 'Authorization'))).toBeUndefined()
  })

  it('refuses OAuth connectors and non-string tokens', () => {
    const svc = build()
    svc.connectorsAdd({ connectorId: 'notion' })
    expect(() => svc.connectorsSetToken({ connectorId: 'notion', token: 'x' })).toThrow(/OAuth/)
    svc.connectorsAdd({ connectorId: 'github' })
    expect(() => svc.connectorsSetToken({ connectorId: 'github', token: 42 as unknown as string })).toThrow(/text/)
  })
})

describe('authorize with a connector preset (real flow, faked)', () => {
  const flowResult = (url: string) => ({
    config: { resource: url, authorizationServer: 'https://accounts.google.com', tokenEndpoint: 'https://oauth2.googleapis.com/token', clientId: 'gcp', clientSource: 'manual' as const, hasClientSecret: true, authorizedAt: new Date(NOW).toISOString() },
    tokens: { accessToken: 'AT-1', refreshToken: 'RT-1' }
  })

  it('asks for client id and secret before any flow for oauthClient connectors', async () => {
    const svc = build()
    const { entry } = svc.connectorsAdd({ connectorId: 'gmail' })
    const s1 = await svc.authorize({ libraryId: entry.id })
    expect(s1).toMatchObject({ state: 'error', needsClientId: true })
    expect(s1.error).toMatch(/client id and client secret/)
    const s2 = await svc.authorize({ libraryId: entry.id, clientId: 'gcp' })
    expect(s2).toMatchObject({ state: 'error', needsClientId: true })
    expect(runAuthorization).not.toHaveBeenCalled()
  })

  it('passes the preset (fixed port, endpoints, scopes) and stores the tokens', async () => {
    const svc = build()
    const { entry } = svc.connectorsAdd({ connectorId: 'gmail' })
    runAuthorization.mockResolvedValue(flowResult(entry.url!))
    const s = await svc.authorize({ libraryId: entry.id, clientId: 'gcp', clientSecret: 'shh' })
    expect(s.state).toBe('authorized')
    const input = runAuthorization.mock.calls[0][0] as AuthorizeFlowInput
    expect(input.preset).toMatchObject({ redirectPort: CONNECTOR_REDIRECT_PORT, endpointsMode: 'replace', sendResource: false })
    expect(input.clientSecret).toBe('shh')
    expect(secrets.get(mcpLibraryOAuthKey(entry.id, 'accessToken'))).toBe('AT-1')
    expect(svc.connectorsList().find((c) => c.connector.id === 'gmail')!.state).toBe('connected')
    // Runs: a linked connector entry resolves with the bearer, like any library entry.
    svc.linkLibrary({ projectId: pid, libraryId: entry.id })
    const enabled = svc.enabledServers(projects.get(pid)!)
    expect(enabled).toHaveLength(1)
    expect(enabled[0]).toMatchObject({ name: 'gmail', libraryId: entry.id, connectorId: 'gmail' })
    const resolved = [svc.resolve(pid, enabled[0])]
    expect(resolved[0].headers.Authorization).toBe('Bearer AT-1')
    expect(toClaudeMcpServers(resolved)).toEqual({ gmail: { type: 'http', url: 'https://gmailmcp.googleapis.com/mcp/v1', headers: { Authorization: 'Bearer AT-1' } } })
    const codex = buildLaunchConfig(undefined, resolved)
    expect(codex.config.join('\n')).toContain('gmailmcp.googleapis.com')
    expect(codex.config.join('\n')).not.toContain('AT-1')
  })

  it('a refresh passes the preset token options', async () => {
    const svc = build()
    const { entry } = svc.connectorsAdd({ connectorId: 'gmail' })
    runAuthorization.mockResolvedValue({ ...flowResult(entry.url!), config: { ...flowResult(entry.url!).config, expiresAt: new Date(NOW + 60_000).toISOString() } })
    await svc.authorize({ libraryId: entry.id, clientId: 'gcp', clientSecret: 'shh' })
    refreshTokens.mockResolvedValue({ accessToken: 'AT-2', expiresAt: new Date(NOW + 3_600_000).toISOString() })
    await svc.refreshIfNeeded({ libraryId: entry.id })
    expect(refreshTokens.mock.calls[0][1]).toMatchObject({ refreshToken: 'RT-1', clientSecret: 'shh', sendResource: false })
  })

  it('a token connector is never authorized with OAuth', async () => {
    const svc = build()
    const { entry } = svc.connectorsAdd({ connectorId: 'github' })
    const s = await svc.authorize({ libraryId: entry.id })
    expect(s.state).toBe('error')
    expect(runAuthorization).not.toHaveBeenCalled()
  })

  it('without ORGAI_MOCK the test goes to the network (here: refused) and no mock tools appear', async () => {
    const svc = build(false)
    const { entry } = svc.connectorsAdd({ connectorId: 'notion' })
    const r = await svc.libraryTest({ libraryId: entry.id })
    expect(r.ok).toBe(false)
    expect(r.tools).toBeUndefined()
    expect(fetchSpy).toHaveBeenCalled()
  })
})

describe('ORGAI_MOCK=1 connectors', () => {
  it('authorize an oauthClient connector without network or browser once a client is entered', async () => {
    const svc = build(true)
    const { entry } = svc.connectorsAdd({ connectorId: 'gmail' })
    expect((await svc.authorize({ libraryId: entry.id })).needsClientId).toBe(true)
    const s = await svc.authorize({ libraryId: entry.id, clientId: 'gcp', clientSecret: 'shh' })
    expect(s).toMatchObject({ state: 'authorized', account: MOCK_CONNECTOR_ACCOUNT })
    expect(runAuthorization).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    const t = await svc.libraryTest({ libraryId: entry.id })
    expect(t.ok).toBe(true)
    expect(t.tools!.length).toBeGreaterThan(0)
    // A linked project server tests the same way.
    const link = svc.linkLibrary({ projectId: pid, libraryId: entry.id }).project.mcpServers![0]
    expect((await svc.test({ projectId: pid, serverId: link.id })).ok).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('DCR connectors authorize in one click; revoke returns to needsSetup', async () => {
    const svc = build(true)
    const { entry } = svc.connectorsAdd({ connectorId: 'notion' })
    expect((await svc.libraryTest({ libraryId: entry.id })).needsAuthorization).toBe(true)
    expect((await svc.authorize({ libraryId: entry.id })).state).toBe('authorized')
    svc.revokeAuth({ libraryId: entry.id })
    expect(svc.connectorsList().find((c) => c.connector.id === 'notion')!.state).toBe('needsSetup')
  })

  it('a mock token left in the data dir is never used outside mock mode', async () => {
    const mockSvc = build(true)
    const { entry } = mockSvc.connectorsAdd({ connectorId: 'notion' })
    await mockSvc.authorize({ libraryId: entry.id })
    mockSvc.linkLibrary({ projectId: pid, libraryId: entry.id })
    const real = build(false)
    expect(real.connectorsList().find((c) => c.connector.id === 'notion')!.state).toBe('needsSetup')
    const link = projects.get(pid)!.mcpServers![0]
    expect(real.resolve(pid, link).headers.Authorization).toBeUndefined()
    expect(await real.prepareForRun(pid, [link])).toEqual(['notion'])
  })

  it('ordinary library entries are untouched by the mock', async () => {
    const svc = build(true)
    library.save({ id: 'mcpl_plain', name: 'plain', transport: 'http', url: 'https://plain.example/mcp', source: 'user', addedAt: '2026-01-01T00:00:00.000Z' })
    runAuthorization.mockRejectedValue(new Error('real flow'))
    const s = await svc.authorize({ libraryId: 'mcpl_plain' })
    expect(s.state).toBe('error')
    expect(runAuthorization).toHaveBeenCalledTimes(1)
    const t = await svc.libraryTest({ libraryId: 'mcpl_plain' })
    expect(t.tools).toBeUndefined()
  })
})
