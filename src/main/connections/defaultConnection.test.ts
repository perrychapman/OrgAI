import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'
import type { AppSettings, ConnectionStatus } from '@shared/types'
import { ProjectStore } from '../store/projects'
import { SecretStore } from '../store/secrets'
import { SettingsStore } from '../store/settings'
import { decideSettingsDefault, defaultRefusal, settingsForSave } from './defaultPick'
import { ConnectionService } from './service'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })
const proxyFetch = (async (url: string | URL | Request) =>
  String(url).endsWith('/v1/models') ? json({ data: [{ id: 'claude-sonnet-4-5' }] }) : json({ data: [] })) as unknown as typeof fetch

function setup(anthropic: { state: ConnectionStatus['state'] } = { state: 'connected' }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'orgai-defconn-'))
  dirs.push(dataDir)
  const settings = new SettingsStore(dataDir)
  const logs: string[] = []
  const probe = { current: anthropic }
  const service = new ConnectionService({
    dataDir,
    settings,
    projects: new ProjectStore(dataDir),
    secrets: new SecretStore(dataDir, { isEncryptionAvailable: () => true, encryptString: (p) => Buffer.from(p, 'utf8'), decryptString: (b) => b.toString('utf8') }),
    broadcast: () => {},
    openExternal: vi.fn(async () => {}),
    fetch: proxyFetch,
    anthropicProbe: async () => ({ ...probe.current }),
    logInfo: (m) => logs.push(m),
    now: () => 1000
  })
  const addLiteLLM = async () => {
    await service.update({ ...settings.get().connections.litellm, baseUrl: 'http://localhost:4000/' })
    await service.setSecret({ id: 'litellm', apiKey: 'sk-test-key' })
  }
  return { settings, service, logs, probe, addLiteLLM }
}

describe('automatic default connection', () => {
  it('moves the stored default to the only connected connection and logs once', async () => {
    const ctx = setup({ state: 'disconnected' })
    await ctx.addLiteLLM()
    await ctx.service.test('anthropic')
    expect(ctx.settings.get().defaultConnection).toBe('anthropic')
    await ctx.service.connect('litellm')
    expect(ctx.settings.get().defaultConnection).toBe('litellm')
    expect(ctx.settings.get().defaultConnectionChosen).toBeUndefined()
    expect(ctx.logs).toEqual(['Default connection is now LiteLLM (automatic: Anthropic is not connected)'])
    await ctx.service.test('anthropic')
    expect(ctx.logs).toHaveLength(1)
    expect(ctx.service.autoReplacedDefault()).toBe('anthropic')
    expect((await ctx.service.list()).map((c) => [c.connection.id, c.isDefault])).toEqual([['anthropic', false], ['openai', false], ['litellm', true]])
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

  it('does not rewrite once the user chose', async () => {
    const ctx = setup({ state: 'disconnected' })
    await ctx.addLiteLLM()
    await ctx.service.setDefault('anthropic') // the stored default is never refused
    expect(ctx.settings.get().defaultConnectionChosen).toBe(true)
    await ctx.service.connect('litellm')
    await ctx.service.test('anthropic')
    expect(ctx.settings.get().defaultConnection).toBe('anthropic')
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

  it('null returns to automatic and rewrites to the effective value', async () => {
    const ctx = setup({ state: 'connected' })
    await ctx.addLiteLLM()
    await ctx.service.test('anthropic')
    await ctx.service.connect('litellm')
    await ctx.service.setDefault('litellm')
    await ctx.service.logout('litellm')
    expect(ctx.settings.get().defaultConnection).toBe('litellm') // chosen stays
    await ctx.service.setDefault(null)
    expect(ctx.settings.get()).toMatchObject({ defaultConnection: 'anthropic' })
    expect(ctx.settings.get().defaultConnectionChosen).toBeUndefined()
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
  const conns = DEFAULT_APP_SETTINGS.connections
  it('names the connection and for LiteLLM the missing piece', () => {
    expect(defaultRefusal('anthropic', conns)).toBe('Anthropic is not connected. Connect it first, then make it the default.')
    expect(defaultRefusal('openai', conns)).toBe('OpenAI is not connected. Connect it first, then make it the default.')
    expect(defaultRefusal('litellm', { ...conns, litellm: { ...conns.litellm, enabled: true, baseUrl: '', hasApiKey: true } })).toMatch(/no base URL/)
    expect(defaultRefusal('litellm', { ...conns, litellm: { ...conns.litellm, enabled: true, baseUrl: 'http://x', hasApiKey: false } })).toMatch(/no API key/)
  })
})

describe('settings:set decision', () => {
  const refusal = (id: string) => (id === 'openai' ? 'nope' : null)
  const base = { stored: 'litellm', chosen: false, autoReplaced: 'anthropic', refusal } as const
  it('keeps an unchanged value, even an unusable one', () => {
    expect(decideSettingsDefault({ ...base, stored: 'openai', incoming: 'openai' })).toEqual({ kind: 'keep' })
  })
  it('keeps the stored value for a stale echo of the replaced one', () => {
    expect(decideSettingsDefault({ ...base, incoming: 'anthropic' })).toEqual({ kind: 'keep' })
    expect(decideSettingsDefault({ ...base, chosen: true, incoming: 'anthropic' })).toEqual({ kind: 'pick', connection: 'anthropic' })
  })
  it('picks a usable change and refuses an unusable one', () => {
    expect(decideSettingsDefault({ ...base, autoReplaced: undefined, incoming: 'anthropic' })).toEqual({ kind: 'pick', connection: 'anthropic' })
    expect(decideSettingsDefault({ ...base, incoming: 'openai' })).toEqual({ kind: 'refuse', message: 'nope' })
  })
  it('settingsForSave never lets the renderer set defaultConnectionChosen', () => {
    const stored: AppSettings = { ...DEFAULT_APP_SETTINGS, defaultConnection: 'litellm' }
    const ctl = { autoReplaced: 'anthropic' as const, refusal }
    const echo = settingsForSave({ ...stored, defaultConnection: 'anthropic', defaultConnectionChosen: true }, stored, ctl)
    expect(echo.defaultConnection).toBe('litellm')
    expect(echo.defaultConnectionChosen).toBeUndefined()
    const pick = settingsForSave({ ...stored, defaultConnection: 'anthropic' }, stored, { ...ctl, autoReplaced: undefined })
    expect(pick).toMatchObject({ defaultConnection: 'anthropic', defaultConnectionChosen: true })
    expect(() => settingsForSave({ ...stored, defaultConnection: 'openai' }, stored, ctl)).toThrow('nope')
    const chosenStored = { ...stored, defaultConnectionChosen: true }
    expect(settingsForSave({ ...stored }, chosenStored, ctl).defaultConnectionChosen).toBe(true)
  })
})
