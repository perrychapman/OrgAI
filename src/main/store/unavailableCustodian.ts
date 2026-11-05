/**
 * The custodian factory a host uses until the platform custodians (keychain, DPAPI, Secret Service, key file) are wired
 * in (docs/design/cli-standalone.md 5.3). Every call fails with kind 'unavailable', so an app host stays in legacy-only
 * mode (secrets.json, as before this wave) and a Node or inproc host refuses to store values with the reason. Hosts
 * replace it by passing OpenSecretStoreOptions.custodian. Electron-free; relative imports only.
 */
import type { VaultCustodyScheme } from '../../shared/types'
import { CustodyError, type CustodianFactory, type KeyCustodian } from './vaultTypes'

/** The sentence every placeholder call answers. */
export function custodianUnavailableReason(scheme: VaultCustodyScheme): string {
  return `The ${scheme} key store is not available in this build yet, so the secret vault cannot be created or opened.`
}

/** A custodian that is never available. */
export function unavailableCustodian(scheme: VaultCustodyScheme): KeyCustodian {
  const reason = custodianUnavailableReason(scheme)
  return {
    scheme,
    probe: () => Promise.resolve({ ok: false, kind: 'unavailable', reason }),
    create: () => Promise.reject(new CustodyError('unavailable', reason)),
    open: () => Promise.reject(new CustodyError('unavailable', reason))
  }
}

/** The default CustodianFactory until the platform custodians land. */
export const unavailableCustodianFactory: CustodianFactory = (scheme) => unavailableCustodian(scheme)
