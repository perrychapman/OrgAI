/**
 * readVaultMetadata (docs/design/cli-standalone.md 5.7): what `orgai doctor` reports about `<data>/vault.json` when no
 * host runs. Reads the file and never decrypts anything, never runs a custodian, never writes. Electron-free; relative
 * imports only.
 *
 * Contracts (Wave 7): today this checks the top-level shape only. WP-G moves the store's full load validation (5.2) into
 * a shared validator and calls it here too, so doctor and the store never disagree about 'corrupt'.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { VAULT_CUSTODY_SCHEMES, type VaultCustodyScheme } from '../../shared/types'
import { VAULT_FILE, VAULT_FORMAT, type VaultMetadata } from './vaultTypes'

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** `<dataDir>/vault.json` metadata. Never throws: an unreadable file other than a missing one is 'corrupt'. */
export function readVaultMetadata(dataDir: string): VaultMetadata {
  const empty = { entries: 0, tombstones: 0, legacyRetired: false }
  let text: string
  try {
    text = readFileSync(join(dataDir, VAULT_FILE), 'utf8')
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? { state: 'absent', ...empty } : { state: 'corrupt', ...empty }
  }
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return { state: 'corrupt', ...empty }
  }
  if (!isRecord(v) || v.format !== VAULT_FORMAT || typeof v.vaultId !== 'string' || !/^[0-9a-f]{32}$/.test(v.vaultId)) return { state: 'corrupt', ...empty }
  const custody = v.custody
  if (!isRecord(custody) || !VAULT_CUSTODY_SCHEMES.includes(custody.scheme as VaultCustodyScheme)) return { state: 'corrupt', ...empty }
  if (!isRecord(v.entries) || !isRecord(v.tombstones) || !isRecord(v.legacy) || !(v.legacyRetired === null || isRecord(v.legacyRetired))) {
    return { state: 'corrupt', ...empty }
  }
  return {
    state: 'present',
    vaultId: v.vaultId,
    scheme: custody.scheme as VaultCustodyScheme,
    entries: Object.keys(v.entries).length,
    tombstones: Object.keys(v.tombstones).length,
    legacyRetired: v.legacyRetired !== null
  }
}
