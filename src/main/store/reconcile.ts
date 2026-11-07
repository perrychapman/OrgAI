/**
 * Reconciliation of vault.json with the older app's secrets.json (docs/design/cli-standalone.md 5.5 and round 6 items
 * 1-3). Pure: it plans the next contents of both files and never touches the disk; SecretStore writes the plan in the
 * crash-safe order (secrets.json first, then vault.json, then an unlink of secrets.json after retirement).
 *
 * Inputs per key K: L (the secrets.json value string), H = sha256(L), B (the baseline: `legacy[K]`, or
 * `legacyRetired.keys[K]` after retirement), E (the entry and its `lc`), T (a tombstone). The first matching row wins:
 *
 * 1. L present, T by 'vault', H = T.legacyHash: delete L from secrets.json, then drop B and T.legacyHash (an
 *    interrupted delete).
 * 2. L absent, T by 'vault', B or T.legacyHash present: drop both.
 * 3/4. L present, H != B (no B counts as different): import L (hosts that can write back, vault open); other hosts
 *    leave it pending-legacy (derived: legacyIsNewer).
 * 5. L present, H = B, E with lc false: write E back to secrets.json (dual-write window, hosts that can write back).
 * 6. L absent, B none, E with lc false: write back (as 5).
 * 7. L absent, file ok, B present, no T: soft delete (T by 'legacy' keeping E), drop B.
 * 8. anything else: nothing.
 *
 * T.legacyHash lives only until the delete it belongs to is finished (delete step 3, or rows 1 and 2): safeStorage is
 * deterministic on macOS and Linux, so a later save of the same value has the same hash and must count as new.
 *
 * 'metadata' mode (vault.json parses but is not open here: locked, missing-key, key-mismatch) runs rows 1 and 2 only:
 * they need no data key (round 6 item 2). A corrupt secrets.json stops every row. Electron-free; relative imports only.
 */
import { sha256Hex } from './vaultCrypto'
import { cloneVault, dict } from './vaultFile'
import { VAULT_TOMBSTONE_KEEP_MS, type VaultCipherText, type VaultFile } from './vaultTypes'

/** The legacy file as reconciliation sees it. */
export interface LegacyView {
  state: 'ok' | 'missing' | 'corrupt'
  /** The secrets map ('ok' only; empty otherwise). */
  values: Record<string, string>
}

/** Ciphers of a host that can write back with the vault open (5.5 "can write back"). Each may throw for one key. */
export interface ReconcileCrypto {
  /** safeStorage decrypt of a secrets.json value string. */
  legacyDecrypt(value: string): string
  /** safeStorage encrypt to a secrets.json value string. */
  legacyEncrypt(plain: string): string
  /** The vault's AES-GCM for key K (AAD bound to the vault and the key). */
  vaultDecrypt(key: string, c: VaultCipherText): string
  vaultEncrypt(key: string, plain: string): VaultCipherText
}

export interface ReconcileInput {
  vault: VaultFile
  legacy: LegacyView
  /** 'full': the vault is open on this host. 'metadata': it parses but is not open (rows 1 and 2 only). */
  mode: 'full' | 'metadata'
  /** Present only for a host that can write back, with the vault open. */
  crypto?: ReconcileCrypto
  /** VAULT_DUAL_WRITE (injectable for tests). */
  dualWrite: boolean
  now: number
  keepMs?: number
}

export type ReconcileSkip = 'legacy-undecryptable' | 'entry-unreadable' | 'legacy-encrypt-failed' | 'prev-legacy-undecryptable'

export interface ReconcilePlan {
  /** The new secrets.json map when it changes (rows 1, 5, 6). Written first. */
  legacy?: Record<string, string>
  /** The new vault when it changes. Written after the legacy file. */
  vault?: VaultFile
  /** After retirement: delete secrets.json once the vault is written (every key in it is resolved). */
  unlinkLegacy: boolean
  imported: string[]
  wroteBack: string[]
  /** Row 7: keys an older app removed; they now read as deleted and keep their value until the user decides. */
  softDeleted: string[]
  /** Rows 1 and 2: interrupted deletes finished. */
  completedDeletes: string[]
  /** Keys skipped for one reason each (one undecryptable value never stops the rest). */
  skipped: { key: string; reason: ReconcileSkip }[]
}

/** B for key K: `legacyRetired.keys[K]` after retirement, else `legacy[K]`. */
export function baselineOf(v: VaultFile, key: string): string | undefined {
  const map = v.legacyRetired ? v.legacyRetired.keys : v.legacy
  return Object.hasOwn(map, key) ? map[key] : undefined
}

/** Set or drop B for key K (round 6 item 1: one baseline after retirement). */
export function setBaseline(v: VaultFile, key: string, hash: string | undefined): void {
  const map = v.legacyRetired ? v.legacyRetired.keys : v.legacy
  if (hash === undefined) delete map[key]
  else map[key] = hash
}

/**
 * L is newer than what the vault holds (rows 3 and 4; after retirement, a new or changed key): H != B, and L is not the
 * exact value a delete targeted (H = T.legacyHash, round 6 item 2). With no vault every legacy value counts as newer.
 * Hosts that cannot write back read such a key as pending-legacy; the app reads L (the legacy read rule).
 */
export function legacyIsNewer(v: VaultFile | undefined, key: string, hash: string | undefined): boolean {
  if (hash === undefined) return false
  if (!v) return true
  const t = Object.hasOwn(v.tombstones, key) ? v.tombstones[key] : undefined
  if (t?.legacyHash !== undefined && t.legacyHash === hash) return false
  return hash !== baselineOf(v, key)
}

function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined
}

/** Plan one reconcile. Never throws for one key's cipher failure (it is skipped and listed). */
export function planReconcile(input: ReconcileInput): ReconcilePlan {
  const { legacy, mode, crypto, now } = input
  const keepMs = input.keepMs ?? VAULT_TOMBSTONE_KEEP_MS
  const v = cloneVault(input.vault)
  const values = dict<string>()
  for (const [k, l] of Object.entries(legacy.values)) values[k] = l
  const plan: ReconcilePlan = { unlinkLegacy: false, imported: [], wroteBack: [], softDeleted: [], completedDeletes: [], skipped: [] }
  let vaultChanged = false
  let legacyChanged = false
  const retired = v.legacyRetired !== null
  const full = mode === 'full'

  if (legacy.state === 'corrupt') {
    // No reconciliation and no legacy reads; only key-independent tombstone upkeep (expiry, prevLegacy conversion).
    if (full && tombstoneUpkeep(v, undefined, crypto, now, keepMs, plan)) return { ...plan, vault: v }
    return plan
  }

  // Legacy 'missing' before retirement: never read as deletions. Every baseline goes and every entry loses lc, so the
  // write-back row (6) recreates the file during the dual-write window.
  if (full && legacy.state === 'missing' && !retired) {
    if (Object.keys(v.legacy).length) {
      v.legacy = dict<string>()
      vaultChanged = true
    }
    for (const e of Object.values(v.entries)) {
      if (e.lc) {
        e.lc = false
        vaultChanged = true
      }
    }
  }

  const hashes = dict<string>()
  for (const [k, l] of Object.entries(values)) hashes[k] = sha256Hex(l)
  const keys = new Set<string>([...Object.keys(values), ...Object.keys(v.entries), ...Object.keys(v.tombstones), ...Object.keys(v.legacy)])
  if (v.legacyRetired) for (const k of Object.keys(v.legacyRetired.keys)) keys.add(k)
  const canWriteBack = full && crypto !== undefined
  const writeBack = canWriteBack && input.dualWrite && !retired

  for (const key of keys) {
    const L = own(values, key)
    const H = own(hashes, key)
    const T = own(v.tombstones, key)
    const E = own(v.entries, key)
    const B = baselineOf(v, key)

    // Row 1: the exact legacy value an interrupted delete targeted is still there. The finished delete also drops
    // T.legacyHash: safeStorage is deterministic on macOS and Linux (a fixed IV), so a later save of the same value
    // has the same hash and must not read as this delete's target (review round 1).
    if (L !== undefined && T?.by === 'vault' && T.legacyHash !== undefined && H === T.legacyHash) {
      delete values[key]
      legacyChanged = true
      if (B !== undefined) setBaseline(v, key, undefined)
      delete T.legacyHash
      vaultChanged = true
      plan.completedDeletes.push(key)
      continue
    }
    // Row 2: a delete interrupted after its second step (also with no B: a pending-legacy key's delete, whose only
    // leftover is T.legacyHash).
    if (L === undefined && T?.by === 'vault' && (B !== undefined || T.legacyHash !== undefined)) {
      setBaseline(v, key, undefined)
      delete T.legacyHash
      vaultChanged = true
      plan.completedDeletes.push(key)
      continue
    }
    if (!full) continue

    // Rows 3 and 4 (after retirement: a new or changed key, never residue with H = keys[K]).
    if (L !== undefined && H !== B) {
      if (!canWriteBack || !crypto) continue // pending-legacy, derived by legacyIsNewer
      let plain: string
      try {
        plain = crypto.legacyDecrypt(L)
      } catch {
        plan.skipped.push({ key, reason: 'legacy-undecryptable' })
        continue
      }
      let sealed: VaultCipherText
      try {
        sealed = crypto.vaultEncrypt(key, plain)
      } catch {
        plan.skipped.push({ key, reason: 'entry-unreadable' })
        continue
      }
      v.entries[key] = { ...sealed, at: now, lc: true }
      delete v.tombstones[key]
      setBaseline(v, key, H)
      vaultChanged = true
      plan.imported.push(key)
      continue
    }
    if (retired) continue // rows 5-7 are off after retirement

    // Rows 5 and 6: write a vault-only value back for an older app.
    if (E && !E.lc && ((L !== undefined && H === B) || (L === undefined && B === undefined))) {
      if (!writeBack || !crypto) continue
      let plain: string
      try {
        plain = crypto.vaultDecrypt(key, E)
      } catch {
        plan.skipped.push({ key, reason: 'entry-unreadable' })
        continue
      }
      let back: string
      try {
        back = crypto.legacyEncrypt(plain)
      } catch {
        plan.skipped.push({ key, reason: 'legacy-encrypt-failed' })
        continue
      }
      values[key] = back
      legacyChanged = true
      setBaseline(v, key, sha256Hex(back))
      E.lc = true
      vaultChanged = true
      plan.wroteBack.push(key)
      continue
    }
    // Row 7: the legacy copy disappeared after the last reconcile: a soft delete, never a hard one.
    if (L === undefined && legacy.state === 'ok' && B !== undefined && !T) {
      if (E) {
        v.tombstones[key] = { at: now, by: 'legacy', prev: { iv: E.iv, ct: E.ct, tag: E.tag } }
        delete v.entries[key]
        plan.softDeleted.push(key)
      }
      setBaseline(v, key, undefined)
      vaultChanged = true
      continue
    }
    // Row 8.
  }

  if (full && tombstoneUpkeep(v, values, crypto, now, keepMs, plan)) vaultChanged = true

  // After retirement the residue file goes once every key in it is resolved (H = keys[K]); never while one is pending.
  if (full && retired && legacy.state === 'ok') {
    const unresolved = Object.keys(values).some((k) => sha256Hex(values[k] as string) !== baselineOf(v, k))
    if (!unresolved) plan.unlinkLegacy = true
  }

  if (legacyChanged && !plan.unlinkLegacy) plan.legacy = values
  if (vaultChanged) plan.vault = v
  return plan
}

/**
 * Tombstones (5.2, round 6 item 3): a `prevLegacy` is re-stored as `prev` under the data key by the first host that can
 * write back with the vault open, a `by: 'vault'` value goes after keepMs, and a tombstone with nothing kept goes once
 * its key is absent from secrets.json and has no baseline (`values` undefined: the file is corrupt, keep them all).
 */
function tombstoneUpkeep(
  v: VaultFile,
  values: Record<string, string> | undefined,
  crypto: ReconcileCrypto | undefined,
  now: number,
  keepMs: number,
  plan: ReconcilePlan
): boolean {
  let changed = false
  for (const [key, t] of Object.entries(v.tombstones)) {
    if (t.prevLegacy !== undefined && crypto) {
      try {
        t.prev = crypto.vaultEncrypt(key, crypto.legacyDecrypt(t.prevLegacy))
        delete t.prevLegacy
        // The 30 days start now (round 6 item 3: "after which the normal 30-day rule applies"), so a value a Node host
        // deleted long before the first app open is not dropped in the same pass that re-stores it. `at` then reads as
        // the time the app took the value over.
        t.at = now
        changed = true
      } catch {
        plan.skipped.push({ key, reason: 'prev-legacy-undecryptable' })
      }
    }
    if (t.by === 'vault' && t.prev && t.prevLegacy === undefined && now - t.at > keepMs) {
      delete t.prev
      changed = true
    }
    if (!t.prev && t.prevLegacy === undefined && values && !Object.hasOwn(values, key) && baselineOf(v, key) === undefined) {
      delete v.tombstones[key]
      changed = true
    }
  }
  return changed
}

/** Why retirement waits (5.5 Retirement), or undefined when it may run now. */
export function retirementBlocker(
  v: VaultFile,
  legacy: LegacyView,
  opts: { open: boolean; canWriteBack: boolean }
): string | undefined {
  if (!opts.open || !opts.canWriteBack) return 'not an app host with the vault open'
  if (v.legacyRetired) return 'already retired'
  if (legacy.state !== 'ok') return `secrets.json is ${legacy.state}`
  for (const [k, l] of Object.entries(legacy.values)) if (sha256Hex(l) !== own(v.legacy, k)) return 'a key is not reconciled'
  for (const k of Object.keys(v.legacy)) if (!Object.hasOwn(legacy.values, k)) return 'a baseline has no legacy value'
  for (const t of Object.values(v.tombstones)) if (t.by === 'legacy' && (t.prev || t.prevLegacy !== undefined)) return 'an unconfirmed soft delete'
  for (const t of Object.values(v.tombstones)) if (t.prevLegacy !== undefined) return 'a deleted value only the app can read'
  return undefined
}

/**
 * Retirement step 1 (5.5): the vault with `legacyRetired` = { at, digest of the exact secrets.json bytes, keys = H for
 * every key } and `legacy` cleared. Step 2 (delete secrets.json) follows once this is durable.
 */
export function planRetirement(v: VaultFile, legacy: { values: Record<string, string>; bytes: Buffer }, now: number): VaultFile {
  const next = cloneVault(v)
  const keys = dict<string>()
  for (const [k, l] of Object.entries(legacy.values)) keys[k] = sha256Hex(l)
  next.legacyRetired = { at: now, digest: sha256Hex(legacy.bytes), keys }
  next.legacy = dict<string>()
  return next
}
