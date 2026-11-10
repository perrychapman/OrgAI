import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_SETTINGS } from '../../shared/defaults'
import type { AppSettings, HostScope, ProviderModel } from '../../shared/types'
import { fakeContext, FakeHostClient } from '../testing/fakeContext'
import { CliError, EXIT } from '../types'
import { SETTING_KEYS, findSettingKey, parseSettingValue, runSettings } from './settings'

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide', 'configure'] }
const CATALOG = [{ id: 'claude-opus-4-1', connection: 'anthropic' }] as ProviderModel[]

function setup(stored: Partial<AppSettings> = {}, json = false) {
  let settings: Record<string, unknown> = { ...DEFAULT_APP_SETTINGS, ...stored, dataDir: '/d' }
  const client = new FakeHostClient(
    {
      'settings:get': () => settings,
      'settings:set': (p) => {
        const patch = (p as [Record<string, unknown>])[0]
        const next = { ...settings }
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) delete next[k]
          else next[k] = v
        }
        settings = next
        return settings
      },
      'models:list': () => CATALOG
    },
    { hello: ALL }
  )
  const f = fakeContext({ connect: [client], ...(json ? { globals: { outputFormat: 'json' } } : {}) })
  return { client, f }
}

async function run(f: ReturnType<typeof fakeContext>, args: string[]): Promise<number> {
  try {
    return await runSettings(f.ctx, args)
  } catch (e) {
    if (e instanceof CliError) {
      f.ctx.io.stderr.write(`${e.message}\n`)
      return e.exitCode
    }
    throw e
  }
}

describe('settings keys', () => {
  it('every key exists in AppSettings defaults (or is optional there) and has a description', () => {
    const optional = new Set(['defaultMaxBudgetUsd', 'skillAssistModel', 'quickRunModel', 'notifications', 'communityPrices'])
    for (const k of SETTING_KEYS) {
      expect(k.description.length).toBeGreaterThan(5)
      expect(Object.hasOwn(DEFAULT_APP_SETTINGS, k.key) || optional.has(k.key)).toBe(true)
    }
    const keys = SETTING_KEYS.map((k) => k.key as string)
    for (const out of ['appearance', 'connections', 'proxies', 'providerAuth', 'defaultConnection', 'modelPrices', 'defaultPreferSonnetNearLimit']) expect(keys).not.toContain(out)
  })

  it('finds keys case-insensitively and refuses unknown ones with the list', () => {
    expect(findSettingKey('defaultkeepruns').key).toBe('defaultKeepRuns')
    expect(() => findSettingKey('appearance')).toThrow(/Unknown setting "appearance". The settings are: defaultPermissionMode,/)
    expect(() => findSettingKey(undefined)).toThrow(/Name a setting/)
  })

  it('validates each kind', () => {
    const k = (name: string) => findSettingKey(name)
    expect(parseSettingValue(k('defaultPermissionMode'), 'acceptEdits')).toBe('acceptEdits')
    expect(() => parseSettingValue(k('defaultPermissionMode'), 'yolo')).toThrow(/use one of/)
    expect(parseSettingValue(k('defaultIsolateWriters'), 'off')).toBe(false)
    expect(parseSettingValue(k('notifications'), 'YES')).toBe(true)
    expect(() => parseSettingValue(k('communityPrices'), 'maybe')).toThrow(/on or off/)
    expect(parseSettingValue(k('defaultMaxBudgetUsd'), '2.5')).toBe(2.5)
    expect(parseSettingValue(k('defaultMaxBudgetUsd'), 'none')).toBeNull()
    expect(() => parseSettingValue(k('defaultMaxBudgetUsd'), '0')).toThrow(/over 0/)
    expect(() => parseSettingValue(k('defaultMaxBudgetUsd'), '-1')).toThrow()
    expect(() => parseSettingValue(k('defaultMaxBudgetUsd'), '1e9x')).toThrow()
    expect(parseSettingValue(k('defaultKeepRuns'), '20')).toBe(20)
    expect(() => parseSettingValue(k('defaultKeepRuns'), '0')).toThrow(/whole number from 1/)
    expect(() => parseSettingValue(k('defaultKeepRuns'), '2.5')).toThrow()
    expect(parseSettingValue(k('defaultMaxAutoContinues'), '0')).toBe(0)
    expect(() => parseSettingValue(k('defaultMaxAutoContinues'), '501')).toThrow(/to 500/)
    expect(() => parseSettingValue(k('opusGuardThreshold'), '101')).toThrow()
    expect(() => parseSettingValue(k('opusGuardThreshold'), 'none')).toThrow()
    expect(parseSettingValue(k('setupModel'), 'deep')).toBe('deep')
    expect(parseSettingValue(k('setupModel'), 'claude-opus-4-1', new Set(['claude-opus-4-1']))).toBe('claude-opus-4-1')
    expect(() => parseSettingValue(k('setupModel'), 'gpt-9', new Set(['claude-opus-4-1']))).toThrow(/not a tier or a model/)
    expect(() => parseSettingValue(k('setupModel'), 'inherit')).toThrow()
  })
})

describe('orgai settings', () => {
  it('list (bare and named) shows every key under read scope', async () => {
    const { f } = setup({ defaultMaxBudgetUsd: undefined })
    expect(await run(f, [])).toBe(0)
    expect(f.connectCalls[0].scopes).toEqual(['read'])
    for (const k of SETTING_KEYS) expect(f.out()).toContain(k.key)
    expect(f.out()).toMatch(/defaultMaxBudgetUsd\s+none/)
    const j = setup({}, true)
    expect(await run(j.f, ['list'])).toBe(0)
    const out = JSON.parse(j.f.out())
    expect(out.settings.map((s: { key: string }) => s.key)).toEqual(SETTING_KEYS.map((k) => k.key))
    expect(out.settings.find((s: { key: string }) => s.key === 'defaultPermissionMode')).toMatchObject({ type: 'enum', values: expect.arrayContaining(['default', 'plan']) })
  })

  it('get <key>', async () => {
    const { f } = setup({ defaultKeepRuns: 42 })
    expect(await run(f, ['get', 'defaultKeepRuns'])).toBe(0)
    expect(f.out().trim()).toBe('42')
    const j = setup({ communityPrices: false }, true)
    expect(await run(j.f, ['get', 'communityPrices'])).toBe(0)
    expect(JSON.parse(j.f.out())).toMatchObject({ key: 'communityPrices', value: false, type: 'boolean' })
  })

  it('set sends exactly one validated field under configure scope', async () => {
    const { f, client } = setup({ defaultKeepRuns: 10 })
    expect(await run(f, ['set', 'defaultKeepRuns', '25'])).toBe(0)
    expect(f.connectCalls[0].scopes).toEqual(['read', 'configure'])
    expect(client.callsOf('settings:set')).toEqual([[{ defaultKeepRuns: 25 }]])
    expect(f.out()).toContain('defaultKeepRuns: 10 -> 25')
  })

  it('set clears the budget with none (null on the wire)', async () => {
    const { f, client } = setup({ defaultMaxBudgetUsd: 5 }, true)
    expect(await run(f, ['set', 'defaultMaxBudgetUsd', 'none'])).toBe(0)
    expect(client.callsOf('settings:set')).toEqual([[{ defaultMaxBudgetUsd: null }]])
    expect(JSON.parse(f.out())).toMatchObject({ key: 'defaultMaxBudgetUsd', value: null, previous: 5, changed: true })
  })

  it('set a model: a tier needs no catalog; an id must be listed', async () => {
    const a = setup()
    expect(await run(a.f, ['set', 'quickRunModel', 'fast'])).toBe(0)
    expect(a.client.callsOf('models:list')).toEqual([])
    expect(a.client.callsOf('settings:set')).toEqual([[{ quickRunModel: 'fast' }]])
    const b = setup()
    expect(await run(b.f, ['set', 'setupModel', 'claude-opus-4-1'])).toBe(0)
    expect(b.client.callsOf('settings:set')).toEqual([[{ setupModel: 'claude-opus-4-1' }]])
    const c = setup()
    expect(await run(c.f, ['set', 'setupModel', 'gpt-9'])).toBe(EXIT.usage)
    expect(c.client.callsOf('settings:set')).toEqual([])
  })

  it('refuses unknown keys, bad values, JSON and extra words before starting a host', async () => {
    const { f } = setup()
    expect(await run(f, ['set', 'appearance', '{"theme":"dark"}'])).toBe(EXIT.usage)
    expect(await run(f, ['set', 'connections', '{}'])).toBe(EXIT.usage)
    expect(await run(f, ['set', 'defaultKeepRuns', '{"defaultKeepRuns":5,"proxies":[]}'])).toBe(EXIT.usage)
    expect(await run(f, ['set', 'defaultKeepRuns', '5', 'extra'])).toBe(EXIT.usage)
    expect(await run(f, ['set', 'defaultKeepRuns'])).toBe(EXIT.usage)
    expect(await run(f, ['get'])).toBe(EXIT.usage)
    expect(await run(f, ['frob'])).toBe(EXIT.usage)
    expect(f.connectCalls).toEqual([])
    expect(f.err()).toContain('Unknown setting "appearance"')
  })
})
