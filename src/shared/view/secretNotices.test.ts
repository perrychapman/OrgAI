import { describe, expect, it } from 'vitest'
import type { SecretsStatusResult } from '../types'
import { legacySoftDeletes, secretNotices, serviceOfKey, servicesOf } from './secretNotices'

const status = (over: Partial<SecretsStatusResult> = {}): SecretsStatusResult => ({
  state: 'open',
  scheme: 'key-file',
  counts: { vault: 1, legacy: 0, unreadable: 0, overlay: 0 },
  pendingLegacy: 0,
  softDeletes: [],
  orphanedKeys: 0,
  orphanedVaults: [],
  legacyFile: 'ok',
  canWriteBack: true,
  ...over
})
const legacy = (key: string) => ({ key, by: 'legacy' as const, at: 1, restorable: 'here' as const })

describe('secret notices', () => {
  it('says nothing for a healthy status and ignores deletes made by the vault itself', () => {
    expect(secretNotices(status())).toEqual([])
    expect(secretNotices(status({ softDeletes: [{ key: 'a', by: 'vault', at: 1, restorable: 'here' }] }))).toEqual([])
    expect(legacySoftDeletes(status({ softDeletes: [legacy('a'), { key: 'b', by: 'vault', at: 1, restorable: 'here' }] })).map((d) => d.key)).toEqual(['a'])
  })

  it('names the services of removed secrets where it can and counts the rest', () => {
    const names = { server: (p: string, s: string) => (p === 'p1' && s === 's1' ? 'GitHub' : undefined), library: (id: string) => (id === 'e1' ? 'Notion' : undefined) }
    expect(serviceOfKey('connection:litellm:apiKey')).toBe('LiteLLM')
    expect(serviceOfKey('connection:proxy-ab12:apiKey', { proxy: (id) => (id === 'proxy-ab12' ? 'Team proxy' : undefined) })).toBe('Team proxy')
    expect(serviceOfKey('connection:proxy-zz:apiKey')).toBeUndefined()
    expect(serviceOfKey('mcp:p1:s1:env:TOKEN', names)).toBe('GitHub')
    expect(serviceOfKey('mcplib:e1:header:X', names)).toBe('Notion')
    expect(serviceOfKey('mcp:p9:s9:env:T', names)).toBeUndefined()
    expect(servicesOf(['mcp:p1:s1:env:A', 'mcp:p1:s1:env:B', 'mcp:p9:s9:env:T'], names)).toEqual({ named: ['GitHub'], unnamed: 1 })
    const [n] = secretNotices(status({ softDeletes: [legacy('connection:litellm:apiKey'), legacy('mcp:p1:s1:env:TOKEN'), legacy('mcp:p9:s9:env:T')] }), names)
    expect(n.kind).toBe('removed')
    expect(n.title).toBe('3 saved secrets were removed by an older version of OrgAI.')
    expect(n.body).toContain('LiteLLM, GitHub and 1 more')
    expect(n.actions).toEqual(['restore', 'keep'])
    expect(n.keys).toHaveLength(3)
  })

  it('a vault that will not open and a damaged secrets.json each get a warning with a next step in the app', () => {
    for (const state of ['locked', 'missing-key', 'key-mismatch', 'corrupt'] as const) {
      const [n] = secretNotices(status({ state, reason: 'Secure storage is locked: The macOS keychain is locked.' }))
      expect(n.kind).toBe('vault')
      expect(n.tone).toBe('warning')
      expect(n.actions).toContain('reset')
      expect(n.body).not.toMatch(/orgai (secrets|command)|`/)
    }
    expect(secretNotices(status({ state: 'locked', reason: 'Secure storage is locked: The macOS keychain is locked.' }))[0].body).toContain('The macOS keychain is locked.')
    const [l] = secretNotices(status({ legacyFile: 'corrupt' }))
    expect(l.kind).toBe('legacy-corrupt')
    expect(l.body).toContain('Keys saved in secure storage still work')
    expect(l.actions).toEqual(['reset'])
  })
})
