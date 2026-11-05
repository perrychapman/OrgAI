/**
 * Test support (Wave 7, cli-standalone.md 5.4-5.6): a SecretStore that behaves like a Node or inproc host's vault for
 * the callers WP-H changed, without any custodian, keychain or real vault. Values live in the real SecretStore's
 * secrets.json under the test's temp dir (a reversible test cipher). On top of that:
 *
 * - `lazy`: the vault starts 'absent' and set() with a value throws VaultNotReady until prepareWrite() ran (the bug trap
 *   of 5.6); forgetVault() makes it 'absent' again, as a fresh Node host would be.
 * - every set / delete / deletePrefix / prepareWrite is logged in order; a prepare records whether its direct caller
 *   was the dispatcher (invokeRpc's storesSecret path) or a writer that prepared itself.
 * - scripted states: unreadable keys with a reason, clear refusals, a rejecting prepareWrite, a failing set().
 *
 * Never used outside tests.
 */
import type { SecretStatus, VaultState } from '../../shared/types'
import { SecretStore } from './secrets'
import { VaultNotReady } from './vaultTypes'

export const FIXTURE_CIPHER = {
  isEncryptionAvailable: (): boolean => true,
  encryptString: (s: string): Buffer => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer): string => b.toString().slice(4)
}

export type VaultLogEntry =
  | { op: 'prepare'; origin: 'dispatcher' | 'writer' }
  | { op: 'set'; key: string; value: boolean; state: VaultState }
  | { op: 'delete'; key: string }
  | { op: 'deletePrefix'; prefix: string }

/** Who called prepareWrite: HostDispatcher.invokeRpc (the storesSecret predicate) or anything else (the writer). */
function prepareOrigin(): 'dispatcher' | 'writer' {
  const frames = (new Error().stack ?? '').split('\n').slice(1).map((l) => l.trim())
  // [0] this function, [1] FixtureVaultStore.prepareWrite, [2] its caller.
  const caller = frames[2] ?? ''
  return /HostDispatcher\.invokeRpc|\binvokeRpc\b/.test(caller) ? 'dispatcher' : 'writer'
}

export class FixtureVaultStore extends SecretStore {
  readonly log: VaultLogEntry[] = []
  /** Every set() with a value that reached the store while it was not ready (the test fails on any). */
  readonly violations: string[] = []
  private vault: VaultState
  private readonly lazy: boolean
  /** key -> reason: status() says unreadable, get() is undefined, has() stays true. */
  readonly unreadable = new Map<string, string>()
  /** key -> sentence clearRefusal returns. */
  readonly clearRefusals = new Map<string, string>()
  /** When set, prepareWrite rejects with it (and the vault stays as it is). */
  prepareError: Error | undefined
  /** When it answers true for a key, set() with a value throws (an I/O failure after preparation). */
  failSet: ((key: string) => boolean) | undefined
  /** available() is false while this is set (a locked or damaged vault on an app host). */
  unavailable = false

  constructor(dataDir: string, opts: { lazy?: boolean } = {}) {
    super(dataDir, FIXTURE_CIPHER)
    this.lazy = opts.lazy === true
    this.vault = this.lazy ? 'absent' : 'open'
  }

  /** As a fresh Node host: no vault until the next prepareWrite (lazy stores only). */
  forgetVault(): void {
    if (this.lazy) this.vault = 'absent'
  }

  setState(state: VaultState): void {
    this.vault = state
  }

  override state(): VaultState {
    return this.vault
  }

  override available(): boolean {
    if (this.unavailable) return false
    if (this.vault === 'corrupt' || this.vault === 'locked' || this.vault === 'missing-key' || this.vault === 'key-mismatch') return false
    return this.lazy ? this.vault === 'open' : super.available()
  }

  override prepareWrite(): Promise<void> {
    this.log.push({ op: 'prepare', origin: prepareOrigin() })
    if (this.prepareError) return Promise.reject(this.prepareError)
    if (this.vault === 'absent' || this.vault === 'locked') this.vault = 'open'
    return Promise.resolve()
  }

  override clearRefusal(key: string): string | undefined {
    return this.clearRefusals.get(key)
  }

  override status(key: string): SecretStatus {
    const why = this.unreadable.get(key)
    if (why !== undefined) return { unreadable: why }
    return super.status(key)
  }

  override has(key: string): boolean {
    return this.unreadable.has(key) || super.has(key)
  }

  override get(key: string): string | undefined {
    if (this.unreadable.has(key)) return undefined
    return super.get(key)
  }

  override keys(prefix = ''): string[] {
    const out = new Set(super.keys(prefix))
    for (const k of this.unreadable.keys()) if (k.startsWith(prefix)) out.add(k)
    return [...out]
  }

  override set(key: string, value: string | null): void {
    const stores = value !== null && value !== ''
    this.log.push({ op: 'set', key, value: stores, state: this.vault })
    if (stores && this.lazy && this.vault !== 'open') {
      this.violations.push(key)
      throw new VaultNotReady(key)
    }
    if (stores && this.failSet?.(key)) throw new Error(`could not write ${key}`)
    if (!stores) this.unreadable.delete(key)
    super.set(key, value)
  }

  override delete(key: string): void {
    this.log.push({ op: 'delete', key })
    this.unreadable.delete(key)
    super.delete(key)
  }

  override deletePrefix(prefix: string): number {
    this.log.push({ op: 'deletePrefix', prefix })
    for (const k of [...this.unreadable.keys()]) if (k.startsWith(prefix)) this.unreadable.delete(k)
    return super.deletePrefix(prefix)
  }

  /** The set() calls that stored a value, in order. */
  storedKeys(): string[] {
    return this.log.filter((e): e is Extract<VaultLogEntry, { op: 'set' }> => e.op === 'set' && e.value).map((e) => e.key)
  }

  prepares(): Extract<VaultLogEntry, { op: 'prepare' }>[] {
    return this.log.filter((e): e is Extract<VaultLogEntry, { op: 'prepare' }> => e.op === 'prepare')
  }
}
