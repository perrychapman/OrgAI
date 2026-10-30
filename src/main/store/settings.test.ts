import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE } from '@shared/defaults'
import { SettingsStore, normalizeAppearance, normalizeSettings, reconcileAnthropicAuth } from './settings'

describe('modelPrices', () => {
  const price = { inputPerMTok: 1, outputPerMTok: 2 }

  it('defaults to an empty list and ignores non-arrays', () => {
    expect(normalizeSettings({}).modelPrices).toEqual([])
    expect(normalizeSettings({ modelPrices: { model: 'x', price } } as never).modelPrices).toEqual([])
    expect(normalizeSettings({ modelPrices: 'x' } as never).modelPrices).toEqual([])
  })

  it('keeps valid entries as fresh plain objects and trims the model', () => {
    const input = [{ model: '  gpt-5 ', connection: 'litellm', price: { ...price, cacheReadPerMTok: 0.1, evil: 1 }, extra: true }]
    const out = normalizeSettings({ modelPrices: input as never }).modelPrices!
    expect(out).toEqual([{ model: 'gpt-5', connection: 'litellm', price: { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.1 } }])
    expect(out[0]).not.toBe(input[0])
    expect(out[0]!.price).not.toBe(input[0]!.price)
  })

  it('drops invalid entries', () => {
    const bad = [
      null, 'x', 4, [], { price },
      { model: '', price }, { model: '   ', price }, { model: 'x'.repeat(201), price }, { model: 5, price },
      { model: 'a', price: { inputPerMTok: -1, outputPerMTok: 1 } },
      { model: 'b', price: { inputPerMTok: 1, outputPerMTok: Number.NaN } },
      { model: 'c', price: { inputPerMTok: 1, outputPerMTok: 10_001 } },
      { model: 'd', price: { inputPerMTok: 1 } },
      { model: 'e', price: null },
      { model: 'f', connection: 'nope', price }
    ]
    expect(normalizeSettings({ modelPrices: bad as never }).modelPrices).toEqual([])
    expect(normalizeSettings({ modelPrices: [{ model: 'ok', price: { ...price, cacheWritePerMTok: -1 } }] as never }).modelPrices).toEqual([{ model: 'ok', price }])
  })

  it('dedupes by normalized model and connection, the last one winning', () => {
    const p = (n: number) => ({ inputPerMTok: n, outputPerMTok: n })
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
    const polluted = JSON.parse('{"model":"x","price":{"inputPerMTok":1,"outputPerMTok":2,"__proto__":{"polluted":1}},"__proto__":{"polluted":1}}')
    const out = normalizeSettings({ modelPrices: [polluted] as never }).modelPrices!
    expect(out).toHaveLength(1)
    expect(Object.keys(out[0]!.price)).toEqual(['inputPerMTok', 'outputPerMTok'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('persists through the store, keeps them when a save leaves them out, and clears with an empty list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgai-set-'))
    try {
      const store = new SettingsStore(dir)
      store.set({ modelPrices: [{ model: 'gpt-5', price }, { model: 'bad', price: { inputPerMTok: -1, outputPerMTok: 1 } }] })
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
  it('defaults the setup and MCP assistant models to opus', () => {
    const s = normalizeSettings({})
    expect(s.setupModel).toBe('opus')
    expect(s.mcpAssistModel).toBe('opus')
  })

  it('keeps a model id and falls back on bad values', () => {
    expect(normalizeSettings({ setupModel: ' us.openai.gpt-5 ', mcpAssistModel: 'sonnet' })).toMatchObject({ setupModel: 'us.openai.gpt-5', mcpAssistModel: 'sonnet' })
    for (const bad of [42, '', '   ', 'inherit', 'two words', 'a\nb', 'x'.repeat(201), null, { id: 'opus' }]) {
      expect(normalizeSettings({ setupModel: bad, mcpAssistModel: bad } as never)).toMatchObject({ setupModel: 'opus', mcpAssistModel: 'opus' })
    }
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
