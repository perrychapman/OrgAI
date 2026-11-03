import { describe, expect, it } from 'vitest'
import type { ConnectionInfo } from '@shared/types'
import { authMethodLabel, connectionWithAuth, defaultChangeAnnouncement, defaultConnectionInfo, defaultMode } from './connectionLabel'

const info = (connection: ConnectionInfo['connection'], isDefault = false): ConnectionInfo => ({ connection, status: { state: 'connected' }, modelCount: 0, isDefault })

describe('authMethodLabel', () => {
  it('names each auth method in plain words', () => {
    expect(authMethodLabel(info({ id: 'anthropic', enabled: true, tierModels: {}, auth: { kind: 'subscription' } }))).toBe('Claude Code login')
    expect(authMethodLabel(info({ id: 'anthropic', enabled: true, tierModels: {}, auth: { kind: 'apiKey', envVar: 'K' } }))).toBe('API key')
    expect(authMethodLabel(info({ id: 'openai', enabled: true, tierModels: {}, auth: { kind: 'chatgpt' } }))).toBe('ChatGPT sign-in')
    expect(authMethodLabel(info({ id: 'openai', enabled: true, tierModels: {}, auth: { kind: 'apiKey', envVar: 'K' } }))).toBe('API key')
    expect(authMethodLabel(info({ id: 'litellm', enabled: true, tierModels: {}, baseUrl: 'http://x', hasApiKey: true }))).toBe('proxy key')
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
