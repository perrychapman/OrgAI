/**
 * The sequences docs/design/cli-standalone.md 5.5 lists as required tests, and round 6 items 1-3, end to end through
 * real files: "app" is a desktop host of this wave (safeStorage), "node" a Node host (no safeStorage), "older" the
 * OrgAI app before this wave (secrets.json only). Hosts share one fake key store.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HostKind } from '@shared/types'
import { VAULT_RECOVERY_MESSAGE, openSecretStore, type OpenSecretStoreOptions, type SecretStore } from './secrets'
import { sha256Hex } from './vaultCrypto'
import { boundaryIndex, faultFs, fakeCipher, fakeCustody, noCipher, olderApp, restoreDir, snapshotDir, type FakeCustody, type OlderApp } from './vaultTesting'
import { VAULT_MESSAGES, VAULT_TOMBSTONE_KEEP_MS, type VaultFile } from './vaultTypes'

let root: string
let dataDir: string
let custody: FakeCustody
let older: OlderApp

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'vault-seq-')))
  dataDir = join(root, 'data')
  mkdirSync(dataDir)
  custody = fakeCustody()
  older = olderApp(dataDir)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

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
const node = async (extra?: Partial<OpenSecretStoreOptions>): Promise<SecretStore> => {
  const s = await host('node', extra)
  return s
}
const nodeWriter = async (extra?: Partial<OpenSecretStoreOptions>): Promise<SecretStore> => {
  const s = await node(extra)
  await s.prepareWrite()
  return s
}
const vaultJson = (): VaultFile => JSON.parse(readFileSync(join(dataDir, 'vault.json'), 'utf8')) as VaultFile
const locked = { kind: 'locked' as const, reason: 'locked' }

describe('required sequences (cli-standalone.md 5.5)', () => {
  it('upgrade -> Node write -> older app write -> upgrade: the older app\'s later change wins (G4)', async () => {
    older.set('k', 'v0')
    expect((await app()).get('k')).toBe('v0')
    ;(await nodeWriter()).set('k', 'v1-node')
    older.set('k', 'v2-older')
    const a = await app()
    expect(a.get('k')).toBe('v2-older')
    expect((await node()).get('k')).toBe('v2-older')
    expect(a.legacySoftDeletes()).toEqual([])
  })

  it('upgrade -> Node write -> older app leaves it alone -> upgrade: the Node value is written back for the older app', async () => {
    older.set('k', 'v0')
    await app()
    ;(await nodeWriter()).set('k', 'v1-node')
    older.set('other', 'o')
    const a = await app()
    expect(a.get('k')).toBe('v1-node')
    expect(older.get('k')).toBe('v1-node')
    expect(vaultJson().entries.k?.lc).toBe(true)
  })

  it.each([false, true])('Node creates a new key -> app opens -> older app sees it (existing secrets.json: %s)', async (existing) => {
    if (existing) older.set('j', 'jv')
    const n = await nodeWriter()
    n.set('k', 'from-node')
    expect(older.get('k')).toBeUndefined()
    if (existing) expect(n.status('j')).toEqual({ unreadable: VAULT_MESSAGES.pendingLegacy })
    const a = await app()
    expect(a.get('k')).toBe('from-node')
    expect(older.get('k')).toBe('from-node')
    if (existing) {
      expect(a.get('j')).toBe('jv')
      expect((await node()).get('j')).toBe('jv')
    }
  })

  it('Node rotate -> app boot with a locked custodian: never the old value', async () => {
    older.set('k', 'old')
    await app()
    ;(await nodeWriter()).set('k', 'rotated')
    custody.fail(locked)
    const a = await app()
    expect(a.state()).toBe('locked')
    expect(a.get('k')).toBeUndefined()
    expect(a.status('k')).toEqual({ unreadable: VAULT_MESSAGES.locked('locked') })
    custody.fail(undefined)
    expect((await app()).get('k')).toBe('rotated')
  })

  it('Node delete -> app boot: deleted everywhere, no "older version" notice', async () => {
    older.set('k', 'v')
    older.set('j', 'w')
    await app()
    ;(await node()).delete('k')
    expect(older.get('k')).toBeUndefined()
    const a = await app()
    expect(a.has('k')).toBe(false)
    expect(a.get('j')).toBe('w')
    expect(a.legacySoftDeletes()).toEqual([])
    expect(a.softDeletes()).toEqual([expect.objectContaining({ key: 'k', by: 'vault' })])
  })

  it('purge (a rolled-back proposal) removes the value and leaves no tombstone; delete still tombstones (review 6)', async () => {
    const a = await app()
    a.set('rolled', 'from-a-failed-proposal')
    a.set('gone', 'user-removed')
    a.purge('rolled')
    a.delete('gone')
    expect(a.has('rolled')).toBe(false)
    expect(older.get('rolled')).toBeUndefined()
    expect(vaultJson().tombstones.rolled).toBeUndefined()
    expect(a.softDeletes().map((s) => s.key)).toEqual(['gone'])
    expect((await app()).softDeletes().map((s) => s.key)).toEqual(['gone'])
    expect(a.undelete({ key: 'rolled' })).toMatchObject({ restored: false })
  })

  it('Node delete of a pending-legacy key, then undelete in the app (only the app can restore it)', async () => {
    await app()
    older.set('k', 'saved-by-app') // pending-legacy for background hosts
    const n = await node()
    expect(n.status('k')).toEqual({ unreadable: VAULT_MESSAGES.pendingLegacy })
    n.delete('k')
    expect(n.has('k')).toBe(false)
    expect(older.get('k')).toBeUndefined()
    expect(vaultJson().tombstones.k).toMatchObject({ by: 'vault', prevLegacy: expect.any(String) })
    expect(n.undelete({ key: 'k' })).toEqual({ restored: false, reason: VAULT_MESSAGES.undeleteAppOnly })
    expect(n.softDeletes()).toEqual([expect.objectContaining({ key: 'k', restorable: 'app' })])
    const a = await app()
    expect(a.has('k')).toBe(false)
    expect(a.undelete({ key: 'k' })).toEqual({ restored: true })
    expect(a.get('k')).toBe('saved-by-app')
    expect(older.get('k')).toBe('saved-by-app')
    expect((await node()).get('k')).toBe('saved-by-app')
  })

  it('legacy-only app save then clear of a vault-only key, then unlock: stays deleted, no notice', async () => {
    ;(await nodeWriter()).set('k', 'vault-only')
    custody.fail(locked)
    const l = await app()
    l.set('k', 'legacy-save')
    expect(l.get('k')).toBe('legacy-save')
    l.set('k', null)
    expect(l.has('k')).toBe(false)
    custody.fail(undefined)
    const a = await app()
    expect(a.has('k')).toBe(false)
    expect(older.get('k')).toBeUndefined()
    expect(a.legacySoftDeletes()).toEqual([])
  })

  it('older app deletes one key: a restorable soft delete with a notice; Restore and Keep removed', async () => {
    older.set('a', '1')
    older.set('b', '2')
    older.set('c', '3')
    await app()
    older.delete('a')
    older.delete('c')
    const a = await app()
    expect(a.has('a')).toBe(false)
    expect(a.get('b')).toBe('2')
    expect(a.legacySoftDeletes().map((s) => s.key).sort()).toEqual(['a', 'c'])
    expect(VAULT_MESSAGES.legacyRemovedNotice(2)).toBe('2 saved secrets were removed by an older version of OrgAI.')
    expect(a.undelete({ key: 'a' })).toEqual({ restored: true })
    expect(older.get('a')).toBe('1')
    expect(a.confirmDeletes({ keys: ['c'] })).toEqual({ confirmed: ['c'] })
    const again = await app()
    expect(again.legacySoftDeletes()).toEqual([])
    expect(again.get('a')).toBe('1')
    expect(again.has('c')).toBe(false)
  })

  it.each([1, 3, 4])('older app rewrites a corrupt secrets.json over %i original keys: all soft deletes, all restorable', async (n) => {
    const keys = ['k1', 'k2', 'k3', 'k4'].slice(0, n)
    for (const k of keys) older.set(k, `v-${k}`)
    await app()
    writeFileSync(join(dataDir, 'secrets.json'), '{ damaged')
    const during = await app()
    expect((await during.statusReport()).legacyFile).toBe('corrupt')
    for (const k of keys) expect(during.get(k)).toBe(`v-${k}`) // no reconciliation, vault values stand
    older.rewrite({ fresh: 'new' }) // the older app loaded it as empty and saved one key
    const a = await app()
    expect(a.get('fresh')).toBe('new')
    expect(a.legacySoftDeletes().map((s) => s.key).sort()).toEqual(keys)
    for (const k of keys) {
      expect(a.has(k)).toBe(false)
      expect(a.undelete({ key: k })).toEqual({ restored: true })
      expect(a.get(k)).toBe(`v-${k}`)
    }
  })

  it('retirement interrupted between its steps, an unrelated older-app edit, then a Node reopen keeps the file while a key is pending', async () => {
    const flags = { vaultFlags: { retirement: true } }
    older.set('a', 'a1')
    older.set('b', 'b1')
    await app() // creates and imports; the next app open retires
    // crash at the unlink of retirement step 2: legacyRetired is durable, secrets.json stays as residue
    const snap = snapshotDir(dataDir)
    const probe = faultFs()
    probe.arm()
    await app({ ...flags, fs: probe.fs })
    const unlinkAt = boundaryIndex(probe.events, { op: 'unlink' })
    expect(unlinkAt).toBeGreaterThan(0)
    restoreDir(dataDir, snap)
    const f = faultFs()
    f.arm(unlinkAt, 'crash')
    await app({ ...flags, fs: f.fs })
    expect(f.dead()).toBe(true)
    expect(vaultJson().legacyRetired).not.toBeNull()
    expect(existsSync(join(dataDir, 'secrets.json'))).toBe(true)
    // the vault moves on: a newer a (vault only after retirement)
    ;(await nodeWriter()).set('a', 'a2')
    // an unrelated older-app edit: b changes; a stays residue with its stale value
    older.set('b', 'b2')
    const n = await node(flags)
    expect(n.get('a')).toBe('a2') // the stale residue is never read
    expect(n.status('b')).toEqual({ unreadable: VAULT_MESSAGES.pendingLegacy })
    expect(existsSync(join(dataDir, 'secrets.json'))).toBe(true) // kept while b is pending
    const lb = (JSON.parse(readFileSync(join(dataDir, 'secrets.json'), 'utf8')) as { secrets: Record<string, string> }).secrets.b as string
    const a = await app(flags)
    expect(a.get('b')).toBe('b2')
    expect(a.get('a')).toBe('a2')
    expect(vaultJson().legacyRetired?.keys.b).toBe(sha256Hex(lb)) // recorded in the same vault write as the import
    expect(existsSync(join(dataDir, 'secrets.json'))).toBe(false) // every key resolved: the residue goes
    expect((await a.statusReport()).legacyFile).toBe('retired')
  })

  it('a vault that turns corrupt after a Node rotation: no legacy read', async () => {
    older.set('k', 'v1')
    await app()
    ;(await nodeWriter()).set('k', 'v2')
    writeFileSync(join(dataDir, 'vault.json'), '{"format":"orgai.vault/1"}')
    const a = await app()
    expect(a.state()).toBe('corrupt')
    expect(a.get('k')).toBeUndefined()
    expect(a.status('k')).toEqual({ unreadable: VAULT_MESSAGES.corrupt })
    expect(older.get('k')).toBe('v1')
  })
})

describe('round 6 item 1: one post-retirement baseline', () => {
  const flags = { vaultFlags: { retirement: true } }
  async function retired(): Promise<void> {
    older.set('a', 'a1')
    older.set('b', 'b1')
    await app()
    await app(flags)
    expect(vaultJson().legacyRetired).not.toBeNull()
    expect(existsSync(join(dataDir, 'secrets.json'))).toBe(false)
  }

  it('retirement records the digest and the per-key baseline, clears legacy; write-back stops', async () => {
    await retired()
    const v = vaultJson()
    expect(Object.keys(v.legacyRetired!.keys).sort()).toEqual(['a', 'b'])
    expect(v.legacy).toEqual({})
    const a = await app(flags)
    a.set('c', 'c1')
    expect(existsSync(join(dataDir, 'secrets.json'))).toBe(false)
    expect(vaultJson().entries.c?.lc).toBe(false)
  })

  it('an older app write after retirement is newer: the app imports it, records keys[K] and deletes the file once resolved', async () => {
    await retired()
    older.set('a', 'a-older')
    const n = await node(flags)
    expect(n.status('a')).toEqual({ unreadable: VAULT_MESSAGES.pendingLegacy })
    ;(await nodeWriter(flags)).set('a', 'a-node') // a Node write over a pending key updates keys[a]
    const h = sha256Hex(JSON.parse(readFileSync(join(dataDir, 'secrets.json'), 'utf8')).secrets.a as string)
    expect(vaultJson().legacyRetired!.keys.a).toBe(h)
    const a = await app(flags)
    expect(a.get('a')).toBe('a-node') // the superseded older value is residue now
    expect(existsSync(join(dataDir, 'secrets.json'))).toBe(false)
  })

  it('a delete after retirement drops keys[K]; an interrupted one never resurrects the residue', async () => {
    await retired()
    older.set('a', 'a-older') // a newer legacy copy exists
    const snap = snapshotDir(dataDir)
    const f = faultFs()
    const n = await node({ ...flags, fs: f.fs })
    // crash after delete step 1 (the vault write) at the start of step 2
    f.arm()
    n.delete('a')
    const step2 = boundaryIndex(f.events, { op: 'open', file: 'secrets.json.tmp' })
    expect(step2).toBeGreaterThan(1)
    restoreDir(dataDir, snap)
    const g = faultFs()
    const m = await node({ ...flags, fs: g.fs })
    g.arm(step2, 'crash')
    m.delete('a')
    expect(g.dead()).toBe(true)
    const a = await app(flags)
    expect(a.has('a')).toBe(false)
    expect(vaultJson().legacyRetired!.keys.a).toBeUndefined()
    expect(a.legacySoftDeletes()).toEqual([])
  })
})

describe('round 6 item 2: delete recovery without a key', () => {
  it('rows 1 and 2 run while the vault is locked, at open, on every host', async () => {
    for (const kind of ['desktop', 'node'] as const) {
      rmSync(dataDir, { recursive: true, force: true })
      mkdirSync(dataDir)
      custody.fail(undefined)
      older.set('k', 'v')
      await app()
      // a delete that crashed after step 1
      const snap = snapshotDir(dataDir)
      const probe = faultFs()
      const p = await app({ fs: probe.fs })
      probe.arm()
      p.delete('k')
      restoreDir(dataDir, snap)
      const f = faultFs()
      const s = await app({ fs: f.fs })
      f.arm(boundaryIndex(probe.events, { op: 'open', file: 'secrets.json.tmp' }), 'crash')
      s.delete('k')
      expect(f.dead()).toBe(true)
      expect(older.get('k')).toBe('v')
      custody.fail(locked)
      const h = await host(kind)
      expect(h.state()).toBe('locked')
      expect(older.get('k')).toBeUndefined() // row 1 removed the targeted legacy value without a key
      expect(h.has('k')).toBe(false)
      expect(vaultJson().legacy.k).toBeUndefined()
    }
  })

  it('a failed delete keeps the store recovery-required until rows 1 and 2 have run; the read rule refuses H = T.legacyHash', async () => {
    older.set('k', 'v')
    older.set('j', 'w')
    await app()
    const snap = snapshotDir(dataDir)
    const probe = faultFs()
    const p = await app({ fs: probe.fs })
    probe.arm()
    p.delete('k')
    restoreDir(dataDir, snap)
    const f = faultFs()
    const a = await app({ fs: f.fs })
    // step 1 lands; every later write fails (a full disk)
    f.arm(boundaryIndex(probe.events, { op: 'open', file: 'secrets.json.tmp' }), 'fail-from')
    a.delete('k')
    expect(older.get('k')).toBe('v') // still in secrets.json
    expect(a.has('k')).toBe(false) // but never read: H = T.legacyHash
    expect(a.get('k')).toBeUndefined()
    expect(() => a.set('j', 'w2')).toThrow(VAULT_RECOVERY_MESSAGE)
    a.delete('j') // removals never throw: left in place
    expect(a.get('j')).toBe('w')
    expect((await a.statusReport()).orphanedKeys).toBe(1)
    f.arm() // the disk works again
    a.set('j', 'w2')
    expect(older.get('k')).toBeUndefined() // the recovery finished the delete first
    expect(older.get('j')).toBe('w2')
  })

  it('delete step 1 clears pending-legacy for the key', async () => {
    await app()
    older.set('k', 'pending')
    const n = await node()
    expect((await n.statusReport()).pendingLegacy).toBe(1)
    n.delete('k')
    expect((await n.statusReport()).pendingLegacy).toBe(0)
    expect(n.status('k')).toBe('unset')
  })
})

describe('round 6 item 3: tombstones that hold the only copy', () => {
  it('a prevLegacy is never collected on a background host and stays while the key is still in secrets.json', async () => {
    let now = 1_000
    await app({ now: () => now })
    older.set('k', 'only-copy')
    const n = await node({ now: () => now })
    n.delete('k')
    now += 400 * 24 * 60 * 60 * 1000
    const later = await node({ now: () => now })
    expect(vaultJson().tombstones.k?.prevLegacy).toBeDefined()
    expect(later.softDeletes()).toEqual([expect.objectContaining({ key: 'k', restorable: 'app' })])
  })

  it('the first app host with the vault open and safeStorage re-stores it as prev under the data key', async () => {
    await app()
    older.set('k', 'only-copy')
    ;(await node()).delete('k')
    const noSafeStorage = await app({ cipher: fakeCipher(false) })
    expect(noSafeStorage.state()).toBe('open')
    expect(vaultJson().tombstones.k?.prevLegacy).toBeDefined()
    await app()
    const t = vaultJson().tombstones.k!
    expect(t.prevLegacy).toBeUndefined()
    expect(t.prev).toBeDefined()
    // now a Node host can restore it too
    const n = await node()
    expect(n.softDeletes()).toEqual([expect.objectContaining({ key: 'k', restorable: 'here' })])
    expect(n.undelete({ key: 'k' })).toEqual({ restored: true })
    expect(n.get('k')).toBe('only-copy')
  })
})

/**
 * Review round 1: safeStorage is deterministic on macOS and Linux (Chromium OSCrypt, AES-CBC with a fixed IV), so saving
 * the same value again gives the same secrets.json string and the same hash. The fake cipher is deterministic too.
 */
describe('review round 1: a save of the same value string again', () => {
  const K = 'connection:litellm:apiKey'

  it('the fake cipher is deterministic, like safeStorage on macOS and Linux', () => {
    const c = fakeCipher()
    expect(c.encryptString('sk-1').equals(c.encryptString('sk-1'))).toBe(true)
  })

  it('a finished delete drops T.legacyHash: a legacy-only save of the same value reads back and survives the unlock', async () => {
    const a = await app()
    a.set(K, 'sk-1')
    a.delete(K)
    expect(vaultJson().tombstones[K]?.legacyHash).toBeUndefined()
    custody.fail(locked)
    const l = await app()
    expect(l.state()).toBe('locked')
    l.set(K, 'sk-1')
    expect(l.get(K)).toBe('sk-1')
    expect(l.status(K)).toBe('set')
    custody.fail(undefined)
    const u = await app()
    expect(u.get(K)).toBe('sk-1')
    expect(older.get(K)).toBe('sk-1')
    expect((await node()).get(K)).toBe('sk-1')
    expect(u.legacySoftDeletes()).toEqual([])
  })

  it('a finished delete, then the older app re-enters the same value (downgrade and upgrade): the value stays', async () => {
    const a = await app()
    a.set(K, 'tok')
    a.delete(K)
    older.set(K, 'tok')
    const u = await app()
    expect(u.get(K)).toBe('tok')
    expect(older.get(K)).toBe('tok')
    expect((await node()).get(K)).toBe('tok')
  })

  it('a Node delete of a pending-legacy key interrupted before step 3, then the same value saved again: row 2 finishes it and the save stays', async () => {
    await app()
    older.set(K, 'v')
    const snap = snapshotDir(dataDir)
    const probe = faultFs()
    const p = await node({ fs: probe.fs })
    probe.arm()
    p.delete(K)
    // the three steps: vault.json (T with legacyHash, no B), secrets.json, vault.json (drops legacyHash)
    const step3 = boundaryIndex(probe.events, { op: 'open', file: 'vault.json.tmp' }, 2)
    expect(step3).toBeGreaterThan(0)
    restoreDir(dataDir, snap)
    const f = faultFs()
    const n = await node({ fs: f.fs })
    f.arm(step3, 'crash')
    n.delete(K)
    expect(f.dead()).toBe(true)
    expect(older.get(K)).toBeUndefined()
    expect(vaultJson().tombstones[K]?.legacyHash).toBeDefined()
    // the next open (any host, no key needed) finishes the delete
    custody.fail(locked)
    await node()
    expect(vaultJson().tombstones[K]?.legacyHash).toBeUndefined()
    custody.fail(undefined)
    older.set(K, 'v') // the user saves the same value again in the older app
    const a = await app()
    expect(a.get(K)).toBe('v')
    expect(older.get(K)).toBe('v')
  })

  it('a legacy-only save of the value the baseline was taken from, after a Node rotation, wins over the rotation (R4, R7)', async () => {
    older.set(K, 'orig')
    await app()
    ;(await nodeWriter()).set(K, 'rotated')
    expect(vaultJson().entries[K]?.lc).toBe(false)
    custody.fail(locked)
    const l = await app()
    expect(l.state()).toBe('locked')
    l.set(K, 'orig')
    expect(l.get(K)).toBe('orig')
    expect(l.status(K)).toBe('set')
    expect(vaultJson().legacy[K]).toBeUndefined() // the metadata-only vault write dropped B
    // a Node host sees the newer app save as pending (not the stale rotation)
    expect((await node()).status(K)).toEqual({ unreadable: VAULT_MESSAGES.pendingLegacy })
    custody.fail(undefined)
    const u = await app()
    expect(u.get(K)).toBe('orig')
    expect(older.get(K)).toBe('orig')
    expect((await node()).get(K)).toBe('orig')
  })

  it('a legacy-only save of another value needs no vault write (secrets.json only, as before)', async () => {
    older.set(K, 'orig')
    await app()
    ;(await nodeWriter()).set(K, 'rotated')
    custody.fail(locked)
    const f = faultFs()
    const l = await app({ fs: f.fs })
    f.arm()
    l.set(K, 'other')
    expect(f.events.filter((e) => e.op === 'rename').map((e) => e.file)).toEqual(['secrets.json'])
    custody.fail(undefined)
    expect((await app()).get(K)).toBe('other')
  })
})

describe('review round 1: a prevLegacy converted after more than 30 days', () => {
  it('the 30 days start at the conversion, so the only copy is restorable in the app (and expires 30 days later)', async () => {
    const day = 24 * 60 * 60 * 1000
    let now = Date.UTC(2026, 0, 1)
    await app({ now: () => now })
    older.set('k', 'only-copy')
    ;(await node({ now: () => now })).delete('k')
    now += VAULT_TOMBSTONE_KEEP_MS + day
    const a = await app({ now: () => now })
    const converted = now
    expect(vaultJson().tombstones.k).toMatchObject({ by: 'vault', at: converted })
    expect(vaultJson().tombstones.k?.prevLegacy).toBeUndefined()
    expect(a.softDeletes()).toEqual([{ key: 'k', by: 'vault', at: converted, restorable: 'here', expiresAt: converted + VAULT_TOMBSTONE_KEEP_MS }])
    expect(a.undelete({ key: 'k' })).toEqual({ restored: true })
    expect(a.get('k')).toBe('only-copy')
    // without the undelete the kept value goes 30 days after the conversion
    a.delete('k')
    now += VAULT_TOMBSTONE_KEEP_MS + day
    const later = await app({ now: () => now })
    expect(later.softDeletes()).toEqual([])
    expect(later.undelete({ key: 'k' })).toEqual({ restored: false, reason: expect.any(String) })
  })
})
