import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostKind } from '@shared/types'
import {
  FOCUS_RETRY_MIN_MS,
  KEY_FILE_INSIDE_DATA_MESSAGE,
  LEGACY_CORRUPT_MESSAGE,
  LITELLM_KEY,
  NOTHING_TO_RESTORE_MESSAGE,
  NO_CUSTODIAN_MESSAGE,
  SecretStore,
  UNDECRYPTABLE_REASON,
  keyFileSchemeConflict,
  openSecretStore,
  type OpenSecretStoreOptions
} from './secrets'
import { custodianUnavailableReason, unavailableCustodianFactory } from './unavailableCustodian'
import { fakeCipher, fakeCustody, noCipher, olderApp, type FakeCustody } from './vaultTesting'
import { VAULT_MESSAGES, VAULT_TOMBSTONE_KEEP_MS, VaultNotReady, type VaultFile } from './vaultTypes'

let root: string
let dataDir: string
let custody: FakeCustody

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'vault-')))
  dataDir = join(root, 'data')
  mkdirSync(dataDir)
  custody = fakeCustody()
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

const isApp = (k: HostKind): boolean => k === 'desktop' || k === 'headless-host'
function host(kind: HostKind, extra: Partial<OpenSecretStoreOptions> = {}): Promise<SecretStore> {
  return openSecretStore({
    dataDir,
    userDataDir: root,
    hostKind: kind,
    cipher: isApp(kind) ? fakeCipher() : noCipher,
    custodian: custody.factory,
    platform: 'darwin',
    env: {},
    log: () => undefined,
    retryMs: 0,
    ...extra
  })
}
const app = (extra?: Partial<OpenSecretStoreOptions>): Promise<SecretStore> => host('desktop', extra)
const node = (extra?: Partial<OpenSecretStoreOptions>): Promise<SecretStore> => host('node', extra)
const vaultJson = (): VaultFile => JSON.parse(readFileSync(join(dataDir, 'vault.json'), 'utf8')) as VaultFile
const legacyKeys = (): string[] => olderApp(dataDir).keys().sort()
const locked = { kind: 'locked' as const, reason: 'Keychain locked over SSH' }

describe('opening and creating (cli-standalone.md 5.6)', () => {
  it('an app host creates the vault at once and imports every legacy key (one custodian call), never rewriting secrets.json values', async () => {
    const old = olderApp(dataDir)
    old.set(LITELLM_KEY, 'sk-1')
    old.set('mcp:p:s:env:T', 'tok')
    const before = readFileSync(join(dataDir, 'secrets.json'), 'utf8')
    const s = await app()
    expect(s.state()).toBe('open')
    expect(custody.calls.create).toBe(1)
    const v = vaultJson()
    expect(Object.keys(v.entries).sort()).toEqual([LITELLM_KEY, 'mcp:p:s:env:T'].sort())
    expect(v.entries[LITELLM_KEY]).toMatchObject({ lc: true })
    expect(v.custody).toEqual({ scheme: 'keychain' })
    expect(JSON.stringify(v)).not.toContain('sk-1')
    expect(readFileSync(join(dataDir, 'secrets.json'), 'utf8')).toBe(before)
    expect(s.get(LITELLM_KEY)).toBe('sk-1')
    // a Node host now reads the same values from the vault
    expect((await node()).get('mcp:p:s:env:T')).toBe('tok')
  })

  it('an app host that cannot create runs legacy-only: reads and writes secrets.json, retried every 10 minutes and swapped in place', async () => {
    vi.useFakeTimers()
    custody.fail(locked)
    olderApp(dataDir).set('a', '1')
    const s = await app({ retryMs: 600_000 })
    expect(s.state()).toBe('absent')
    expect(s.get('a')).toBe('1')
    s.set('b', '2')
    expect(olderApp(dataDir).get('b')).toBe('2')
    expect(existsSync(join(dataDir, 'vault.json'))).toBe(false)
    custody.fail(undefined)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(s.state()).toBe('open')
    expect(Object.keys(vaultJson().entries).sort()).toEqual(['a', 'b'])
    // no restart needed: the same store now writes both files
    s.set('c', '3')
    expect(vaultJson().entries.c?.lc).toBe(true)
    expect(olderApp(dataDir).get('c')).toBe('3')
    s.dispose()
  })

  it('retryOpen: focus only after a lock failure (throttled), never when nothing failed, never on Node hosts', async () => {
    let now = 1_000_000
    const s0 = await app({ now: () => now })
    s0.retryOpen('focus')
    expect(custody.calls.create).toBe(1)
    rmSync(join(dataDir, 'vault.json'))
    custody.fail({ kind: 'unavailable', reason: 'no secret-tool' })
    const s = await app({ now: () => now })
    expect(custody.calls.create).toBe(2)
    s.retryOpen('focus') // not a lock failure
    expect(custody.calls.create).toBe(2)
    custody.fail(locked)
    s.retryOpen('timer')
    await vi.waitFor(() => expect(custody.calls.create).toBe(3))
    s.retryOpen('focus')
    await vi.waitFor(() => expect(custody.calls.create).toBe(4))
    s.retryOpen('focus') // throttled
    expect(custody.calls.create).toBe(4)
    now += FOCUS_RETRY_MIN_MS + 1
    custody.fail(undefined)
    s.retryOpen('focus')
    await vi.waitFor(() => expect(s.state()).toBe('open'))
    custody.fail(locked)
    const n = await node()
    const opens = custody.calls.open
    n.retryOpen('focus')
    n.retryOpen('timer')
    expect(custody.calls.open).toBe(opens)
  })

  it('opens an existing vault with its recorded scheme; locked, missing and a wrong key are states, never a new key', async () => {
    olderApp(dataDir).set('k', 'v')
    await app()
    const id = vaultJson().vaultId
    custody.fail(locked)
    const l = await app()
    expect(l.state()).toBe('locked')
    expect(l.status('k')).toBe('set') // the app reads secrets.json while H = B and lc (legacy read rule)
    custody.fail({ kind: 'missing', reason: 'gone' })
    expect((await node()).state()).toBe('missing-key')
    custody.fail(undefined)
    custody.items.set(id, Buffer.alloc(32, 9))
    const m = await node()
    expect(m.state()).toBe('key-mismatch')
    expect(m.status('k')).toEqual({ unreadable: VAULT_MESSAGES.keyMismatch })
    // never a DEK while vault.json exists: prepareWrite and init do not create
    await expect(m.prepareWrite()).rejects.toThrow(VAULT_MESSAGES.keyMismatch)
    expect(custody.calls.create).toBe(1)
    expect(vaultJson().vaultId).toBe(id)
  })

  it('a Node host retries open at prepareWrite (unlocking the keychain over SSH works without a restart)', async () => {
    await app()
    custody.fail(locked)
    const n = await node()
    expect(n.state()).toBe('locked')
    await expect(n.prepareWrite()).rejects.toThrow('Keychain locked over SSH')
    custody.fail(undefined)
    await n.prepareWrite()
    expect(n.state()).toBe('open')
    n.set('x', 'y')
    expect(vaultJson().entries.x?.lc).toBe(false)
  })

  it('missing-key is retried only with a key file configured', async () => {
    const keyFile = join(tmpdir(), `orgai-test-${process.pid}.key`)
    await app({ env: { ORGAI_VAULT_KEY_FILE: keyFile } })
    expect(vaultJson().custody).toEqual({ scheme: 'key-file', keyFile })
    custody.fail({ kind: 'missing', reason: 'no file' })
    const n = await node({ env: { ORGAI_VAULT_KEY_FILE: keyFile } })
    expect(n.state()).toBe('missing-key')
    custody.fail(undefined)
    await n.prepareWrite()
    expect(n.state()).toBe('open')
    // custody.keyFile is recorded, so no variable is needed later; the variable overrides it
    expect(custody.calls.requests.at(-1)?.custody?.keyFile).toBe(keyFile)
    expect(n.vaultKeyFiles()).toContain(keyFile)
    rmSync(join(dataDir, 'vault.json'))
    custody.fail({ kind: 'missing', reason: 'gone' })
    await app()
    const k = await node()
    expect(k.state()).toBe('absent')
  })

  it('a key file inside the user data folder is refused at init and open', async () => {
    const s = await node()
    await expect(s.initVault({ keyFile: join(root, 'k.key') })).rejects.toThrow(KEY_FILE_INSIDE_DATA_MESSAGE)
    await expect(s.initVault({ keyFile: 'relative.key' })).rejects.toThrow(/absolute/)
    await expect(s.initVault({ importKeyFile: true })).rejects.toThrow(/--key-file/)
    const viaEnv = await node({ env: { ORGAI_VAULT_KEY_FILE: join(dataDir, 'k.key') } })
    await expect(viaEnv.prepareWrite()).rejects.toThrow(KEY_FILE_INSIDE_DATA_MESSAGE)
    expect(custody.calls.create).toBe(0)
  })

  it('a corrupt vault: no legacy reads, values and clears refused, never rewritten; removals leave the key', async () => {
    olderApp(dataDir).set('k', 'v')
    writeFileSync(join(dataDir, 'vault.json'), '{ broken')
    for (const s of [await app(), await node()]) {
      expect(s.state()).toBe('corrupt')
      expect(s.get('k')).toBeUndefined()
      expect(s.status('k')).toEqual({ unreadable: VAULT_MESSAGES.corrupt })
      expect(s.has('k')).toBe(true)
      expect(() => s.set('k', 'new')).toThrow(VAULT_MESSAGES.corrupt)
      await expect(s.prepareWrite()).rejects.toThrow(VAULT_MESSAGES.corrupt)
      expect(s.clearRefusal('k')).toBe(VAULT_MESSAGES.clearRefusedCorrupt)
      expect(s.clearRefusal('nowhere')).toBeUndefined()
      s.delete('k')
      expect(s.has('k')).toBe(true)
      expect((await s.statusReport()).orphanedKeys).toBe(1)
      expect(s.available()).toBe(false)
    }
    expect(readFileSync(join(dataDir, 'vault.json'), 'utf8')).toBe('{ broken')
    expect(olderApp(dataDir).get('k')).toBe('v')
    expect(custody.calls.create).toBe(0)
  })

  it('the default custodian is unavailable: an app host stays legacy-only, a Node host refuses values with the reason', async () => {
    const a = await app({ custodian: undefined })
    expect(a.state()).toBe('absent')
    a.set('k', 'v')
    expect(olderApp(dataDir).get('k')).toBe('v')
    const n = await openSecretStore({ dataDir, userDataDir: root, hostKind: 'inproc', cipher: noCipher, platform: 'darwin', env: {}, log: () => undefined })
    await expect(n.prepareWrite()).rejects.toThrow(custodianUnavailableReason('keychain'))
    expect(() => n.set('x', 'y')).toThrow(VaultNotReady)
    expect((await n.statusReport({ probe: true })).probe).toEqual({ ok: false, kind: 'unavailable', reason: custodianUnavailableReason('keychain') })
    expect(unavailableCustodianFactory('dpapi-user').scheme).toBe('dpapi-user')
    const none = await node({ platform: 'freebsd' as NodeJS.Platform })
    await expect(none.prepareWrite()).rejects.toThrow(NO_CUSTODIAN_MESSAGE)
  })
})

describe('Node and inproc hosts with an absent vault (5.4, 5.6)', () => {
  it('legacy keys read as pending-legacy; set without prepareWrite is a bug trap; clears never create a vault', async () => {
    olderApp(dataDir).set('k', 'v')
    const s = await node()
    expect(s.state()).toBe('absent')
    expect(s.status('k')).toEqual({ unreadable: VAULT_MESSAGES.pendingLegacy })
    expect(s.has('k')).toBe(true)
    expect(s.keys()).toEqual(['k'])
    expect(() => s.set('k', 'new')).toThrow(VaultNotReady)
    expect(s.clearRefusal('k')).toBe(VAULT_MESSAGES.clearRefusedLegacyOnly)
    expect(s.clearRefusal('nowhere')).toBeUndefined()
    s.set('k', null)
    s.delete('nowhere')
    expect(s.deletePrefix('')).toBe(0)
    expect(olderApp(dataDir).get('k')).toBe('v')
    expect(existsSync(join(dataDir, 'vault.json'))).toBe(false)
    expect(custody.calls.create).toBe(0)
    expect((await s.statusReport()).pendingLegacy).toBe(1)
  })

  it('prepareWrite is single-flight: concurrent callers share one creation, then values go to the vault only', async () => {
    olderApp(dataDir).set('legacy', 'L')
    const s = await node()
    custody.hold()
    const all = Promise.all([s.prepareWrite(), s.prepareWrite(), s.prepareWrite()])
    await vi.waitFor(() => expect(custody.calls.create).toBe(1))
    custody.release()
    await all
    expect(custody.calls.create).toBe(1)
    expect(s.state()).toBe('open')
    s.set('new', 'value')
    const v = vaultJson()
    expect(v.entries.new?.lc).toBe(false)
    expect(v.entries.legacy).toBeUndefined() // a Node host never imports
    expect(olderApp(dataDir).keys()).toEqual(['legacy'])
    expect(s.status('legacy')).toEqual({ unreadable: VAULT_MESSAGES.pendingLegacy })
  })

  it('prepareWrite re-checks vault.json after the custodian call and opens a vault that appeared instead of overwriting it', async () => {
    const s = await node()
    custody.hold()
    const p = s.prepareWrite()
    await vi.waitFor(() => expect(custody.calls.create).toBe(1))
    // another writer created a vault meanwhile (simulated: an app host on the same custody)
    custody.release()
    const other = await app()
    const id = vaultJson().vaultId
    other.set('k', 'v')
    await p.catch(() => undefined)
    expect(vaultJson().vaultId).toBe(id)
    expect(vaultJson().entries.k).toBeDefined()
  })
})

describe('reads (5.4, 5.5 legacy read rule)', () => {
  it('an entry whose tag fails after the check passed is unreadable, never unset', async () => {
    const s = await app()
    s.set('k', 'v')
    const v = vaultJson()
    v.entries.k!.ct = Buffer.from('tampered').toString('base64')
    writeFileSync(join(dataDir, 'vault.json'), JSON.stringify(v))
    // a Node host has no safeStorage to fall back to secrets.json
    const n = await node()
    expect(n.status('k')).toEqual({ unreadable: VAULT_MESSAGES.unreadableEntry })
    expect(n.has('k')).toBe(true)
  })

  it('a damaged entry falls back to secrets.json on the app only while lc says it holds the same value', async () => {
    const s = await app()
    s.set('k', 'v')
    const v = vaultJson()
    v.entries.k!.ct = Buffer.from('tampered').toString('base64')
    writeFileSync(join(dataDir, 'vault.json'), JSON.stringify(v))
    expect((await app()).get('k')).toBe('v')
  })

  it('an undecryptable legacy value is skipped for that key only, and reads unreadable rather than an older vault value', async () => {
    const s = await app()
    s.set('a', 'old')
    s.set('b', 'b')
    // an older app under another OS user / keyring wrote a value this safeStorage cannot decrypt
    const file = join(dataDir, 'secrets.json')
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { secrets: Record<string, string> }
    raw.secrets.a = Buffer.from('garbage').toString('base64')
    raw.secrets.c = Buffer.from('garbage2').toString('base64')
    writeFileSync(file, JSON.stringify(raw))
    const again = await app()
    expect(again.status('a')).toEqual({ unreadable: UNDECRYPTABLE_REASON })
    expect(again.get('b')).toBe('b')
    expect(again.status('c')).toEqual({ unreadable: UNDECRYPTABLE_REASON })
  })

  it('an app host reads secrets.json values whenever safeStorage decrypts them (as before), and never counts them as pending', async () => {
    olderApp(dataDir).set('k', 'v')
    custody.fail(locked)
    const s = await app({ cipher: { ...fakeCipher(), isEncryptionAvailable: () => false } })
    expect(s.state()).toBe('absent')
    expect(s.get('k')).toBe('v')
    expect((await s.statusReport()).pendingLegacy).toBe(0)
    expect(() => s.set('k', 'w')).toThrow(/Secure storage is not available/)
  })

  it('overlay values win in get / has / keys and are never saved; a stored value replaces the overlay one', async () => {
    const s = await node({ overlay: new Map([[LITELLM_KEY, 'from-env']]) })
    expect(s.get(LITELLM_KEY)).toBe('from-env')
    expect(s.status(LITELLM_KEY)).toBe('set')
    await s.prepareWrite()
    s.set(LITELLM_KEY, 'stored')
    expect(s.get(LITELLM_KEY)).toBe('stored')
    expect((await s.statusReport()).counts.overlay).toBe(0)
    const t = await node({ overlay: new Map([['o', 'x']]) })
    expect(t.deletePrefix('o')).toBe(1)
    expect(existsSync(join(dataDir, 'secrets.json'))).toBe(false)
  })
})

describe('writes (5.5 Writes)', () => {
  it('1: a host that can write back writes secrets.json first, then the vault with lc true and the baseline', async () => {
    const s = await app()
    s.set('k', 'v1')
    const v = vaultJson()
    expect(v.entries.k?.lc).toBe(true)
    expect(v.legacy.k).toBeDefined()
    expect(olderApp(dataDir).get('k')).toBe('v1')
  })

  it('2: an app whose safeStorage is unavailable (vault open through a key file) writes the vault only, lc false', async () => {
    await app()
    const s = await app({ cipher: fakeCipher(false) })
    expect(s.state()).toBe('open')
    s.set('k', 'v')
    expect(vaultJson().entries.k?.lc).toBe(false)
    expect(existsSync(join(dataDir, 'secrets.json'))).toBe(false)
    expect((await s.statusReport()).canWriteBack).toBe(false)
  })

  it('2: a Node write over a pending-legacy key sets legacy[K] = H, so the stale copy is never read again', async () => {
    olderApp(dataDir).set('k', 'app-value')
    await node().then((n) => n.prepareWrite())
    const n = await node()
    expect(n.status('k')).toEqual({ unreadable: VAULT_MESSAGES.pendingLegacy })
    await n.prepareWrite()
    n.set('k', 'node-value')
    expect(n.get('k')).toBe('node-value')
    custody.fail(locked)
    const lockedApp = await app()
    expect(lockedApp.get('k')).toBeUndefined() // H = B with lc false: never the stale legacy value
    custody.fail(undefined)
    const a = await app()
    expect(a.get('k')).toBe('node-value')
    expect(olderApp(dataDir).get('k')).toBe('node-value') // row 5 wrote it back
  })

  it('3: an app in legacy-only mode writes secrets.json only; the next open with a working key imports it (row 4)', async () => {
    const first = await app()
    first.set('k', 'v1')
    custody.fail(locked)
    const l = await app()
    l.set('k', 'v2')
    expect(l.get('k')).toBe('v2')
    custody.fail(undefined)
    const a = await app()
    expect(a.get('k')).toBe('v2')
    expect((await node()).get('k')).toBe('v2')
  })

  it('a corrupt secrets.json is never rewritten: legacy-only writes refuse, an open vault stores vault-only', async () => {
    writeFileSync(join(dataDir, 'secrets.json'), 'garbage')
    custody.fail(locked)
    const l = await app()
    expect(() => l.set('k', 'v')).toThrow(LEGACY_CORRUPT_MESSAGE)
    custody.fail(undefined)
    const s = await app()
    expect(s.state()).toBe('open')
    s.set('k', 'v')
    expect(vaultJson().entries.k?.lc).toBe(false)
    expect(readFileSync(join(dataDir, 'secrets.json'), 'utf8')).toBe('garbage')
    expect((await s.statusReport()).legacyFile).toBe('corrupt')
  })

  it('values are refused with the reason on a Node host whose vault is locked', async () => {
    await app()
    custody.fail(locked)
    const n = await node()
    expect(() => n.set('k', 'v')).toThrow(VAULT_MESSAGES.locked('Keychain locked over SSH'))
    expect(n.available()).toBe(false)
  })
})

describe('deletes (5.5 Deletes)', () => {
  it('three metadata-only steps: tombstone with legacyHash and prev, secrets.json removal, baseline dropped; no notice', async () => {
    const s = await app()
    s.set('k', 'v')
    const h = vaultJson().legacy.k
    s.delete('k')
    const v = vaultJson()
    expect(v.entries.k).toBeUndefined()
    expect(v.tombstones.k).toMatchObject({ by: 'vault', legacyHash: h })
    expect(v.tombstones.k?.prev).toBeDefined()
    expect(v.legacy.k).toBeUndefined()
    expect(legacyKeys()).toEqual([])
    const again = await app()
    expect(again.has('k')).toBe(false)
    expect(again.legacySoftDeletes()).toEqual([])
    expect(again.softDeletes()).toEqual([expect.objectContaining({ key: 'k', by: 'vault', restorable: 'here' })])
  })

  it('works in locked, missing-key and key-mismatch without a key, on every host', async () => {
    for (const fail of [locked, { kind: 'missing' as const, reason: 'gone' }, 'mismatch'] as const) {
      rmSync(dataDir, { recursive: true, force: true })
      mkdirSync(dataDir)
      custody.fail(undefined)
      const s = await app()
      s.set('k', 'v')
      if (fail === 'mismatch') custody.items.set(vaultJson().vaultId, Buffer.alloc(32, 3))
      else custody.fail(fail)
      for (const kind of ['desktop', 'node'] as const) {
        const h = await host(kind)
        expect(h.state()).not.toBe('open')
        h.set('k', null)
        expect(h.has('k')).toBe(false)
      }
      expect(vaultJson().tombstones.k?.by).toBe('vault')
      expect(legacyKeys()).toEqual([])
    }
  })

  it('keeps the newest value: prevLegacy when L is newer (H != B or pending-legacy), else prev', async () => {
    const s = await app()
    s.set('k', 'vault-v')
    custody.fail(locked)
    const l = await app()
    l.set('k', 'legacy-newer') // legacy-only save: H != B
    l.delete('k')
    const t = vaultJson().tombstones.k!
    expect(t.prevLegacy).toBeDefined()
    expect(t.prev).toBeUndefined()
    custody.fail(undefined)
    const a = await app()
    // the first app host with the vault open re-stores prevLegacy as prev (round 6 item 3)
    expect(vaultJson().tombstones.k?.prev).toBeDefined()
    expect(vaultJson().tombstones.k?.prevLegacy).toBeUndefined()
    expect(a.undelete({ key: 'k' })).toEqual({ restored: true })
    expect(a.get('k')).toBe('legacy-newer')
  })

  it('a Node host with an absent vault leaves a legacy-only key in place (orphaned) and never throws', async () => {
    olderApp(dataDir).set('mcp:p:s:env:A', 'a')
    olderApp(dataDir).set('mcp:p:s:env:B', 'b')
    const n = await node()
    expect(n.deletePrefix('mcp:p:')).toBe(0)
    expect((await n.statusReport()).orphanedKeys).toBe(2)
    expect(legacyKeys()).toEqual(['mcp:p:s:env:A', 'mcp:p:s:env:B'])
  })

  it('prefix deletes apply each rule per key and count what was removed', async () => {
    const s = await app()
    for (const k of ['mcp:p1:s:env:A', 'mcp:p1:s:env:B', 'mcp:p2:s:env:C']) s.set(k, 'v')
    expect(s.deletePrefix('mcp:p1:')).toBe(2)
    expect(s.keys()).toEqual(['mcp:p2:s:env:C'])
    expect(legacyKeys()).toEqual(['mcp:p2:s:env:C'])
    expect(Object.keys(vaultJson().tombstones).sort()).toEqual(['mcp:p1:s:env:A', 'mcp:p1:s:env:B'])
    expect(s.deletePrefix('mcp:none:')).toBe(0)
  })

  it('deleting a key that exists nowhere is a no-op in every state (no file is touched)', async () => {
    const n = await node()
    n.delete('nothing')
    expect(readdirSync(dataDir)).toEqual([])
    const a = await app()
    const before = readFileSync(join(dataDir, 'vault.json'), 'utf8')
    a.delete('nothing')
    expect(readFileSync(join(dataDir, 'vault.json'), 'utf8')).toBe(before)
  })
})

describe('secrets:* on the store (5.6, 5.7)', () => {
  it('statusReport: scheme, counts, pending, soft deletes, orphans, legacy file; never a value', async () => {
    olderApp(dataDir).set('a', 'secret-a')
    const s = await app()
    s.set('b', 'secret-b')
    s.delete('b')
    const r = await s.statusReport({ probe: true })
    expect(r).toMatchObject({
      state: 'open',
      scheme: 'keychain',
      probe: { ok: true },
      counts: { vault: 1, legacy: 1, unreadable: 0, overlay: 0 },
      pendingLegacy: 0,
      orphanedKeys: 0,
      orphanedVaults: [],
      legacyFile: 'ok',
      canWriteBack: true
    })
    expect(r.vaultId).toMatch(/^[0-9a-f]{32}$/)
    expect(r.softDeletes).toEqual([expect.objectContaining({ key: 'b', by: 'vault', restorable: 'here', expiresAt: expect.any(Number) })])
    expect(JSON.stringify(r)).not.toMatch(/secret-a|secret-b/)
    const absent = await (async () => {
      rmSync(dataDir, { recursive: true, force: true })
      mkdirSync(dataDir)
      return node({ env: { ORGAI_VAULT_KEY_FILE: '/elsewhere/k.key' } })
    })()
    expect(await absent.statusReport()).toMatchObject({ state: 'absent', scheme: 'key-file', keyFile: '/elsewhere/k.key', legacyFile: 'missing' })
  })

  it('initVault: created, opened, unchanged; a key file request on an OS-scheme vault is refused', async () => {
    const n = await node()
    expect((await n.initVault({})).action).toBe('created')
    expect((await n.initVault({})).action).toBe('unchanged')
    await expect(n.initVault({ keyFile: '/elsewhere/k.key' })).rejects.toThrow(keyFileSchemeConflict('keychain'))
    custody.fail(locked)
    const l = await node()
    await expect(l.initVault({})).rejects.toThrow('Keychain locked over SSH')
    custody.fail(undefined)
    expect((await l.initVault({})).action).toBe('opened')
    const k = join(tmpdir(), 'other-orgai.key')
    rmSync(join(dataDir, 'vault.json'))
    const kf = await node()
    const res = await kf.initVault({ keyFile: k, importKeyFile: true })
    expect(res.action).toBe('created')
    expect(res.status.scheme).toBe('key-file')
    expect(custody.calls.requests.at(-1)).toMatchObject({ scheme: 'key-file', request: { keyFile: k, importKeyFile: true } })
    expect(vaultJson().custody).toEqual({ scheme: 'key-file', keyFile: k })
  })

  it('resetVault moves vault.json aside (absent again), the app creates a fresh vault from secrets.json; orphans listed', async () => {
    olderApp(dataDir).set('a', '1')
    const s = await app({ now: () => Date.UTC(2026, 10, 5, 12, 0, 0, 7) })
    const oldId = vaultJson().vaultId
    await expect(s.resetVault({} as never)).rejects.toThrow(/confirm/)
    const res = await s.resetVault({ confirm: true })
    expect(res.movedTo).toBe('vault.json.reset-20261105T120000007Z')
    expect(existsSync(join(dataDir, res.movedTo!))).toBe(true)
    expect(s.state()).toBe('open')
    expect(vaultJson().vaultId).not.toBe(oldId)
    expect(s.get('a')).toBe('1')
    expect(res.status.orphanedVaults).toEqual([{ vaultId: oldId, scheme: 'keychain', file: res.movedTo }])
    // a Node host stays absent until the next stored value
    const n = await node()
    await n.resetVault({ confirm: true })
    expect(n.state()).toBe('absent')
    // corrupt: moved aside as .corrupt-
    writeFileSync(join(dataDir, 'vault.json'), 'x')
    const c = await node()
    expect((await c.resetVault({ confirm: true })).movedTo).toMatch(/^vault\.json\.corrupt-/)
    expect(c.state()).toBe('absent')
  })

  it('resetVault is refused while a sign-in or save is in flight (the integration hook) or a custody step runs', async () => {
    const s = await node()
    s.setResetBusyCheck(() => true)
    await expect(s.resetVault({ confirm: true })).rejects.toThrow(VAULT_MESSAGES.resetBusy)
    s.setResetBusyCheck(() => false)
    custody.hold()
    const p = s.prepareWrite()
    await expect(s.resetVault({ confirm: true })).rejects.toThrow(VAULT_MESSAGES.resetBusy)
    custody.release()
    await p
  })

  it('undelete restores prev here; a prevLegacy only on the app; expired and unknown keys report why', async () => {
    let now = 1_000
    const a = await app({ now: () => now })
    a.set('k', 'v')
    a.delete('k')
    expect(a.undelete({ key: 'nope' })).toEqual({ restored: false, reason: NOTHING_TO_RESTORE_MESSAGE })
    expect(a.undelete({ key: 'k' })).toEqual({ restored: true })
    expect(a.get('k')).toBe('v')
    expect(olderApp(dataDir).get('k')).toBe('v')
    a.delete('k')
    now += VAULT_TOMBSTONE_KEEP_MS + 1
    expect(a.undelete({ key: 'k' })).toEqual({ restored: false, reason: NOTHING_TO_RESTORE_MESSAGE })
  })

  it('confirmDeletes drops the kept values (metadata only, works while locked) and leaves unknown keys out', async () => {
    const s = await app()
    s.set('a', '1')
    s.set('b', '2')
    s.delete('a')
    custody.fail(locked)
    const l = await node()
    expect(l.confirmDeletes({ keys: ['a', 'zz', 'a'] })).toEqual({ confirmed: ['a'] })
    expect(vaultJson().tombstones.a).toBeUndefined()
    expect(l.softDeletes()).toEqual([])
    const n = await node({ dataDir: join(root, 'empty') } as Partial<OpenSecretStoreOptions>)
    expect(n.confirmDeletes({ keys: ['a'] })).toEqual({ confirmed: [] })
  })

  it('vaultKeyFiles lists ORGAI_VAULT_KEY_FILE and custody.keyFile, lexical and canonical', async () => {
    expect((await node()).vaultKeyFiles()).toEqual([])
    const k = join(root, '..', `${process.pid}-orgai.key`)
    const n = await node({ env: { ORGAI_VAULT_KEY_FILE: k } })
    expect(n.vaultKeyFiles()).toContain(join(root, '..', `${process.pid}-orgai.key`))
  })

  it('background custody steps hold a lease once the host attached them', async () => {
    vi.useFakeTimers()
    custody.fail(locked)
    const s = await app({ retryMs: 1000 })
    const labels: string[] = []
    let open = 0
    s.attachLeases((label) => {
      labels.push(label)
      open++
      return () => {
        open--
      }
    })
    custody.fail(undefined)
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.state()).toBe('open')
    expect(labels).toEqual(['secret vault retry'])
    expect(open).toBe(0)
    s.dispose()
  })
})
