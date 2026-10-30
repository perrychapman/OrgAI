import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE } from '@shared/defaults'
import { SettingsStore, normalizeAppearance, normalizeSettings, reconcileAnthropicAuth } from './settings'

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
