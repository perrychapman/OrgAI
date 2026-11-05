/**
 * The secret vault in `orgai doctor` (cli-standalone.md 5.7): custodian scheme and probe, vault state, legacy file
 * state, the pending-legacy count with the "open the app once" hint, soft deletes and orphans. With a host: its
 * secrets:status (probe on). Without one: vault.json metadata (readVaultMetadata) and the shape of secrets.json only,
 * never a decryption, never a custodian call, never a write. Never prints a value, and never throws (a failure is a
 * 'warn' check).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SecretsStatusResult } from '../../shared/types'
import { readVaultMetadata } from '../../main/store/vaultMetadata'
import { LEGACY_SECRETS_FILE, VAULT_MESSAGES } from '../../main/store/vaultTypes'
import type { DoctorCheck } from '../commands/doctor'
import { schemeText } from '../commands/secrets'
import type { DoctorCheckGroup } from './types'

/** Largest secrets.json doctor reads (it only counts keys). */
export const DOCTOR_LEGACY_MAX_BYTES = 8 * 1024 * 1024

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

/** secrets.json's shape and key count, read without decrypting anything. */
export function readLegacyShape(dataDir: string): { state: SecretsStatusResult['legacyFile']; keys: number } {
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
    if (!s || typeof s !== 'object' || Array.isArray(s)) return { state: 'corrupt', keys: 0 }
    return { state: 'ok', keys: Object.values(s).filter((v) => typeof v === 'string').length }
  } catch {
    return { state: 'corrupt', keys: 0 }
  }
}

/** Checks without a host: metadata only. */
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
