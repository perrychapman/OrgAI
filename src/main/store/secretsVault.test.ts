import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostKind } from '@shared/types'
import {
  FOCUS_RETRY_MIN_MS,
  KEY_FILE_INSIDE_DATA_MESSAGE,
  KEY_STORE_UNREACHABLE_MESSAGE,
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
import { faultFs, fakeCipher, fakeCustody, noCipher, olderApp, type FakeCustody } from './vaultTesting'
import { CustodyError, VAULT_MESSAGES, VAULT_TOMBSTONE_KEEP_MS, VaultNotReady, type CustodianFactory, type VaultFile } from './vaultTypes'

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

  it('retryOpen: focus only after a lock failure (throttled), never when nothing failed, never on background hosts', async () => {
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

  it('a background host retries open at prepareWrite (unlocking the keychain over SSH works without a restart)', async () => {
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
      expect(() => s.set('k', null)).toThrow(VAULT_MESSAGES.clearRefusedCorrupt)
      s.delete('k')
      expect(s.has('k')).toBe(true)
      expect((await s.statusReport()).orphanedKeys).toBe(1)
      expect(s.available()).toBe(false)
    }
    expect(readFileSync(join(dataDir, 'vault.json'), 'utf8')).toBe('{ broken')
    expect(olderApp(dataDir).get('k')).toBe('v')
    expect(custody.calls.create).toBe(0)
  })

  it('the default custodian is unavailable: an app host stays legacy-only, a background host refuses values with the reason', async () => {
    const a = await app({ custodian: unavailableCustodianFactory })
    expect(a.state()).toBe('absent')
    a.set('k', 'v')
    expect(olderApp(dataDir).get('k')).toBe('v')
    const n = await openSecretStore({ dataDir, userDataDir: root, hostKind: 'inproc', cipher: noCipher, platform: 'darwin', env: {}, log: () => undefined, custodian: unavailableCustodianFactory })
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
    // an explicit clear is refused with the reason (review round 2); a removal leaves the key in place without throwing
    expect(() => s.set('k', null)).toThrow(VAULT_MESSAGES.clearRefusedLegacyOnly)
    expect(() => s.clear('k')).toThrow(VAULT_MESSAGES.clearRefusedLegacyOnly)
    s.clear('nowhere')
    s.delete('k')
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
    expect(v.entries.legacy).toBeUndefined() // a background host never imports
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

  it('3b: a legacy-only write with secrets.json missing resets the other keys, so the next full reconcile keeps them', async () => {
    const first = await app()
    for (const k of ['a', 'b', 'c']) first.set(k, `${k}-value`)
    rmSync(join(dataDir, 'secrets.json'))
    custody.fail(locked)
    const l = await app()
    l.set('b', 'b2')
    custody.fail(undefined)
    const a = await app()
    expect(a.state()).toBe('open')
    expect(a.get('a')).toBe('a-value')
    expect(a.get('b')).toBe('b2')
    expect(a.get('c')).toBe('c-value')
    expect(Object.keys(vaultJson().tombstones)).toEqual([])
    expect((await node()).get('a')).toBe('a-value')
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

  it('values are refused with the reason on a background host whose vault is locked', async () => {
    await app()
    custody.fail(locked)
    const n = await node()
    expect(() => n.set('k', 'v')).toThrow(VAULT_MESSAGES.locked('Keychain locked over SSH'))
    expect(n.available()).toBe(false)
  })
})

describe('deletes (5.5 Deletes)', () => {
  it('three metadata-only steps: tombstone with legacyHash and prev, secrets.json removal, baseline and legacyHash dropped; no notice', async () => {
    const s = await app()
    s.set('k', 'v')
    const h = vaultJson().legacy.k
    const f = faultFs()
    const steps = await app({ fs: f.fs })
    f.arm()
    steps.delete('k')
    // step 1 names the targeted legacy value; step 3 drops it with the baseline once secrets.json no longer holds it
    const writes = f.events.filter((e) => e.op === 'rename').map((e) => e.file)
    expect(writes).toEqual(['vault.json', 'secrets.json', 'vault.json'])
    const v = vaultJson()
    expect(v.entries.k).toBeUndefined()
    expect(v.tombstones.k).toMatchObject({ by: 'vault' })
    expect(v.tombstones.k?.legacyHash).toBeUndefined()
    expect(h).toBeDefined()
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

  it('a background host with an absent vault leaves a legacy-only key in place (orphaned) and never throws', async () => {
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
    expect(labels).toEqual(['secure storage retry'])
    expect(open).toBe(0)
    s.dispose()
  })
})

describe('review round 1: custody steps and creation failures', () => {
  it('prepareWrite after a reset in flight (background host) creates the vault instead of refusing', async () => {
    const n = await node()
    await n.prepareWrite()
    n.set('k', 'v')
    const first = vaultJson().vaultId
    const reset = n.resetVault({ confirm: true })
    const prepared = n.prepareWrite()
    await reset
    await prepared
    expect(n.state()).toBe('open')
    expect(vaultJson().vaultId).not.toBe(first)
    n.set('k2', 'v2')
    expect((await node()).get('k2')).toBe('v2')
  })

  it('prepareWrite after a failed init flight makes its own attempt; a shared prepare is never repeated', async () => {
    let creates = 0
    const flaky: CustodianFactory = (scheme, request) => {
      const real = custody.factory(scheme, request)
      return {
        scheme,
        probe: () => real.probe(),
        open: (id, c) => real.open(id, c),
        create: async (id) => {
          if (creates++ === 0) throw new CustodyError('locked', 'locked once')
          return real.create(id)
        }
      }
    }
    const n = await node({ custodian: flaky })
    const init = n.initVault({})
    const prepared = n.prepareWrite()
    await expect(init).rejects.toThrow('locked once')
    await prepared
    expect(n.state()).toBe('open')
    expect(creates).toBe(2)
    // two prepares sharing one failing attempt: one custodian call, both refuse
    rmSync(join(dataDir, 'vault.json'))
    custody.fail(locked)
    const m = await node()
    const both = await Promise.allSettled([m.prepareWrite(), m.prepareWrite()])
    expect(both.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(custody.calls.create).toBe(2) // the flaky host's second create, then this one
  })

  it('a creation whose vault.json save fails (disk full) reports the disk, not the key store, and reuses the key item on retry (background host)', async () => {
    const f = faultFs()
    const n = await node({ fs: f.fs })
    f.arm(1, 'fail-from')
    const err = await n.prepareWrite().then(
      () => undefined,
      (e: unknown) => e as Error
    )
    expect(err?.message).toMatch(/could not save the new secure storage \(open failed \(ENOSPC\)\)/)
    expect(err?.message).not.toContain(KEY_STORE_UNREACHABLE_MESSAGE)
    await expect(n.initVault({})).rejects.toThrow(/could not save the new secure storage/)
    await expect(n.prepareWrite()).rejects.toThrow(/could not save the new secure storage/)
    expect(custody.calls.create).toBe(1)
    expect(custody.items.size).toBe(1)
    expect(existsSync(join(dataDir, 'vault.json'))).toBe(false)
    f.arm() // the disk works again
    await n.prepareWrite()
    expect(n.state()).toBe('open')
    expect(custody.calls.create).toBe(1)
    expect([...custody.items.keys()]).toEqual([vaultJson().vaultId])
    n.set('k', 'v')
    expect((await node()).get('k')).toBe('v')
  })

  it('an app host whose creation save fails stays legacy-only; timer retries reuse the key item, focus does not retry a disk error', async () => {
    olderApp(dataDir).set('a', '1')
    const f = faultFs()
    f.arm(1, 'fail-from')
    const a = await app({ fs: f.fs })
    expect(a.state()).toBe('absent')
    expect(a.get('a')).toBe('1')
    expect(custody.calls.create).toBe(1)
    a.retryOpen('focus')
    await a.prepareWrite() // waits for any custody step in flight
    expect(custody.calls.create).toBe(1)
    a.retryOpen('timer')
    await a.prepareWrite()
    expect(a.state()).toBe('absent')
    expect(custody.calls.create).toBe(1)
    f.arm()
    a.retryOpen('timer')
    await a.prepareWrite()
    expect(a.state()).toBe('open')
    expect(custody.calls.create).toBe(1)
    expect(custody.items.size).toBe(1)
    expect(vaultJson().entries.a?.lc).toBe(true)
  })

  it('a key made for another scheme is not reused (the store asks the key-file custodian anew)', async () => {
    const keyFile = join(root, '..', `vault-key-${process.pid}-${Date.now()}`)
    const f = faultFs()
    const n = await node({ fs: f.fs })
    f.arm(1, 'fail-from')
    await expect(n.prepareWrite()).rejects.toThrow(/could not save/)
    f.arm()
    await n.initVault({ keyFile })
    expect(custody.calls.create).toBe(2)
    expect(vaultJson().custody.scheme).toBe('key-file')
  })
})

describe('review round 1: a damaged secrets.json and secrets:reset', () => {
  it('reset moves a corrupt secrets.json aside, so a legacy-only app can save again', async () => {
    writeFileSync(join(dataDir, 'secrets.json'), '{ damaged')
    custody.fail({ kind: 'unavailable', reason: 'no key store' })
    const a = await app({ now: () => Date.UTC(2026, 10, 5, 12, 0, 0, 7) })
    expect(a.state()).toBe('absent')
    expect(() => a.set('k', 'v')).toThrow(LEGACY_CORRUPT_MESSAGE)
    await expect(a.prepareWrite()).rejects.toThrow(LEGACY_CORRUPT_MESSAGE)
    const res = await a.resetVault({ confirm: true })
    expect(res.movedTo).toBeNull()
    expect(res.legacyMovedTo).toBe('secrets.json.corrupt-20261105T120000007Z')
    expect(readFileSync(join(dataDir, res.legacyMovedTo!), 'utf8')).toBe('{ damaged')
    expect(res.status.legacyFile).toBe('missing')
    a.set('k', 'v')
    expect(a.get('k')).toBe('v')
    expect(olderApp(dataDir).get('k')).toBe('v')
    // a moved-aside secrets.json is never listed as an orphan vault
    expect(res.status.orphanedVaults).toEqual([])
  })

  it('reset leaves a readable secrets.json where it is', async () => {
    olderApp(dataDir).set('a', '1')
    const s = await app()
    const res = await s.resetVault({ confirm: true })
    expect(res.legacyMovedTo).toBeUndefined()
    expect(s.get('a')).toBe('1')
    expect(readdirSync(dataDir).filter((n) => n.startsWith('secrets.json.'))).toEqual([])
  })

  it('a reset whose directory fsync fails after the move is reported as not durable, never success, and the store is absent', async () => {
    const n = await node()
    await n.prepareWrite()
    n.set('k', 'v')
    const f = faultFs()
    const m = await node({ fs: f.fs })
    f.arm(2, 'throw') // 1: the rename, 2: the directory open of its fsync
    await expect(m.resetVault({ confirm: true })).rejects.toThrow(VAULT_MESSAGES.notDurable)
    expect(m.state()).toBe('absent')
    expect(existsSync(join(dataDir, 'vault.json'))).toBe(false)
  })
})

describe('review round 1: temp files', () => {
  it('leftover temp files of a crashed save are replaced, never piled up', async () => {
    olderApp(dataDir).set('a', '1')
    const s = await app()
    writeFileSync(join(dataDir, 'vault.json.tmp'), 'stale')
    writeFileSync(join(dataDir, 'secrets.json.tmp'), 'stale')
    s.set('k', 'v')
    expect(readdirSync(dataDir).filter((n) => n.endsWith('.tmp'))).toEqual([])
    expect((await app()).get('k')).toBe('v')
  })
})
