import { describe, expect, it } from 'vitest'
import { normalizeSettings, reconcileAnthropicAuth } from './settings'

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
