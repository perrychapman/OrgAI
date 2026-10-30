import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE } from '@shared/defaults'
import { SettingsStore, normalizeAppearance, normalizeSettings, reconcileAnthropicAuth, reconcileNearLimit } from './settings'

describe('tier model validation', () => {
  it('drops renderer or file tier models that are not valid model ids', () => {
    const tierModels = { top: '--help', deep: ' opus ', everyday: 'has space', fast: 'bell\u0007' }
    const s = normalizeSettings({ connections: { anthropic: { tierModels }, litellm: { tierModels: { deep: 'x'.repeat(201), fast: 'openai/gpt-ok' } } } } as never)
    expect(s.connections.anthropic.tierModels).toEqual({ deep: 'opus' })
    expect(s.connections.litellm.tierModels).toEqual({ fast: 'openai/gpt-ok' })
  })

  it('SettingsStore.set drops them too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgai-set-'))
    try {
      const store = new SettingsStore(dir)
      const base = store.get()
      store.set({ ...base, connections: { ...base.connections, openai: { ...base.connections.openai, tierModels: { deep: '-c', fast: 'gpt-mini' } } } })
      expect(store.get().connections.openai.tierModels).toEqual({ fast: 'gpt-mini' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('modelPrices', () => {
  const price = { inputPerToken: 1e-6, outputPerToken: 2e-6 }

  it('defaults to an empty list and ignores non-arrays', () => {
    expect(normalizeSettings({}).modelPrices).toEqual([])
    expect(normalizeSettings({ modelPrices: { model: 'x', price } } as never).modelPrices).toEqual([])
    expect(normalizeSettings({ modelPrices: 'x' } as never).modelPrices).toEqual([])
  })

  it('keeps valid entries as fresh plain objects and trims the model', () => {
    const input = [{ model: '  gpt-5 ', connection: 'litellm', price: { ...price, cacheReadPerToken: 1e-7, evil: 1 }, extra: true }]
    const out = normalizeSettings({ modelPrices: input as never }).modelPrices!
    expect(out).toEqual([{ model: 'gpt-5', connection: 'litellm', price: { inputPerToken: 1e-6, outputPerToken: 2e-6, cacheReadPerToken: 1e-7 } }])
    expect(out[0]).not.toBe(input[0])
    expect(out[0]!.price).not.toBe(input[0]!.price)
  })

  it('drops invalid entries', () => {
    const bad = [
      null, 'x', 4, [], { price },
      { model: '', price }, { model: '   ', price }, { model: 'x'.repeat(201), price }, { model: 5, price },
      { model: 'a', price: { inputPerToken: -1, outputPerToken: 1e-6 } },
      { model: 'b', price: { inputPerToken: 1e-6, outputPerToken: Number.NaN } },
      { model: 'c', price: { inputPerToken: 1e-6, outputPerToken: 0.010001 } },
      { model: 'd', price: { inputPerToken: 1e-6 } },
      { model: 'e', price: null },
      { model: 'f', connection: 'nope', price }
    ]
    expect(normalizeSettings({ modelPrices: bad as never }).modelPrices).toEqual([])
    expect(normalizeSettings({ modelPrices: [{ model: 'ok', price: { ...price, cacheCreationPerToken: -1 } }] as never }).modelPrices).toEqual([{ model: 'ok', price }])
  })

  it('dedupes by normalized model and connection, the last one winning', () => {
    const p = (n: number) => ({ inputPerToken: n * 1e-6, outputPerToken: n * 1e-6 })
    const out = normalizeSettings({
      modelPrices: [
        { model: 'Claude-Sonnet-4-5', price: p(1) },
        { model: 'anthropic/claude-sonnet-4-5-20250929', price: p(2) },
        { model: 'claude-sonnet-4-5', connection: 'litellm', price: p(3) }
      ] as never
    }).modelPrices!
    expect(out).toEqual([
      { model: 'anthropic/claude-sonnet-4-5-20250929', price: p(2) },
      { model: 'claude-sonnet-4-5', connection: 'litellm', price: p(3) }
    ])
  })

  it('caps the list', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ model: `m${i}`, price }))
    expect(normalizeSettings({ modelPrices: many as never }).modelPrices).toHaveLength(200)
  })

  it('does not copy prototype keys', () => {
    const polluted = JSON.parse('{"model":"x","price":{"inputPerToken":1e-6,"outputPerToken":2e-6,"__proto__":{"polluted":1}},"__proto__":{"polluted":1}}')
    const out = normalizeSettings({ modelPrices: [polluted] as never }).modelPrices!
    expect(out).toHaveLength(1)
    expect(Object.keys(out[0]!.price)).toEqual(['inputPerToken', 'outputPerToken'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('persists through the store, keeps them when a save leaves them out, and clears with an empty list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgai-set-'))
    try {
      const store = new SettingsStore(dir)
      store.set({ modelPrices: [{ model: 'gpt-5', price }, { model: 'bad', price: { inputPerToken: -1, outputPerToken: 1e-6 } }] })
      expect(store.get().modelPrices).toEqual([{ model: 'gpt-5', price }])
      expect(new SettingsStore(dir).get().modelPrices).toEqual([{ model: 'gpt-5', price }])
      store.set({ notifications: false })
      expect(store.get().modelPrices).toEqual([{ model: 'gpt-5', price }])
      store.set({ modelPrices: [] })
      expect(store.get().modelPrices).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('normalizeSettings', () => {
  it('defaults to the unattended permission mode', () => {
    expect(normalizeSettings(null).defaultPermissionMode).toBe('auto')
  })

  it('keeps every known mode and drops unknown ones', () => {
    for (const mode of ['auto', 'acceptEdits', 'default', 'dontAsk', 'plan', 'bypassPermissions'] as const) {
      expect(normalizeSettings({ defaultPermissionMode: mode }).defaultPermissionMode).toBe(mode)
    }
    expect(normalizeSettings({ defaultPermissionMode: 'yolo' as never }).defaultPermissionMode).toBe('auto')
  })
})

describe('built-in role models', () => {
  it('defaults every model setting to a tier, never a vendor alias', () => {
    const s = normalizeSettings({})
    expect(s).toMatchObject({ defaultRootModel: 'deep', defaultReportModel: 'everyday', setupModel: 'deep', mcpAssistModel: 'deep' })
  })

  it('keeps a model id and falls back on bad values', () => {
    expect(normalizeSettings({ setupModel: ' us.openai.gpt-5 ', mcpAssistModel: 'sonnet' })).toMatchObject({ setupModel: 'us.openai.gpt-5', mcpAssistModel: 'sonnet' })
    for (const bad of [42, '', '   ', 'inherit', 'two words', 'a\nb', 'x'.repeat(201), null, { id: 'opus' }]) {
      expect(normalizeSettings({ setupModel: bad, mcpAssistModel: bad } as never)).toMatchObject({ setupModel: 'deep', mcpAssistModel: 'deep' })
    }
  })

  it('migrates a saved value equal to the old Claude default to its tier, and only that', () => {
    expect(normalizeSettings({ defaultRootModel: 'opus', defaultReportModel: 'sonnet', setupModel: 'opus', mcpAssistModel: 'opus' })).toMatchObject({
      defaultRootModel: 'deep',
      defaultReportModel: 'everyday',
      setupModel: 'deep',
      mcpAssistModel: 'deep'
    })
    expect(normalizeSettings({ defaultRootModel: 'fable', defaultReportModel: 'haiku', setupModel: 'sonnet', mcpAssistModel: 'claude-opus-4-5' })).toMatchObject({
      defaultRootModel: 'fable',
      defaultReportModel: 'haiku',
      setupModel: 'sonnet',
      mcpAssistModel: 'claude-opus-4-5'
    })
  })
})

describe('near-limit everyday steering', () => {
  it('reads the legacy field when the new one is missing and mirrors both', () => {
    expect(normalizeSettings({ defaultPreferSonnetNearLimit: true })).toMatchObject({ defaultPreferEverydayNearLimit: true, defaultPreferSonnetNearLimit: true })
    expect(normalizeSettings({ defaultPreferEverydayNearLimit: false, defaultPreferSonnetNearLimit: true })).toMatchObject({
      defaultPreferEverydayNearLimit: false,
      defaultPreferSonnetNearLimit: false
    })
    expect(normalizeSettings({})).toMatchObject({ defaultPreferEverydayNearLimit: false, communityPrices: true })
  })

  it('lets an older renderer that changes only the legacy field win', () => {
    const prev = normalizeSettings({})
    expect(reconcileNearLimit(prev, { ...prev, defaultPreferSonnetNearLimit: true }).defaultPreferEverydayNearLimit).toBe(true)
    expect(reconcileNearLimit(prev, { ...prev, defaultPreferEverydayNearLimit: true }).defaultPreferEverydayNearLimit).toBe(true)
  })
})

describe('connection autoTiers', () => {
  it('keeps known tiers once and leaves a missing list undefined', () => {
    const s = normalizeSettings({ connections: { litellm: { autoTiers: ['fast', 'fast', 'bogus', 'deep'] } } } as never)
    expect(s.connections.litellm.autoTiers).toEqual(['fast', 'deep'])
    expect(normalizeSettings({}).connections.anthropic.autoTiers).toBeUndefined()
  })
})

describe('connections', () => {
  it('migrates settings saved before connections existed from providerAuth', () => {
    const s = normalizeSettings({ providerAuth: { kind: 'apiKey', envVar: 'MY_KEY' } })
    expect(s.connections.anthropic.auth).toEqual({ kind: 'apiKey', envVar: 'MY_KEY' })
    expect(s.providerAuth).toEqual({ kind: 'apiKey', envVar: 'MY_KEY' })
    expect(s.connections.anthropic.tierModels).toEqual({ top: 'fable', deep: 'opus', everyday: 'sonnet', fast: 'haiku' })
    expect(s.connections.openai).toMatchObject({ enabled: false, auth: { kind: 'chatgpt' } })
    expect(s.connections.litellm).toMatchObject({ enabled: false, baseUrl: '', hasApiKey: false })
    expect(s.defaultConnection).toBe('anthropic')
  })

  it('mirrors the connection auth into providerAuth and drops malformed entries', () => {
    const base = normalizeSettings(null)
    const s = normalizeSettings({
      ...base,
      providerAuth: { kind: 'subscription' },
      connections: {
        ...base.connections,
        anthropic: { ...base.connections.anthropic, auth: { kind: 'apiKey', envVar: 'K' } },
        litellm: { ...base.connections.litellm, baseUrl: ' http://x:4000 ', tierModels: { deep: 'a', bogus: 'b', fast: 3 } as never }
      },
      defaultConnection: 'nope' as never
    })
    expect(s.providerAuth).toEqual({ kind: 'apiKey', envVar: 'K' })
    expect(s.connections.litellm.baseUrl).toBe('http://x:4000')
    expect(s.connections.litellm.tierModels).toEqual({ deep: 'a' })
    expect(s.defaultConnection).toBe('anthropic')
  })

  it('lets an older UI change providerAuth alone, and the connection win otherwise', () => {
    const prev = normalizeSettings(null)
    const legacy = reconcileAnthropicAuth(prev, { ...prev, providerAuth: { kind: 'apiKey', envVar: 'NEW' } })
    expect(normalizeSettings(legacy).connections.anthropic.auth).toEqual({ kind: 'apiKey', envVar: 'NEW' })
    const viaConnection = reconcileAnthropicAuth(prev, {
      ...prev,
      connections: { ...prev.connections, anthropic: { ...prev.connections.anthropic, auth: { kind: 'apiKey', envVar: 'C' } } }
    })
    expect(normalizeSettings(viaConnection).providerAuth).toEqual({ kind: 'apiKey', envVar: 'C' })
  })
})

describe('appearance', () => {
  it('fills defaults for settings saved before appearance existed', () => {
    expect(normalizeSettings({ notifications: false }).appearance).toEqual(DEFAULT_APPEARANCE)
    expect(DEFAULT_APPEARANCE.theme).toBe('dark')
  })

  it('keeps valid values and falls back field by field', () => {
    expect(
      normalizeAppearance({ theme: 'light', accent: '#22C58B', canvas: { pattern: 'grid', tint: false, edges: 'orthogonal', minimap: true }, reduceMotion: 'on' })
    ).toEqual({ theme: 'light', accent: '#22c58b', canvas: { pattern: 'grid', tint: false, edges: 'orthogonal', minimap: true }, reduceMotion: 'on' })
    expect(normalizeAppearance({ theme: 'sepia', accent: 'purple', canvas: { pattern: 'stars', tint: 'yes', edges: 3 }, reduceMotion: 'always' })).toEqual(DEFAULT_APPEARANCE)
    expect(normalizeAppearance({ theme: 'system', accent: '#AbC' })).toMatchObject({ theme: 'system', accent: '#aabbcc' })
    expect(normalizeAppearance('nonsense')).toEqual(DEFAULT_APPEARANCE)
  })
})

describe('SettingsStore', () => {
  const tmp = (): string => mkdtempSync(join(tmpdir(), 'orgai-settings-'))

  it('migrates an old settings.json and keeps the stored appearance when a caller leaves it out', () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 1, settings: { notifications: false, defaultKeepRuns: 7 } }))
      const store = new SettingsStore(dir)
      expect(store.get()).toMatchObject({ notifications: false, defaultKeepRuns: 7, appearance: DEFAULT_APPEARANCE })
      store.set({ ...store.get(), appearance: { ...DEFAULT_APPEARANCE, theme: 'light' } })
      const { appearance: _drop, ...older } = store.get()
      store.set(older)
      expect(store.get().appearance.theme).toBe('light')
      expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).settings.appearance.theme).toBe('light')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('merges a partial appearance over the stored one', () => {
    const dir = tmp()
    try {
      const store = new SettingsStore(dir)
      store.set({ ...store.get(), appearance: { ...DEFAULT_APPEARANCE, accent: '#22c58b', canvas: { ...DEFAULT_APPEARANCE.canvas, minimap: true } } })
      store.set({ ...store.get(), appearance: { theme: 'light', canvas: { pattern: 'grid' } } as never })
      expect(store.get().appearance).toEqual({ ...DEFAULT_APPEARANCE, theme: 'light', accent: '#22c58b', canvas: { ...DEFAULT_APPEARANCE.canvas, pattern: 'grid', minimap: true } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('tells listeners about every save until they unsubscribe', () => {
    const dir = tmp()
    try {
      const store = new SettingsStore(dir)
      const seen: boolean[] = []
      const off = store.onChange((s) => seen.push(s.notifications !== false))
      store.set({ ...store.get(), notifications: false })
      store.set({ ...store.get(), notifications: true })
      off()
      store.set({ ...store.get(), notifications: false })
      expect(seen).toEqual([false, true])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
