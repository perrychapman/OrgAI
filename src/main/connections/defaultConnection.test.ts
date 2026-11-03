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
  const logs: string[] = []
  const probe = { current: anthropic, throws: opts.throwProbe === true }
  const fetchImpl = { fail: false }
  const service = new ConnectionService({
    dataDir,
    settings,
    projects: new ProjectStore(dataDir),
    secrets: new SecretStore(dataDir, { isEncryptionAvailable: () => true, encryptString: (p) => Buffer.from(p, 'utf8'), decryptString: (b) => b.toString('utf8') }),
    broadcast: () => {},
    openExternal: vi.fn(async () => {}),
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
    await service.update({ ...settings.get().connections.litellm, baseUrl: 'http://localhost:4000/' })
    await service.setSecret({ id: 'litellm', apiKey: 'sk-test-key' })
  }
  return { settings, service, logs, probe, fetchImpl, addLiteLLM }
}

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
  const conns = DEFAULT_APP_SETTINGS.connections
  it('names the connection and for LiteLLM the missing piece', () => {
    expect(defaultRefusal('anthropic', conns)).toBe('Anthropic is not connected. Connect it first, then make it the default.')
    expect(defaultRefusal('anthropic', { ...conns, anthropic: { ...conns.anthropic, enabled: false } })).toMatch(/turned off/)
    expect(defaultRefusal('openai', conns)).toBe('OpenAI is not connected. Connect it first, then make it the default.')
    expect(defaultRefusal('litellm', { ...conns, litellm: { ...conns.litellm, enabled: true, baseUrl: '', hasApiKey: true } })).toMatch(/no base URL/)
    expect(defaultRefusal('litellm', { ...conns, litellm: { ...conns.litellm, enabled: true, baseUrl: 'http://x', hasApiKey: false } })).toMatch(/no API key/)
  })
})
