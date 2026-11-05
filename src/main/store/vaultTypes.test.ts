import { describe, expect, it } from 'vitest'
import { CustodyError, VaultNotReady, dpapiEntropy, isCustodyFailure, vaultCheckAad, vaultEntryAad, vaultStateForFailure, VAULT_FORMAT, VAULT_RETIREMENT_ENABLED } from './vaultTypes'

describe('vault format helpers (cli-standalone.md 5.2, 5.3)', () => {
  it('builds the AADs and the DPAPI entropy exactly as the spec writes them', () => {
    expect(VAULT_FORMAT).toBe('orgai.vault/1')
    expect(vaultEntryAad('ab12', 'connection:litellm:apiKey')).toBe('orgai.vault/1\u0000ab12\u0000connection:litellm:apiKey')
    expect(vaultCheckAad('ab12')).toBe('orgai.vault/1\u0000ab12\u0000\u0000check')
    expect(vaultCheckAad('ab12')).not.toBe(vaultEntryAad('ab12', 'check'))
    expect(dpapiEntropy('ab12')).toBe('orgai.vault/1:ab12')
  })

  it('maps custodian failures to vault states and recognises them', () => {
    expect(vaultStateForFailure('locked')).toBe('locked')
    expect(vaultStateForFailure('timeout')).toBe('locked')
    expect(vaultStateForFailure('unavailable')).toBe('locked')
    expect(vaultStateForFailure('missing')).toBe('missing-key')
    expect(vaultStateForFailure('denied')).toBe('missing-key')
    const e = new CustodyError('locked', 'The macOS keychain is locked')
    expect(isCustodyFailure(e)).toBe(true)
    expect(e.message).toBe('The macOS keychain is locked')
    expect(isCustodyFailure({ kind: 'nope', reason: 'x' })).toBe(false)
    expect(isCustodyFailure(null)).toBe(false)
    expect(new VaultNotReady('k').name).toBe('VaultNotReady')
  })

  it('retirement stays off this release', () => {
    expect(VAULT_RETIREMENT_ENABLED).toBe(false)
  })
})
