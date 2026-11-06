import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readVaultMetadata } from './vaultMetadata'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmeta-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const write = (v: unknown): void => writeFileSync(join(dir, 'vault.json'), typeof v === 'string' ? v : JSON.stringify(v))
// Shape-valid ciphertexts (12-byte iv, 16-byte tag, base64): the full load validator is shared with the store.
const ct = { iv: Buffer.alloc(12, 1).toString('base64'), ct: Buffer.from('x').toString('base64'), tag: Buffer.alloc(16, 2).toString('base64') }
const valid = {
  format: 'orgai.vault/1',
  vaultId: 'ab'.repeat(16),
  custody: { scheme: 'keychain' },
  check: ct,
  entries: { 'connection:litellm:apiKey': { ...ct, at: 1, lc: true } },
  tombstones: {},
  legacy: {},
  legacyRetired: null
}

describe('readVaultMetadata (cli-standalone.md 5.7, Wave 7 contract)', () => {
  it('reports absent, present with counts, and corrupt; never a value', () => {
    expect(readVaultMetadata(dir)).toEqual({ state: 'absent', entries: 0, tombstones: 0, legacyRetired: false })
    write(valid)
    const m = readVaultMetadata(dir)
    expect(m).toEqual({ state: 'present', vaultId: 'ab'.repeat(16), scheme: 'keychain', entries: 1, tombstones: 0, legacyRetired: false })
    expect(JSON.stringify(m)).not.toContain('connection:litellm')
    for (const bad of [
      '{',
      { ...valid, format: 'x' },
      { ...valid, vaultId: 'short' },
      { ...valid, custody: { scheme: 'nope' } },
      { ...valid, entries: [] },
      // the store's validation (5.2): exact iv and tag lengths, base64, check present
      { ...valid, check: { ...ct, iv: Buffer.alloc(11).toString('base64') } },
      { ...valid, entries: { k: { ...ct, tag: 'not base64!', at: 1, lc: true } } },
      { ...valid, check: undefined },
      { ...valid, custody: { scheme: 'dpapi-user' } }
    ]) {
      write(bad)
      expect(readVaultMetadata(dir).state).toBe('corrupt')
    }
    write({ ...valid, legacyRetired: { at: 1, digest: 'd'.repeat(64), keys: {} } })
    expect(readVaultMetadata(dir).legacyRetired).toBe(true)
  })
})
