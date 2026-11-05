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
import { VaultNotReady } from './vaultTypes'

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
})
