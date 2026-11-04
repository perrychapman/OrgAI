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

  it('is idempotent per connector for the same, missing or unknown variant', () => {
    const svc = build()
    const a = svc.connectorsAdd({ connectorId: 'linear' })
    const b = svc.connectorsAdd({ connectorId: 'linear' })
    const c = svc.connectorsAdd({ connectorId: 'linear', variant: 'readonly' })
    const d = svc.connectorsAdd({ connectorId: 'linear', variant: 'nope' })
    for (const x of [b, c, d]) expect(x.entry).toEqual(a.entry)
    expect(library.list()).toHaveLength(1)
    expect(libEvents).toHaveLength(1)
  })

  it('switches an unconnected token connector to another variant in place', () => {
    const svc = build()
    const a = svc.connectorsAdd({ connectorId: 'github' })
    expect(a.entry.headers).toEqual({ 'X-MCP-Readonly': 'true' })
    const b = svc.connectorsAdd({ connectorId: 'github', variant: 'full' })
    expect(b.entry.id).toBe(a.entry.id)
    expect(b.entry.name).toBe(a.entry.name)
    expect(b.entry.addedAt).toBe(a.entry.addedAt)
    expect(b.entry.connectorVariant).toBe('full')
    expect(b.entry.headers?.['X-MCP-Readonly']).toBeUndefined()
    expect(b.entry.secretHeaders).toEqual(['Authorization'])
    expect(b.entry.connectedAt).toBeUndefined()
    expect(secrets.get(mcpLibrarySecretKey(a.entry.id, 'header', 'Authorization'))).toBeUndefined()
    expect(b.missingSecrets).toEqual(['Authorization'])
    expect(library.list()).toHaveLength(1)
    expect(svc.connectorsList().find((c) => c.connector.id === 'github')!.variant).toBe('full')
    // Unknown id: untouched.
    expect(svc.connectorsAdd({ connectorId: 'github', variant: 'nope' }).entry).toEqual(b.entry)
  })

  it('locks the variant while connected and unlocks it on Disconnect', () => {
    const svc = build()
    svc.connectorsAdd({ connectorId: 'github' })
    svc.connectorsSetToken({ connectorId: 'github', token: 'ghp_1' })
    const locked = svc.connectorsAdd({ connectorId: 'github', variant: 'full' })
    expect(locked.entry.connectorVariant).toBe('readonly')
    expect(locked.entry.headers).toEqual({ 'X-MCP-Readonly': 'true' })
    svc.connectorsSetToken({ connectorId: 'github', token: null })
    const switched = svc.connectorsAdd({ connectorId: 'github', variant: 'full' })
    expect(switched.entry.connectorVariant).toBe('full')
    expect(switched.entry.id).toBe(locked.entry.id)
  })

  it('switching an OAuth connector variant drops its OAuth state and tokens', () => {
    const svc = build()
    const a = svc.connectorsAdd({ connectorId: 'cloudflare', variant: 'token' })
    const o = svc.connectorsAdd({ connectorId: 'cloudflare', variant: 'oauth' })
    expect(o.entry.id).toBe(a.entry.id)
    secrets.set(mcpLibraryOAuthKey(o.entry.id, 'clientSecret'), 'CS-stale')
    library.save({ ...library.get(o.entry.id)!, oauth: { resource: 'https://mcp.cloudflare.com/mcp', authorizationServer: 'https://x.example', hasClientSecret: false } })
    const t = svc.connectorsAdd({ connectorId: 'cloudflare', variant: 'token' })
    expect(t.entry.connectorVariant).toBe('token')
    expect(t.entry.oauth).toBeUndefined()
    expect(secrets.get(mcpLibraryOAuthKey(o.entry.id, 'clientSecret'))).toBeUndefined()
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

  it('a refresh never posts the client secret to a stored token endpoint off the connector domain', async () => {
    const svc = build()
    const { entry } = svc.connectorsAdd({ connectorId: 'gmail' })
    const base = flowResult(entry.url!).config
    runAuthorization.mockResolvedValue({ ...flowResult(entry.url!), config: { ...base, tokenEndpoint: 'https://evil.test/token', expiresAt: new Date(NOW + 60_000).toISOString() } })
    await svc.authorize({ libraryId: entry.id, clientId: 'gcp', clientSecret: 'shh' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await svc.refreshIfNeeded({ libraryId: entry.id })
    expect(refreshTokens).not.toHaveBeenCalled()
    expect(warn.mock.calls.join(' ')).toMatch(/not on the connector's domain/)
    warn.mockRestore()
  })

  it('a second fixed-port sign-in aborts the pending one and starts only after it released the port', async () => {
    const svc = build()
    const gmail = svc.connectorsAdd({ connectorId: 'gmail' }).entry
    const slack = svc.connectorsAdd({ connectorId: 'slack' }).entry
    const order: string[] = []
    runAuthorization.mockImplementationOnce(
      (input: AuthorizeFlowInput) =>
        new Promise((_resolve, reject) => {
          input.signal!.addEventListener('abort', () => {
            // The real flow closes its listener before it settles.
            order.push('first released')
            reject(new Error('Authorization was cancelled.'))
          })
        })
    )
    runAuthorization.mockImplementationOnce(async (input: AuthorizeFlowInput) => {
      order.push('second started')
      expect(input.signal!.aborted).toBe(false)
      return { ...flowResult(input.url), config: { ...flowResult(input.url).config, authorizationServer: 'https://slack.com' } }
    })
    const first = svc.authorize({ libraryId: gmail.id, clientId: 'gcp', clientSecret: 'shh' })
    await vi.waitFor(() => expect(runAuthorization).toHaveBeenCalledTimes(1))
    const second = await svc.authorize({ libraryId: slack.id, clientId: 'slk', clientSecret: 'sec' })
    expect(second.state).toBe('authorized')
    expect(await first).toEqual({ state: 'error', error: 'Authorization was cancelled: another sign-in started.' })
    expect(order).toEqual(['first released', 'second started'])
    // The superseded flow leaves no sticky error behind.
    expect(svc.authStatus({ libraryId: gmail.id }).state).not.toBe('error')
  })

  it('a DCR (ephemeral port) sign-in never aborts a pending fixed-port one', async () => {
    const svc = build()
    const gmail = svc.connectorsAdd({ connectorId: 'gmail' }).entry
    const notion = svc.connectorsAdd({ connectorId: 'notion' }).entry
    let firstSignal: AbortSignal | undefined
    runAuthorization.mockImplementationOnce((input: AuthorizeFlowInput) => {
      firstSignal = input.signal
      return new Promise(() => {})
    })
    runAuthorization.mockRejectedValueOnce(new Error('dcr failed'))
    void svc.authorize({ libraryId: gmail.id, clientId: 'gcp', clientSecret: 'shh' })
    await vi.waitFor(() => expect(runAuthorization).toHaveBeenCalledTimes(1))
    await svc.authorize({ libraryId: notion.id })
    expect(firstSignal!.aborted).toBe(false)
    svc.cancelAuthorize({ libraryId: gmail.id })
  })

  it('rejects client ids and secrets with control characters or past the length caps', async () => {
    const svc = build()
    const { entry } = svc.connectorsAdd({ connectorId: 'gmail' })
    await expect(svc.authorize({ libraryId: entry.id, clientId: 'a\nb', clientSecret: 's' })).rejects.toThrow(/client id must be a single line/)
    await expect(svc.authorize({ libraryId: entry.id, clientId: 'a\u007fb' })).rejects.toThrow(/client id/)
    await expect(svc.authorize({ libraryId: entry.id, clientId: 'x'.repeat(513) })).rejects.toThrow(/client id is too long/)
    await expect(svc.authorize({ libraryId: entry.id, clientId: 'gcp', clientSecret: 's\u0000' })).rejects.toThrow(/client secret must be a single line/)
    await expect(svc.authorize({ libraryId: entry.id, clientId: 'gcp', clientSecret: 's'.repeat(4001) })).rejects.toThrow(/client secret is too long/)
    // Nothing was stored by a refused call.
    expect(library.get(entry.id)!.oauth?.clientId).toBeUndefined()
    expect(secrets.get(mcpLibraryOAuthKey(entry.id, 'clientSecret'))).toBeUndefined()
    runAuthorization.mockResolvedValue(flowResult(entry.url!))
    const ok = await svc.authorize({ libraryId: entry.id, clientId: 'x'.repeat(512), clientSecret: 's'.repeat(4000) })
    expect(ok.state).toBe('authorized')
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

  it('never stores a placeholder client id, and ignores a legacy one outside mock mode', async () => {
    const svc = build(true)
    const notion = svc.connectorsAdd({ connectorId: 'notion' }).entry
    await svc.authorize({ libraryId: notion.id })
    expect(library.get(notion.id)!.oauth?.clientId).toBeUndefined()
    expect(library.get(notion.id)!.oauth?.clientSource).toBeUndefined()
    // A gmail entry an older mock build left with 'mock-client' still needs the user's own app outside mock mode.
    const gmail = svc.connectorsAdd({ connectorId: 'gmail' }).entry
    library.save({ ...library.get(gmail.id)!, oauth: { resource: gmail.url!, clientId: 'mock-client', clientSource: 'manual', hasClientSecret: true } })
    secrets.set(mcpLibraryOAuthKey(gmail.id, 'clientSecret'), 'shh')
    const real = build(false)
    const s = await real.authorize({ libraryId: gmail.id })
    expect(s).toMatchObject({ state: 'error', needsClientId: true })
    expect(runAuthorization).not.toHaveBeenCalled()
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

describe('auth kind none (DeepWiki, keyless Exa)', () => {
  it('adds with no secret slots or OAuth, is connected at once and stamps connectedAt', () => {
    const svc = build()
    const info = svc.connectorsAdd({ connectorId: 'deepwiki' })
    expect(info.entry).toMatchObject({ url: 'https://mcp.deepwiki.com/mcp', connectorId: 'deepwiki', connectedAt: NOW })
    expect(info.entry.secretHeaders).toBeUndefined()
    expect(info.entry.oauth).toBeUndefined()
    expect(info.missingSecrets).toEqual([])
    expect(info.auth.state).toBe('notRequired')
    expect(svc.connectorsList().find((c) => c.connector.id === 'deepwiki')).toMatchObject({ state: 'connected', connectedAt: NOW })
  })

  it('authorize answers notRequired without a flow, setToken refuses; a link resolves with no auth header and never copies connectedAt', async () => {
    const svc = build()
    const { entry } = svc.connectorsAdd({ connectorId: 'exa' })
    expect(entry.connectorVariant).toBe('free')
    const s = await svc.authorize({ libraryId: entry.id })
    expect(s).toEqual({ state: 'notRequired' })
    expect(runAuthorization).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(library.get(entry.id)!.oauth).toBeUndefined()
    expect(() => svc.connectorsSetToken({ connectorId: 'exa', token: 'k' })).toThrow(/needs no sign-in/)
    svc.linkLibrary({ projectId: pid, libraryId: entry.id })
    const link = projects.get(pid)!.mcpServers![0]
    expect('connectedAt' in link).toBe(false)
    expect(svc.resolve(pid, link).headers).toEqual({})
    expect(await svc.prepareForRun(pid, [link])).toEqual([])
  })

  it('the keyed Exa variant is a token connector with an x-api-key slot', () => {
    const svc = build()
    const { entry } = svc.connectorsAdd({ connectorId: 'exa', variant: 'key' })
    expect(entry.secretHeaders).toEqual(['x-api-key'])
    svc.connectorsSetToken({ connectorId: 'exa', token: 'exa-key' })
    expect(secrets.get(mcpLibrarySecretKey(entry.id, 'header', 'x-api-key'))).toBe('exa-key')
  })

  it('ORGAI_MOCK=1: tests without network and lists mock tools', async () => {
    const svc = build(true)
    const { entry } = svc.connectorsAdd({ connectorId: 'deepwiki' })
    const t = await svc.libraryTest({ libraryId: entry.id })
    expect(t.ok).toBe(true)
    expect(t.tools).toEqual(['search', 'read_page', 'ask_question'])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('ORGAI_MOCK=1 covers every catalog entry', () => {
  it('each connector connects (authorize, token or nothing) and tests without network', async () => {
    const svc = build(true)
    for (const def of CONNECTORS) {
      const { entry } = svc.connectorsAdd({ connectorId: def.id })
      const kind = def.variants.find((v) => v.id === def.defaultVariant)!.auth.kind
      if (kind === 'token') svc.connectorsSetToken({ connectorId: def.id, token: 'tok' })
      else if (kind === 'oauth') expect((await svc.authorize({ libraryId: entry.id })).state, def.id).toBe('authorized')
      else if (kind === 'oauthClient') expect((await svc.authorize({ libraryId: entry.id, clientId: 'c', clientSecret: 's' })).state, def.id).toBe('authorized')
      const t = await svc.libraryTest({ libraryId: entry.id })
      expect(t.ok, def.id).toBe(true)
      expect(t.tools!.length, def.id).toBeGreaterThan(0)
      expect(svc.connectorsList().find((c) => c.connector.id === def.id)!.connectedAt, def.id).toBe(NOW)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(runAuthorization).not.toHaveBeenCalled()
  })
})

describe('connectedAt', () => {
  it('is set by a token and cleared with it', () => {
    const svc = build()
    const { entry } = svc.connectorsAdd({ connectorId: 'github' })
    expect(entry.connectedAt).toBeUndefined()
    expect(svc.connectorsList().find((c) => c.connector.id === 'github')!.connectedAt).toBeUndefined()
    const info = svc.connectorsSetToken({ connectorId: 'github', token: 'ghp_1' })
    expect(info.entry.connectedAt).toBe(NOW)
    expect(svc.connectorsList().find((c) => c.connector.id === 'github')!.connectedAt).toBe(NOW)
    svc.connectorsSetToken({ connectorId: 'github', token: null })
    expect(library.get(entry.id)!.connectedAt).toBeUndefined()
  })

  it('is set by a real authorize, kept on a same-target edit, cleared by revoke', async () => {
    const svc = build()
    const { entry } = svc.connectorsAdd({ connectorId: 'notion' })
    runAuthorization.mockResolvedValue({
      config: { resource: 'https://mcp.notion.com/mcp', authorizationServer: 'https://mcp.notion.com', clientId: 'c', clientSource: 'dcr', authorizedAt: new Date(NOW).toISOString() },
      tokens: { accessToken: 'AT' }
    })
    expect((await svc.authorize({ libraryId: entry.id })).state).toBe('authorized')
    expect(library.get(entry.id)!.connectedAt).toBe(NOW)
    svc.libraryUpsert({ ...library.get(entry.id)!, description: 'mine', connectedAt: 1 })
    expect(library.get(entry.id)!.connectedAt).toBe(NOW)
    svc.revokeAuth({ libraryId: entry.id })
    expect(library.get(entry.id)!.connectedAt).toBeUndefined()
    expect(svc.connectorsList().find((c) => c.connector.id === 'notion')!.connectedAt).toBeUndefined()
  })

  it('is set by a mock authorize; a failed authorize leaves it unset; a mock stamp is hidden outside mock mode', async () => {
    const svc = build(true)
    const { entry } = svc.connectorsAdd({ connectorId: 'linear' })
    expect((await svc.authorize({ libraryId: entry.id })).state).toBe('authorized')
    expect(library.get(entry.id)!.connectedAt).toBe(NOW)
    const real = build(false)
    const gmail = real.connectorsAdd({ connectorId: 'gmail' }).entry
    await real.authorize({ libraryId: gmail.id })
    expect(library.get(gmail.id)!.connectedAt).toBeUndefined()
    const card = real.connectorsList().find((c) => c.connector.id === 'linear')!
    expect(card.state).toBe('needsSetup')
    expect(card.connectedAt).toBeUndefined()
  })

  it('cannot be forged through mcpLibrary:upsert on a custom entry', () => {
    const svc = build()
    svc.libraryUpsert({ id: 'mcpl_c', name: 'c', transport: 'http', url: 'https://c.example/mcp', source: 'user', addedAt: '2026-01-01T00:00:00.000Z', connectedAt: 5 })
    expect(library.get('mcpl_c')!.connectedAt).toBeUndefined()
  })

  it('old records load without it; malformed values are dropped on read', () => {
    const base = { transport: 'http' as const, source: 'user' as const, addedAt: '2026-01-01T00:00:00.000Z' }
    library.save({ ...base, id: 'mcpl_a', name: 'a', url: 'https://a.example/mcp', connectorId: 'notion', connectedAt: NOW })
    library.save({ ...base, id: 'mcpl_b', name: 'b', url: 'https://b.example/mcp', connectorId: 'linear', connectedAt: 'yesterday' as unknown as number })
    library.save({ ...base, id: 'mcpl_c', name: 'c', url: 'https://c.example/mcp', connectedAt: NOW })
    library.save({ ...base, id: 'mcpl_d', name: 'd', url: 'https://d.example/mcp' })
    const reread = new McpLibraryStore(join(dir, 'data'))
    expect(reread.get('mcpl_a')!.connectedAt).toBe(NOW)
    expect('connectedAt' in reread.get('mcpl_b')!).toBe(false)
    expect('connectedAt' in reread.get('mcpl_c')!).toBe(false)
    expect('connectedAt' in reread.get('mcpl_d')!).toBe(false)
    expect(structuredClone(reread.list())).toEqual(reread.list())
  })
})
