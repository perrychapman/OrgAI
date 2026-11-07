import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROXIES_MAX } from '@shared/types'
import { SettingsStore, normalizeProxies, normalizeSettings } from './settings'

const legacy = (over: Record<string, unknown> = {}) => ({
  connections: { litellm: { id: 'litellm', enabled: true, baseUrl: 'https://llm.example.com/', hasApiKey: true, tierModels: { deep: 'team-big' }, autoTiers: ['deep'], ...over } }
})

describe('proxies migration from connections.litellm', () => {
  it('loads an old LiteLLM record as proxies[0] and does not emit the old key', () => {
    const s = normalizeSettings(legacy() as never)
    expect(s.proxies).toEqual([
      { id: 'litellm', name: 'LiteLLM', kind: 'litellm', anthropicBaseUrl: 'https://llm.example.com', enabled: true, hasApiKey: true, tierModels: { deep: 'team-big' }, autoTiers: ['deep'] }
    ])
    expect(s.connections).not.toHaveProperty('litellm')
    expect(normalizeSettings(s).proxies).toEqual(s.proxies)
  })

  it('migrates nothing from the blank default record an old file always held', () => {
    expect(normalizeSettings({ connections: { litellm: { id: 'litellm', enabled: false, baseUrl: '', hasApiKey: false, tierModels: {} } } } as never).proxies).toEqual([])
  })

  it('a stored default of litellm stays chosen when the record migrated, and falls back when nothing migrated', () => {
    const kept = normalizeSettings({ ...legacy(), defaultConnection: 'litellm' } as never)
    expect(kept.defaultConnection).toBe('litellm')
    expect(kept.defaultConnectionChosen).toBe(true)
    const lost = normalizeSettings({ defaultConnection: 'litellm', defaultConnectionChosen: true } as never)
    expect(lost.defaultConnection).toBe('anthropic')
    expect(lost.defaultConnectionChosen).toBe(false)
  })

  it('a file with both: proxies win, the old record is ignored', () => {
    const s = normalizeSettings({ ...legacy(), proxies: [{ id: 'proxy-0a1b2c3d', name: 'Gateway', kind: 'openai-compatible', anthropicBaseUrl: 'https://gw.example.com', enabled: true, hasApiKey: false, tierModels: {} }] } as never)
    expect(s.proxies.map((p) => p.id)).toEqual(['proxy-0a1b2c3d'])
  })

  it('an empty proxies array is respected (the user removed it)', () => {
    expect(normalizeSettings({ ...legacy(), proxies: [] } as never).proxies).toEqual([])
  })

  it('a refused old base URL migrates as unset', () => {
    expect(normalizeSettings(legacy({ baseUrl: 'http://llm.example.com' }) as never).proxies[0].anthropicBaseUrl).toBe('')
  })
})

describe('normalizeProxies', () => {
  const rec = (over: Record<string, unknown>) => ({ id: 'proxy-0a1b2c3d', name: 'Gateway', anthropicBaseUrl: 'https://gw.example.com', ...over })

  it('rebuilds entries: kind default, optional URLs cleaned, booleans strict', () => {
    const [p] = normalizeProxies([rec({ openaiBaseUrl: 'https://o.example.com/v1/', modelsUrl: 'https://m.example.com/models', enabled: 'yes', hasApiKey: 1, extra: 1 })])
    expect(p).toEqual({ id: 'proxy-0a1b2c3d', name: 'Gateway', kind: 'openai-compatible', anthropicBaseUrl: 'https://gw.example.com', openaiBaseUrl: 'https://o.example.com/v1', modelsUrl: 'https://m.example.com/models', enabled: false, hasApiKey: false, tierModels: {} })
  })

  it('drops junk: bad ids, duplicates, non-objects, hidden-character names; suffixes a name clash', () => {
    const out = normalizeProxies([
      rec({}),
      rec({}),
      rec({ id: 'proxy-0A1B2C3D' }),
      rec({ id: 'proxy-1b2c3d4e', name: 'gateway' }),
      rec({ id: 'proxy-2c3d4e5f', name: 'bad‮name' }),
      rec({ id: 'proxy-3d4e5f60', name: '   ' }),
      rec({ id: '__proto__' }),
      null,
      'x',
      [],
      rec({ id: 'proxy-4e5f6071', anthropicBaseUrl: 'https://user:pw@gw.example.com', openaiBaseUrl: 'ftp://x', modelsUrl: 42 })
    ])
    expect(out.map((p) => [p.id, p.name])).toEqual([
      ['proxy-0a1b2c3d', 'Gateway'],
      ['proxy-1b2c3d4e', 'gateway 2'],
      ['proxy-4e5f6071', 'Gateway 3']
    ])
    expect(out[2]).not.toHaveProperty('openaiBaseUrl')
    expect(out[2].anthropicBaseUrl).toBe('')
  })

  it('caps the list at PROXIES_MAX', () => {
    const many = Array.from({ length: PROXIES_MAX + 5 }, (_, i) => rec({ id: `proxy-${i.toString(16).padStart(8, '0')}`, name: `P${i}` }))
    expect(normalizeProxies(many)).toHaveLength(PROXIES_MAX)
  })

  it('non-array input with no legacy record is empty', () => {
    for (const junk of [undefined, null, 'x', 3, {}]) expect(normalizeProxies(junk)).toEqual([])
  })
})

describe('SettingsStore and proxies', () => {
  const withStore = (fn: (dir: string, store: SettingsStore) => void, initial?: unknown): void => {
    const dir = mkdtempSync(join(tmpdir(), 'orgai-proxies-'))
    try {
      if (initial) writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 1, settings: initial }))
      fn(dir, new SettingsStore(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('settings.set keeps the stored proxies and hasApiKey whatever the caller sends', () => {
    withStore((_dir, store) => {
      const before = store.get()
      store.set({ ...before, proxies: [], connections: { ...before.connections, litellm: { enabled: true, baseUrl: 'https://evil.example.com' } } as never })
      expect(store.get().proxies).toEqual(before.proxies)
      expect(store.get().proxies[0].hasApiKey).toBe(true)
      expect(store.get().proxies[0].anthropicBaseUrl).toBe('https://llm.example.com')
      store.set({ ...store.get(), proxies: [{ ...before.proxies[0], hasApiKey: false, name: 'Hijack' }] })
      expect(store.get().proxies[0]).toMatchObject({ hasApiKey: true, name: 'LiteLLM' })
    }, legacy())
  })

  it('writes the migrated list on the next save and not the old key', () => {
    withStore((dir, store) => {
      store.set({ ...store.get(), notifications: false })
      const saved = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { settings: { connections: Record<string, unknown>; proxies: { id: string }[] } }
      expect(saved.settings.proxies.map((p) => p.id)).toEqual(['litellm'])
      expect(saved.settings.connections).not.toHaveProperty('litellm')
    }, legacy())
  })

  it('setProxies replaces the list, notifies listeners and returns a removed default to anthropic / automatic', () => {
    withStore((_dir, store) => {
      let seen = 0
      store.onChange(() => seen++)
      store.set({ ...store.get(), defaultConnection: 'litellm', defaultConnectionChosen: true })
      expect(store.get().defaultConnection).toBe('litellm')
      seen = 0
      const out = store.setProxies([])
      expect(seen).toBe(1)
      expect(out.proxies).toEqual([])
      expect(out.defaultConnection).toBe('anthropic')
      expect(out.defaultConnectionChosen).toBe(false)
    }, legacy())
  })

  it('setProxyKeyStored flips one proxy only and ignores unknown ids', () => {
    withStore((_dir, store) => {
      store.setProxyKeyStored('litellm', false)
      expect(store.get().proxies[0].hasApiKey).toBe(false)
      store.setProxyKeyStored('proxy-ffffffff', true)
      store.setProxyKeyStored('__proto__', true)
      expect(store.get().proxies).toHaveLength(1)
      expect(store.get().proxies[0].hasApiKey).toBe(false)
    }, legacy())
  })
})
