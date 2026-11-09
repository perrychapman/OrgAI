import { unavailableCustodianFactory } from './unavailableCustodian'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
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
  READ_ONLY_SECRETS_MESSAGE,
  openSecretStore,
  type SecretCipher
} from './secrets'
import type { SecretStoreApi } from './vaultTypes'

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

describe('SecretStore overlay and read-only mode (cli-spec 3.5)', () => {
  it('lets overlay values win in get, has and keys, without writing them to disk', () => {
    const dir = dataDir()
    new SecretStore(dir, fakeCipher()).set(LITELLM_KEY, 'disk-value')
    const before = readFileSync(join(dir, 'secrets.json'), 'utf8')
    const extra = mcpLibrarySecretKey('lib1', 'env', 'TOKEN')
    const store = new SecretStore(dir, fakeCipher(), { overlay: new Map([[LITELLM_KEY, 'overlay-value'], [extra, 'tok']]) })
    expect(store.get(LITELLM_KEY)).toBe('overlay-value')
    expect(store.has(extra)).toBe(true)
    expect(store.get(extra)).toBe('tok')
    expect(store.keys().sort()).toEqual([LITELLM_KEY, extra].sort())
    expect(store.keys('mcplib:')).toEqual([extra])
    expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).toBe(before)
  })

  it('a read-only store reads disk values, is never available and refuses to save', () => {
    const dir = dataDir()
    new SecretStore(dir, fakeCipher()).set(LITELLM_KEY, 'disk-value')
    const store = new SecretStore(dir, fakeCipher(), { readOnly: true })
    expect(store.available()).toBe(false)
    expect(store.get(LITELLM_KEY)).toBe('disk-value')
    expect(() => store.set(LITELLM_KEY, 'new')).toThrow(READ_ONLY_SECRETS_MESSAGE)
    expect(store.get(LITELLM_KEY)).toBe('disk-value')
  })

  it('read-only deletes drop overlay entries only and never touch secrets.json', () => {
    const dir = dataDir()
    const disk = new SecretStore(dir, fakeCipher())
    const a = mcpSecretKey('p1', 's1', 'env', 'A')
    const b = mcpSecretKey('p1', 's1', 'env', 'B')
    disk.set(a, 'disk-a')
    const file = join(dir, 'secrets.json')
    const before = readFileSync(file, 'utf8')
    const mtime = statSync(file).mtimeMs
    const store = new SecretStore(dir, fakeCipher(), { readOnly: true, overlay: new Map([[a, 'over-a'], [b, 'over-b']]) })
    expect(store.get(a)).toBe('over-a')
    store.delete(a)
    expect(store.get(a)).toBe('disk-a')
    store.set(b, null)
    expect(store.has(b)).toBe(false)
    store.set(b, '')
    expect(new SecretStore(dir, fakeCipher(), { readOnly: true, overlay: new Map([[b, 'x']]) }).deletePrefix(mcpSecretPrefix('p1', 's1'))).toBe(1)
    expect(store.deletePrefix(mcpSecretPrefix('p1', 's1'))).toBe(0)
    expect(store.get(a)).toBe('disk-a')
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(statSync(file).mtimeMs).toBe(mtime)
  })

  it('a read-only store over an empty data dir never creates secrets.json', () => {
    const dir = dataDir()
    const store = new SecretStore(dir, fakeCipher(), { readOnly: true, overlay: new Map([[LITELLM_KEY, 'k']]) })
    store.delete(LITELLM_KEY)
    store.deletePrefix('')
    expect(existsSync(join(dir, 'secrets.json'))).toBe(false)
  })

  it('without read-only, a stored value replaces the overlay one and delete clears both', () => {
    const dir = dataDir()
    const store = new SecretStore(dir, fakeCipher(), { overlay: new Map([[LITELLM_KEY, 'over']]) })
    store.set(LITELLM_KEY, 'stored')
    expect(store.get(LITELLM_KEY)).toBe('stored')
    store.delete(LITELLM_KEY)
    expect(store.has(LITELLM_KEY)).toBe(false)
  })
})

describe('SecretStore without an opened vault (direct construction, cli-standalone.md 5.4, 5.6)', () => {
  it('implements SecretStoreApi as an app host in legacy-only mode: status set / unset / unreadable, state absent', async () => {
    const dir = dataDir()
    new SecretStore(dir, fakeCipher()).set(LITELLM_KEY, 'sk-1')
    const store: SecretStoreApi = new SecretStore(dir, fakeCipher())
    expect(store.status(LITELLM_KEY)).toBe('set')
    expect(store.status('mcp:p:s:env:NOPE')).toBe('unset')
    expect(store.state()).toBe('absent')
    // an app host writes secrets.json while it has no vault, so prepareWrite resolves without a custodian
    await expect(store.prepareWrite()).resolves.toBeUndefined()
    expect(store.vaultKeyFiles()).toEqual([])
    store.attachLeases(() => () => undefined)
    // an app host may clear a legacy key; nothing failed, so retryOpen does nothing
    expect(store.clearRefusal(LITELLM_KEY)).toBeUndefined()
    store.retryOpen('focus')
    expect(store.state()).toBe('absent')
    // a value this host cannot decrypt is unreadable, never "unset"
    const other = new SecretStore(dir, { ...fakeCipher(), decryptString: () => { throw new Error('no') } })
    expect(other.status(LITELLM_KEY)).toEqual({ unreadable: expect.any(String) })
  })

  it('statusReport describes the legacy file without a vault; init with the default custodian reports why it cannot', async () => {
    const dir = dataDir()
    const empty = new SecretStore(dir, fakeCipher(), { overlay: new Map([['k', 'v']]), platform: 'darwin', env: {} })
    expect(await empty.statusReport()).toMatchObject({ state: 'absent', scheme: 'keychain', legacyFile: 'missing', counts: { vault: 0, legacy: 0, overlay: 1 }, canWriteBack: true })
    empty.set(LITELLM_KEY, 'sk-2')
    const report = await empty.statusReport({ probe: true })
    expect(report).toMatchObject({ legacyFile: 'ok', counts: { legacy: 1 }, pendingLegacy: 0, softDeletes: [], orphanedKeys: 0, orphanedVaults: [] })
    expect(report.probe).toMatchObject({ ok: false, kind: 'unavailable' })
    expect(JSON.stringify(report)).not.toContain('sk-2')
    await expect(empty.initVault({})).rejects.toThrow(/not available in this build yet/)
    expect((await empty.resetVault({ confirm: true })).movedTo).toBeNull()
    expect(empty.undelete({ key: LITELLM_KEY })).toMatchObject({ restored: false })
    expect(empty.confirmDeletes({ keys: [LITELLM_KEY] })).toEqual({ confirmed: [] })
    expect(empty.get(LITELLM_KEY)).toBe('sk-2')
  })

  it('openSecretStore honours read-only and the overlay; an app host without a working custodian stays legacy-only', async () => {
    const dir = dataDir()
    const store = await openSecretStore({ dataDir: dir, userDataDir: dir, hostKind: 'inproc', product: 'desktop', cipher: fakeCipher(), custodian: unavailableCustodianFactory, readOnly: true, overlay: new Map([['k', 'v']]) })
    expect(store).toBeInstanceOf(SecretStore)
    expect(store.get('k')).toBe('v')
    expect(store.available()).toBe(false)
    const rw = await openSecretStore({ dataDir: dir, userDataDir: dir, hostKind: 'desktop', product: 'desktop', cipher: fakeCipher(), log: () => undefined, custodian: unavailableCustodianFactory })
    expect(rw.state()).toBe('absent')
    rw.set(LITELLM_KEY, 'sk-3')
    expect(existsSync(join(dir, 'secrets.json'))).toBe(true)
    expect(existsSync(join(dir, 'vault.json'))).toBe(false)
    rw.dispose()
  })
})
