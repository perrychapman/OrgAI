import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LITELLM_KEY,
  SecretStore,
  mcpLibraryOAuthKey,
  mcpLibraryPrefix,
  mcpLibrarySecretKey,
  mcpOAuthKey,
  mcpOwnerOAuthKey,
  mcpOwnerPrefix,
  mcpOwnerSecretKey,
  mcpProjectPrefix,
  mcpSecretKey,
  mcpSecretPrefix,
  type SecretCipher
} from './secrets'

/** Reversible fake of safeStorage: not encryption, but never stores the plain text. */
const fakeCipher = (available = true): SecretCipher => ({
  isEncryptionAvailable: () => available,
  encryptString: (plain) => Buffer.from(`enc:${[...plain].reverse().join('')}`, 'utf8'),
  decryptString: (buf) => {
    const s = buf.toString('utf8')
    if (!s.startsWith('enc:')) throw new Error('bad ciphertext')
    return [...s.slice(4)].reverse().join('')
  }
})

const dirs: string[] = []
function dataDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'orgai-secrets-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('SecretStore', () => {
  it('round-trips values through the cipher and a reload, without plain text on disk', () => {
    const dir = dataDir()
    const store = new SecretStore(dir, fakeCipher())
    store.set(LITELLM_KEY, 'sk-litellm-123')
    expect(store.get(LITELLM_KEY)).toBe('sk-litellm-123')
    expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).not.toContain('sk-litellm-123')
    const reloaded = new SecretStore(dir, fakeCipher())
    expect(reloaded.has(LITELLM_KEY)).toBe(true)
    expect(reloaded.get(LITELLM_KEY)).toBe('sk-litellm-123')
  })

  it('deletes on null or empty and by prefix', () => {
    const store = new SecretStore(dataDir(), fakeCipher())
    const a = mcpSecretKey('p1', 's1', 'env', 'GITHUB_TOKEN')
    const b = mcpSecretKey('p1', 's1', 'header', 'Authorization')
    const c = mcpSecretKey('p1', 's2', 'env', 'X')
    const d = mcpSecretKey('p2', 's3', 'env', 'Y')
    for (const k of [a, b, c, d]) store.set(k, 'v')
    store.set(a, null)
    expect(store.has(a)).toBe(false)
    store.set(c, '')
    expect(store.has(c)).toBe(false)
    expect(store.keys(mcpSecretPrefix('p1', 's1'))).toEqual([b])
    expect(store.deletePrefix(mcpProjectPrefix('p1'))).toBe(1)
    expect(store.keys()).toEqual([d])
  })

  it('keeps library and project key spaces apart, including OAuth slots and owner helpers', () => {
    expect(mcpLibrarySecretKey('e1', 'env', 'T')).toBe('mcplib:e1:env:T')
    expect(mcpLibraryOAuthKey('e1', 'refreshToken')).toBe('mcplib:e1:oauth:refreshToken')
    expect(mcpOAuthKey('p1', 's1', 'accessToken')).toBe('mcp:p1:s1:oauth:accessToken')
    // a project whose id is "lib" cannot reach an entry's keys, and deleting a project prefix leaves the library alone
    const store = new SecretStore(dataDir(), fakeCipher())
    store.set(mcpLibrarySecretKey('e1', 'env', 'T'), 'lib')
    store.set(mcpSecretKey('p1', 's1', 'env', 'T'), 'proj')
    store.set(mcpOAuthKey('p1', 's1', 'accessToken'), 'tok')
    expect(store.deletePrefix(mcpProjectPrefix('p1'))).toBe(2)
    expect(store.keys()).toEqual(['mcplib:e1:env:T'])
    const owner = { libraryId: 'e1' }
    expect(mcpOwnerPrefix(owner)).toBe(mcpLibraryPrefix('e1'))
    expect(mcpOwnerSecretKey(owner, 'header', 'H')).toBe('mcplib:e1:header:H')
    expect(mcpOwnerOAuthKey({ projectId: 'p1', serverId: 's1' }, 'clientSecret')).toBe('mcp:p1:s1:oauth:clientSecret')
    expect(store.deletePrefix(mcpOwnerPrefix(owner))).toBe(1)
  })

  it('refuses to store when encryption is unavailable and reads undecryptable values as missing', () => {
    const dir = dataDir()
    const off = new SecretStore(dir, fakeCipher(false))
    expect(() => off.set(LITELLM_KEY, 'x')).toThrow(/Secure storage is not available/)
    const on = new SecretStore(dir, fakeCipher())
    on.set(LITELLM_KEY, 'x')
    const broken = new SecretStore(dir, { ...fakeCipher(), decryptString: () => { throw new Error('keyring changed') } })
    expect(broken.has(LITELLM_KEY)).toBe(true)
    expect(broken.get(LITELLM_KEY)).toBeUndefined()
  })
})
