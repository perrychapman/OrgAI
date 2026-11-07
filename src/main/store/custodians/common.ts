/**
 * Shared pieces of the custodians (cli-standalone.md 5.3): their options, the extra `removeItem` the probe script uses,
 * and the sentences every scheme shares. Relative imports only.
 */
import { timingSafeEqual } from 'node:crypto'
import { CustodyError, VAULT_KEY_FILE_ENV, type KeyCustodian, type VaultCustody } from '../vaultTypes'
import type { CustodianSpawner } from './run'

type Env = Readonly<Record<string, string | undefined>>

/** Options of the helper-based custodians (keychain, dpapi-user, secret-service). */
export interface HelperCustodianOptions {
  /** The host's environment; each custodian keeps only its allowlist (custodianEnvFor). Default process.env. */
  env?: Env
  platform?: NodeJS.Platform
  /** child_process.spawn stand-in (tests). */
  spawner?: CustodianSpawner
  /** Default CUSTODIAN_TIMEOUT_MS. */
  timeoutMs?: number
}

/**
 * A custodian that can also remove the OS item it made (scripts/probe-custodian.mjs cleans up with it). The store never
 * calls it: a moved-aside vault's item is left in place (5.6 Reset).
 */
export interface RemovableKeyCustodian extends KeyCustodian {
  /** Deletes the OS item (or key file) for vaultId; resolves when it is gone or was never there. Throws CustodyError. */
  removeItem(vaultId: string, custody: VaultCustody): Promise<void>
}

export const EXISTS_REASON = 'An OS key item for this vault id already exists; OrgAI never overwrites one.'
export const BAD_VAULT_ID_REASON = 'The vault id is not 32 hexadecimal characters.'
export const BAD_ITEM_REASON = "The OS key item for this vault does not hold a valid key."
export const KEY_FILE_HINT = `or set ${VAULT_KEY_FILE_ENV} to a key file (see \`orgai secrets init --key-file\`)`

export function wrongPlatform(scheme: string, platform: NodeJS.Platform, phase: 'probe' | 'create' | 'open'): CustodyError {
  // A vault made on another OS opens only with its recorded scheme, so its key is simply not here.
  return phase === 'open'
    ? new CustodyError('missing', `This vault's key is kept by ${scheme}, which this ${platform} machine does not have.`)
    : new CustodyError('unavailable', `${scheme} is not available on ${platform}.`)
}

/** Constant-time equality of two keys of the same length. */
export function sameKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}
