/**
 * readVaultMetadata (docs/design/cli-standalone.md 5.7): what `orgai doctor` reports about `<data>/vault.json` when no
 * host runs. Reads the file and never decrypts anything, never runs a custodian, never writes. It uses the store's own
 * load validator (vaultFile.ts validateVaultFile), so doctor and the store never disagree about 'corrupt'.
 * Electron-free; relative imports only.
 */
import { join } from 'node:path'
import { readVaultFile } from './vaultFile'
import { VAULT_FILE, type VaultMetadata } from './vaultTypes'

/** `<dataDir>/vault.json` metadata. Never throws: an unreadable file other than a missing one is 'corrupt'. */
export function readVaultMetadata(dataDir: string): VaultMetadata {
  const empty = { entries: 0, tombstones: 0, legacyRetired: false }
  const read = readVaultFile(join(dataDir, VAULT_FILE))
  if (read.kind !== 'vault') return { state: read.kind, ...empty }
  const v = read.vault
  return {
    state: 'present',
    vaultId: v.vaultId,
    scheme: v.custody.scheme,
    entries: Object.keys(v.entries).length,
    tombstones: Object.keys(v.tombstones).length,
    legacyRetired: v.legacyRetired !== null
  }
}
