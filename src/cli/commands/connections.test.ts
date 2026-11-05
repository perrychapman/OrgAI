import { afterEach, describe, expect, it } from 'vitest'
import { defaultConnections } from '../../shared/defaults'
import type { ConnectionInfo, ConnectionStatus, HostScope, ProviderConnection } from '../../shared/types'
import { manageDeps } from '../manage'
import { fakeContext, FakeHostClient, flush, rpcError, type Answer, type FakeContextOptions } from '../testing/fakeContext'
import { CliError, EXIT } from '../types'
import { baseUrlArg, loginDeps, loginMethodFor, runConnections, statusExit, updatedConnection } from './connections'

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide', 'configure'] }
const realDeps = { ...manageDeps }
const realTimeout = loginDeps.timeoutMs
afterEach(() => {
  Object.assign(manageDeps, realDeps)
  loginDeps.timeoutMs = realTimeout
})

function infos(over: Partial<Record<'anthropic' | 'openai' | 'litellm', Partial<ConnectionInfo>>> = {}, defaultId = 'anthropic'): ConnectionInfo[] {
  const conns = defaultConnections()
  return (['anthropic', 'openai', 'litellm'] as const).map((id) => ({
    connection: conns[id] as ProviderConnection,
    status: { state: id === 'anthropic' ? 'connected' : 'disconnected', ...(id === 'anthropic' ? { account: 'me@example.com' } : {}) } as ConnectionStatus,
    modelCount: 3,
    isDefault: id === defaultId,
    ...over[id]
  }))
}

function setup(answers: Record<string, Answer>, o: FakeContextOptions = {}) {
  const client = new FakeHostClient({ 'host.subscribe': (p) => ({ topics: (p as [{ topics: string[] }])[0].topics }), ...answers }, { hello: ALL })
  const f = fakeContext({ connect: [client], ...o })
  clients.set(f, client)
  return { client, f }
}

/** The fake client closes with each command; reopen it so one test can run several commands. */
const clients = new WeakMap<object, FakeHostClient>()

async function run(f: ReturnType<typeof fakeContext>, args: string[]): Promise<number> {
  const c = clients.get(f)
  if (c) c.closed = false
  try {
    return await runConnections(f.ctx, args)
  } catch (e) {
    if (e instanceof CliError) {
      f.ctx.io.stderr.write(`${e.message}\n`)
      return e.exitCode
    }
    throw e
  }
}

describe('connections list / show', () => {
  it('lists every connection with the default marker (Chosen / Automatic)', async () => {
    const { f } = setup({ 'connections:list': () => infos(), 'settings:get': () => ({ defaultConnectionChosen: true }) })
    expect(await run(f, ['list'])).toBe(0)
    expect(f.out()).toMatch(/anthropic \(Anthropic\)\s+yes\s+Connected\s+me@example.com\s+Default \(Chosen\)/)
    expect(f.out()).toMatch(/openai \(OpenAI\)\s+no\s+Not connected/)
    const g = setup({ 'connections:list': () => infos({}, 'openai'), 'settings:get': () => ({ defaultConnectionChosen: false }) }, { globals: { outputFormat: 'json' } })
    expect(await run(g.f, ['list'])).toBe(0)
    const j = JSON.parse(g.f.out())
    expect(j.connections.map((c: { id: string; isDefault: boolean }) => [c.id, c.isDefault])).toEqual([['anthropic', false], ['openai', true], ['litellm', false]])
    expect(j.connections[1].defaultMode).toBe('automatic')
    expect(j.connections[2]).toMatchObject({ baseUrl: '', hasApiKey: false })
  })

  it('show <id>; an unknown id is exit 2', async () => {
    const { f } = setup({ 'connections:list': () => infos(), 'settings:get': () => ({}) })
    expect(await run(f, ['show', 'litellm'])).toBe(0)
    expect(f.out()).toContain('Base URL: (not set)')
    const g = setup({})
    expect(await run(g.f, ['show', 'gemini'])).toBe(EXIT.usage)
    expect(g.f.err()).toContain('Unknown connection')
    expect(await run(g.f, ['nope'])).toBe(EXIT.usage)
  })
})

describe('connections test', () => {
  it.each<[ConnectionStatus, number]>([
    [{ state: 'connected' }, 0],
    [{ state: 'disconnected', detail: 'Not signed in.' }, 5],
    [{ state: 'error', detail: 'API Error: 401 authentication_failed' }, 5],
    [{ state: 'error', detail: 'Claude Code CLI not found' }, 1],
    [{ state: 'connecting' }, 1]
  ])('%o -> exit %i', async (status, code) => {
    expect(statusExit(status)).toBe(code)
    const { f, client } = setup({ 'connections:test': () => status })
    expect(await run(f, ['test', 'anthropic'])).toBe(code)
    expect(client.callsOf('connections:test')).toEqual([['anthropic']])
  })

  it('asks for the operate scope', async () => {
    const { f } = setup({ 'connections:test': () => ({ state: 'connected' }) })
    await run(f, ['test', 'openai'])
    expect(f.connectCalls[0].scopes).toEqual(['read', 'operate'])
  })
})

describe('connections connect', () => {
  it('prints remap results pushed during the call', async () => {
    const { f, client } = setup({
      'connections:connect': () => {
        client.push('connections:event', { type: 'projects.remapped', results: [{ projectId: 'p1', connection: 'openai', reason: 'connected', changes: [{ roleId: 'r1', from: 'sonnet', to: 'gpt-5' }] }] })
        return infos({ openai: { status: { state: 'connected' } } })[1]
      },
      'projects:list': () => [{ id: 'p1', name: 'App', roles: [{ id: 'r1', name: 'Coder' }] }]
    })
    expect(await run(f, ['connect', 'openai'])).toBe(0)
    expect(f.out()).toContain('Remapped 1 role model in App:')
    expect(f.out()).toContain('Coder: sonnet -> gpt-5')
    expect(client.calls.findIndex((c) => c.method === 'host.subscribe')).toBeLessThan(client.calls.findIndex((c) => c.method === 'connections:connect'))
  })
})

describe('connections login', () => {
  const deviceStart = { loginId: 'L1', connection: 'openai', method: 'deviceCode', verificationUrl: 'https://auth.example/device', userCode: 'ABCD-1234', expiresAt: Date.UTC(2026, 10, 5, 12) }

  it('chooses the method by flag and by remote session', () => {
    expect(loginMethodFor({ deviceCode: true }, {}, 'darwin')).toBe('deviceCode')
    expect(loginMethodFor({ browser: true }, { SSH_TTY: '/dev/pts/1' }, 'linux')).toBe('browser')
    expect(loginMethodFor({}, { SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' }, 'darwin')).toBe('deviceCode')
    expect(loginMethodFor({}, { SSH_TTY: '/dev/pts/1' }, 'darwin')).toBe('deviceCode')
    expect(loginMethodFor({}, {}, 'linux')).toBe('deviceCode')
    expect(loginMethodFor({}, { DISPLAY: ':0' }, 'linux')).toBe('browser')
    expect(loginMethodFor({}, {}, 'darwin')).toBe('browser')
  })

  async function login(env: NodeJS.ProcessEnv, args: string[], after: (client: FakeHostClient, f: ReturnType<typeof fakeContext>) => void) {
    const { f, client } = setup({ 'connections:login': (p) => ((p as unknown[])[1] === 'deviceCode' ? deviceStart : { loginId: 'L1', connection: 'openai', method: 'browser', authUrl: 'https://auth.example/authorize?x=1' }), 'connections:cancelLogin': () => undefined }, { env })
    const pending = run(f, ['login', 'openai', ...args])
    for (let i = 0; i < 5; i++) await flush()
    after(client, f)
    return { code: await pending, f, client }
  }

  it('device code over SSH: subscribes first, prints the URL and code, success -> 0', async () => {
    const r = await login({ SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' }, [], (client) => {
      client.push('connections:event', { type: 'connection.login', login: { loginId: 'OTHER', connection: 'openai', state: 'success' } })
      client.push('connections:event', { type: 'connection.login', login: { loginId: 'L1', connection: 'openai', state: 'pending' } })
      client.push('connections:event', { type: 'connection.login', login: { loginId: 'L1', connection: 'openai', state: 'success', account: 'me@example.com · plus' } })
    })
    expect(r.code).toBe(0)
    expect(r.client.callsOf('connections:login')).toEqual([['openai', 'deviceCode']])
    const order = r.client.calls.map((c) => c.method)
    expect(order.indexOf('host.subscribe')).toBeLessThan(order.indexOf('connections:login'))
    expect(r.f.out()).toContain('https://auth.example/device')
    expect(r.f.out()).toContain('ABCD-1234')
    expect(r.f.out()).toContain('Signed in to OpenAI as me@example.com · plus.')
    expect(r.f.ctx.io.stdout).toBeDefined()
    expect(r.f.connectCalls[0].scopes).toEqual(['read', 'configure'])
  })

  it('--device-code on a local machine; an error event -> 5', async () => {
    const r = await login({}, ['--device-code'], (client) => client.push('connections:event', { type: 'connection.login', login: { loginId: 'L1', connection: 'openai', state: 'error', detail: 'Code expired' } }))
    expect(r.code).toBe(EXIT.auth)
    expect(r.client.callsOf('connections:login')).toEqual([['openai', 'deviceCode']])
    expect(r.f.out()).toContain('Sign-in failed: Code expired')
  })

  it('events for another login id are ignored; Ctrl+C cancels the login and exits 130', async () => {
    const r = await login({}, [], (client, f) => {
      client.push('connections:event', { type: 'connection.login', login: { loginId: 'L2', connection: 'openai', state: 'success' } })
      f.signal('SIGINT')
    })
    expect(r.code).toBe(EXIT.sigint)
    expect(r.client.callsOf('connections:login')).toEqual([['openai', 'browser']])
    expect(r.client.callsOf('connections:cancelLogin')).toEqual([['L1']])
    expect(r.f.out()).toContain('Opening your browser; if it does not open, visit: https://auth.example/authorize?x=1')
    expect(r.f.signalListeners()).toBe(0)
  })

  it('--browser over SSH notes that the browser opens on the host machine', async () => {
    const r = await login({ SSH_TTY: '/dev/pts/2' }, ['--browser'], (client) => client.push('connections:event', { type: 'connection.login', login: { loginId: 'L1', connection: 'openai', state: 'success' } }))
    expect(r.code).toBe(0)
    expect(r.f.out()).toContain('the browser opens on the machine running OrgAI, not yours')
  })

  it('times out: cancels and exits 1', async () => {
    loginDeps.timeoutMs = 10
    const { f, client } = setup({ 'connections:login': () => deviceStart, 'connections:cancelLogin': () => undefined })
    expect(await run(f, ['login', 'openai', '--device-code'])).toBe(1)
    expect(client.callsOf('connections:cancelLogin')).toEqual([['L1']])
  })

  it('json: the start goes to stderr, the result to stdout', async () => {
    const { f, client } = setup({ 'connections:login': () => deviceStart }, { globals: { outputFormat: 'json' } })
    const pending = run(f, ['login', 'openai', '--device-code'])
    for (let i = 0; i < 5; i++) await flush()
    client.push('connections:event', { type: 'connection.login', login: { loginId: 'L1', connection: 'openai', state: 'success', account: 'a@b' } })
    expect(await pending).toBe(0)
    expect(JSON.parse(f.out())).toMatchObject({ loginId: 'L1', state: 'success', account: 'a@b', userCode: 'ABCD-1234' })
    expect(f.err()).toContain('ABCD-1234')
  })

  it('only openai signs in; others exit 2 with a hint; both method flags exit 2', async () => {
    const { f } = setup({})
    expect(await run(f, ['login', 'anthropic'])).toBe(EXIT.usage)
    expect(f.err()).toContain('/login')
    expect(await run(f, ['login', 'litellm'])).toBe(EXIT.usage)
    expect(f.err()).toContain('set-secret')
    expect(await run(f, ['login', 'openai', '--device-code', '--browser'])).toBe(EXIT.usage)
  })

  it('a skewed host that grants no configure is exit 1', async () => {
    const client = new FakeHostClient({}, { hello: { grantedScopes: ['read', 'operate', 'decide'] } })
    const f = fakeContext({ connect: [client] })
    expect(await run(f, ['login', 'openai'])).toBe(1)
    expect(client.callsOf('connections:login')).toEqual([])
  })
})

describe('connections set-default', () => {
  it('auto sends null; an id is Chosen', async () => {
    const { f, client } = setup({ 'connections:setDefault': () => infos() })
    expect(await run(f, ['set-default', 'auto'])).toBe(0)
    expect(f.out()).toContain('Default connection: Anthropic (Automatic).')
    expect(await run(f, ['set-default', 'anthropic'])).toBe(0)
    expect(client.callsOf('connections:setDefault')).toEqual([[null], ['anthropic']])
    expect(f.out()).toContain('(Chosen)')
  })

  it("prints the host's refusal sentence and exits 1", async () => {
    const { f } = setup({ 'connections:setDefault': () => Promise.reject(rpcError({ code: 'internal', message: 'OpenAI is not connected. Connect it first, then make it the default.' } as never)) })
    expect(await run(f, ['set-default', 'openai'])).toBe(1)
    expect(f.err()).toContain('OpenAI is not connected. Connect it first, then make it the default.')
  })
})

describe('connections set-secret', () => {
  const SECRET = 'sk-litellm-very-secret-value'
  const secretAnswer = (p: unknown) => {
    const apiKey = (p as [{ apiKey: string | null }])[0].apiKey
    return { ...infos()[2], connection: { ...infos()[2].connection, hasApiKey: apiKey !== null } }
  }

  it('from env: saves, never echoes the key (text and json)', async () => {
    for (const fmt of ['text', 'json'] as const) {
      const { f, client } = setup({ 'connections:setSecret': secretAnswer }, { env: { LITE_KEY: SECRET }, globals: { outputFormat: fmt } })
      expect(await run(f, ['set-secret', 'litellm', '--from-env', 'LITE_KEY'])).toBe(0)
      expect(client.callsOf('connections:setSecret')).toEqual([[{ id: 'litellm', apiKey: SECRET }]])
      expect(f.out()).toContain('Key saved. Test and connect to apply.')
      expect(f.out() + f.err()).not.toContain(SECRET)
    }
  })

  it('from stdin (one trailing newline trimmed)', async () => {
    manageDeps.readStdin = async () => `${SECRET}\n`
    const { f, client } = setup({ 'connections:setSecret': secretAnswer })
    expect(await run(f, ['set-secret', 'litellm', '--stdin'])).toBe(0)
    expect(client.callsOf('connections:setSecret')).toEqual([[{ id: 'litellm', apiKey: SECRET }]])
    expect(f.out() + f.err()).not.toContain(SECRET)
  })

  it('--clear sends null; other connections and mixed sources exit 2', async () => {
    const { f, client } = setup({ 'connections:setSecret': secretAnswer })
    expect(await run(f, ['set-secret', 'litellm', '--clear'])).toBe(0)
    expect(client.callsOf('connections:setSecret')).toEqual([[{ id: 'litellm', apiKey: null }]])
    expect(f.out()).toContain('Key removed.')
    expect(await run(f, ['set-secret', 'openai', '--stdin'])).toBe(EXIT.usage)
    expect(await run(f, ['set-secret', 'litellm', '--clear', '--stdin'])).toBe(EXIT.usage)
    expect(await run(f, ['set-secret', 'litellm'])).toBe(EXIT.usage)
    expect(await run(f, ['set-secret', 'litellm', SECRET])).toBe(EXIT.usage)
    expect(f.err()).not.toContain(SECRET)
  })
})

describe('connections update', () => {
  it('base-url none clears it; enable / disable map onto the record', async () => {
    const lite = infos()[2].connection
    expect(updatedConnection(lite, { baseUrl: '' })).toMatchObject({ id: 'litellm', baseUrl: '' })
    expect(updatedConnection(lite, { enabled: false })).toMatchObject({ enabled: false })
    expect(() => updatedConnection(infos()[0].connection, { baseUrl: 'http://x' })).toThrow(CliError)
    expect(baseUrlArg('none')).toBe('')
    expect(baseUrlArg('http://localhost:4000/')).toBe('http://localhost:4000')
    expect(() => baseUrlArg('ftp://x')).toThrow(CliError)
    expect(() => baseUrlArg('http://u:p@x')).toThrow(CliError)

    const withUrl = infos({ litellm: { connection: { ...lite, baseUrl: 'http://old:4000' } as ProviderConnection } })
    const { f, client } = setup({ 'connections:list': () => withUrl, 'connections:update': (p) => ({ ...withUrl[2], connection: (p as [ProviderConnection])[0] }), 'settings:get': () => ({}) })
    expect(await run(f, ['update', 'litellm', '--base-url', 'none', '--disable'])).toBe(0)
    expect(client.callsOf('connections:update')).toEqual([[{ ...lite, baseUrl: '', enabled: false }]])
    expect(await run(f, ['update', 'openai', '--enable'])).toBe(0)
    expect((client.callsOf('connections:update')[1] as [ProviderConnection])[0]).toMatchObject({ id: 'openai', enabled: true })
  })

  it('usage errors: nothing to change, both flags, base-url on another connection', async () => {
    const { f } = setup({})
    expect(await run(f, ['update', 'litellm'])).toBe(EXIT.usage)
    expect(await run(f, ['update', 'litellm', '--enable', '--disable'])).toBe(EXIT.usage)
    expect(await run(f, ['update', 'openai', '--base-url', 'http://x'])).toBe(EXIT.usage)
    expect(f.connectCalls).toEqual([])
  })
})

describe('connections logout', () => {
  it('--yes signs out; without a terminal it asks for --yes', async () => {
    const { f, client } = setup({ 'connections:logout': () => infos()[1] })
    expect(await run(f, ['logout', 'openai', '--yes'])).toBe(0)
    expect(client.callsOf('connections:logout')).toEqual([['openai']])
    expect(await run(f, ['logout', 'openai'])).toBe(EXIT.usage)
    expect(f.err()).toContain('Pass --yes')
  })
})
