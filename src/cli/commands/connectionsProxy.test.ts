import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectionInfo, ConnectionStatus, HostScope, ProviderConnection, ProxyConnection } from '../../shared/types'
import { manageDeps } from '../manage'
import { fakeContext, FakeHostClient, rpcError, type Answer, type FakeContextOptions } from '../testing/fakeContext'
import { CliError, EXIT } from '../types'
import { runConnections } from './connections'

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide', 'configure'] }
const realDeps = { ...manageDeps }
afterEach(() => {
  Object.assign(manageDeps, realDeps)
})

const PROXY2 = 'proxy-0a1b2c3d'
const KEY = 'sk-proxy-very-secret-value'

const record: ProxyConnection = {
  id: PROXY2,
  name: 'Team gateway',
  kind: 'openai-compatible',
  enabled: true,
  anthropicBaseUrl: 'https://gateway.example.com',
  openaiBaseUrl: 'https://gateway.example.com/v1',
  hasApiKey: true,
  tierModels: {},
  autoTiers: true
} as unknown as ProxyConnection

const infoOf = (c: ProviderConnection, state: ConnectionStatus['state'] = 'disconnected'): ConnectionInfo => ({ connection: c, status: { state } as ConnectionStatus, modelCount: 0, isDefault: false })

function setup(answers: Record<string, Answer>, o: FakeContextOptions = {}) {
  const client = new FakeHostClient({ 'host.subscribe': (p) => ({ topics: (p as [{ topics: string[] }])[0].topics }), ...answers }, { hello: ALL })
  const f = fakeContext({ connect: [client], ...o })
  return { client, f, run: runWith(f, client) }
}

function runWith(f: ReturnType<typeof fakeContext>, client: FakeHostClient) {
  return async (args: string[]): Promise<number> => {
    client.closed = false
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
}

const created = (p: unknown): ConnectionInfo => infoOf({ ...record, name: (p as [{ name: string }])[0].name })

describe('connections proxy add', () => {
  it('sends the fields, reads the key from the env var and never echoes it', async () => {
    for (const fmt of ['text', 'json'] as const) {
      const { f, client, run } = setup({ 'connections:createProxy': created }, { env: { GW_KEY: KEY }, globals: { outputFormat: fmt } })
      expect(
        await run(['proxy', 'add', '--name', 'Team gateway', '--anthropic-url', 'https://gateway.example.com/', '--openai-url', 'https://gateway.example.com/v1', '--models-url', 'https://gateway.example.com/models', '--kind', 'openai-compatible', '--key-env', 'GW_KEY'])
      ).toBe(0)
      expect(client.callsOf('connections:createProxy')).toEqual([
        [{ name: 'Team gateway', anthropicBaseUrl: 'https://gateway.example.com', openaiBaseUrl: 'https://gateway.example.com/v1', modelsUrl: 'https://gateway.example.com/models', kind: 'openai-compatible', apiKey: KEY }]
      ])
      expect(f.out()).toContain(PROXY2)
      expect(f.out() + f.err()).not.toContain(KEY)
      expect(client.callsOf('connections:connect')).toEqual([])
    }
  })

  it('--key-stdin and --connect', async () => {
    manageDeps.readStdin = async () => `${KEY}\n`
    const { f, client, run } = setup({ 'connections:createProxy': created, 'connections:connect': () => infoOf(record, 'connected') })
    expect(await run(['proxy', 'add', '--name', 'G', '--anthropic-url', 'https://gateway.example.com', '--key-stdin', '--connect'])).toBe(0)
    expect(client.callsOf('connections:createProxy')).toEqual([[{ name: 'G', anthropicBaseUrl: 'https://gateway.example.com', apiKey: KEY }]])
    expect(client.callsOf('connections:connect')).toEqual([[PROXY2]])
    expect(f.out() + f.err()).not.toContain(KEY)
  })

  it('--connect exits 5 when the proxy does not connect', async () => {
    const { run } = setup({ 'connections:createProxy': created, 'connections:connect': () => infoOf(record, 'disconnected') })
    expect(await run(['proxy', 'add', '--name', 'G', '--anthropic-url', 'https://gateway.example.com', '--connect'])).toBe(EXIT.auth)
  })

  it('usage errors: no name, no address, bad kind or URL, a key as an argument, an unset variable', async () => {
    const { f, client, run } = setup({})
    expect(await run(['proxy', 'add', '--anthropic-url', 'https://gateway.example.com'])).toBe(EXIT.usage)
    expect(await run(['proxy', 'add', '--name', 'G'])).toBe(EXIT.usage)
    expect(await run(['proxy', 'add', '--name', 'G', '--anthropic-url', 'https://gateway.example.com', '--kind', 'other'])).toBe(EXIT.usage)
    expect(await run(['proxy', 'add', '--name', 'G', '--anthropic-url', 'ftp://x'])).toBe(EXIT.usage)
    expect(await run(['proxy', 'add', '--name', 'G', '--anthropic-url', 'https://u:p@gateway.example.com'])).toBe(EXIT.usage)
    expect(await run(['proxy', 'add', '--name', 'G', '--anthropic-url', 'https://gateway.example.com', KEY])).toBe(EXIT.usage)
    expect(await run(['proxy', 'add', '--name', 'G', '--anthropic-url', 'https://gateway.example.com', '--key-env', 'UNSET_VAR'])).toBe(EXIT.usage)
    expect(f.err()).not.toContain(KEY)
    expect(client.callsOf('connections:createProxy')).toEqual([])
  })

  it('a host refusal is exit 1 with the host text', async () => {
    const { f, run } = setup({ 'connections:createProxy': () => Promise.reject(rpcError({ code: 'bad_request', message: 'A proxy named G already exists.' })) })
    expect(await run(['proxy', 'add', '--name', 'G', '--anthropic-url', 'https://gateway.example.com'])).toBe(EXIT.failure)
    expect(f.err()).toContain('already exists')
  })
})

describe('connections proxy edit / remove', () => {
  it('edit changes name and URLs through connections:update; none clears an optional URL', async () => {
    const list = [infoOf(record)]
    const { client, run } = setup({ 'connections:list': () => list, 'connections:update': (p) => infoOf((p as [ProviderConnection])[0]), 'settings:get': () => ({}) })
    expect(await run(['proxy', 'edit', PROXY2, '--name', 'Renamed', '--anthropic-url', 'https://other.example.com/', '--openai-url', 'none', '--models-url', 'https://other.example.com/m'])).toBe(0)
    const sent = (client.callsOf('connections:update')[0] as [ProxyConnection])[0]
    expect(sent).toMatchObject({ id: PROXY2, name: 'Renamed', anthropicBaseUrl: 'https://other.example.com', modelsUrl: 'https://other.example.com/m' })
    expect(Object.hasOwn(sent, 'openaiBaseUrl')).toBe(false)
    expect(await run(['proxy', 'edit', PROXY2])).toBe(EXIT.usage)
    expect(await run(['proxy', 'edit', 'openai', '--name', 'x'])).toBe(EXIT.usage)
    expect(await run(['proxy', 'edit', PROXY2, '--enable', '--disable'])).toBe(EXIT.usage)
  })

  it('remove asks for --yes, then calls connections:removeProxy', async () => {
    const { client, run } = setup({ 'connections:removeProxy': () => ({ connections: [] }) })
    expect(await run(['proxy', 'remove', PROXY2])).toBe(EXIT.usage)
    expect(client.callsOf('connections:removeProxy')).toEqual([])
    expect(await run(['proxy', 'remove', PROXY2, '--yes'])).toBe(0)
    expect(client.callsOf('connections:removeProxy')).toEqual([[PROXY2]])
    expect(await run(['proxy', 'remove', 'anthropic', '--yes'])).toBe(EXIT.usage)
  })

  it('a refused removal (projects still use it) is exit 1 with the host text', async () => {
    const { f, run } = setup({ 'connections:removeProxy': () => Promise.reject(rpcError({ code: 'bad_request', message: 'Projects still use it: Demo.' })) })
    expect(await run(['proxy', 'remove', PROXY2, '--yes'])).toBe(EXIT.failure)
    expect(f.err()).toContain('Projects still use it')
  })

  it('a missing or unknown proxy subcommand is exit 2', async () => {
    const { run } = setup({})
    expect(await run(['proxy', 'nope'])).toBe(EXIT.usage)
    expect(await run(['proxy'])).toBe(EXIT.usage)
  })
})
