/**
 * The FixtureVaultStore itself (the channel-coverage test relies on it): set() with a value on an unprepared lazy
 * vault throws VaultNotReady and is recorded, clears never need a vault, and a prepare called directly is the writer's
 * (secretChannels.test.ts shows the dispatcher attribution through invokeRpc).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FixtureVaultStore } from './vaultStore.fixture'
import { VAULT_MESSAGES, VaultNotReady } from './vaultTypes'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-vaultfixture-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('FixtureVaultStore', () => {
  it('traps a value on an unprepared vault; a clear needs no vault; a prepare opens it until forgotten', async () => {
    const s = new FixtureVaultStore(dir, { lazy: true })
    expect(s.state()).toBe('absent')
    expect(() => s.set('k', 'v')).toThrow(VaultNotReady)
    expect(s.violations).toEqual(['k'])
    s.set('k', null)
    expect(s.state()).toBe('absent')
    await s.prepareWrite()
    s.set('k', 'v')
    expect(s.get('k')).toBe('v')
    s.forgetVault()
    expect(() => s.set('k', 'w')).toThrow(VaultNotReady)
    expect(s.get('k')).toBe('v')
    expect(s.prepares().map((p) => p.origin)).toEqual(['writer'])
  })

  it("reads the app's own values as pending-legacy on a Node host until a Node write supersedes them", async () => {
    const s = new FixtureVaultStore(dir, { lazy: true })
    s.seedAppValue('app', 'from-the-app')
    expect(s.status('app')).toEqual({ unreadable: VAULT_MESSAGES.pendingLegacy })
    expect(s.get('app')).toBeUndefined()
    expect(s.has('app')).toBe(true)
    expect(s.keys('a')).toEqual(['app'])
    expect(s.storedKeys()).toEqual([])
    // An explicit clear is refused while there is no vault; a removal still goes through.
    expect(s.clearRefusal('app')).toBe(VAULT_MESSAGES.clearRefusedLegacyOnly)
    await s.prepareWrite()
    expect(s.clearRefusal('app')).toBeUndefined()
    expect(s.status('app')).toEqual({ unreadable: VAULT_MESSAGES.pendingLegacy })
    s.set('app', 'from-node')
    expect(s.status('app')).toBe('set')
    expect(s.get('app')).toBe('from-node')
    s.seedAppValue('gone', 'x')
    s.delete('gone')
    expect(s.has('gone')).toBe(false)
  })

  it("refuses a value with the store's own sentence in a state that cannot take one", async () => {
    const s = new FixtureVaultStore(dir)
    s.lockReason = 'Run security unlock-keychain'
    for (const [state, sentence] of [
      ['locked', VAULT_MESSAGES.locked('Run security unlock-keychain')],
      ['corrupt', VAULT_MESSAGES.corrupt],
      ['missing-key', VAULT_MESSAGES.missingKey],
      ['key-mismatch', VAULT_MESSAGES.keyMismatch]
    ] as const) {
      s.setState(state)
      expect(() => s.set('k', 'v'), state).toThrow(sentence)
      s.set('k', null)
    }
    s.setState('open')
    s.unavailable = true
    expect(() => s.set('k', 'v')).toThrow(/Secure storage is not available/)
    expect(s.violations).toEqual([])
  })
})
