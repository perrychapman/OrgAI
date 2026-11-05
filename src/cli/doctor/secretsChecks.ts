/**
 * WP-H: custodian scheme and probe, vault state, legacy file state, pending-legacy count with the "open the app once"
 * hint, soft deletes, orphans (cli-standalone.md 5.7): secrets:status through `client` when a host runs, else
 * vault.json metadata only (never decrypts). Contracts only: no checks yet.
 */
import type { DoctorCheckGroup } from './types'

export const secretsChecks: DoctorCheckGroup = async () => []
