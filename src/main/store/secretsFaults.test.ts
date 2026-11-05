/**
 * Fault injection at every write, fsync, rename and unlink boundary (docs/design/cli-standalone.md 5.5 "Durability and
 * failures", R7). Each scenario is run once on a healthy file system to list its boundaries, then once per boundary
 * and failure mode from the same starting files:
 *
 * - 'throw': that call fails and the store goes on (it re-reads from disk and reconciles in process);
 * - 'crash': the process dies at that call (every later call fails); a healthy host then opens the folder;
 * - 'crash-lose-rename' (directory fsync boundaries): as 'crash', and the rename before it is lost (a power cut before
 *   the directory entry was durable).
 *
 * After each run the folder must converge to the state just before or just after the operation, never a mix; a
 * failure before the first rename must change nothing; an indeterminate one must be an error, never success.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HostKind } from '@shared/types'
import { openSecretStore, type OpenSecretStoreOptions, type SecretStore } from './secrets'
import { boundaryIndex, faultFs, fakeCipher, fakeCustody, noCipher, olderApp, restoreDir, snapshotDir, type FakeCustody, type FaultMode, type FsBoundary } from './vaultTesting'
import { VAULT_MESSAGES } from './vaultTypes'
import type { VaultFs } from './durableFs'

let root: string
let dataDir: string
let custody: FakeCustody

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'vault-fault-')))
  dataDir = join(root, 'data')
  mkdirSync(dataDir)
  custody = fakeCustody()
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
    platform: process.platform,
    env: {},
    log: () => undefined,
    retryMs: 0,
    ...extra
  })
}

interface Run {
  at: number
  mode: FaultMode
  event: FsBoundary
  /** The thrown error, if any. */
  error?: unknown
  /** The store the operation ran on ('throw' mode keeps using it). */
  store?: SecretStore
  /** 1-based index of the first rename of the operation, and whether the rename the fault followed was undone. */
  firstRename: number
  lostRename?: number
}

/**
 * Run `action` once healthy (to list its boundaries), then once per boundary and mode from the same starting files.
 * `open` builds the store on the given file system (not yet armed); `check` asserts the invariants of one run.
 */
async function exhaust(
  open: (fs: VaultFs) => Promise<SecretStore>,
  action: (s: SecretStore) => void | Promise<void>,
  check: (run: Run) => Promise<void>,
  armBeforeOpen = false
): Promise<number> {
  const snap = snapshotDir(dataDir)
  const probe = faultFs()
  if (armBeforeOpen) probe.arm()
  const p = await open(probe.fs)
  if (!armBeforeOpen) probe.arm()
  await action(p)
  const events = [...probe.events]
  expect(events.length).toBeGreaterThan(0)
  const firstRename = boundaryIndex(events, { op: 'rename' })
  let runs = 0
  for (let at = 1; at <= events.length; at++) {
    const event = events[at - 1] as FsBoundary
    const modes: FaultMode[] = event.op === 'dir-fsync' ? ['throw', 'crash', 'crash-lose-rename'] : ['throw', 'crash']
    for (const mode of modes) {
      restoreDir(dataDir, snap)
      const f = faultFs()
      let store: SecretStore | undefined
      let error: unknown
      if (armBeforeOpen) f.arm(at, mode)
      try {
        store = await open(f.fs)
        if (!armBeforeOpen) f.arm(at, mode)
        await action(store)
      } catch (e) {
        error = e
      }
      let lostRename: number | undefined
      if (mode === 'crash-lose-rename') {
        for (let i = at - 1; i >= 1; i--) if ((events[i - 1] as FsBoundary).op === 'rename') {
          lostRename = i
          break
        }
      }
      f.arm() // the disk works again for checks (a crashed store is never used again)
      await check({ at, mode, event, error, firstRename, ...(mode === 'throw' && store ? { store } : {}), ...(lostRename ? { lostRename } : {}) })
      runs++
    }
  }
  restoreDir(dataDir, snap)
  return runs
}

const app = (fs?: VaultFs, extra: Partial<OpenSecretStoreOptions> = {}): Promise<SecretStore> => host('desktop', { ...(fs ? { fs } : {}), ...extra })
const node = (fs?: VaultFs, extra: Partial<OpenSecretStoreOptions> = {}): Promise<SecretStore> => host('node', { ...(fs ? { fs } : {}), ...extra })
const locked = { kind: 'locked' as const, reason: 'locked' }
const older = (): ReturnType<typeof olderApp> => olderApp(dataDir)

/** Whether an operation's first durable change survived: the first rename ran and was not undone by a lost rename. */
const firstChangeLanded = (r: Run): boolean => r.at > r.firstRename && r.lostRename !== r.firstRename

/** What every view reads after a healthy app host opened the folder (which reconciles): app, Node, older app. */
async function views(key: string): Promise<{ app: string | undefined; node: string | undefined; older: string | undefined }> {
  const a = await app()
  const n = await node()
  return { app: a.get(key), node: n.get(key), older: older().get(key) }
}

describe('fault injection: writes', () => {
  it('a dual-write set (app host) converges to the old or the new value everywhere', async () => {
    older().set('k', 'old')
    await app()
    const runs = await exhaust(
      (fs) => app(fs),
      (s) => s.set('k', 'new'),
      async (r) => {
        expect(r.error, `${r.mode} at ${r.at} ${r.event.op} ${r.event.file}`).toBeDefined()
        const indeterminate = (r.error as Error).message === VAULT_MESSAGES.notDurable
        if (!indeterminate) expect(r.at).toBeLessThan(r.firstRename) // a clean error only before the first rename
        const inMemory = r.store?.get('k')
        const v = await views('k')
        // 5.5: secrets.json first, so once its rename landed a crash converges to the new value (row 4 imports it)
        expect(v.app).toBe(firstChangeLanded(r) ? 'new' : 'old')
        expect(v.node).toBe(v.app)
        expect(v.older).toBe(v.app)
        if (!indeterminate) expect(v.app).toBe('old')
        if (r.store) expect(inMemory).toBe(v.app) // reads keep serving what is on disk
        expect((await app()).legacySoftDeletes()).toEqual([])
      }
    )
    expect(runs).toBeGreaterThan(20)
  })

  it('a vault-only set (Node host) converges to the old or the new value', async () => {
    older().set('k', 'old')
    await app()
    await exhaust(
      (fs) => node(fs),
      (s) => s.set('k', 'new'),
      async (r) => {
        expect(r.error).toBeDefined()
        const indeterminate = (r.error as Error).message === VAULT_MESSAGES.notDurable
        const v = await views('k')
        expect(v.app).toBe(firstChangeLanded(r) ? 'new' : 'old')
        expect(v.node).toBe(v.app)
        expect(v.older).toBe(v.app)
        if (!indeterminate) expect(v.app).toBe('old')
      }
    )
  })

  it('a legacy-only set (app host, locked vault) converges to the old or the new value', async () => {
    older().set('k', 'old')
    await app()
    custody.fail(locked)
    await exhaust(
      (fs) => app(fs),
      (s) => s.set('k', 'new'),
      async (r) => {
        expect(r.error).toBeDefined()
        custody.fail(undefined)
        const v = await views('k')
        custody.fail(locked)
        expect(v.app).toBe(firstChangeLanded(r) ? 'new' : 'old')
        expect(v.node).toBe(v.app)
        if ((r.error as Error).message !== VAULT_MESSAGES.notDurable) expect(v.app).toBe('old')
      }
    )
  })

  it('lazy creation then a set (Node host): never a vault without its key, never a lost acknowledged value', async () => {
    await exhaust(
      (fs) => node(fs),
      async (s) => {
        await s.prepareWrite()
        s.set('k', 'v')
      },
      async (r) => {
        const n = await node()
        expect(['absent', 'open']).toContain(n.state())
        // A creation whose directory fsync failed in process is found again by the recovery (its key opens it); the
        // set that follows fsyncs the same directory, so an acknowledged value is durable and must read back.
        if (!r.error) expect(n.get('k')).toBe('v')
        else expect([undefined, 'v']).toContain(n.get('k'))
        await n.prepareWrite()
        n.set('k2', 'v2')
        expect((await node()).get('k2')).toBe('v2')
      }
    )
  })
})

describe('fault injection: deletes (every step interrupted: no notice, converges to deleted)', () => {
  const deleteChecks = async (r: Run, kinds: HostKind[] = ['desktop', 'node']): Promise<void> => {
    // removals never throw
    expect(r.error, `${r.mode} at ${r.at}`).toBeUndefined()
    custody.fail(undefined)
    const v = await views('k')
    const deleted = firstChangeLanded(r)
    if (deleted) {
      expect(v).toEqual({ app: undefined, node: undefined, older: undefined })
      for (const kind of kinds) expect((await host(kind)).has('k')).toBe(false)
    } else expect(v).toEqual({ app: 'old', node: 'old', older: 'old' })
    expect((await app()).legacySoftDeletes()).toEqual([])
    expect((await app()).get('other')).toBe('o')
  }

  it('app host, vault open, legacy copy present (three steps)', async () => {
    older().set('k', 'old')
    older().set('other', 'o')
    await app()
    const runs = await exhaust((fs) => app(fs), (s) => s.delete('k'), (r) => deleteChecks(r))
    expect(runs).toBeGreaterThan(20)
  })

  it('Node host, vault locked: metadata only, no key needed', async () => {
    older().set('k', 'old')
    older().set('other', 'o')
    await app()
    custody.fail(locked)
    await exhaust(
      (fs) => node(fs),
      (s) => s.delete('k'),
      async (r) => {
        await deleteChecks(r)
        custody.fail(locked)
      }
    )
  })

  it('a vault-only key (steps 1 and 3 in one write)', async () => {
    older().set('other', 'o')
    await app()
    const n = await node()
    n.set('k', 'old')
    // a Node value is written back by the next app open; keep it vault-only by opening Node hosts only
    await exhaust(
      (fs) => node(fs),
      (s) => s.delete('k'),
      async (r) => {
        expect(r.error).toBeUndefined()
        const fresh = await node()
        if (firstChangeLanded(r)) expect(fresh.has('k')).toBe(false)
        else expect(fresh.get('k')).toBe('old')
        expect(fresh.legacySoftDeletes()).toEqual([])
      }
    )
  })

  it('a prefix delete of several keys', async () => {
    for (const k of ['mcp:p:s:env:A', 'mcp:p:s:env:B']) older().set(k, 'old')
    older().set('other', 'o')
    await app()
    await exhaust(
      (fs) => app(fs),
      (s) => void s.deletePrefix('mcp:p:'),
      async (r) => {
        expect(r.error).toBeUndefined()
        const a = await app()
        const left = a.keys('mcp:p:')
        expect(left.length === 0 || left.length === 2).toBe(true)
        if (firstChangeLanded(r)) expect(left).toEqual([])
        expect(older().keys().filter((k) => k.startsWith('mcp:p:')).length).toBe(left.length)
        expect(a.legacySoftDeletes()).toEqual([])
      }
    )
  })
})

describe('fault injection: open and reconcile', () => {
  it('an app open that imports, writes back and soft deletes converges to the reconciled state', async () => {
    older().set('gone', 'g')
    older().set('stay', 's')
    await app()
    const n = await node()
    n.set('vaultOnly', 'vo') // row 6 on the next app open
    older().set('added', 'a') // row 3
    older().delete('gone') // row 7
    let runs = 0
    runs = await exhaust(
      (fs) => app(fs),
      () => undefined,
      async (r) => {
        expect(r.error).toBeUndefined() // openSecretStore never rejects for a write failure
        const a = await app()
        expect(a.get('vaultOnly')).toBe('vo')
        expect(older().get('vaultOnly')).toBe('vo')
        expect(a.get('added')).toBe('a')
        expect((await node()).get('added')).toBe('a')
        expect(a.get('stay')).toBe('s')
        expect(a.has('gone')).toBe(false)
        expect(a.legacySoftDeletes().map((d) => d.key)).toEqual(['gone'])
      },
      true
    )
    expect(runs).toBeGreaterThan(10)
  })

  it('an app open that creates the vault and imports converges to an open vault holding every legacy value', async () => {
    older().set('a', '1')
    older().set('b', '2')
    await exhaust(
      (fs) => app(fs),
      () => undefined,
      async (r) => {
        expect(r.error).toBeUndefined()
        const a = await app()
        expect(a.state()).toBe('open')
        expect(a.get('a')).toBe('1')
        expect((await node()).get('b')).toBe('2')
      },
      true
    )
  })

  it('retirement (flag forced on) interrupted at any boundary converges to retired with the values intact', async () => {
    older().set('a', '1')
    older().set('b', '2')
    await app()
    const flags = { vaultFlags: { retirement: true } }
    await exhaust(
      (fs) => app(fs, flags),
      () => undefined,
      async (r) => {
        expect(r.error).toBeUndefined()
        const a = await app(undefined, flags)
        expect(a.get('a')).toBe('1')
        expect((await node(undefined, flags)).get('b')).toBe('2')
        expect((await a.statusReport()).legacyFile).toBe('retired')
        expect(a.legacySoftDeletes()).toEqual([])
      },
      true
    )
  })
})

describe('fault injection: secrets:* store steps', () => {
  it('reset moves vault.json aside or leaves it; the store is never half reset', async () => {
    older().set('a', '1')
    await app()
    ;(await node()).set('vaultOnly', 'x')
    await exhaust(
      (fs) => node(fs),
      async (s) => {
        await s.resetVault({ confirm: true })
      },
      async (r) => {
        const n = await node()
        expect(['absent', 'open']).toContain(n.state())
        if (n.state() === 'open') expect(n.get('vaultOnly')).toBe('x')
        if (!r.error) expect(n.state()).toBe('absent')
      }
    )
  })

  it('undelete and confirmDeletes: old or new state, no mix', async () => {
    older().set('k', 'v')
    older().set('j', 'w')
    const a = await app()
    a.delete('k')
    a.delete('j')
    await exhaust(
      (fs) => app(fs),
      (s) => {
        s.undelete({ key: 'k' })
      },
      async () => {
        const v = await views('k')
        expect([undefined, 'v']).toContain(v.app)
        expect(v.older).toBe(v.app)
        expect(v.node).toBe(v.app)
      }
    )
    await exhaust(
      (fs) => app(fs),
      (s) => {
        s.confirmDeletes({ keys: ['j'] })
      },
      async () => {
        const fresh = await app()
        expect(fresh.has('j')).toBe(false)
        expect(fresh.legacySoftDeletes()).toEqual([])
      }
    )
  })
})
