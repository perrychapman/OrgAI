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
const valid = {
  format: 'orgai.vault/1',
  vaultId: 'ab'.repeat(16),
  custody: { scheme: 'keychain' },
  check: { iv: 'a', ct: 'b', tag: 'c' },
  entries: { 'connection:litellm:apiKey': { iv: 'a', ct: 'b', tag: 'c', at: 1, lc: true } },
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
    for (const bad of ['{', { ...valid, format: 'x' }, { ...valid, vaultId: 'short' }, { ...valid, custody: { scheme: 'nope' } }, { ...valid, entries: [] }]) {
      write(bad)
      expect(readVaultMetadata(dir).state).toBe('corrupt')
    }
    write({ ...valid, legacyRetired: { at: 1, digest: 'd', keys: {} } })
    expect(readVaultMetadata(dir).legacyRetired).toBe(true)
  })
})
