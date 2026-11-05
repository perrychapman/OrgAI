import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorInfo, HostScope, McpLibraryInfo, McpServerInfo, McpServerSpec } from '../../shared/types'
import { CONNECTORS } from '../../shared/connectors'
import { manageDeps } from '../manage'
import { fakeContext, FakeHostClient, project, rpcError, type FakeContextOptions } from '../testing/fakeContext'
import { CliError, EXIT } from '../types'
import { assistInput, mcpDeps, runMcp } from './mcp'
import { parsePairs } from './mcp/common'

const realDeps = { ...manageDeps }
const realMcpDeps = { ...mcpDeps }
afterEach(() => {
  Object.assign(manageDeps, realDeps)
  Object.assign(mcpDeps, realMcpDeps)
  vi.restoreAllMocks()
})

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide', 'configure'] }
const P = project('p1', '/work', { name: 'Work' })

const spec = (over: Partial<McpServerSpec> = {}): McpServerSpec => ({
  id: 'mcp_1',
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
const info = (s: McpServerSpec, over: Partial<McpServerInfo> = {}): McpServerInfo => ({
  spec: s,
  envSet: [],
  headersSet: [],
  missingSecrets: s.secretEnv ?? [],
  auth: { state: 'notRequired' },
  ...over
})

function setup(answers: Record<string, (p: unknown) => unknown>, o: FakeContextOptions = {}) {
  const client = new FakeHostClient({ 'projects:list': () => [P], 'host.subscribe': () => ({ topics: ['connections'] }), ...answers }, { hello: ALL })
  const f = fakeContext({ connect: [client], ...o })
  return { client, f }
}

async function run(f: ReturnType<typeof fakeContext>, args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const code = await runMcp(f.ctx, args)
    return { code, out: f.out(), err: f.err() }
  } catch (e) {
    if (e instanceof CliError) return { code: e.exitCode, out: f.out(), err: `${f.err()}${e.message}` }
    throw e
  }
}

describe('NAME=VALUE parsing', () => {
  it('splits on the first =, refuses an empty name, a missing = and a repeat', () => {
    expect(parsePairs(['A=b=c', 'B='], 'env')).toEqual({ A: 'b=c', B: '' })
    for (const bad of [['=x'], ['NOEQ'], ['A=1', 'A=2']]) {
      try {
        parsePairs(bad, 'env')
        throw new Error('expected a refusal')
      } catch (e) {
        expect((e as CliError).exitCode).toBe(EXIT.usage)
      }
    }
  })
})

describe('mcp add', () => {
  it('maps flags to an mcp:upsert spec with secret slots by name only', async () => {
    const { client, f } = setup({ 'mcp:upsert': (p) => ({ project: P, servers: [info((p as [{ spec: McpServerSpec }])[0].spec)] }) })
    const r = await run(f, ['add', 'github', '--command', 'npx', '--arg', '-y', '--arg', '@x/github@1.4.2', '--env', 'LOG=debug', '--secret-var', 'GITHUB_TOKEN', '--description', 'GitHub', '--disabled'])
    expect(r.code).toBe(0)
    const [input] = client.callsOf('mcp:upsert')[0] as [{ projectId: string; spec: McpServerSpec }]
    expect(input.projectId).toBe('p1')
    expect(input.spec).toMatchObject({ name: 'github', transport: 'stdio', command: 'npx', args: ['-y', '@x/github@1.4.2'], env: { LOG: 'debug' }, secretEnv: ['GITHUB_TOKEN'], enabled: false, source: 'user', description: 'GitHub' })
    expect(input.spec.id).toMatch(/^mcp_/)
    expect(r.out).toContain('Added github to Work (disabled).')
    expect(r.out).toContain('orgai mcp set-secret github')
  })

  it('a remote server takes --url, --header and --secret-header', async () => {
    const { client, f } = setup({ 'mcp:upsert': (p) => ({ project: P, servers: [info((p as [{ spec: McpServerSpec }])[0].spec, { missingSecrets: [] })] }) })
    expect((await run(f, ['add', 'docs', '--url', 'https://docs.test/mcp', '--header', 'X-Org=acme', '--secret-header', 'Authorization'])).code).toBe(0)
    const [input] = client.callsOf('mcp:upsert')[0] as [{ spec: McpServerSpec }]
    expect(input.spec).toMatchObject({ transport: 'http', url: 'https://docs.test/mcp', headers: { 'X-Org': 'acme' }, secretHeaders: ['Authorization'] })
    expect(input.spec.command).toBeUndefined()
  })

  it.each([
    [['add', 'x', '--command', 'a', '--env', 'A=1', '--env', 'A=2']],
    [['add', 'x', '--command', 'a', '--env', '=1']],
    [['add', 'x', '--command', 'a', '--secret-var', 'TOKEN=abc']],
    [['add', 'x', '--command', 'a', '--url', 'https://x.test']],
    [['add', 'x']],
    [['add', 'x', '--url', 'https://x.test', '--env', 'A=1']],
    [['add', 'x', '--command', 'a', '--env', 'A=1', '--secret-var', 'A']]
  ])('%j is a usage error before any host call', async (args) => {
    const { client, f } = setup({})
    const r = await run(f, args)
    expect(r.code).toBe(EXIT.usage)
    expect(client.calls).toHaveLength(0)
  })

  it("the host's validateSpec refusal reaches the user with its sentence", async () => {
    const { f } = setup({ 'mcp:upsert': () => Promise.reject(rpcError({ code: 'bad_request', message: 'Pin an exact version of @x/github.' })) })
    const r = await run(f, ['add', 'github', '--command', 'npx', '--arg', '@x/github'])
    expect(r.code).toBe(EXIT.usage)
    expect(r.err).toContain('Pin an exact version')
  })
})

describe('mcp list / show / enable / remove', () => {
  it('lists transport, enabled, auth, missing secrets, the library link and a secret clash', async () => {
    const a = spec()
    const b = spec({ id: 'mcp_2', name: 'gh-two', libraryId: 'mcpl_1', source: 'library' })
    const { f } = setup({ 'mcp:list': () => [info(a), info(b, { auth: { state: 'authorized' }, missingSecrets: [] })] })
    const r = await run(f, ['list'])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/github\s+stdio\s+on\s+-\s+GITHUB_TOKEN\s+-/)
    expect(r.out).toMatch(/gh-two\s+stdio\s+on\s+authorized\s+-\s+linked/)
    expect(r.out).toContain('Shares the secret name GITHUB_TOKEN with gh-two')
  })

  it('resolves by name within this project only and sanitizes server text', async () => {
    const s = spec({ description: 'evil \x1b[31mred\x1b[0m' })
    const { f } = setup({ 'mcp:list': () => [info(s)] })
    const r = await run(f, ['show', 'github'])
    expect(r.code).toBe(0)
    expect(r.out).not.toContain('\x1b')
    expect(r.out).toContain('GITHUB_TOKEN (missing)')
    const miss = await run(setup({ 'mcp:list': () => [info(s)] }).f, ['show', 'nope'])
    expect(miss.code).toBe(EXIT.usage)
  })

  it('enable / disable upsert the stored spec with enabled flipped', async () => {
    const s = spec({ enabled: false })
    const { client, f } = setup({ 'mcp:list': () => [info(s)], 'mcp:upsert': (p) => ({ project: P, servers: [info((p as [{ spec: McpServerSpec }])[0].spec)] }) })
    expect((await run(f, ['enable', 'github'])).code).toBe(0)
    expect((client.callsOf('mcp:upsert')[0] as [{ spec: McpServerSpec }])[0].spec).toEqual({ ...s, enabled: true })
  })

  it('remove without a terminal needs --yes; with --yes it removes', async () => {
    const { client, f } = setup({ 'mcp:list': () => [info(spec())], 'mcp:remove': () => ({ project: P, servers: [] }) })
    expect((await run(f, ['remove', 'github'])).code).toBe(EXIT.usage)
    expect(client.callsOf('mcp:remove')).toHaveLength(0)
    const g = setup({ 'mcp:list': () => [info(spec())], 'mcp:remove': () => ({ project: P, servers: [] }) })
    expect((await run(g.f, ['remove', 'github', '--yes'])).code).toBe(0)
    expect(g.client.callsOf('mcp:remove')[0]).toEqual([{ projectId: 'p1', serverId: 'mcp_1' }])
  })
})

describe('mcp set-secret', () => {
  const answers = () => ({ 'mcp:list': () => [info(spec())], 'mcp:setSecret': () => ({ project: P, servers: [] }) })

  it('reads the value from the environment and never prints it', async () => {
    const { client, f } = setup(answers(), { env: { MY_TOKEN: 'ghp_supersecret' }, globals: { outputFormat: 'json' } })
    const r = await run(f, ['set-secret', 'github', 'GITHUB_TOKEN', '--from-env', 'MY_TOKEN'])
    expect(r.code).toBe(0)
    expect(client.callsOf('mcp:setSecret')[0]).toEqual([{ projectId: 'p1', serverId: 'mcp_1', kind: 'env', name: 'GITHUB_TOKEN', value: 'ghp_supersecret' }])
    expect(r.out + r.err).not.toContain('ghp_supersecret')
    expect(JSON.parse(r.out)).toMatchObject({ name: 'GITHUB_TOKEN', set: true })
  })

  it('reads stdin (one trailing newline trimmed) and never prints it', async () => {
    manageDeps.readStdin = async () => 'from-stdin-secret\n'
    const { client, f } = setup(answers())
    const r = await run(f, ['set-secret', 'github', 'GITHUB_TOKEN', '--stdin'])
    expect(r.code).toBe(0)
    expect((client.callsOf('mcp:setSecret')[0] as [{ value: string }])[0].value).toBe('from-stdin-secret')
    expect(r.out + r.err).not.toContain('from-stdin-secret')
  })

  it('--clear sends null; a value on argv is refused', async () => {
    const { client, f } = setup(answers())
    expect((await run(f, ['set-secret', 'github', 'GITHUB_TOKEN', '--clear'])).code).toBe(0)
    expect((client.callsOf('mcp:setSecret')[0] as [{ value: unknown }])[0].value).toBeNull()
    const g = setup(answers())
    expect((await run(g.f, ['set-secret', 'github', 'GITHUB_TOKEN', 'plain-value'])).code).toBe(EXIT.usage)
    expect((await run(setup(answers()).f, ['set-secret', 'github', 'GITHUB_TOKEN'])).code).toBe(EXIT.usage)
  })
})

describe('mcp auth', () => {
  const remote = spec({ id: 'mcp_r', name: 'docs', transport: 'http', url: 'https://docs.test/mcp', command: undefined, args: undefined, secretEnv: undefined })
  const URL_ = 'https://as.test/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A38917%2Fcallback&state=s'

  function authSetup(o: FakeContextOptions, answer: (client: FakeHostClient, input: Record<string, unknown>) => unknown) {
    let c!: FakeHostClient
    const s = setup(
      {
        'mcp:list': () => [info(remote, { missingSecrets: [] })],
        'mcp:authorize': (p) => answer(c, (p as [Record<string, unknown>])[0]),
        'mcp:cancelAuthorize': () => undefined
      },
      o
    )
    c = s.client
    return s
  }

  const announce = (client: FakeHostClient, target: unknown, openedBrowser: boolean): void =>
    client.push('connections:event', { type: 'mcp.authorize', authorize: { target, url: URL_, redirectUri: 'http://127.0.0.1:38917/callback', openedBrowser, at: 1 } })

  it('subscribes before mcp:authorize, sets announceUrl, prints the URL and succeeds', async () => {
    const { client, f } = authSetup({}, (c, input) => {
      announce(c, { projectId: 'p1', serverId: 'mcp_r' }, true)
      expect(input).toMatchObject({ projectId: 'p1', serverId: 'mcp_r', announceUrl: true, openBrowser: true })
      return { state: 'authorized', account: 'me@example.com' }
    })
    const r = await run(f, ['auth', 'docs'])
    expect(r.code).toBe(0)
    const order = client.calls.map((c) => c.method)
    expect(order.indexOf('host.subscribe')).toBeLessThan(order.indexOf('mcp:authorize'))
    expect(client.callsOf('host.subscribe')[0]).toEqual([{ topics: ['connections'] }])
    expect(r.out).toContain('If it did not open, use this URL:')
    expect(r.out).toContain(URL_)
    expect(r.out).toContain('docs: authorized (me@example.com).')
    expect(r.out).not.toContain('ssh -L')
  })

  it('under SSH_CONNECTION: openBrowser false, prints the URL and the ssh -L command with the right port', async () => {
    const env = { SSH_CONNECTION: '10.0.0.5 51000 10.0.0.9 2222', USER: 'me' }
    const { client, f } = authSetup({ env, platform: 'linux' }, (c) => {
      announce(c, { projectId: 'p1', serverId: 'mcp_r' }, false)
      return { state: 'authorized' }
    })
    const r = await run(f, ['auth', 'docs'])
    expect(r.code).toBe(0)
    expect((client.callsOf('mcp:authorize')[0] as [Record<string, unknown>])[0].openBrowser).toBe(false)
    expect(r.out).toContain('Forward the callback first: ssh -L 38917:127.0.0.1:38917 -p 2222 me@10.0.0.9')
    expect(r.out).toContain('Open this URL in a browser')
  })

  it('--no-browser sets openBrowser false; --browser over SSH sets it true', async () => {
    const a = authSetup({}, () => ({ state: 'authorized' }))
    await run(a.f, ['auth', 'docs', '--no-browser'])
    expect((a.client.callsOf('mcp:authorize')[0] as [Record<string, unknown>])[0].openBrowser).toBe(false)
    const b = authSetup({ env: { SSH_TTY: '/dev/pts/1' } }, () => ({ state: 'authorized' }))
    await run(b.f, ['auth', 'docs', '--browser'])
    expect((b.client.callsOf('mcp:authorize')[0] as [Record<string, unknown>])[0].openBrowser).toBe(true)
  })

  it("ignores another target's announcement", async () => {
    const { f } = authSetup({}, (c) => {
      announce(c, { libraryId: 'someone-else' }, false)
      announce(c, { projectId: 'p2', serverId: 'mcp_r' }, false)
      return { state: 'authorized' }
    })
    const r = await run(f, ['auth', 'docs'])
    expect(r.code).toBe(0)
    expect(r.out).not.toContain(URL_)
  })

  it('a linked project server authorizes through its library entry', async () => {
    const linked = { ...remote, libraryId: 'mcpl_9', source: 'library' as const }
    const s = setup({ 'mcp:list': () => [info(linked, { missingSecrets: [] })], 'mcp:authorize': () => ({ state: 'authorized' }) })
    expect((await run(s.f, ['auth', 'docs'])).code).toBe(0)
    const input = (s.client.callsOf('mcp:authorize')[0] as [Record<string, unknown>])[0]
    expect(input.libraryId).toBe('mcpl_9')
    expect(input.projectId).toBeUndefined()
  })

  it('Ctrl+C calls mcp:cancelAuthorize for the target and exits 130', async () => {
    let finish!: (v: unknown) => void
    const { client, f } = authSetup({}, () => new Promise((r) => (finish = r)))
    const p = run(f, ['auth', 'docs'])
    await vi.waitFor(() => expect(client.callsOf('mcp:authorize')).toHaveLength(1))
    f.signal('SIGINT')
    await vi.waitFor(() => expect(client.callsOf('mcp:cancelAuthorize')).toHaveLength(1))
    expect(client.callsOf('mcp:cancelAuthorize')[0]).toEqual([{ projectId: 'p1', serverId: 'mcp_r' }])
    finish({ state: 'error', error: 'Authorization was cancelled.' })
    expect((await p).code).toBe(EXIT.sigint)
    expect(f.signalListeners()).toBe(0)
  })

  it('an authorization error exits 5 (with the client-id hint); a host failure exits 1', async () => {
    const a = authSetup({}, () => ({ state: 'error', error: 'No dynamic registration.', needsClientId: true }))
    const r = await run(a.f, ['auth', 'docs'])
    expect(r.code).toBe(EXIT.auth)
    expect(r.out).toContain('--client-id')
    const b = authSetup({}, () => Promise.reject(rpcError({ code: 'frame_too_large', message: 'boom' })))
    expect((await run(b.f, ['auth', 'docs'])).code).toBe(EXIT.failure)
  })

  it('takes the client secret from the environment and never prints it', async () => {
    const { client, f } = authSetup({ env: { CS: 'client-secret-xyz' }, globals: { outputFormat: 'json' } }, () => ({ state: 'authorized' }))
    const r = await run(f, ['auth', 'docs', '--client-id', 'cid', '--client-secret-from-env', 'CS'])
    expect(r.code).toBe(0)
    expect((client.callsOf('mcp:authorize')[0] as [Record<string, unknown>])[0]).toMatchObject({ clientId: 'cid', clientSecret: 'client-secret-xyz' })
    expect(r.out + r.err).not.toContain('client-secret-xyz')
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, status: { state: 'authorized' } })
  })

  it('needs a server or --library, not both', async () => {
    expect((await run(setup({}).f, ['auth'])).code).toBe(EXIT.usage)
    expect((await run(setup({}).f, ['auth', 'docs', '--library', 'x'])).code).toBe(EXIT.usage)
  })
})

describe('mcp connectors and presets', () => {
  const card = (id: string, over: Partial<ConnectorInfo> = {}): ConnectorInfo => ({ connector: CONNECTORS.find((c) => c.id === id)!, state: 'available', ...over })

  it('connectors list shows the ease word, state, category and the custom marker; --filter narrows', async () => {
    const custom: ConnectorInfo = { connector: { ...CONNECTORS[0], id: 'my-tool', name: 'My tool', publisher: 'user' }, state: 'available', custom: true }
    const { f } = setup({ 'connectors:list': () => [card('deepwiki'), card('linear', { state: 'connected' }), custom] })
    const r = await run(f, ['connectors', 'list'])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/deepwiki\s+DeepWiki\s+No sign-in needed\s+available/)
    expect(r.out).toMatch(/linear\s+Linear\s+Sign in\s+connected/)
    expect(r.out).toContain('my-tool *')
    const g = setup({ 'connectors:list': () => [card('deepwiki'), card('linear')] })
    const only = await run(g.f, ['connectors', 'list', '--filter', 'linear'])
    expect(only.out).toContain('Linear')
    expect(only.out).not.toContain('DeepWiki')
  })

  it('connectors add validates the id client-side and passes the variant', async () => {
    const lib = { entry: { id: 'mcpl_1', name: 'linear' } } as unknown as McpLibraryInfo
    const { client, f } = setup({ 'connectors:add': () => lib, 'connectors:list': () => [card('linear', { state: 'needsSetup' })] })
    const r = await run(f, ['connectors', 'add', 'linear', '--variant', 'full'])
    expect(r.code).toBe(0)
    expect(client.callsOf('connectors:add')[0]).toEqual([{ connectorId: 'linear', variant: 'full' }])
    expect(r.out).toContain('orgai mcp auth --library linear')
    for (const bad of ['Linear', 'a'.repeat(65), 'bad_id', '-x-']) expect((await run(setup({}).f, ['connectors', 'add', bad])).code).toBe(EXIT.usage)
  })

  it('connectors set-token reads stdin and never prints it; --clear sends null', async () => {
    manageDeps.readStdin = async () => 'tok-123\n'
    const { client, f } = setup({ 'connectors:setToken': () => ({ entry: { id: 'mcpl_1' } }) })
    const r = await run(f, ['connectors', 'set-token', 'exa', '--stdin'])
    expect(r.code).toBe(0)
    expect(client.callsOf('connectors:setToken')[0]).toEqual([{ connectorId: 'exa', token: 'tok-123' }])
    expect(r.out + r.err).not.toContain('tok-123')
    const g = setup({ 'connectors:setToken': () => ({ entry: { id: 'mcpl_1' } }) })
    await run(g.f, ['connectors', 'set-token', 'exa', '--clear'])
    expect(g.client.callsOf('connectors:setToken')[0]).toEqual([{ connectorId: 'exa', token: null }])
  })

  it('presets add reads the JSON file and sends it to connectorPresets:upsert', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'orgai-preset-'))
    try {
      const preset = { id: 'acme-crm', name: 'Acme CRM', vendor: 'Acme', category: 'crm', description: 'CRM', variants: [], defaultVariant: 'x' }
      writeFileSync(join(dir, 'p.json'), JSON.stringify(preset))
      const { client, f } = setup({ 'connectorPresets:upsert': () => [{ ...preset, publisher: 'user', verified: false }] }, { cwd: dir })
      const r = await run(f, ['presets', 'add', '--file', 'p.json'])
      expect(r.code).toBe(0)
      expect(client.callsOf('connectorPresets:upsert')[0]).toEqual([preset])
      expect(r.out).toContain('Saved the preset Acme CRM')
      writeFileSync(join(dir, 'bad.json'), '{nope')
      expect((await run(setup({}, { cwd: dir }).f, ['presets', 'add', '--file', 'bad.json'])).code).toBe(EXIT.usage)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('mcp search', () => {
  it('sanitizes registry text (an escape sequence in a description is stripped)', async () => {
    const { client, f } = setup({
      'mcp:registrySearch': () => ({ entries: [{ name: 'io.github.x/evil', description: 'Nice \x1b]0;pwned\x07 server \x1b[2J', version: '1.0.0', packages: [{ registryType: 'npm' }], remotes: [] }] })
    })
    const r = await run(f, ['search', 'evil', '--limit', '5'])
    expect(r.code).toBe(0)
    expect(client.callsOf('mcp:registrySearch')[0]).toEqual([{ query: 'evil', limit: 5 }])
    expect(r.out).not.toContain('\x1b')
    expect(r.out).not.toContain('\x07')
    expect(r.out).toContain('io.github.x/evil')
    expect((await run(setup({}).f, ['search', 'x', '--limit', '0'])).code).toBe(EXIT.usage)
  })
})

describe('mcp library', () => {
  it('library add builds an entry with --per-project-secrets and mcpLibrary:upsert gets it', async () => {
    const { client, f } = setup({ 'mcpLibrary:upsert': (p) => [{ entry: (p as [unknown])[0], envSet: [], headersSet: [], missingSecrets: [], auth: { state: 'notRequired' }, usedBy: [] }] })
    const r = await run(f, ['library', 'add', 'pg', '--command', 'npx', '--arg', 'pg-mcp@1.0.0', '--secret-var', 'PG_URL', '--per-project-secrets'])
    expect(r.code).toBe(0)
    const [entry] = client.callsOf('mcpLibrary:upsert')[0] as [Record<string, unknown>]
    expect(entry).toMatchObject({ name: 'pg', transport: 'stdio', secretEnv: ['PG_URL'], perProjectSecrets: true, source: 'user' })
    expect(String(entry.id)).toMatch(/^mcpl_/)
  })
})

describe('mcp test / promote / copy / overrides', () => {
  const linked = (over: Partial<McpServerSpec> = {}) => spec({ id: 'mcp_2', name: 'pg', libraryId: 'mcpl_1', source: 'library', secretEnv: [], ...over })

  it('test sends { projectId, serverId } to mcp:test; ok is 0, needs authorization is the auth exit, a failure 1', async () => {
    const { client, f } = setup({ 'mcp:list': () => [info(spec())], 'mcp:test': () => ({ ok: true, tools: ['search'], durationMs: 12 }) })
    const r = await run(f, ['test', 'github'])
    expect(r.code).toBe(0)
    expect(client.callsOf('mcp:test')).toEqual([[{ projectId: 'p1', serverId: 'mcp_1' }]])
    expect(r.out).toContain('github answered in 12 ms with 1 tool.')
    const auth = await run(setup({ 'mcp:list': () => [info(spec())], 'mcp:test': () => ({ ok: false, needsAuthorization: true }) }).f, ['test', 'github'])
    expect(auth.code).toBe(EXIT.auth)
    expect(auth.out).toContain('orgai mcp auth github')
    const bad = await run(setup({ 'mcp:list': () => [info(spec())], 'mcp:test': () => ({ ok: false, error: 'spawn \x1b[2Jnpx ENOENT' }) }).f, ['test', 'github'])
    expect(bad.code).toBe(1)
    expect(bad.out).not.toContain('\x1b')
  })

  it('promote sends { projectId, serverId } to mcp:promote; a linked server is refused before the call', async () => {
    const { client, f } = setup({ 'mcp:list': () => [info(spec())], 'mcp:promote': () => ({ project: P, servers: [info(spec({ libraryId: 'mcpl_9', source: 'library' }))] }) })
    const r = await run(f, ['promote', 'github'])
    expect(r.code).toBe(0)
    expect(client.callsOf('mcp:promote')).toEqual([[{ projectId: 'p1', serverId: 'mcp_1' }]])
    expect(r.out).toContain('Moved github to your MCP library')
    const g = setup({ 'mcp:list': () => [info(linked())], 'mcp:promote': () => ({ project: P, servers: [] }) })
    expect((await run(g.f, ['promote', 'pg'])).code).toBe(EXIT.usage)
    expect(g.client.callsOf('mcp:promote')).toEqual([])
  })

  it('copy sends { projectId, serverId, copySecrets } to mcp:copyFromLibrary and reports the new copy', async () => {
    const copy = spec({ id: 'mcp_3', name: 'pg', secretEnv: [] })
    const { client, f } = setup({ 'mcp:list': () => [info(linked())], 'mcp:copyFromLibrary': () => ({ project: P, servers: [info(copy)] }) }, { globals: { outputFormat: 'json' } })
    expect((await run(f, ['copy', 'pg', '--copy-secrets'])).code).toBe(0)
    expect(client.callsOf('mcp:copyFromLibrary')).toEqual([[{ projectId: 'p1', serverId: 'mcp_2', copySecrets: true }]])
    expect(JSON.parse(f.out()).server.id).toBe('mcp_3')
    const g = setup({ 'mcp:list': () => [info(linked())], 'mcp:copyFromLibrary': () => ({ project: P, servers: [info(copy)] }) })
    expect((await run(g.f, ['copy', 'pg'])).code).toBe(0)
    expect(g.client.callsOf('mcp:copyFromLibrary')[0]).toEqual([{ projectId: 'p1', serverId: 'mcp_2', copySecrets: false }])
    const h = setup({ 'mcp:list': () => [info(spec())], 'mcp:copyFromLibrary': () => ({ project: P, servers: [] }) })
    expect((await run(h.f, ['copy', 'github'])).code).toBe(EXIT.usage)
    expect(h.client.callsOf('mcp:copyFromLibrary')).toEqual([])
  })

  /** A fake mcp:setProjectOverrides that keeps only the names the entry allows, like McpService does. */
  const overridesHost = (stored: McpServerSpec, allowed: string[]) => ({
    'mcp:list': () => [info(stored)],
    'mcp:setProjectOverrides': (p: unknown) => {
      const [input] = p as [{ env?: Record<string, string>; headers?: Record<string, string> }]
      const keep = (m?: Record<string, string>) => (m ? Object.fromEntries(Object.entries(m).filter(([k]) => allowed.includes(k))) : undefined)
      const env = keep(input.env)
      return { project: P, servers: [info({ ...stored, envOverrides: env && Object.keys(env).length ? env : undefined })] }
    }
  })

  it('overrides merges the given pairs onto the stored ones; --unset removes one; --clear sends {}', async () => {
    const stored = linked({ envOverrides: { A: '1', B: '2' } })
    const { client, f } = setup(overridesHost(stored, ['A', 'B', 'C']))
    const r = await run(f, ['overrides', 'pg', '--env', 'A=3', '--env', 'C=4'])
    expect(r.code).toBe(0)
    expect(client.callsOf('mcp:setProjectOverrides')).toEqual([[{ projectId: 'p1', serverId: 'mcp_2', env: { A: '3', B: '2', C: '4' } }]])
    expect(r.out).toContain('Saved the overrides of pg.')
    const g = setup(overridesHost(stored, ['A', 'B']))
    expect((await run(g.f, ['overrides', 'pg', '--unset', 'B'])).code).toBe(0)
    expect(g.client.callsOf('mcp:setProjectOverrides')[0]).toEqual([{ projectId: 'p1', serverId: 'mcp_2', env: { A: '1' } }])
    const h = setup(overridesHost(stored, ['A', 'B']))
    expect((await run(h.f, ['overrides', 'pg', '--clear'])).code).toBe(0)
    expect(h.client.callsOf('mcp:setProjectOverrides')[0]).toEqual([{ projectId: 'p1', serverId: 'mcp_2', env: {} }])
    const show = setup(overridesHost(stored, []))
    const shown = await run(show.f, ['overrides', 'pg'])
    expect(shown.out).toContain('A=1')
    expect(show.client.callsOf('mcp:setProjectOverrides')).toEqual([])
  })

  it('overrides: a name the host dropped is exit 1, an unknown --unset or the wrong kind is exit 2, project-only servers are refused', async () => {
    const stored = linked({ envOverrides: { A: '1' } })
    const { f } = setup(overridesHost(stored, ['A']))
    const r = await run(f, ['overrides', 'pg', '--env', 'NOPE=x'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('does not take NOPE per project')
    const stale = setup(overridesHost(linked({ envOverrides: { OLD: '1' } }), ['A']))
    expect((await run(stale.f, ['overrides', 'pg', '--env', 'A=2'])).code).toBe(0)
    for (const args of [['overrides', 'pg', '--unset', 'Z'], ['overrides', 'pg', '--header', 'X=1'], ['overrides', 'pg', '--env', 'A=1', '--unset', 'A'], ['overrides', 'pg', '--clear', '--env', 'A=2']]) {
      const g = setup(overridesHost(stored, ['A']))
      expect((await run(g.f, args)).code).toBe(EXIT.usage)
      expect(g.client.callsOf('mcp:setProjectOverrides')).toEqual([])
    }
    expect((await run(setup(overridesHost(spec(), [])).f, ['overrides', 'github', '--env', 'A=1'])).code).toBe(EXIT.usage)
  })

  it('overrides on a remote server sends headers', async () => {
    const remote = linked({ transport: 'http', command: undefined, args: undefined, url: 'https://x.example/mcp', headerOverrides: { 'X-Team': 'a' } })
    const { client, f } = setup({ 'mcp:list': () => [info(remote)], 'mcp:setProjectOverrides': (p) => ({ project: P, servers: [info({ ...remote, headerOverrides: (p as [{ headers: Record<string, string> }])[0].headers })] }) })
    expect((await run(f, ['overrides', 'pg', '--header', 'X-Org=b'])).code).toBe(0)
    expect(client.callsOf('mcp:setProjectOverrides')[0]).toEqual([{ projectId: 'p1', serverId: 'mcp_2', headers: { 'X-Team': 'a', 'X-Org': 'b' } }])
  })
})

describe('mcp library test / set-secret and presets remove', () => {
  const lib = (over: Record<string, unknown> = {}): McpLibraryInfo =>
    ({ entry: { id: 'mcpl_1', name: 'pg', transport: 'stdio', command: 'npx', secretEnv: ['PG_URL'], secretHeaders: [], source: 'user', addedAt: '2026-01-01T00:00:00.000Z', ...over }, envSet: [], headersSet: [], missingSecrets: ['PG_URL'], auth: { state: 'notRequired' }, usedBy: [] }) as unknown as McpLibraryInfo

  it('library test sends { libraryId } to mcpLibrary:test', async () => {
    const { client, f } = setup({ 'mcpLibrary:list': () => [lib()], 'mcpLibrary:test': () => ({ ok: true, tools: [] }) })
    expect((await run(f, ['library', 'test', 'pg'])).code).toBe(0)
    expect(client.callsOf('mcpLibrary:test')).toEqual([[{ libraryId: 'mcpl_1' }]])
    const g = setup({ 'mcpLibrary:list': () => [lib()], 'mcpLibrary:test': () => ({ ok: false, needsAuthorization: true }) })
    const r = await run(g.f, ['library', 'test', 'pg'])
    expect(r.code).toBe(EXIT.auth)
    expect(r.out).toContain('orgai mcp auth --library pg')
  })

  it('library set-secret sends { libraryId, kind, name, value } from the environment and never prints the value; --clear sends null', async () => {
    const { client, f } = setup({ 'mcpLibrary:list': () => [lib()], 'mcpLibrary:setSecret': () => [lib()] }, { env: { MY_PG: 'postgres://u:pw@h/db' } })
    const r = await run(f, ['library', 'set-secret', 'pg', 'PG_URL', '--from-env', 'MY_PG'])
    expect(r.code).toBe(0)
    expect(client.callsOf('mcpLibrary:setSecret')).toEqual([[{ libraryId: 'mcpl_1', kind: 'env', name: 'PG_URL', value: 'postgres://u:pw@h/db' }]])
    expect(r.out + r.err).not.toContain('pw@h')
    const g = setup({ 'mcpLibrary:list': () => [lib({ secretEnv: [], secretHeaders: ['Authorization'] })], 'mcpLibrary:setSecret': () => [] })
    expect((await run(g.f, ['library', 'set-secret', 'pg', 'Authorization', '--clear'])).code).toBe(0)
    expect(g.client.callsOf('mcpLibrary:setSecret')[0]).toEqual([{ libraryId: 'mcpl_1', kind: 'header', name: 'Authorization', value: null }])
    expect((await run(setup({}).f, ['library', 'set-secret', 'pg'])).code).toBe(EXIT.usage)
  })

  it('presets remove needs --yes without a terminal and sends { id } to connectorPresets:remove', async () => {
    const { client, f } = setup({ 'connectorPresets:remove': () => [] })
    expect((await run(f, ['presets', 'remove', 'acme-crm'])).code).toBe(EXIT.usage)
    expect(client.callsOf('connectorPresets:remove')).toEqual([])
    const g = setup({ 'connectorPresets:remove': () => [] })
    expect((await run(g.f, ['presets', 'remove', 'acme-crm', '--yes'])).code).toBe(0)
    expect(g.client.callsOf('connectorPresets:remove')).toEqual([[{ id: 'acme-crm' }]])
    expect((await run(setup({}).f, ['presets', 'remove', 'Acme_CRM', '--yes'])).code).toBe(EXIT.usage)
  })
})

describe('mcp assist', () => {
  it('builds McpAssistInput and calls runInteractiveRun (library scope by default outside a project)', async () => {
    const calls: unknown[] = []
    mcpDeps.runInteractiveRun = async (_ctx, spec, flags) => {
      calls.push({ spec, flags })
      return 0
    }
    const f = fakeContext({ cwd: '/elsewhere', store: { projects: [P] } })
    expect(await runMcp(f.ctx, ['assist', 'connect', 'postgres', '--build', '--inline'])).toBe(0)
    expect(calls[0]).toMatchObject({ spec: { channel: 'mcp:startAssist', label: 'MCP assistant', input: { scope: 'library', instruction: 'connect postgres', allowBuild: true } }, flags: { inline: true } })
  })

  it('a cwd project gives project scope; --library overrides; --build with --project is refused', async () => {
    const inProject = fakeContext({ cwd: '/work', store: { projects: [P] } })
    expect(await assistInput(inProject.ctx, undefined, { build: false, library: false })).toEqual({ scope: 'project', projectId: 'p1' })
    expect(await assistInput(inProject.ctx, 'x', { build: false, library: true })).toEqual({ scope: 'library', instruction: 'x' })
    const flagged = fakeContext({ cwd: '/elsewhere', globals: { project: 'p1' }, store: { projects: [P] } })
    expect(await assistInput(flagged.ctx, undefined, { build: false, library: false })).toEqual({ scope: 'project', projectId: 'p1' })
    await expect(assistInput(flagged.ctx, undefined, { build: true, library: false })).rejects.toMatchObject({ exitCode: EXIT.usage })
  })
})

describe('routing', () => {
  it('a missing or unknown subcommand is exit 2', async () => {
    expect((await run(setup({}).f, [])).code).toBe(EXIT.usage)
    expect((await run(setup({}).f, ['frobnicate'])).code).toBe(EXIT.usage)
    expect((await run(setup({}).f, ['library'])).code).toBe(EXIT.usage)
  })
})
