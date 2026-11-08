/**
 * WP-G1 review round 2: a creation whose save failed keeps the custodian's real key for the retry (never an all-zero
 * one), explicit clears report a failed save, read I/O errors are not 'corrupt', and available() / the retry timer do
 * not promise or spam what the placeholder custodian cannot do.
 */
import { unavailableCustodianFactory } from './unavailableCustodian'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostKind } from '@shared/types'
import { nodeVaultFs, type VaultFs } from './durableFs'
import {
  VAULT_RECOVERY_MESSAGE,
  VAULT_REPEAT_LOG_MS,
  fileReadFailedMessage,
  openSecretStore,
  resetReadFailedMessage,
  secretClearFailedMessage,
  type OpenSecretStoreOptions,
  type SecretStore
} from './secrets'
import { checkMatches } from './vaultCrypto'
import { readLegacyFile, readVaultFile } from './vaultFile'
import { readVaultMetadata } from './vaultMetadata'
import {
  boundaryIndex,
  faultFs,
  fakeCipher,
  fakeCustody,
  noCipher,
  olderApp,
  restoreDir,
  snapshotDir,
  type FakeCustody,
  type FaultFs,
  type FaultMode,
  type FsBoundary
} from './vaultTesting'
import { VAULT_MESSAGES, type VaultFile } from './vaultTypes'

let root: string
let dataDir: string
let custody: FakeCustody

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'vault-r2-')))
  dataDir = join(root, 'data')
  mkdirSync(dataDir)
  custody = fakeCustody()
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

const isApp = (k: HostKind): boolean => k === 'desktop'
function host(kind: HostKind, extra: Partial<OpenSecretStoreOptions> = {}): Promise<SecretStore> {
  return openSecretStore({
    product: 'desktop',
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
const node = (extra?: Partial<OpenSecretStoreOptions>): Promise<SecretStore> => host('inproc', extra)
const vaultJson = (): VaultFile => JSON.parse(readFileSync(join(dataDir, 'vault.json'), 'utf8')) as VaultFile

/** The key item the fake keychain holds for the vault on disk opens that vault's check record (never a zero key). */
function keyItemMatchesVault(): void {
  const v = vaultJson()
  const item = custody.items.get(v.vaultId)
  expect(item, 'a key item for the vault on disk').toBeDefined()
  expect(checkMatches(item as Buffer, v.vaultId, v.check)).toBe(true)
  expect(checkMatches(Buffer.alloc(32), v.vaultId, v.check)).toBe(false)
}

/** Every boundary of a lazy creation on a Node host (prepareWrite on an absent vault). */
async function creationBoundaries(): Promise<number> {
  const probe: FaultFs = faultFs()
  const p = await node({ fs: probe.fs })
  probe.arm()
  await p.prepareWrite()
  const n = probe.events.length
  rmSync(join(dataDir, 'vault.json'), { force: true })
  custody.items.clear()
  return n
}

describe('review round 2, blocker: a failed creation save keeps the real key for the retry', () => {
  it('a background host: a throw at every creation boundary, then a retry on the same store, set and a fresh store reads it back', async () => {
    const snap = snapshotDir(dataDir)
    const total = await creationBoundaries()
    expect(total).toBeGreaterThan(4)
    for (let at = 1; at <= total; at++) {
      restoreDir(dataDir, snap)
      custody.items.clear()
      const f = faultFs()
      const s = await node({ fs: f.fs })
      f.arm(at, 'throw')
      await s.prepareWrite().catch(() => undefined)
      f.arm()
      await s.prepareWrite()
      s.set('k', 'v')
      expect(s.get('k')).toBe('v')
      const fresh = await node()
      expect(fresh.state(), `throw at ${at}`).toBe('open')
      expect(fresh.get('k'), `throw at ${at}`).toBe('v')
      keyItemMatchesVault()
      // one key item at most: a retry reuses the key the custodian made
      expect(custody.items.size, `throw at ${at}`).toBe(1)
    }
  })

  it.each(['prepareWrite', 'initVault'] as const)('the rename of a new vault.json throws: a retry through %s writes the vault under the custodian key, not a zeroed one', async (via) => {
    const probe = faultFs()
    const p = await node({ fs: probe.fs })
    probe.arm()
    await p.prepareWrite()
    const at = boundaryIndex(probe.events, { op: 'rename', file: 'vault.json' })
    expect(at).toBeGreaterThan(0)
    rmSync(join(dataDir, 'vault.json'))
    custody.items.clear()
    const creates = custody.calls.create
    const f = faultFs()
    const s = await node({ fs: f.fs })
    f.arm(at, 'throw')
    await expect(s.prepareWrite()).rejects.toThrow()
    expect(existsSync(join(dataDir, 'vault.json'))).toBe(false)
    f.arm()
    if (via === 'initVault') expect((await s.initVault({})).action).toBe('created')
    else await s.prepareWrite()
    s.set('k', 'v')
    const fresh = await node()
    expect(fresh.state()).toBe('open')
    expect(fresh.get('k')).toBe('v')
    keyItemMatchesVault()
    expect(custody.calls.create).toBe(creates + 1) // the retry reused the key item the failed creation made
  })

  it('an app host: a failed creation save retried by the timer imports every legacy key under the real key', async () => {
    olderApp(dataDir).set('a', '1')
    olderApp(dataDir).set('b', '2')
    const snap = snapshotDir(dataDir)
    const probe = faultFs()
    probe.arm()
    await app({ fs: probe.fs })
    const total = probe.events.length
    const creationEnd = boundaryIndex(probe.events, { op: 'rename', file: 'vault.json' })
    expect(creationEnd).toBeGreaterThan(0)
    // the creation's own boundaries: up to its rename and the directory fsync after it
    const last = Math.min(total, creationEnd + 2)
    for (let at = 1; at <= last; at++) {
      restoreDir(dataDir, snap)
      custody.items.clear()
      const f = faultFs()
      f.arm(at, 'throw')
      const s = await app({ fs: f.fs })
      f.arm()
      if (s.state() !== 'open') {
        s.retryOpen('timer')
        await s.prepareWrite() // waits for the retry in flight
      }
      expect(s.state(), `throw at ${at}`).toBe('open')
      const fresh = await node()
      expect(fresh.state(), `throw at ${at}`).toBe('open')
      expect(fresh.get('a'), `throw at ${at}`).toBe('1')
      expect(fresh.get('b'), `throw at ${at}`).toBe('2')
      keyItemMatchesVault()
    }
  })
})

const locked = { kind: 'locked' as const, reason: 'locked' }
const older = (): ReturnType<typeof olderApp> => olderApp(dataDir)

/** What a healthy app host (which reconciles), a Node host and the older app read for `key`. */
async function views(key: string): Promise<{ app: string | undefined; node: string | undefined; older: string | undefined }> {
  const a = await app()
  const n = await node()
  return { app: a.get(key), node: n.get(key), older: older().get(key) }
}

describe('review round 2, major: an explicit clear reports a failed save (5.5 Durability)', () => {
  it('a full disk: set(key, null) and clear() throw with the disk reason and the value stays; a removal does not throw', async () => {
    const a = await app()
    a.set('tok', 'secret')
    const f = faultFs()
    const s = await app({ fs: f.fs })
    expect(s.get('tok')).toBe('secret')
    f.arm(1, 'fail-from')
    expect(() => s.set('tok', null)).toThrow(secretClearFailedMessage('open failed (ENOSPC)'))
    expect(s.get('tok')).toBe('secret')
    expect(() => s.set('tok', '')).toThrow(/it is still saved/)
    expect(() => s.clear('tok')).toThrow(/it is still saved/)
    expect(s.clearRefusal('tok')).toBeUndefined()
    s.delete('tok') // a removal: never throws, left in place and counted
    expect(s.get('tok')).toBe('secret')
    expect((await s.statusReport()).orphanedKeys).toBe(1)
    f.arm()
    expect((await views('tok')).app).toBe('secret')
    // the disk works again: the same store clears it and the orphan count drops
    s.clear('tok')
    expect(s.has('tok')).toBe(false)
    expect((await s.statusReport()).orphanedKeys).toBe(0)
    expect(await views('tok')).toEqual({ app: undefined, node: undefined, older: undefined })
  })

  it('a legacy-only app host (vault locked) and a background host also throw', async () => {
    older().set('k', 'v')
    await app()
    custody.fail(locked)
    for (const kind of ['desktop', 'inproc'] as const) {
      const f = faultFs()
      const s = await host(kind, { fs: f.fs })
      expect(s.state()).toBe('locked')
      f.arm(1, 'fail-from')
      expect(() => s.set('k', null)).toThrow(/it is still saved/)
      f.arm()
    }
    custody.fail(undefined)
    expect(await views('k')).toEqual({ app: 'v', node: 'v', older: 'v' })
  })

  type Setup = { name: string; open: (fs: VaultFs) => Promise<SecretStore>; before: () => Promise<void>; lockedDuring?: boolean }
  const setups: Setup[] = [
    {
      name: 'app host, vault open, legacy copy (three steps)',
      open: (fs) => app({ fs }),
      before: async () => {
        older().set('k', 'old')
        older().set('other', 'o')
        await app()
      }
    },
    {
      name: 'background host, vault locked (metadata only)',
      open: (fs) => node({ fs }),
      before: async () => {
        older().set('k', 'old')
        older().set('other', 'o')
        await app()
      },
      lockedDuring: true
    },
    {
      name: 'background host, vault open, a vault-only key',
      open: (fs) => node({ fs }),
      before: async () => {
        older().set('other', 'o')
        await app()
        ;(await node()).set('k', 'old')
      }
    }
  ]

  it.each(setups)('an explicit clear interrupted at every boundary ($name): an error every time, never success', async (setup) => {
    await setup.before()
    const lock = (on: boolean): void => custody.fail(on && setup.lockedDuring ? locked : undefined)
    lock(true)
    const snap = snapshotDir(dataDir)
    const probe = faultFs()
    const p = await setup.open(probe.fs)
    probe.arm()
    p.clear('k')
    const events = [...probe.events]
    expect(events.length).toBeGreaterThan(0)
    const firstRename = boundaryIndex(events, { op: 'rename' })
    let runs = 0
    for (let at = 1; at <= events.length; at++) {
      const event = events[at - 1] as FsBoundary
      for (const mode of ['throw', 'crash', 'fail-from'] as FaultMode[]) {
        restoreDir(dataDir, snap)
        lock(true)
        const f = faultFs()
        const s = await setup.open(f.fs)
        f.arm(at, mode)
        let error: unknown
        try {
          s.clear('k')
        } catch (e) {
          error = e
        }
        const where = `${mode} at ${at} ${event.op} ${event.file}`
        expect(error, where).toBeInstanceOf(Error)
        const indeterminate = (error as Error).message === VAULT_MESSAGES.notDurable
        if (!indeterminate) {
          // a clean error only before the first rename, and the value is still saved
          expect(at, where).toBeLessThan(firstRename)
          expect((error as Error).message, where).toMatch(/it is still saved/)
          if (mode !== 'crash') expect(s.has('k'), where).toBe(true)
        }
        f.arm()
        lock(false)
        const v = await views('k')
        expect([undefined, 'old'], where).toContain(v.app)
        expect(v.node, where).toBe(v.app)
        expect(v.older, where).toBe(v.app)
        if (!indeterminate) expect(v.app, where).toBe('old')
        expect((await app()).legacySoftDeletes(), where).toEqual([])
        runs++
      }
    }
    expect(runs).toBeGreaterThan(6)
  })

  it('a clear while a failed save is not reconciled yet refuses with the recovery message; a removal does not throw', async () => {
    older().set('k', 'old')
    older().set('j', 'j')
    await app()
    const f = faultFs()
    const s = await app({ fs: f.fs })
    // list a dual write's boundaries, then fail the same write from its second rename (vault.json after secrets.json)
    f.arm()
    s.set('k', 'x')
    const at = boundaryIndex(f.events, { op: 'rename' }, 2)
    expect(at).toBeGreaterThan(0)
    f.arm(at, 'fail-from') // the disk stays full, so the recovery's reconcile cannot finish either
    expect(() => s.set('k', 'y')).toThrow(VAULT_MESSAGES.notDurable)
    expect(() => s.clear('j')).toThrow(VAULT_RECOVERY_MESSAGE)
    expect(s.get('j')).toBe('j')
    s.delete('j') // a removal: never throws
    f.arm()
    s.clear('j')
    expect(s.has('j')).toBe(false)
    expect(await views('j')).toEqual({ app: undefined, node: undefined, older: undefined })
    expect((await views('k')).app).toBe('y')
  })
})

/** A file system whose reads of the named files fail with `code` (an I/O error, not damage) until healed. */
function readFailFs(): { fs: VaultFs; fail(names: string[], code?: string): void; heal(): void } {
  let failing = new Set<string>()
  let code = 'EIO'
  const fs: VaultFs = {
    ...nodeVaultFs,
    readFileSync: (p) => {
      if (failing.has(basename(p))) throw Object.assign(new Error(`injected ${code}`), { code })
      return nodeVaultFs.readFileSync(p)
    }
  }
  return {
    fs,
    fail: (names, c = 'EIO') => {
      failing = new Set(names)
      code = c
    },
    heal: () => {
      failing = new Set()
    }
  }
}

describe('review round 2, minor: a read I/O error is not damage', () => {
  it('vaultFile: EIO and EACCES read as unreadable with the code, strict reads rethrow, a directory stays corrupt', () => {
    const r = readFailFs()
    writeFileSync(join(dataDir, 'vault.json'), '{}')
    writeFileSync(join(dataDir, 'secrets.json'), '{}')
    r.fail(['vault.json', 'secrets.json'], 'EACCES')
    expect(readVaultFile(join(dataDir, 'vault.json'), r.fs)).toEqual({ kind: 'unreadable', code: 'EACCES' })
    expect(readLegacyFile(join(dataDir, 'secrets.json'), r.fs)).toEqual({ state: 'unreadable', code: 'EACCES' })
    expect(() => readVaultFile(join(dataDir, 'vault.json'), r.fs, true)).toThrow('EACCES')
    expect(() => readLegacyFile(join(dataDir, 'secrets.json'), r.fs, true)).toThrow('EACCES')
    rmSync(join(dataDir, 'secrets.json'))
    mkdirSync(join(dataDir, 'secrets.json'))
    expect(readLegacyFile(join(dataDir, 'secrets.json'))).toEqual({ state: 'corrupt' })
  })

  it('a background host: an unreadable vault.json is locked with the I/O reason, never corrupt; prepareWrite reads it again', async () => {
    older().set('k', 'v')
    await app()
    const r = readFailFs()
    r.fail(['vault.json'])
    const n = await node({ fs: r.fs })
    const reason = VAULT_MESSAGES.locked(fileReadFailedMessage('vault.json', 'EIO'))
    expect(n.state()).toBe('locked')
    // whether secure storage holds a newer value cannot be seen: unreadable with the I/O reason, never pending-legacy
    expect(n.status('k')).toEqual({ unreadable: reason })
    const st = await n.statusReport()
    expect(st).toMatchObject({ state: 'locked', reason, readError: fileReadFailedMessage('vault.json', 'EIO') })
    expect(JSON.stringify(st)).not.toContain(VAULT_MESSAGES.corrupt)
    expect(n.available()).toBe(false)
    await expect(n.prepareWrite()).rejects.toThrow(reason)
    expect(() => n.set('x', 'y')).toThrow(reason)
    expect(n.clearRefusal('k')).toBe(reason)
    expect(() => n.clear('k')).toThrow(reason)
    n.delete('k') // a removal: left in place, counted
    expect(n.deletePrefix('mcp:p:')).toBe(0) // whether anything is stored under it cannot be seen: counted as one
    expect((await n.statusReport()).orphanedKeys).toBe(2)
    // the disk works again: prepareWrite reads it, opens secure storage, and the store is whole
    r.heal()
    await n.prepareWrite()
    expect(n.state()).toBe('open')
    expect(n.get('k')).toBe('v')
    n.set('x', 'y')
    expect((await node()).get('x')).toBe('y')
    expect((await n.statusReport()).readError).toBeUndefined()
  })

  it('an app host: an unreadable vault.json is never read past (no legacy reads, values refused); the retry opens it', async () => {
    older().set('k', 'v')
    await app()
    older().set('k', 'rotated-elsewhere') // an older app's change the vault has not seen
    const r = readFailFs()
    r.fail(['vault.json'])
    const s = await app({ fs: r.fs })
    expect(s.state()).toBe('locked')
    expect(s.get('k')).toBeUndefined()
    expect(s.status('k')).toEqual({ unreadable: VAULT_MESSAGES.locked(fileReadFailedMessage('vault.json', 'EIO')) })
    expect(() => s.set('k', 'new')).toThrow(fileReadFailedMessage('vault.json', 'EIO'))
    expect(older().get('k')).toBe('rotated-elsewhere')
    s.retryOpen('timer') // still failing: nothing to do
    expect(s.state()).toBe('locked')
    r.heal()
    s.retryOpen('timer')
    await s.prepareWrite() // waits for the retry in flight
    expect(s.state()).toBe('open')
    expect(s.get('k')).toBe('rotated-elsewhere') // row 4 imported the newer secrets.json value
    expect((await node()).get('k')).toBe('rotated-elsewhere')
  })

  it.each(['desktop', 'inproc'] as const)(
    'a %s host whose secrets.json cannot be read: the vault reads, values and clears wait, nothing is confirmed; then it catches up',
    async (kind) => {
      older().set('k', 'old')
      await app()
      ;(await node()).set('v', 'vault-only')
      // an older app's newer value the vault has not seen: a save made while secrets.json cannot be read must not lose to it later
      older().set('k', 'newer-elsewhere')
      older().delete('gone')
      const r = readFailFs()
      r.fail(['secrets.json'], 'EBUSY')
      const s = await host(kind, { fs: r.fs })
      expect(s.state()).toBe('open')
      const reason = fileReadFailedMessage('secrets.json', 'EBUSY')
      expect((await s.statusReport()).readError).toBe(reason)
      expect((await s.statusReport()).legacyFile).toBe('corrupt')
      expect(s.get('v')).toBe('vault-only')
      expect(s.available()).toBe(false)
      expect(() => s.set('k', 'mine')).toThrow(reason)
      await expect(s.prepareWrite()).rejects.toThrow(reason)
      expect(s.clearRefusal('v')).toBe(reason)
      expect(() => s.set('v', null)).toThrow(reason)
      expect(s.confirmDeletes({ keys: ['v'] })).toEqual({ confirmed: [] })
      expect(older().get('k')).toBe('newer-elsewhere')
      r.heal()
      // the next status reads it again (and an app host reconciles it in place)
      expect((await s.statusReport()).readError).toBeUndefined()
      await s.prepareWrite()
      s.set('k', 'mine')
      expect(await views('k')).toEqual({ app: 'mine', node: 'mine', older: 'mine' })
      expect(await views('v')).toEqual({ app: 'vault-only', node: 'vault-only', older: 'vault-only' })
    }
  )

  it('a Node creation whose re-check cannot read vault.json keeps the key for the next attempt and writes nothing', async () => {
    const r = readFailFs()
    const n = await node({ fs: r.fs })
    expect(n.state()).toBe('absent')
    custody.hold()
    const first = n.prepareWrite()
    await vi.waitFor(() => expect(custody.calls.create).toBe(1))
    r.fail(['vault.json'])
    custody.release()
    await expect(first).rejects.toThrow(fileReadFailedMessage('vault.json', 'EIO'))
    expect(existsSync(join(dataDir, 'vault.json'))).toBe(false)
    expect(n.state()).toBe('locked')
    r.heal()
    await n.prepareWrite()
    expect(custody.calls.create).toBe(1) // the same key item, no second one
    n.set('k', 'v')
    expect((await node()).get('k')).toBe('v')
    keyItemMatchesVault()
  })

  it('secrets:reset refuses while either file cannot be read: nothing is moved aside as damaged', async () => {
    older().set('k', 'v')
    await app()
    const before = readFileSync(join(dataDir, 'vault.json'), 'utf8')
    const r = readFailFs()
    for (const file of ['vault.json', 'secrets.json']) {
      r.fail([file])
      const n = await node({ fs: r.fs })
      await expect(n.resetVault({ confirm: true })).rejects.toThrow(resetReadFailedMessage(file, 'EIO'))
      expect(readdirSync(dataDir).sort()).toEqual(['secrets.json', 'vault.json'])
      r.heal()
    }
    expect(readFileSync(join(dataDir, 'vault.json'), 'utf8')).toBe(before)
    // doctor without a host keeps its contract: an unreadable file reads as 'corrupt' there
    expect(readVaultMetadata(dataDir).state).toBe('present')
  })
})

describe('review round 2, minor: available() and the retry timer with the placeholder custodian', () => {
  it('a background host with the placeholder custodian does not offer to store; a real one does until a creation fails unavailable', async () => {
    const placeholder = await node({ custodian: unavailableCustodianFactory })
    expect(placeholder.state()).toBe('absent')
    expect(placeholder.available()).toBe(false)
    const real = await node()
    expect(real.available()).toBe(true)
    custody.fail({ kind: 'unavailable', reason: 'no secret-tool' })
    await expect(real.prepareWrite()).rejects.toThrow('no secret-tool')
    expect(real.available()).toBe(false)
    custody.fail(undefined)
    await real.prepareWrite()
    expect(real.available()).toBe(true)
    expect(existsSync(join(dataDir, 'vault.json'))).toBe(true)
  })

  it('no timer with the placeholder custodian; a repeated identical failure is logged once a day, a new one at once', async () => {
    vi.useFakeTimers()
    const hour = 60 * 60 * 1000
    const lines: string[] = []
    const log = (m: string): void => void lines.push(m)
    const created = (): number => lines.filter((l) => l.includes('could not create the vault')).length
    const p = await app({ custodian: unavailableCustodianFactory, retryMs: hour, log, now: () => Date.now() })
    await vi.advanceTimersByTimeAsync(10 * hour)
    expect(created()).toBe(1)
    p.retryOpen('timer') // the placeholder never succeeds: a manual retry is still allowed, and not logged again
    await p.prepareWrite()
    expect(created()).toBe(1)
    p.dispose()
    lines.length = 0
    custody.fail({ kind: 'unavailable', reason: 'no secret-tool' })
    const s = await app({ retryMs: hour, log, now: () => Date.now() })
    const calls = custody.calls.create
    await vi.advanceTimersByTimeAsync(10 * hour)
    expect(custody.calls.create).toBe(calls + 10)
    expect(created()).toBe(1)
    await vi.advanceTimersByTimeAsync(VAULT_REPEAT_LOG_MS)
    expect(created()).toBe(2)
    custody.fail({ kind: 'timeout', reason: 'slow' })
    await vi.advanceTimersByTimeAsync(hour)
    expect(created()).toBe(3)
    custody.fail(undefined)
    await vi.advanceTimersByTimeAsync(hour)
    expect(s.state()).toBe('open')
    s.dispose()
  })
})
