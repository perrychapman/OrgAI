import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { VaultDecryptError, checkMatches, decryptEntry, encryptEntry, isDek, makeCheck, newVaultId, sha256Hex, zeroize } from './vaultCrypto'

describe('vault crypto (cli-standalone.md 5.2)', () => {
  const dek = randomBytes(32)
  const vaultId = 'ab'.repeat(16)

  it('round-trips an entry with a fresh 12-byte iv and a 16-byte tag per write', () => {
    const a = encryptEntry(dek, vaultId, 'k', 'sk-secret')
    const b = encryptEntry(dek, vaultId, 'k', 'sk-secret')
    expect(Buffer.from(a.iv, 'base64')).toHaveLength(12)
    expect(Buffer.from(a.tag, 'base64')).toHaveLength(16)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ct).not.toContain('sk-secret')
    expect(decryptEntry(dek, vaultId, 'k', a)).toBe('sk-secret')
  })

  it('binds the AAD to the vault and the key, and refuses another key or a damaged record', () => {
    const c = encryptEntry(dek, vaultId, 'k1', 'v')
    expect(() => decryptEntry(dek, vaultId, 'k2', c)).toThrow(VaultDecryptError)
    expect(() => decryptEntry(dek, 'cd'.repeat(16), 'k1', c)).toThrow(VaultDecryptError)
    expect(() => decryptEntry(randomBytes(32), vaultId, 'k1', c)).toThrow(VaultDecryptError)
    const tag = Buffer.from(c.tag, 'base64')
    tag[0] = (tag[0] as number) ^ 1
    expect(() => decryptEntry(dek, vaultId, 'k1', { ...c, tag: tag.toString('base64') })).toThrow(VaultDecryptError)
  })

  it('the check record tells a matching key from another key or a damaged record (key-mismatch)', () => {
    const check = makeCheck(dek, vaultId)
    expect(checkMatches(dek, vaultId, check)).toBe(true)
    expect(checkMatches(randomBytes(32), vaultId, check)).toBe(false)
    expect(checkMatches(dek, 'cd'.repeat(16), check)).toBe(false)
    expect(checkMatches(Buffer.alloc(16), vaultId, check)).toBe(false)
    // the check AAD is not an entry AAD: an entry named "check" never passes as the check record
    expect(checkMatches(dek, vaultId, encryptEntry(dek, vaultId, 'check', 'orgai-vault-check'))).toBe(false)
    expect(checkMatches(dek, vaultId, { ...check, ct: Buffer.from('xx').toString('base64') })).toBe(false)
  })

  it('ids, hashes, key checks and zeroize', () => {
    expect(newVaultId()).toMatch(/^[0-9a-f]{32}$/)
    expect(newVaultId()).not.toBe(newVaultId())
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(isDek(Buffer.alloc(32))).toBe(true)
    expect(isDek(Buffer.alloc(31))).toBe(false)
    expect(isDek('x'.repeat(32))).toBe(false)
    const k = Buffer.alloc(32, 7)
    zeroize(k)
    expect(k.every((b) => b === 0)).toBe(true)
    zeroize(undefined)
  })
})
