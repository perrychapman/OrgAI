/**
 * The secret vault in `orgai doctor` (cli-standalone.md 5.7): custodian scheme and probe, vault state, legacy file
 * state, the pending-legacy count with the "open the app once" hint, soft deletes and orphans. With a host: its
 * secrets:status (probe on). Without one: vault.json metadata (readVaultMetadata, plus the key names, baseline hashes
 * and tombstone kinds of a valid file) and secrets.json's keys and value strings, hashed, never decrypted: the
 * pending-legacy count of 5.4 / 5.5 (rows 3 and 4) and the legacy-removal notice. Never a custodian call, never a
 * write. Never prints a value, and never throws (a failure is a 'warn' check).
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SecretsStatusResult } from '../../shared/types'
import { readVaultMetadata } from '../../main/store/vaultMetadata'
import { LEGACY_SECRETS_FILE, VAULT_FILE, VAULT_MESSAGES } from '../../main/store/vaultTypes'
import type { DoctorCheck } from '../commands/doctor'
import { schemeText } from '../commands/secrets'
import type { DoctorCheckGroup } from './types'

/** Largest secrets.json doctor reads (it counts keys and hashes value strings). */
export const DOCTOR_LEGACY_MAX_BYTES = 8 * 1024 * 1024
/** Largest vault.json doctor reads for the pending count (key names and hashes only). */
export const DOCTOR_VAULT_MAX_BYTES = 64 * 1024 * 1024

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** Checks from a host's secrets:status. */
export function hostSecretsChecks(s: SecretsStatusResult): DoctorCheck[] {
  const checks: DoctorCheck[] = []
  const scheme = schemeText(s.scheme)
  switch (s.state) {
    case 'open':
      checks.push({ id: 'vault', status: 'ok', detail: `Open (${scheme}); ${plural(s.counts.vault, 'secret')} in it` })
      break
    case 'absent':
      checks.push({ id: 'vault', status: 'ok', detail: `Not created yet (${scheme}); the first saved secret creates it` })
      break
    case 'corrupt':
      checks.push({ id: 'vault', status: 'fail', detail: s.reason ?? VAULT_MESSAGES.corrupt })
      break
    default:
      checks.push({ id: 'vault', status: 'warn', detail: `${s.state} (${scheme}): ${s.reason ?? 'its key cannot be read now'}` })
  }
  if (s.probe) {
    checks.push(
      s.probe.ok
        ? { id: 'vault-key-store', status: 'ok', detail: `${scheme} reachable` }
        : { id: 'vault-key-store', status: 'warn', detail: `${scheme}: ${s.probe.kind}: ${s.probe.reason}` }
    )
  }
  checks.push(legacyCheck(s.legacyFile, s.counts.legacy))
  if (s.pendingLegacy > 0) {
    checks.push({ id: 'vault-pending', status: 'warn', detail: `${plural(s.pendingLegacy, 'secret')} not shared with the orgai command yet. ${VAULT_MESSAGES.pendingLegacy}` })
  }
  if (s.counts.unreadable > s.pendingLegacy) {
    checks.push({ id: 'vault-unreadable', status: 'warn', detail: `${plural(s.counts.unreadable - s.pendingLegacy, 'secret')} cannot be read on this host; \`orgai secrets status\` says why` })
  }
  if (s.softDeletes.length) {
    const legacy = s.softDeletes.filter((d) => d.by === 'legacy').length
    checks.push({
      id: 'vault-removed',
      status: legacy ? 'warn' : 'ok',
      detail: `${plural(s.softDeletes.length, 'removed secret')} kept for undelete${legacy ? ` (${legacy} removed by an older OrgAI)` : ''}; \`orgai secrets status\` lists them, \`orgai secrets undelete <key>\` restores one`
    })
  }
  if (s.orphanedKeys || s.orphanedVaults.length) {
    const parts = [
      ...(s.orphanedKeys ? [`${plural(s.orphanedKeys, 'secret')} a removal had to leave in place`] : []),
      ...(s.orphanedVaults.length ? [`${plural(s.orphanedVaults.length, 'OS key item')} of moved-aside vaults`] : [])
    ]
    checks.push({ id: 'vault-orphans', status: 'warn', detail: `${parts.join('; ')}; \`orgai secrets status\` lists them` })
  }
  return checks
}

function legacyCheck(state: SecretsStatusResult['legacyFile'], keys: number): DoctorCheck {
  switch (state) {
    case 'ok':
      return { id: 'legacy-secrets', status: 'ok', detail: `secrets.json (the app's copy): ${plural(keys, 'key')}` }
    case 'missing':
      return { id: 'legacy-secrets', status: 'ok', detail: "secrets.json (the app's copy): none" }
    case 'retired':
      return { id: 'legacy-secrets', status: 'ok', detail: 'secrets.json was retired; the vault holds every secret' }
    default:
      return { id: 'legacy-secrets', status: 'warn', detail: "secrets.json is damaged: no host of this version reads or rewrites it; the app shows a notice" }
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * secrets.json's shape, key count and value strings (each an encrypted blob, never decrypted here), read without
 * decrypting anything. `values` only for an 'ok' file.
 */
export function readLegacyShape(dataDir: string): { state: SecretsStatusResult['legacyFile']; keys: number; values?: Record<string, string> } {
  let text: string
  try {
    text = readFileSync(join(dataDir, LEGACY_SECRETS_FILE), 'utf8')
  } catch (e) {
    return { state: (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'corrupt', keys: 0 }
  }
  if (text.length > DOCTOR_LEGACY_MAX_BYTES) return { state: 'corrupt', keys: 0 }
  try {
    const parsed = JSON.parse(text) as { secrets?: unknown }
    const s = parsed?.secrets
    if (!isRecord(s)) return { state: 'corrupt', keys: 0 }
    const values: Record<string, string> = {}
    for (const [k, v] of Object.entries(s)) if (typeof v === 'string') values[k] = v
    return { state: 'ok', keys: Object.keys(values).length, values }
  } catch {
    return { state: 'corrupt', keys: 0 }
  }
}

/** What a valid vault.json says about the legacy copy (5.5): no ciphertext is read, only names, hashes and kinds. */
export interface VaultLegacyView {
  /** Keys with a vault entry. */
  entries: ReadonlySet<string>
  /** key -> sha256 hex of the secrets.json value string at the last reconcile (B), or legacyRetired.keys once retired. */
  baseline: Readonly<Record<string, string>>
  /** key -> the tombstone's kind and the legacy hash it targeted. */
  tombstones: Readonly<Record<string, { by?: string; legacyHash?: string }>>
}

/** vault.json's legacy view, or null when it cannot be read (doctor then reports no pending count). Call after readVaultMetadata said 'present'. */
export function readVaultLegacyView(dataDir: string): VaultLegacyView | null {
  try {
    const file = join(dataDir, VAULT_FILE)
    if (statSync(file).size > DOCTOR_VAULT_MAX_BYTES) return null
    const v = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    if (!isRecord(v) || !isRecord(v.entries) || !isRecord(v.legacy) || !isRecord(v.tombstones)) return null
    const retired = isRecord(v.legacyRetired) && isRecord(v.legacyRetired.keys) ? v.legacyRetired.keys : undefined
    const strings = (r: Record<string, unknown>): Record<string, string> => Object.fromEntries(Object.entries(r).filter((e): e is [string, string] => typeof e[1] === 'string'))
    const tombstones: Record<string, { by?: string; legacyHash?: string }> = {}
    for (const [k, t] of Object.entries(v.tombstones)) {
      if (!isRecord(t)) continue
      tombstones[k] = { ...(typeof t.by === 'string' ? { by: t.by } : {}), ...(typeof t.legacyHash === 'string' ? { legacyHash: t.legacyHash } : {}) }
    }
    return { entries: new Set(Object.keys(v.entries)), baseline: strings(retired ?? v.legacy), tombstones }
  } catch {
    return null
  }
}

/** sha256 hex of a secrets.json value string (H of 5.5). */
const legacyHash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

/**
 * How many secrets.json keys a Node or inproc host would read as `pending-legacy` (5.4, 5.5 rows 3 and 4): every key
 * when there is no vault; else each key whose value string's hash differs from the baseline (none counts as
 * different), except row 1 (a vault delete of exactly that value is still finishing). Never decrypts anything.
 */
export function pendingLegacyCount(values: Readonly<Record<string, string>>, vault: VaultLegacyView | null): number {
  let n = 0
  for (const [key, value] of Object.entries(values)) {
    if (!vault) {
      n += 1
      continue
    }
    const h = legacyHash(value)
    const t = Object.hasOwn(vault.tombstones, key) ? vault.tombstones[key] : undefined
    if (t?.by === 'vault' && t.legacyHash === h) continue
    const b = Object.hasOwn(vault.baseline, key) ? vault.baseline[key] : undefined
    if (b === undefined || b !== h) n += 1
  }
  return n
}

/** Checks without a host: metadata, key names and hashes only. */
export function offlineSecretsChecks(dataDir: string): DoctorCheck[] {
  const meta = readVaultMetadata(dataDir)
  const checks: DoctorCheck[] = []
  if (meta.state === 'absent') checks.push({ id: 'vault', status: 'ok', detail: 'Not created yet; the first saved secret (or the app) creates it' })
  else if (meta.state === 'corrupt') checks.push({ id: 'vault', status: 'fail', detail: VAULT_MESSAGES.corrupt })
  else {
    const tomb = meta.tombstones ? `, ${plural(meta.tombstones, 'removed secret')} kept` : ''
    checks.push({ id: 'vault', status: 'ok', detail: `Present (${schemeText(meta.scheme ?? null)}): ${plural(meta.entries, 'secret')}${tomb}; not opened (no host is running)` })
  }
  const legacy = readLegacyShape(dataDir)
  if (meta.legacyRetired && legacy.state === 'missing') checks.push(legacyCheck('retired', 0))
  else checks.push(legacyCheck(legacy.state, legacy.keys))
  // A damaged vault reads nothing from the legacy copy (5.4): no pending count then.
  const view = meta.state === 'present' ? readVaultLegacyView(dataDir) : null
  if (legacy.values && meta.state !== 'corrupt' && (meta.state === 'absent' || view)) {
    const pending = pendingLegacyCount(legacy.values, view)
    if (pending > 0) {
      checks.push({ id: 'vault-pending', status: 'warn', detail: `${plural(pending, 'secret')} not shared with the orgai command yet. ${VAULT_MESSAGES.pendingLegacy}` })
    }
  }
  // The guard notice of 5.5: secrets an older OrgAI removed, kept until the user restores them or keeps them removed.
  const removedByOlder = view ? Object.values(view.tombstones).filter((t) => t.by === 'legacy').length : 0
  if (removedByOlder > 0) {
    checks.push({
      id: 'vault-removed',
      status: 'warn',
      detail: `${VAULT_MESSAGES.legacyRemovedNotice(removedByOlder)} \`orgai secrets status\` lists them, \`orgai secrets undelete <key>\` restores one`
    })
  }
  return checks
}

export const secretsChecks: DoctorCheckGroup = async ({ ctx, client }) => {
  if (client) {
    try {
      const s = await client.call<SecretsStatusResult>('secrets:status', [{ probe: true }], { timeoutMs: 20_000 })
      return hostSecretsChecks(s)
    } catch (e) {
      // An older host without secrets:status, or a refusal: fall back to what the files say.
      return [
        { id: 'vault-host', status: 'warn', detail: `The host did not report the secret vault (${(e as Error)?.message ?? String(e)}); read from the files instead` },
        ...offlineSecretsChecks(ctx.paths.dataDir)
      ]
    }
  }
  return offlineSecretsChecks(ctx.paths.dataDir)
}
