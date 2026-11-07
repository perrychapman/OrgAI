/**
 * secrets:* inputs (docs/design/cli-standalone.md 5.6, 5.7; Wave 7) rebuilt field by field: only known fields with the
 * right shape reach the SecretStore, extra fields are dropped and a wrong shape is refused with a HostRpcFailure
 * 'bad_request' (exit 2 in the CLI). None of these inputs ever carries a secret value: key names and a key file PATH
 * only. Electron-free; relative imports only.
 */
import { isAbsolute } from 'node:path'
import type { SecretsConfirmDeleteInput, SecretsInitInput, SecretsResetInput, SecretsStatusInput, SecretsUndeleteInput } from '../../shared/types'
import { HostRpcFailure } from './registry'

/** Longest key file path accepted (a path, never the key). */
export const SECRETS_KEY_FILE_MAX_CHARS = 4096
/** Longest secret key name accepted (keys are `mcp:<project>:<server>:env:<NAME>` and similar). */
export const SECRETS_KEY_MAX_CHARS = 512
/** Most keys one secrets:confirmDelete may name. */
export const SECRETS_CONFIRM_MAX_KEYS = 1000

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}
const own = (r: Record<string, unknown>, k: string): unknown => (Object.hasOwn(r, k) ? r[k] : undefined)
const bad = (message: string): never => {
  throw new HostRpcFailure('bad_request', message)
}
/** Control, format, line and paragraph separator characters (C0, C1, bidi, zero-width ...). */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

/** A secret key name: 1..SECRETS_KEY_MAX_CHARS printable characters without whitespace at either end. */
function keyName(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > SECRETS_KEY_MAX_CHARS || HIDDEN.test(v) || v.trim() !== v) return bad('Name the secret by its key, as `orgai secrets status` lists it.')
  return v
}

/** secrets:status: `probe` only as literal true. */
export function secretsStatusArgs(input: unknown): SecretsStatusInput {
  return isPlain(input) && own(input, 'probe') === true ? { probe: true } : {}
}

/**
 * secrets:init: no input (the OS scheme, or ORGAI_VAULT_KEY_FILE when set), or `keyFile` as an absolute path (the CLI
 * resolves a relative one against its cwd first) with `importKeyFile` only as literal true and only with keyFile.
 */
export function secretsInitArgs(input: unknown): SecretsInitInput {
  if (input === undefined || input === null) return {}
  if (!isPlain(input)) return bad('secrets:init takes { keyFile?, importKeyFile? }.')
  const keyFile = own(input, 'keyFile')
  const importKeyFile = own(input, 'importKeyFile')
  if (importKeyFile !== undefined && typeof importKeyFile !== 'boolean') return bad('importKeyFile must be true or false.')
  if (keyFile === undefined || keyFile === null) {
    if (importKeyFile === true) return bad('--import needs --key-file <path>.')
    return {}
  }
  if (typeof keyFile !== 'string' || !keyFile) return bad('The key file must be a path.')
  if (keyFile.length > SECRETS_KEY_FILE_MAX_CHARS) return bad(`The key file path is longer than ${SECRETS_KEY_FILE_MAX_CHARS} characters.`)
  if (HIDDEN.test(keyFile)) return bad('The key file path contains control or hidden characters.')
  if (!isAbsolute(keyFile)) return bad('The key file must be an absolute path.')
  return importKeyFile === true ? { keyFile, importKeyFile: true } : { keyFile }
}

/** secrets:reset: `confirm` must be literal true (the caller confirmed that CLI-only secrets are lost). */
export function secretsResetArgs(input: unknown): SecretsResetInput {
  if (!isPlain(input) || own(input, 'confirm') !== true) return bad('secrets:reset needs { confirm: true }.')
  return { confirm: true }
}

/** secrets:undelete: one key name. */
export function secretsUndeleteArgs(input: unknown): SecretsUndeleteInput {
  if (!isPlain(input)) return bad('secrets:undelete takes { key }.')
  return { key: keyName(own(input, 'key')) }
}

/** secrets:confirmDelete: a list of key names (duplicates dropped, order kept), at most SECRETS_CONFIRM_MAX_KEYS. */
export function secretsConfirmDeleteArgs(input: unknown): SecretsConfirmDeleteInput {
  if (!isPlain(input)) return bad('secrets:confirmDelete takes { keys }.')
  const keys = own(input, 'keys')
  if (!Array.isArray(keys)) return bad('keys must be a list of secret key names.')
  if (keys.length > SECRETS_CONFIRM_MAX_KEYS) return bad(`At most ${SECRETS_CONFIRM_MAX_KEYS} keys at once.`)
  return { keys: [...new Set(keys.map(keyName))] }
}
