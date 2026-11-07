import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'
import type { ConnectionStatus } from '@shared/types'
import { ProjectStore } from '../store/projects'
import { SecretStore } from '../store/secrets'
import { SettingsStore } from '../store/settings'
import { defaultRefusal } from './defaultPick'
import { ConnectionService } from './service'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })
const proxyFetch = (async (url: string | URL | Request) =>
  String(url).endsWith('/v1/models') ? json({ data: [{ id: 'claude-sonnet-4-5' }] }) : json({ data: [] })) as unknown as typeof fetch

function setup(anthropic: { state: ConnectionStatus['state'] } = { state: 'connected' }, opts: { throwProbe?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'orgai-defconn-'))
  dirs.push(dataDir)
  const settings = new SettingsStore(dataDir)
  settings.setProxies([{ id: 'litellm', name: 'LiteLLM', kind: 'litellm', anthropicBaseUrl: '', enabled: false, hasApiKey: false, tierModels: {} }])
  const logs: string[] = []
  const probe = { current: anthropic, throws: opts.throwProbe === true }
  const fetchImpl = { fail: false }
  const cipher = { decryptFails: false }
  const defaultChanged = vi.fn()
  const statuses: { connection: string; state: string }[] = []
  const service = new ConnectionService({
    dataDir,
    settings,
    projects: new ProjectStore(dataDir),
    secrets: new SecretStore(dataDir, {
      isEncryptionAvailable: () => true,
      encryptString: (p) => Buffer.from(p, 'utf8'),
      decryptString: (b) => {
        if (cipher.decryptFails) throw new Error('safeStorage cannot decrypt')
        return b.toString('utf8')
      }
    }),
    broadcast: (e) => {
      if (e.type === 'connection.status') statuses.push({ connection: e.connection, state: e.status.state })
    },
    onDefaultChanged: defaultChanged,
    openExternal: vi.fn(async () => {}),
    // Never look for or run a real codex (cli-standalone 6.2 runtime check).
    codexRuntime: async () => ({ ok: true, binary: { path: '/fake/codex' } }),
    fetch: (async (url: string | URL | Request) => {
      if (fetchImpl.fail) throw new Error('proxy down')
      return proxyFetch(url as string)
    }) as unknown as typeof fetch,
    anthropicProbe: async () => {
      if (probe.throws) throw new Error('CLI timed out')
      return { ...probe.current }
    },
    logInfo: (m) => logs.push(m),
    now: () => 1000
  })
  const addLiteLLM = async () => {
    await service.update({ ...settings.get().proxies[0], anthropicBaseUrl: 'http://localhost:4000/' })
    await service.setSecret({ id: 'litellm', apiKey: 'sk-test-key' })
  }
  return { settings, service, logs, probe, fetchImpl, addLiteLLM, cipher, defaultChanged, statuses }
}

describe('review hardening (self-configuration fix-up)', () => {
  it('refuses junk connection ids in test, logout, refresh and models without touching any status', async () => {
    const ctx = setup({ state: 'connected' })
    await ctx.service.test('anthropic')
    const before = ctx.settings.get()
    for (const junk of ['bogus', '__proto__', 'constructor', 'toString', '', 42, null]) {
      await expect(ctx.service.test(junk as never)).rejects.toThrow('Unknown connection')
      await expect(ctx.service.logout(junk as never)).rejects.toThrow('Unknown connection')
      await expect(ctx.service.connect(junk as never)).rejects.toThrow('Unknown connection')
      if (junk !== null) {
        await expect(ctx.service.refresh({ connection: junk as never })).rejects.toThrow('Unknown connection')
        expect(() => ctx.service.models({ connection: junk as never })).toThrow('Unknown connection')
      }
    }
    expect(ctx.statuses.map((s) => s.connection)).toEqual(['anthropic'])
    expect(ctx.settings.get()).toEqual(before)
    expect((await ctx.service.list()).find((c) => c.connection.id === 'anthropic')?.status.state).toBe('connected')
    expect(ctx.service.effectiveDefault()).toBe('anthropic')
  })

  it('a stored LiteLLM key that cannot be decrypted probes as error and never moves the default', async () => {
    const ctx = setup({ state: 'disconnected' })
    await ctx.addLiteLLM()
    await ctx.service.test('anthropic')
    await ctx.service.connect('litellm')
    expect(ctx.settings.get().defaultConnection).toBe('litellm')
    ctx.probe.current = { state: 'error' }
    ctx.cipher.decryptFails = true
    const status = await ctx.service.test('litellm')
    // Wave 7 (5.4): the detail is SecretStore.status()'s reason (why it cannot be read here), never "set it again".
    expect(status.state).toBe('error')
    expect(status.detail).toBeTruthy()
    expect(status.detail).not.toMatch(/set (it|the API key) again|Set an API key/i)
    expect(ctx.settings.get().defaultConnection).toBe('litellm')
    expect(ctx.service.effectiveDefault()).toBe('litellm')
  })

  it('a base URL change or a saved key waits for Test and connect and does not move the automatic default', async () => {
    const ctx = setup({ state: 'disconnected' })
    await ctx.addLiteLLM()
    await ctx.service.test('anthropic')
    await ctx.service.connect('litellm')
    expect(ctx.settings.get().defaultConnection).toBe('litellm')
    const logs = ctx.logs.length
    await ctx.service.update({ ...ctx.settings.get().proxies[0], anthropicBaseUrl: 'http://localhost:4000/v2' })
    expect(ctx.statuses.at(-1)).toEqual({ connection: 'litellm', state: 'disconnected' })
    expect(ctx.settings.get().defaultConnection).toBe('litellm')
    expect(ctx.service.effectiveDefault()).toBe('litellm')
    await ctx.service.setSecret({ id: 'litellm', apiKey: 'sk-other' })
    expect(ctx.settings.get().defaultConnection).toBe('litellm')
    expect(ctx.service.effectiveDefault()).toBe('litellm')
    expect(ctx.logs.length).toBe(logs)
    // The next definite probe decides again; a removed key is definite at once.
    await ctx.service.setSecret({ id: 'litellm', apiKey: null })
    expect(ctx.service.effectiveDefault()).toBe('anthropic')
    expect(ctx.settings.get().defaultConnection).toBe('anthropic')
  })

  it('forgets a replaced connection that is no longer configured', async () => {
    const ctx = setup({ state: 'disconnected' })
    await ctx.addLiteLLM()
    await ctx.service.test('anthropic')
    await ctx.service.connect('litellm')
    expect(ctx.settings.get().defaultConnectionReplaced).toBe('anthropic')
    await ctx.service.update({ ...ctx.settings.get().connections.anthropic, enabled: false })
    expect(ctx.settings.get()).not.toHaveProperty('defaultConnectionReplaced')
    expect(ctx.settings.get()).toMatchObject({ defaultConnection: 'litellm', defaultConnectionChosen: false })
  })

  it('re-choosing the stored default still requires it to be configured', async () => {
    const ctx = setup({ state: 'connected' })
    await ctx.service.test('anthropic')
    await ctx.service.update({ ...ctx.settings.get().connections.anthropic, enabled: false })
    expect(ctx.settings.get().defaultConnection).toBe('anthropic') // nothing else configured
    await expect(ctx.service.setDefault('anthropic')).rejects.toThrow(/turned off/)
    expect(ctx.settings.get().defaultConnectionChosen).not.toBe(true)
  })

  it('rewrites the automatic default when a cleared base URL leaves LiteLLM unconfigured, and moves back later', async () => {
    const ctx = setup({ state: 'disconnected' })
    await ctx.addLiteLLM()
    await ctx.service.test('anthropic')
    await ctx.service.connect('litellm')
    expect(ctx.settings.get().defaultConnection).toBe('litellm')
    ctx.probe.current = { state: 'connected' }
    await ctx.service.test('anthropic') // moves back to anthropic (the replaced one)
    expect(ctx.settings.get().defaultConnection).toBe('anthropic')
    await ctx.service.setDefault('litellm')
    await ctx.service.setDefault(null)
    expect(ctx.settings.get().defaultConnection).toBe('litellm')
    await ctx.service.update({ ...ctx.settings.get().proxies[0], anthropicBaseUrl: '' })
    expect(ctx.settings.get()).toMatchObject({ defaultConnection: 'anthropic', defaultConnectionChosen: false })
    expect(ctx.service.effectiveDefault()).toBe('anthropic')
  })

  it('reports an effective-default move in chosen mode through onDefaultChanged', async () => {
    const ctx = setup({ state: 'connected' })
    await ctx.addLiteLLM()
    await ctx.service.test('anthropic')
    await ctx.service.connect('litellm')
    await ctx.service.setDefault('litellm')
    ctx.defaultChanged.mockClear()
    await ctx.service.test('anthropic') // no move
    expect(ctx.defaultChanged).not.toHaveBeenCalled()
    await ctx.service.logout('litellm') // chosen LiteLLM is no longer configured: the effective default moves
    expect(ctx.settings.get()).toMatchObject({ defaultConnection: 'litellm', defaultConnectionChosen: true })
    expect(ctx.service.effectiveDefault()).toBe('anthropic')
    expect(ctx.defaultChanged).toHaveBeenCalled()
  })
})

describe('automatic default connection', () => {
  it('moves the stored default to the only connected connection, remembers what it replaced and logs once', async () => {
    const ctx = setup({ state: 'disconnected' })
    await ctx.addLiteLLM()
    await ctx.service.test('anthropic')
    expect(ctx.settings.get().defaultConnection).toBe('anthropic')
    await ctx.service.connect('litellm')
    expect(ctx.settings.get()).toMatchObject({ defaultConnection: 'litellm', defaultConnectionChosen: false, defaultConnectionReplaced: 'anthropic' })
    expect(ctx.logs).toEqual(['Default connection is now LiteLLM (automatic: Anthropic is not connected)'])
    expect((await ctx.service.list()).map((c) => [c.connection.id, c.isDefault])).toEqual([['anthropic', false], ['openai', false], ['litellm', true]])
  })

  it('moves back to the replaced connection when it connects again and clears the field', async () => {
    const ctx = setup({ state: 'disconnected' })
    await ctx.addLiteLLM()
    await ctx.service.test('anthropic')
    await ctx.service.connect('litellm')
    ctx.probe.current = { state: 'connected' }
    await ctx.service.test('anthropic')
    expect(ctx.settings.get().defaultConnection).toBe('anthropic')
    expect(ctx.settings.get().defaultConnectionChosen).toBe(false)
    expect(ctx.settings.get()).not.toHaveProperty('defaultConnectionReplaced')
    expect(ctx.logs.at(-1)).toBe('Default connection is now Anthropic (automatic: Anthropic is connected again)')
  })

  it('never rewrites on error, a probe throw or a failed discovery', async () => {
    const ctx = setup({ state: 'error' })
    await ctx.addLiteLLM()
    await ctx.service.connect('litellm')
    await ctx.service.test('anthropic')
    expect(ctx.settings.get().defaultConnection).toBe('anthropic')
    ctx.probe.throws = true
    await ctx.service.test('anthropic')
    expect(ctx.settings.get().defaultConnection).toBe('anthropic')
    expect(ctx.service.effectiveDefault()).toBe('anthropic')
    // The stored default on LiteLLM: a proxy that stops answering is 'error', not a definite disconnect.
    await ctx.service.setDefault('litellm')
    await ctx.service.setDefault(null)
    expect(ctx.settings.get().defaultConnection).toBe('litellm')
    ctx.fetchImpl.fail = true
    ctx.probe.throws = false
    ctx.probe.current = { state: 'connected' }
    await ctx.service.test('anthropic')
    expect((await ctx.service.test('litellm')).state).toBe('error')
    expect(ctx.settings.get().defaultConnection).toBe('litellm')
    expect(ctx.logs).toEqual([])
  })

  it('does not rewrite while the stored default is unknown', async () => {
    const ctx = setup({ state: 'connected' })
    await ctx.addLiteLLM()
    await ctx.service.connect('litellm') // anthropic never probed: unknown
    expect(ctx.settings.get().defaultConnection).toBe('anthropic')
    expect(ctx.logs).toEqual([])
  })

  it('falls back when the connected default signs out', async () => {
    const ctx = setup({ state: 'connected' })
    await ctx.addLiteLLM()
    await ctx.service.test('anthropic')
    await ctx.service.connect('litellm')
    await ctx.service.setDefault('litellm')
    await ctx.service.setDefault(null)
    expect(ctx.settings.get().defaultConnection).toBe('litellm')
    await ctx.service.logout('litellm')
    expect(ctx.settings.get().defaultConnection).toBe('anthropic')
  })

  it('moves off an Anthropic connection the user turned off', async () => {
    const ctx = setup({ state: 'connected' })
    await ctx.addLiteLLM()
    await ctx.service.test('anthropic')
    await ctx.service.connect('litellm')
    await ctx.service.update({ ...ctx.settings.get().connections.anthropic, enabled: false })
    expect(ctx.settings.get().defaultConnection).toBe('litellm')
    expect(ctx.service.effectiveDefault()).toBe('litellm')
  })

  it('does not rewrite once the user chose, and keeps the chosen one effective while it is down (H1)', async () => {
    const ctx = setup({ state: 'disconnected' })
    await ctx.addLiteLLM()
    await ctx.service.setDefault('anthropic') // the stored default is never refused
    expect(ctx.settings.get().defaultConnectionChosen).toBe(true)
    await ctx.service.connect('litellm')
    await ctx.service.test('anthropic')
    expect(ctx.settings.get().defaultConnection).toBe('anthropic')
    expect(ctx.service.effectiveSettings().defaultConnection).toBe('anthropic')
    ctx.probe.current = { state: 'error' }
    await ctx.service.test('anthropic')
    expect(ctx.service.effectiveSettings().defaultConnection).toBe('anthropic')
    expect((await ctx.service.list()).find((c) => c.isDefault)?.connection.id).toBe('anthropic')
    expect(ctx.logs).toEqual([])
  })
})

describe('setDefault', () => {
  it('picks a connected connection and refuses others with a readable message', async () => {
    const ctx = setup({ state: 'connected' })
    await expect(ctx.service.setDefault('openai')).rejects.toThrow('OpenAI is not connected. Connect it first, then make it the default.')
    await expect(ctx.service.setDefault('litellm')).rejects.toThrow('LiteLLM is not connected. Connect it first, then make it the default.')
    await ctx.addLiteLLM()
    await ctx.service.connect('litellm')
    const list = await ctx.service.setDefault('litellm')
    expect(ctx.settings.get()).toMatchObject({ defaultConnection: 'litellm', defaultConnectionChosen: true })
    expect(list.find((c) => c.isDefault)?.connection.id).toBe('litellm')
    await expect(ctx.service.setDefault('bogus' as never)).rejects.toThrow('Unknown connection')
  })

  it('a pick clears the replaced connection', async () => {
    const ctx = setup({ state: 'disconnected' })
    await ctx.addLiteLLM()
    await ctx.service.test('anthropic')
    await ctx.service.connect('litellm')
    expect(ctx.settings.get().defaultConnectionReplaced).toBe('anthropic')
    await ctx.service.setDefault('litellm')
    expect(ctx.settings.get()).not.toHaveProperty('defaultConnectionReplaced')
  })

  it('null returns to automatic and rewrites to the effective value', async () => {
    const ctx = setup({ state: 'connected' })
    await ctx.addLiteLLM()
    await ctx.service.test('anthropic')
    await ctx.service.connect('litellm')
    await ctx.service.setDefault('litellm')
    await ctx.service.logout('litellm')
    expect(ctx.settings.get().defaultConnection).toBe('litellm') // chosen stays
    await ctx.service.setDefault(null)
    expect(ctx.settings.get()).toMatchObject({ defaultConnection: 'anthropic', defaultConnectionChosen: false, defaultConnectionReplaced: 'litellm' })
  })

  it('effective settings follow the effective default', async () => {
    const ctx = setup({ state: 'disconnected' })
    await ctx.addLiteLLM()
    await ctx.service.test('anthropic')
    await ctx.service.connect('litellm')
    expect(ctx.service.effectiveSettings().defaultConnection).toBe('litellm')
  })
})

describe('defaultRefusal', () => {
  const base = { connections: DEFAULT_APP_SETTINGS.connections }
  const conns = DEFAULT_APP_SETTINGS.connections
  const px = (over: Record<string, unknown>) => ({ proxies: [{ id: 'litellm', name: 'Team gateway', kind: 'litellm' as const, anthropicBaseUrl: '', enabled: true, hasApiKey: true, tierModels: {}, ...over }] })
  it('names the connection and for a proxy the missing piece', () => {
    expect(defaultRefusal('anthropic', base)).toBe('Anthropic is not connected. Connect it first, then make it the default.')
    expect(defaultRefusal('anthropic', { connections: { ...conns, anthropic: { ...conns.anthropic, enabled: false } } })).toMatch(/turned off/)
    expect(defaultRefusal('openai', base)).toBe('OpenAI is not connected. Connect it first, then make it the default.')
    expect(defaultRefusal('litellm', px({ anthropicBaseUrl: '' }))).toBe('Team gateway has no base URL yet. Add it and connect, then make it the default.')
    expect(defaultRefusal('litellm', px({ anthropicBaseUrl: 'http://x', hasApiKey: false }))).toMatch(/Team gateway has no API key/)
    expect(defaultRefusal('litellm', px({ anthropicBaseUrl: 'http://x' }))).toBe('Team gateway is not connected. Connect it first, then make it the default.')
    expect(defaultRefusal('proxy-0a1b2c3d', base)).toMatch(/no longer exists/)
  })
})
