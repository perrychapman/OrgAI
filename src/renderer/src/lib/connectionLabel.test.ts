import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectionInfo } from '@shared/types'
import { authMethodLabel, connectionKindLabel, connectionLabel, connectionWithAuth, defaultChangeAnnouncement, defaultConnectionInfo, defaultMode, isProxyId, setConnectionRegistry } from './connectionLabel'

const info = (connection: ConnectionInfo['connection'], isDefault = false): ConnectionInfo => ({ connection, status: { state: 'connected' }, modelCount: 0, isDefault })

describe('authMethodLabel', () => {
  it('names each auth method in plain words', () => {
    expect(authMethodLabel(info({ id: 'anthropic', enabled: true, tierModels: {}, auth: { kind: 'subscription' } }))).toBe('Claude Code login')
    expect(authMethodLabel(info({ id: 'anthropic', enabled: true, tierModels: {}, auth: { kind: 'apiKey', envVar: 'K' } }))).toBe('API key')
    expect(authMethodLabel(info({ id: 'openai', enabled: true, tierModels: {}, auth: { kind: 'chatgpt' } }))).toBe('ChatGPT sign-in')
    expect(authMethodLabel(info({ id: 'openai', enabled: true, tierModels: {}, auth: { kind: 'apiKey', envVar: 'K' } }))).toBe('API key')
    expect(authMethodLabel(info({ id: 'litellm', enabled: true, tierModels: {}, name: 'LiteLLM', kind: 'litellm', anthropicBaseUrl: 'http://x', hasApiKey: true, autoTiers: [] } as never))).toBe('proxy key')
  })
  it('joins name and method', () => {
    expect(connectionWithAuth(info({ id: 'anthropic', enabled: true, tierModels: {}, auth: { kind: 'subscription' } }))).toBe('Anthropic (Claude Code login)')
  })
})

describe('defaultConnectionInfo', () => {
  it('reads isDefault, never guesses', () => {
    const a = info({ id: 'anthropic', enabled: true, tierModels: {}, auth: { kind: 'subscription' } })
    const o = info({ id: 'openai', enabled: true, tierModels: {}, auth: { kind: 'chatgpt' } }, true)
    expect(defaultConnectionInfo([a, o])?.connection.id).toBe('openai')
    expect(defaultConnectionInfo(null)).toBeNull()
    expect(defaultConnectionInfo([a])).toBeNull()
  })
})

describe('defaultMode', () => {
  it('says Chosen only on the card the user picked', () => {
    expect(defaultMode('openai', true, 'openai')).toBe('chosen')
    expect(defaultMode('anthropic', false, 'anthropic')).toBe('automatic')
    expect(defaultMode('anthropic', null, 'anthropic')).toBeNull()
  })
  it('says Automatic on a fallback card when the chosen connection is no longer usable (L3)', () => {
    expect(defaultMode('anthropic', true, 'openai')).toBe('automatic')
  })
})

describe('defaultChangeAnnouncement', () => {
  it('names the chosen default', () => {
    expect(defaultChangeAnnouncement('openai', 'openai')).toBe('OpenAI is now the default for new projects and assistants')
  })
  it('names the automatic default it falls back to (L14)', () => {
    expect(defaultChangeAnnouncement(null, 'anthropic')).toBe('The default connection is automatic again: Anthropic for new projects and assistants')
    expect(defaultChangeAnnouncement(null, null)).toBe('The default connection is automatic again')
  })
})

const proxy = (id: string, name: string, kind: 'litellm' | 'openai-compatible' = 'litellm'): ConnectionInfo =>
  info({ id, name, kind, enabled: true, tierModels: {}, anthropicBaseUrl: 'https://proxy.invalid', hasApiKey: true, autoTiers: [] } as never)

describe('connectionLabel', () => {
  afterEach(() => setConnectionRegistry(null))
  it('names the built-ins, whatever the registry holds', () => {
    expect(connectionLabel('anthropic')).toBe('Anthropic')
    expect(connectionLabel('openai')).toBe('OpenAI')
    setConnectionRegistry([])
    expect(connectionLabel('anthropic')).toBe('Anthropic')
  })
  it('says Proxy before the list loads, never a raw id', () => {
    expect(connectionLabel('litellm')).toBe('Proxy')
    expect(connectionLabel('proxy-0000dead')).toBe('Proxy')
  })
  it('names a proxy by its own name', () => {
    setConnectionRegistry([proxy('litellm', 'Team gateway'), proxy('proxy-1a2b3c4d', 'Lab', 'openai-compatible')])
    expect(connectionLabel('litellm')).toBe('Team gateway')
    expect(connectionLabel('proxy-1a2b3c4d')).toBe('Lab')
  })
  it('says Removed proxy for a proxy id missing from a loaded list, including litellm when absent', () => {
    setConnectionRegistry([proxy('proxy-1a2b3c4d', 'Lab')])
    expect(connectionLabel('proxy-0000dead')).toBe('Removed proxy')
    expect(connectionLabel('litellm')).toBe('Removed proxy')
  })
  it('handles an empty id and tells proxies from built-ins', () => {
    expect(connectionLabel(null)).toBe('No connection')
    expect(isProxyId('proxy-1a2b3c4d')).toBe(true)
    expect(isProxyId('openai')).toBe(false)
    expect(isProxyId(undefined)).toBe(false)
  })
  it('words the kind for a badge', () => {
    expect(connectionKindLabel(proxy('litellm', 'A').connection)).toBe('LiteLLM proxy')
    expect(connectionKindLabel(proxy('proxy-1a2b3c4d', 'B', 'openai-compatible').connection)).toBe('OpenAI-compatible proxy')
    expect(connectionKindLabel(info({ id: 'openai', enabled: true, tierModels: {}, auth: { kind: 'chatgpt' } }).connection)).toBe('OpenAI')
    expect(connectionKindLabel(undefined)).toBe('Proxy')
  })
})
