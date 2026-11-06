/**
 * Test support (Wave 7, cli-standalone.md 5.4-5.6): a SecretStore that behaves like a Node or inproc host's vault for
 * the callers WP-H changed, without any custodian, keychain or real vault. Values live in the real SecretStore's
 * secrets.json under the test's temp dir (a reversible test cipher). On top of that:
 *
 * - `lazy`: the vault starts 'absent' and set() with a value throws VaultNotReady until prepareWrite() ran (the bug trap
 *   of 5.6); forgetVault() makes it 'absent' again. Values stored before stay readable across forgetVault (a test
 *   simplification: a real reset would lose them), except those seeded with seedAppValue: the OrgAI app's own
 *   secrets.json values, which a Node host reads as pending-legacy (5.4) until one of its own writes supersedes them,
 *   and whose explicit clear is refused while the vault is 'absent' (VAULT_MESSAGES.clearRefusedLegacyOnly, 5.5).
 * - set() with a value refuses with the store's own sentence where WP-G's store does (writeReadiness): a corrupt,
 *   locked (`lockReason`), missing-key or key-mismatch vault, or no secure storage (`unavailable`).
 * - every set / delete / deletePrefix / prepareWrite is logged in order; a prepare records whether its direct caller
 *   was the dispatcher (invokeRpc's storesSecret path) or a writer that prepared itself.
 * - scripted states: unreadable keys with a reason, clear refusals, a rejecting prepareWrite, a failing set().
 *
 * Never used outside tests.
 */
import type { SecretStatus, VaultState } from '../../shared/types'
import { SecretStore } from './secrets'
import { VAULT_MESSAGES, VaultNotReady } from './vaultTypes'

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
  /** available() is false while this is set (no secure storage on an app host); set() then refuses as the store does. */
  unavailable = false
  /** The custodian's reason a 'locked' vault gives (VAULT_MESSAGES.locked(lockReason)). */
  lockReason = 'Run `security unlock-keychain`, or set ORGAI_VAULT_KEY_FILE'
  /** Lazy stores: keys only the OrgAI app's secrets.json holds (seedAppValue); a Node host reads them as pending-legacy. */
  readonly appSaved = new Set<string>()
  private seeding = false

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

  /**
   * A value the OrgAI app saved in secrets.json (lazy stores model a Node host, which cannot decrypt it: pending-legacy
   * until a Node write supersedes it). Written without preparing; never logged as a set.
   */
  seedAppValue(key: string, value: string): void {
    this.seeding = true
    try {
      super.set(key, value)
    } finally {
      this.seeding = false
    }
    if (this.lazy) this.appSaved.add(key)
  }

  /** The sentence WP-G's store throws for set() with a value in this state, or undefined when it would store. */
  writeRefusal(): string | undefined {
    switch (this.vault) {
      case 'corrupt':
        return VAULT_MESSAGES.corrupt
      case 'locked':
        return VAULT_MESSAGES.locked(this.lockReason)
      case 'missing-key':
        return VAULT_MESSAGES.missingKey
      case 'key-mismatch':
        return VAULT_MESSAGES.keyMismatch
      default:
        return this.unavailable ? 'Secure storage is not available on this system, so OrgAI cannot store secrets.' : undefined
    }
  }

  override available(): boolean {
    if (this.seeding) return true
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
    const scripted = this.clearRefusals.get(key)
    if (scripted !== undefined) return scripted
    // 5.5 Deletes: a Node host without a vault never clears a value only the app's secrets.json holds.
    if (this.appSaved.has(key) && this.vault === 'absent') return VAULT_MESSAGES.clearRefusedLegacyOnly
    return undefined
  }

  /** The reason status() gives for an unreadable key, or undefined. */
  private unreadableReason(key: string): string | undefined {
    return this.unreadable.get(key) ?? (this.appSaved.has(key) ? VAULT_MESSAGES.pendingLegacy : undefined)
  }

  override status(key: string): SecretStatus {
    const why = this.unreadableReason(key)
    if (why !== undefined) return { unreadable: why }
    return super.status(key)
  }

  override has(key: string): boolean {
    return this.unreadable.has(key) || super.has(key)
  }

  override get(key: string): string | undefined {
    if (this.unreadableReason(key) !== undefined) return undefined
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
    if (stores) {
      if (this.lazy && this.vault === 'absent') {
        this.violations.push(key)
        throw new VaultNotReady(key)
      }
      const refusal = this.writeRefusal()
      if (refusal) throw new Error(refusal)
      if (this.failSet?.(key)) throw new Error(`could not write ${key}`)
    }
    this.unreadable.delete(key)
    // A Node write supersedes the app's value (round 6 item 1); a clear removes it.
    this.appSaved.delete(key)
    super.set(key, value)
  }

  override delete(key: string): void {
    this.log.push({ op: 'delete', key })
    this.unreadable.delete(key)
    this.appSaved.delete(key)
    super.delete(key)
  }

  override deletePrefix(prefix: string): number {
    this.log.push({ op: 'deletePrefix', prefix })
    for (const k of [...this.unreadable.keys()]) if (k.startsWith(prefix)) this.unreadable.delete(k)
    for (const k of [...this.appSaved]) if (k.startsWith(prefix)) this.appSaved.delete(k)
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
