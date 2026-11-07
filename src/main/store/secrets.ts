import { isAbsolute, join, resolve } from 'node:path'
import type {
  HostKind,
  McpSecretKind,
  SecretStatus,
  SecretsConfirmDeleteInput,
  SecretsConfirmDeleteResult,
  SecretsInitInput,
  SecretsInitResult,
  SecretsOrphanVault,
  SecretsResetInput,
  SecretsResetResult,
  SecretsSoftDelete,
  SecretsStatusInput,
  SecretsStatusResult,
  SecretsUndeleteInput,
  SecretsUndeleteResult,
  VaultCustodyScheme,
  VaultState
} from '@shared/types'
import { isInsideEither } from '../quick/scratch'
import { DurableFsError, errorCode, nodeVaultFs, renameDurable, unlinkDurable, writeFileDurable, type VaultFs } from './durableFs'
import { baselineOf, legacyIsNewer, planReconcile, planRetirement, retirementBlocker, setBaseline, type ReconcileCrypto } from './reconcile'
import { createCustodianFactory } from './custodians'
import { isPlaceholderCustodian, unavailableCustodian, unavailableCustodianFactory } from './unavailableCustodian'
import { checkMatches, decryptEntry, encryptEntry, isDek, makeCheck, newVaultId, sha256Hex, zeroize } from './vaultCrypto'
import {
  cloneVault,
  dict,
  parseVaultFile,
  readLegacyFile,
  readVaultFile,
  serializeLegacyFile,
  serializeVaultFile,
  validSecretKey
} from './vaultFile'
import {
  CustodyError,
  LEGACY_SECRETS_FILE,
  VAULT_CORRUPT_SUFFIX,
  VAULT_DUAL_WRITE,
  VAULT_FILE,
  VAULT_FORMAT,
  VAULT_KEY_FILE_ENV,
  VAULT_MESSAGES,
  VAULT_RESET_SUFFIX,
  VAULT_RETIREMENT_ENABLED,
  VAULT_RETRY_MS,
  VAULT_TOMBSTONE_KEEP_MS,
  VaultNotReady,
  isCustodyFailure,
  vaultStateForFailure,
  type CustodianCreated,
  type CustodianFactory,
  type CustodianRequest,
  type CustodyFailure,
  type SecretStoreApi,
  type VaultCustody,
  type VaultEntry,
  type VaultFile,
  type VaultTombstone
} from './vaultTypes'

/** Set to '1' by the unit test runner (vitest.config.ts): the OS key stores report 'unavailable' to openSecretStore's default factory. */
export const NO_OS_KEYSTORE_ENV = 'ORGAI_VAULT_NO_OS_KEYSTORE'

/**
 * Encrypted secrets (the LiteLLM key, MCP server env vars and headers, OAuth client secrets and tokens), Wave 7
 * (docs/design/cli-standalone.md 5): every host kind keeps them in `<data>/vault.json` (AES-256-GCM under a data key a
 * KeyCustodian holds), and the OrgAI app keeps the older app's `<data>/secrets.json` (Electron safeStorage) in step
 * during the dual-write window. Reads, writes and deletes stay synchronous (R6); opening, creating and retrying the vault
 * are asynchronous steps (openSecretStore, prepareWrite, retryOpen, initVault, resetVault) that run before them.
 *
 * Modules: vaultFile.ts (format, validation, the legacy file's states), vaultCrypto.ts (AES-GCM, check record,
 * sha256), reconcile.ts (rows 1-8, pure), durableFs.ts (fsync, rename, directory fsync, fault injection),
 * unavailableCustodian.ts (the default factory until the platform custodians land).
 *
 * Values never cross IPC and are never logged (key names may be); callers ask for has / status unless they are about
 * to hand the value to a child process.
 */

/** The part of Electron's safeStorage this store uses; tests pass a fake. */
export interface SecretCipher {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** Key of the migrated 'litellm' proxy's key. Equal to proxySecretKey('litellm'), so keys stored before proxies existed still resolve. */
export const LITELLM_KEY = 'connection:litellm:apiKey'

/** Key of one proxy connection's API key (`connection:<proxy id>:apiKey`). The id must be a proxy id (the caller checks). */
export function proxySecretKey(proxyId: string): string {
  return `connection:${proxyId}:apiKey`
}

/** Prefix of every secret of one MCP server (remove them all when the server is removed). */
export function mcpSecretPrefix(projectId: string, serverId: string): string {
  return `mcp:${projectId}:${serverId}:`
}

/** Key of one MCP secret slot. */
export function mcpSecretKey(projectId: string, serverId: string, kind: McpSecretKind, name: string): string {
  return `${mcpSecretPrefix(projectId, serverId)}${kind}:${name}`
}

/** Prefix of every MCP secret of a project (remove them all when the project is removed). */
export function mcpProjectPrefix(projectId: string): string {
  return `mcp:${projectId}:`
}

/** The OAuth secret slots of one server: the client secret and the current tokens. */
export type McpOAuthSlot = 'clientSecret' | 'accessToken' | 'refreshToken'

/** Key of one OAuth secret of a project-only server (under mcpSecretPrefix, so removing the server removes it). */
export function mcpOAuthKey(projectId: string, serverId: string, slot: McpOAuthSlot): string {
  return `${mcpSecretPrefix(projectId, serverId)}oauth:${slot}`
}

/** Prefix of every secret of one library entry. Distinct from every project key ('mcplib:' never starts 'mcp:'). */
export function mcpLibraryPrefix(entryId: string): string {
  return `mcplib:${entryId}:`
}

/** Key of one env or header secret of a library entry. */
export function mcpLibrarySecretKey(entryId: string, kind: McpSecretKind, name: string): string {
  return `${mcpLibraryPrefix(entryId)}${kind}:${name}`
}

/** Key of one OAuth secret of a library entry. */
export function mcpLibraryOAuthKey(entryId: string, slot: McpOAuthSlot): string {
  return `${mcpLibraryPrefix(entryId)}oauth:${slot}`
}

/** Whose secrets: a project-only server or a library entry (linked project servers use their entry's). */
export type McpSecretOwner = { projectId: string; serverId: string } | { libraryId: string }

export function mcpOwnerPrefix(owner: McpSecretOwner): string {
  return 'libraryId' in owner ? mcpLibraryPrefix(owner.libraryId) : mcpSecretPrefix(owner.projectId, owner.serverId)
}

export function mcpOwnerSecretKey(owner: McpSecretOwner, kind: McpSecretKind, name: string): string {
  return `${mcpOwnerPrefix(owner)}${kind}:${name}`
}

export function mcpOwnerOAuthKey(owner: McpSecretOwner, slot: McpOAuthSlot): string {
  return `${mcpOwnerPrefix(owner)}oauth:${slot}`
}

/** Test hooks for the Wave 7 switches (VAULT_DUAL_WRITE, VAULT_RETIREMENT_ENABLED); production uses the constants. */
export interface VaultFlags {
  dualWrite?: boolean
  retirement?: boolean
}

/** SecretStore options. Without any, the store is an app host's (desktop) store with no vault opened yet. */
export interface SecretStoreOptions {
  /**
   * Never write: available() is false, set() with a value throws, and delete / deletePrefix / set(null) only drop
   * overlay entries. Kept for older callers; no host passes it since Node hosts write the vault (Wave 7).
   */
  readOnly?: boolean
  /**
   * Plain values kept in memory only (the CLI's ORGAI_SECRET_* / --secret-env secrets); they win over stored values in
   * get / has / keys and are never persisted. The map is copied at construction.
   */
  overlay?: ReadonlyMap<string, string>
  /** Decides "can write back" (an app host: desktop or headless-host, with safeStorage) and lazy creation. Default 'desktop'. */
  hostKind?: HostKind
  /** `<userDataDir>`: a key file anywhere inside it is refused (5.3.1). */
  userDataDir?: string
  /** The custodian of a scheme (default: unavailableCustodianFactory until the platform custodians land). */
  custodian?: CustodianFactory
  /** ORGAI_VAULT_KEY_FILE is read from here. Default process.env. */
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  log?: (m: string) => void
  /** Tests: the file system (fault injection), the clock, the switches and the retry period. */
  fs?: VaultFs
  now?: () => number
  vaultFlags?: VaultFlags
  retryMs?: number
}

/** set() refusal of a read-only store. */
export const READ_ONLY_SECRETS_MESSAGE = 'This OrgAI host runs inside the CLI (--host inproc) and cannot save secrets.'

/** What the vault channels answered before the vault landed (kept for callers that still name it). */
export const VAULT_NOT_AVAILABLE_MESSAGE = 'Secure storage is not available in this build yet.'

/** set() refusal when safeStorage cannot encrypt (an app host in legacy-only mode). */
export const SECURE_STORAGE_UNAVAILABLE_MESSAGE = 'Secure storage is not available on this system, so OrgAI cannot store secrets.'

/** A value the app's safeStorage cannot decrypt (another user, a damaged string, a host without safeStorage). */
export const UNDECRYPTABLE_REASON = 'Saved by the OrgAI app and cannot be read here'

/**
 * secrets.json does not parse: legacy-only writes refuse rather than overwrite it (5.5 Legacy file states). secrets:reset
 * moves it aside (review round 1), which also starts secure storage over.
 */
export const LEGACY_CORRUPT_MESSAGE =
  "The OrgAI app's secrets file (secrets.json) is damaged, so OrgAI does not change it; `orgai secrets reset` moves it aside (and starts secure storage over)."

/** Mutations refused until the reconcile after a failed save succeeds (5.5 Durability and failures). */
export const VAULT_RECOVERY_MESSAGE = 'A save did not finish and OrgAI could not check the saved secrets again yet; try again, or check with `orgai secrets status`.'

/** A custodian failure that is not a classified CustodyFailure (a helper bug, an unexpected throw). */
export const KEY_STORE_UNREACHABLE_MESSAGE = 'The key store could not be reached.'

/** A new vault's own save failed (a disk error such as ENOSPC or EIO), not the key store (review round 1). */
export const vaultSaveFailedMessage = (detail: string): string => `OrgAI could not save the new secure storage (${detail}); try again when the disk works.`

/**
 * vault.json or secrets.json could not be read (an I/O error such as EIO, EACCES or EBUSY; not damage). The store reads
 * it again on the next save, prepareWrite, retry, secrets:init and secrets:status (review round 2).
 */
export const fileReadFailedMessage = (file: string, code: string): string =>
  `${file} could not be read (${code}); OrgAI reads it again on the next save or \`orgai secrets status\``

/** secrets:reset refuses while a file cannot be read: a healthy file is never moved aside as damaged (review round 2). */
export const resetReadFailedMessage = (file: string, code: string): string =>
  `${file} could not be read (${code}), so nothing was moved aside; try again when the disk works.`

/** An explicit clear whose save failed before anything changed on disk (review round 2): the value is still saved. */
export const secretClearFailedMessage = (detail: string): string => `OrgAI could not remove the secret (${detail}); it is still saved.`

/** A repeated identical vault failure is logged again at most this often (review round 2: no line every 10 minutes). */
export const VAULT_REPEAT_LOG_MS = 24 * 60 * 60 * 1000

/** secrets:reset could not move a file aside (it is still in place). */
export const VAULT_MOVE_FAILED_MESSAGE = 'vault.json could not be moved aside.'
export const LEGACY_MOVE_FAILED_MESSAGE = 'The damaged secrets.json could not be moved aside.'

export const NOTHING_TO_RESTORE_MESSAGE = 'No deleted value is kept for this secret.'
export const NO_CUSTODIAN_MESSAGE = 'No key store is available on this system; set ORGAI_VAULT_KEY_FILE or run `orgai secrets init --key-file <path>`.'
export const KEY_FILE_INSIDE_DATA_MESSAGE = "The key file must be outside OrgAI's data folder."
export const VAULT_NOT_OPENED_MESSAGE = 'Secure storage has not been opened yet.'
export const keyFileSchemeConflict = (scheme: VaultCustodyScheme): string =>
  `This vault keeps its key in ${scheme}; run \`orgai secrets reset\` before starting a vault with a key file.`

/** The OS scheme a new vault uses on a platform (5.3), or null where there is none. */
export function platformVaultScheme(platform: NodeJS.Platform): VaultCustodyScheme | null {
  if (platform === 'darwin') return 'keychain'
  if (platform === 'win32') return 'dpapi-user'
  if (platform === 'linux') return 'secret-service'
  return null
}

/** Hosts that run in the OrgAI app (Electron with safeStorage): the "can write back" column of 5.5. */
export function isAppHostKind(kind: HostKind): boolean {
  return kind === 'desktop' || kind === 'headless-host'
}

/** Thrown by a commit. 'clean': nothing changed on disk. 'indeterminate': the outcome is not known (5.5). */
class CommitError extends Error {
  constructor(
    readonly outcome: 'clean' | 'indeterminate',
    readonly failure: unknown
  ) {
    super(outcome === 'indeterminate' ? VAULT_MESSAGES.notDurable : failure instanceof Error ? failure.message : String(failure))
    this.name = 'CommitError'
  }
}

/**
 * A creation whose save of the new vault.json failed (a disk error, not the key store). The message is the disk's
 * reason, or VAULT_MESSAGES.notDurable when the outcome is not known; `detail` is for logs (never a value).
 */
class VaultSaveError extends Error {
  readonly detail: string
  constructor(e: unknown) {
    const indeterminate = e instanceof CommitError && e.outcome === 'indeterminate'
    const failure = e instanceof CommitError ? e.failure : e
    const detail = failure instanceof Error ? failure.message : 'error'
    super(indeterminate ? VAULT_MESSAGES.notDurable : vaultSaveFailedMessage(detail))
    this.detail = detail
    this.name = 'VaultSaveError'
  }
}

/** The custody steps that run one at a time (single-flight). */
type FlightLabel = 'open' | 'prepare' | 'retry' | 'init' | 'reset'

/** A key the custodian made for a vault whose save failed, kept for the next creation attempt. */
interface PendingCreate {
  scheme: VaultCustodyScheme
  keyFile?: string
  importKeyFile: boolean
  vaultId: string
  created: CustodianCreated
}

type CommitStep =
  | { kind: 'vault'; next: VaultFile }
  | { kind: 'legacy'; next: Record<string, string> }
  /** Delete secrets.json (retirement, post-retirement residue) only when its bytes still hash to `expect`. */
  | { kind: 'unlink-legacy'; expect: string }

type Resolution =
  | { k: 'vault'; entry: VaultEntry; fallback?: string }
  | { k: 'legacy'; value: string }
  | { k: 'unreadable'; reason: string }
  | { k: 'unset' }

type LegacyState = { state: 'ok'; values: Record<string, string>; bytes: Buffer } | { state: 'missing' } | { state: 'corrupt' }

const EMPTY = dict<string>()

export class SecretStore implements SecretStoreApi {
  private readonly dataDir: string
  private readonly vaultPath: string
  private readonly legacyPath: string
  private readonly hostKind: HostKind
  private readonly isApp: boolean
  private readonly readOnly: boolean
  /** key -> plain value, memory only. */
  private readonly overlay = new Map<string, string>()
  private readonly fs: VaultFs
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv
  private readonly now: () => number
  private readonly logLine: (m: string) => void
  private readonly factory: CustodianFactory
  private readonly dualWrite: boolean
  private readonly retirement: boolean
  private readonly retryMs: number
  private readonly userDataDir: string | undefined

  private legacy: LegacyState = { state: 'missing' }
  /** sha256 of every secrets.json value string (H of 5.5). */
  private legacyHashes: Record<string, string> = dict<string>()
  private vault: VaultFile | undefined
  private vstate: VaultState = 'absent'
  private dek: Buffer | undefined
  /** Why the vault is not open (locked / missing-key: the custodian's reason). */
  private reason: string | undefined
  /** The last custodian failure (open or create); retries and statusReport read it. */
  private lastFailure: CustodyFailure | undefined
  /** A failed save left the files unreconciled: mutations retry the reconcile first and refuse until it succeeds. */
  private recoveryRequired = false
  private recovering = false
  /** Keys a removal had to leave where they were (5.5 Deletes), counted by doctor (`<prefix>*` for a prefix it could not list). */
  private readonly orphaned = new Set<string>()
  /**
   * vault.json could not be read (an I/O error, not damage; review round 2): handled internally like 'corrupt' (no legacy
   * reads, values and clears refused, removals left in place, the file never written), but state() reports 'locked'
   * with this sentence, reset is never advised, and the file is read again (retryRead) before every mutation and on
   * prepareWrite, retryOpen, secrets:init and secrets:status.
   */
  private vaultReadError: string | undefined
  /** secrets.json could not be read (an I/O error): handled like a corrupt legacy file (never written), read again as above. */
  private legacyReadError: string | undefined
  /** The last repeated failure logged (signature and time), so the retry timer does not add a line every 10 minutes. */
  private lastRepeatLog: { sig: string; at: number } | undefined
  /** Why the last creation's own save failed (a disk error): reported instead of a custody reason. */
  private createSaveError: string | undefined
  /** The custodian's key for a vault whose save failed: the next creation reuses it instead of making another item. */
  private pendingCreate: PendingCreate | undefined
  /** The one asynchronous custody operation in flight (create, open, init, reset): single-flight. */
  private flight: Promise<unknown> | undefined
  private flightLabel: FlightLabel | undefined
  private retryTimer: ReturnType<typeof setInterval> | undefined
  private lastFocusRetry = 0
  private acquireLease: ((label: string) => () => void) | undefined
  private resetBusy: (() => boolean) | undefined

  constructor(
    dataDir: string,
    private cipher: SecretCipher,
    opts: SecretStoreOptions = {}
  ) {
    this.dataDir = dataDir
    this.vaultPath = join(dataDir, VAULT_FILE)
    this.legacyPath = join(dataDir, LEGACY_SECRETS_FILE)
    this.hostKind = opts.hostKind ?? 'desktop'
    this.isApp = isAppHostKind(this.hostKind)
    this.readOnly = opts.readOnly === true
    for (const [k, v] of opts.overlay ?? []) if (typeof k === 'string' && typeof v === 'string' && v !== '') this.overlay.set(k, v)
    this.fs = opts.fs ?? nodeVaultFs
    this.platform = opts.platform ?? process.platform
    this.env = opts.env ?? process.env
    this.now = opts.now ?? Date.now
    const log = opts.log
    this.logLine = (m) => {
      try {
        if (log) log(`Secure storage: ${m}`)
        else console.log(`Secure storage: ${m}`)
      } catch {
        // logging never breaks the store
      }
    }
    this.factory = opts.custodian ?? unavailableCustodianFactory
    this.dualWrite = opts.vaultFlags?.dualWrite ?? VAULT_DUAL_WRITE
    this.retirement = opts.vaultFlags?.retirement ?? VAULT_RETIREMENT_ENABLED
    this.retryMs = opts.retryMs ?? VAULT_RETRY_MS
    this.userDataDir = opts.userDataDir
    this.reload()
  }

  // ---------- Loading ----------

  /**
   * Re-read both files from disk into fresh maps; the data key is kept only while it still opens secure storage on disk.
   * `strictIo` (recovery): an I/O error other than ENOENT throws and leaves the maps as they were, so a transient read
   * failure never passes for a damaged file.
   */
  private reload(strictIo = false): void {
    const legacy = readLegacyFile(this.legacyPath, this.fs, strictIo)
    const read = readVaultFile(this.vaultPath, this.fs, strictIo)
    if (legacy.state === 'unreadable') {
      // Never written while it cannot be read (the corrupt rules), and read again later.
      this.legacy = { state: 'corrupt' }
      this.legacyReadError = fileReadFailedMessage(LEGACY_SECRETS_FILE, legacy.code)
    } else {
      this.legacy = legacy
      this.legacyReadError = undefined
    }
    const hashes = dict<string>()
    if (this.legacy.state === 'ok') for (const [k, l] of Object.entries(this.legacy.values)) hashes[k] = sha256Hex(l)
    this.legacyHashes = hashes
    if (read.kind === 'unreadable') {
      this.dropKey()
      this.vault = undefined
      this.vstate = 'corrupt'
      this.vaultReadError = fileReadFailedMessage(VAULT_FILE, read.code)
      this.reason = this.vaultReadError
      return
    }
    this.vaultReadError = undefined
    if (read.kind !== 'vault') {
      this.dropKey()
      this.vault = undefined
      this.vstate = read.kind
      this.reason = read.kind === 'corrupt' ? VAULT_MESSAGES.corrupt : undefined
      return
    }
    this.vault = read.vault
    // A key that opens this secure storage's check record belongs to it (also right after a creation whose save was not durable).
    if (this.dek && checkMatches(this.dek, read.vault.vaultId, read.vault.check)) {
      this.vstate = 'open'
      this.reason = undefined
      return
    }
    if (this.dek) {
      // The vault on disk is not the one this key opened: open it again on the next prepareWrite / retry.
      this.dropKey()
      this.vstate = 'locked'
      this.reason = VAULT_NOT_OPENED_MESSAGE
      this.lastFailure = { kind: 'locked', reason: VAULT_NOT_OPENED_MESSAGE }
      return
    }
    if (this.vstate === 'absent' || this.vstate === 'corrupt' || this.vstate === 'open') {
      this.vstate = 'locked'
      this.reason = VAULT_NOT_OPENED_MESSAGE
    }
  }

  private dropKey(): void {
    zeroize(this.dek)
    this.dek = undefined
  }

  private log(m: string): void {
    this.logLine(m)
  }

  /** Log a failure the retry timer may repeat: an identical one again only after VAULT_REPEAT_LOG_MS. */
  private logRepeated(sig: string, m: string): void {
    const now = this.now()
    const last = this.lastRepeatLog
    if (last && last.sig === sig && now - last.at < VAULT_REPEAT_LOG_MS) return
    this.lastRepeatLog = { sig, at: now }
    this.log(m)
  }

  private hasReadError(): boolean {
    return this.vaultReadError !== undefined || this.legacyReadError !== undefined
  }

  /**
   * After an I/O read failure: read both files again (synchronous and cheap). Once both read, reconcile as an open would
   * (an app host with the vault open imports what secrets.json held). Never throws.
   */
  private retryRead(): void {
    if (!this.hasReadError()) return
    try {
      this.reload()
    } catch (e) {
      this.log(`could not read the secret files again (${e instanceof Error ? e.message : 'error'})`)
      return
    }
    if (this.hasReadError()) return
    this.lastRepeatLog = undefined
    this.log('the secret files can be read again')
    // An app host opens (or creates) the vault found again through its background retry (retryOpen needs a failure).
    if (this.isApp && this.vstate !== 'open' && !this.lastFailure && this.createSaveError === undefined) {
      this.lastFailure = { kind: 'locked', reason: VAULT_NOT_OPENED_MESSAGE }
    }
    if (!this.recoveryRequired) this.reconcileNow()
  }

  // ---------- Small helpers ----------

  private cipherAvailable(): boolean {
    try {
      return this.cipher.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  /** 5.5 "can write back": an app host whose safeStorage can encrypt (imports, write-back, dual-write). */
  private legacyCapable(): boolean {
    return this.isApp && this.cipherAvailable()
  }

  private legacyValues(): Record<string, string> {
    return this.legacy.state === 'ok' ? this.legacy.values : EMPTY
  }

  /** L: the secrets.json value string of key K, when the file is 'ok'. */
  private L(key: string): string | undefined {
    const values = this.legacyValues()
    return Object.hasOwn(values, key) ? values[key] : undefined
  }

  private H(key: string): string | undefined {
    return Object.hasOwn(this.legacyHashes, key) ? this.legacyHashes[key] : undefined
  }

  private legacyDecrypt(l: string): string {
    return this.cipher.decryptString(Buffer.from(l, 'base64'))
  }

  private legacyEncrypt(plain: string): string {
    return this.cipher.encryptString(plain).toString('base64')
  }

  private notOpenReason(): string {
    if (this.vaultReadError) return VAULT_MESSAGES.locked(this.vaultReadError)
    if (this.vstate === 'corrupt') return VAULT_MESSAGES.corrupt
    if (this.vstate === 'missing-key') return VAULT_MESSAGES.missingKey
    if (this.vstate === 'key-mismatch') return VAULT_MESSAGES.keyMismatch
    return VAULT_MESSAGES.locked(this.reason ?? VAULT_NOT_OPENED_MESSAGE)
  }

  private envKeyFile(): string | undefined {
    const v = this.env[VAULT_KEY_FILE_ENV]
    return typeof v === 'string' && v.trim() !== '' ? v : undefined
  }

  /** The scheme a new vault would use: key-file when ORGAI_VAULT_KEY_FILE is set, else the platform's OS scheme. */
  private newScheme(): VaultCustodyScheme | null {
    return this.envKeyFile() ? 'key-file' : platformVaultScheme(this.platform)
  }

  private keyFileConfigured(): boolean {
    return this.vault?.custody.scheme === 'key-file' || this.envKeyFile() !== undefined
  }

  private keyFileProblem(path: string): string | undefined {
    if (!isAbsolute(path)) return 'The key file path must be absolute.'
    if (this.userDataDir && isInsideEither(this.userDataDir, path)) return KEY_FILE_INSIDE_DATA_MESSAGE
    if (isInsideEither(this.dataDir, path)) return KEY_FILE_INSIDE_DATA_MESSAGE
    return undefined
  }

  private canonical(path: string): string {
    try {
      return this.fs.realpathSync(path)
    } catch {
      return resolve(path)
    }
  }

  // ---------- Reads (5.4, 5.5 legacy read rule) ----------

  /** Where K's value comes from on this host, without decrypting anything. */
  private resolve(key: string): Resolution {
    if (this.vstate === 'corrupt') return this.L(key) !== undefined ? { k: 'unreadable', reason: this.notOpenReason() } : { k: 'unset' }
    const l = this.L(key)
    // Only the app reads secrets.json values (with safeStorage; a failed decrypt reads unreadable, as before Wave 7).
    const capable = this.isApp
    // A secrets.json value newer than the vault (rows 3 and 4, or no vault at all): the app reads it, others cannot.
    if (l !== undefined && legacyIsNewer(this.vault, key, this.H(key))) {
      return capable ? { k: 'legacy', value: l } : { k: 'unreadable', reason: VAULT_MESSAGES.pendingLegacy }
    }
    const v = this.vault
    if (!v) return { k: 'unset' }
    const e = Object.hasOwn(v.entries, key) ? v.entries[key] : undefined
    if (!e) return { k: 'unset' }
    // The legacy read rule: L with H = B is used only while E.lc says secrets.json holds the same value.
    const current =
      capable && l !== undefined && e.lc && this.H(key) === baselineOf(v, key) && !Object.hasOwn(v.tombstones, key) ? l : undefined
    if (this.vstate === 'open') return current !== undefined ? { k: 'vault', entry: e, fallback: current } : { k: 'vault', entry: e }
    return current !== undefined ? { k: 'legacy', value: current } : { k: 'unreadable', reason: this.notOpenReason() }
  }

  /** The value and its status in one step (decrypts at most twice). */
  private read(key: string): { value: string } | { unreadable: string } | 'unset' {
    const o = this.overlay.get(key)
    if (o !== undefined) return { value: o }
    const r = this.resolve(key)
    if (r.k === 'unset') return 'unset'
    if (r.k === 'unreadable') return { unreadable: r.reason }
    if (r.k === 'legacy') {
      try {
        return { value: this.legacyDecrypt(r.value) }
      } catch {
        return { unreadable: UNDECRYPTABLE_REASON }
      }
    }
    const v = this.vault
    if (v && this.dek) {
      try {
        return { value: decryptEntry(this.dek, v.vaultId, key, r.entry) }
      } catch {
        // an entry whose tag fails after the check passed is unreadable, never unset; secrets.json may still hold it
      }
    }
    if (r.fallback !== undefined) {
      try {
        return { value: this.legacyDecrypt(r.fallback) }
      } catch {
        // fall through
      }
    }
    return { unreadable: VAULT_MESSAGES.unreadableEntry }
  }

  /**
   * False when nothing can be stored here (read-only, a corrupt or unreadable vault, an unreadable secrets.json, no cipher
   * in legacy-only mode, a closed vault). A Node or inproc host with an absent vault answers true only while a key store
   * may create one: never with the placeholder custodian of this build, nor after a creation failed 'unavailable'
   * (review round 2).
   */
  available(): boolean {
    if (this.readOnly || this.vstate === 'corrupt' || this.legacyReadError !== undefined) return false
    if (this.vstate === 'open') return true
    if (this.isApp) return this.cipherAvailable() && this.legacy.state !== 'corrupt'
    if (this.vstate !== 'absent' || this.newScheme() === null) return false
    return !isPlaceholderCustodian(this.factory) && this.lastFailure?.kind !== 'unavailable'
  }

  /** True while an in-memory overlay value (ORGAI_SECRET_*, --secret-env) answers for the key; it is never persisted. */
  fromOverlay(key: string): boolean {
    return this.overlay.has(key)
  }

  has(key: string): boolean {
    return this.overlay.has(key) || this.resolve(key).k !== 'unset'
  }

  /** The plain value, or undefined when unset or unreadable (status() says which). */
  get(key: string): string | undefined {
    const r = this.read(key)
    return typeof r === 'object' && 'value' in r ? r.value : undefined
  }

  status(key: string): SecretStatus {
    const r = this.read(key)
    if (r === 'unset') return 'unset'
    return 'value' in r ? 'set' : { unreadable: r.unreadable }
  }

  state(): VaultState {
    // An unreadable vault.json (an I/O error) is reported as locked with the read error, never as damaged.
    return this.vaultReadError ? 'locked' : this.vstate
  }

  /** Keys (stored and overlay) starting with a prefix that hold a value somewhere, readable or not. */
  keys(prefix = ''): string[] {
    const out = new Set<string>()
    for (const k of this.overlay.keys()) if (k.startsWith(prefix)) out.add(k)
    const candidates = new Set<string>(Object.keys(this.legacyValues()))
    if (this.vault) for (const k of Object.keys(this.vault.entries)) candidates.add(k)
    for (const k of candidates) if (k.startsWith(prefix) && !out.has(k) && this.resolve(k).k !== 'unset') out.add(k)
    return [...out]
  }

  // ---------- Commits (5.5 Durability and failures) ----------

  /**
   * Write `steps` in order, updating the in-memory maps after each durable step. A failure before the first rename
   * changes nothing (CommitError 'clean'); any other failure re-reads both files from disk at once into fresh maps,
   * reconciles (rows 1 and 2 without a key) and throws CommitError 'indeterminate'.
   */
  private commit(steps: CommitStep[]): void {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] as CommitStep
      try {
        this.writeStep(step)
      } catch (e) {
        const clean = i === 0 && (!(e instanceof DurableFsError) || e.outcome === 'unchanged')
        if (clean) throw new CommitError('clean', e)
        this.log(`a save may not be durable (${e instanceof Error ? e.message : 'error'}); re-reading from disk`)
        this.recoveryRequired = true
        if (this.recovering) this.reloadForRecovery()
        else this.tryRecover()
        throw new CommitError('indeterminate', e)
      }
    }
  }

  private writeStep(step: CommitStep): void {
    const opts = { fs: this.fs, platform: this.platform }
    if (step.kind === 'vault') {
      writeFileDurable(this.vaultPath, serializeVaultFile(step.next), opts)
      this.vault = step.next
      if (this.vstate === 'absent' && this.dek) this.vstate = 'open'
      return
    }
    if (step.kind === 'legacy') {
      const bytes = serializeLegacyFile(step.next)
      writeFileDurable(this.legacyPath, bytes, opts)
      const values = dict<string>()
      const hashes = dict<string>()
      for (const [k, l] of Object.entries(step.next)) {
        values[k] = l
        hashes[k] = sha256Hex(l)
      }
      this.legacy = { state: 'ok', values, bytes }
      this.legacyHashes = hashes
      return
    }
    // Delete secrets.json only when its bytes have not changed since they were read (re-hash before unlink).
    let current: Buffer
    try {
      current = this.fs.readFileSync(this.legacyPath)
    } catch {
      this.legacy = { state: 'missing' }
      this.legacyHashes = dict<string>()
      return
    }
    if (sha256Hex(current) !== step.expect) {
      this.log('secrets.json changed since it was read; it stays until the next reconcile')
      return
    }
    unlinkDurable(this.legacyPath, opts)
    this.legacy = { state: 'missing' }
    this.legacyHashes = dict<string>()
  }

  /** A strict re-read; an I/O error keeps the current maps (recovery stays required). */
  private reloadForRecovery(): void {
    try {
      this.reload(true)
    } catch (e) {
      this.log(`could not re-read the secret files (${e instanceof Error ? e.message : 'error'}); recovery stays pending`)
    }
  }

  /** Re-read and reconcile; clears recoveryRequired on success. Never throws. */
  private tryRecover(): boolean {
    this.recovering = true
    try {
      this.reload(true)
      const ok = this.reconcileNow()
      this.recoveryRequired = !ok
      return ok
    } catch (e) {
      this.log(`recovery failed: ${e instanceof Error ? e.message : 'error'}`)
      this.recoveryRequired = true
      return false
    } finally {
      this.recovering = false
    }
  }

  /**
   * The reconcile after an open or a creation. While a file cannot be read (an I/O error) a strict re-read would only
   * fail and mark a recovery that no save needs: read it again instead (retryRead reconciles once both read).
   */
  private reconcileAfterOpen(): void {
    if (this.hasReadError()) this.retryRead()
    else this.tryRecover()
  }

  /** Before a mutation: finish the recovery a failed save left, or refuse. */
  private ensureRecovered(): void {
    if (this.recoveryRequired && !this.tryRecover()) throw new Error(VAULT_RECOVERY_MESSAGE)
  }

  /** The ciphers reconciliation may use: only an app host that can write back, with the vault open. */
  private reconcileCrypto(): ReconcileCrypto | undefined {
    const v = this.vault
    const dek = this.dek
    if (this.vstate !== 'open' || !v || !dek || !this.legacyCapable()) return undefined
    return {
      legacyDecrypt: (l) => this.legacyDecrypt(l),
      legacyEncrypt: (p) => this.legacyEncrypt(p),
      vaultDecrypt: (key, c) => decryptEntry(dek, v.vaultId, key, c),
      vaultEncrypt: (key, p) => encryptEntry(dek, v.vaultId, key, p)
    }
  }

  /**
   * Reconcile with secrets.json (5.5): every row when the vault is open here, rows 1 and 2 only when it parses but is
   * not open (round 6 item 2), nothing when it is absent or corrupt. Returns false when a write failed.
   */
  private reconcileNow(): boolean {
    const v = this.vault
    if (!v || this.vstate === 'corrupt' || this.vstate === 'absent') return true
    const mode = this.vstate === 'open' ? 'full' : 'metadata'
    const legacy = this.legacy
    const plan = planReconcile({
      vault: v,
      legacy: { state: legacy.state, values: legacy.state === 'ok' ? legacy.values : EMPTY },
      mode,
      crypto: this.reconcileCrypto(),
      dualWrite: this.dualWrite,
      now: this.now()
    })
    for (const s of plan.skipped) this.log(`skipped ${s.key}: ${s.reason}`)
    if (plan.softDeleted.length) this.log(VAULT_MESSAGES.legacyRemovedNotice(plan.softDeleted.length))
    const steps: CommitStep[] = []
    if (plan.legacy) steps.push({ kind: 'legacy', next: plan.legacy })
    if (plan.vault) steps.push({ kind: 'vault', next: plan.vault })
    if (plan.unlinkLegacy && legacy.state === 'ok') steps.push({ kind: 'unlink-legacy', expect: sha256Hex(legacy.bytes) })
    if (steps.length) {
      try {
        this.commit(steps)
      } catch (e) {
        this.log(`reconcile did not finish: ${e instanceof Error ? e.message : 'error'}`)
        this.recoveryRequired = true
        return false
      }
      if (plan.imported.length || plan.wroteBack.length || plan.completedDeletes.length) {
        this.log(`reconciled: ${plan.imported.length} imported, ${plan.wroteBack.length} written back, ${plan.completedDeletes.length} deletes finished`)
      }
    }
    if (this.vstate === 'open') this.maybeRetire()
    return true
  }

  /** 5.5 Retirement (behind VAULT_RETIREMENT_ENABLED): write legacyRetired durably, then delete secrets.json. */
  private maybeRetire(): void {
    if (!this.retirement) return
    const v = this.vault
    const legacy = this.legacy
    if (!v || legacy.state !== 'ok') return
    const blocker = retirementBlocker(v, { state: legacy.state, values: legacy.values }, { open: this.vstate === 'open', canWriteBack: this.legacyCapable() })
    if (blocker) return
    try {
      this.commit([{ kind: 'vault', next: planRetirement(v, legacy, this.now()) }, { kind: 'unlink-legacy', expect: sha256Hex(legacy.bytes) }])
      this.log('secrets.json retired')
    } catch (e) {
      this.log(`retirement waits for a later boot: ${e instanceof Error ? e.message : 'error'}`)
    }
  }

  // ---------- Writes (5.5 Writes) ----------

  /**
   * Store a value, or clear it with null or '' (an explicit clear: see clear(), which throws when the clear is refused or
   * its save failed; removals use delete() / deletePrefix(), which never throw).
   */
  set(key: string, value: string | null): void {
    if (value === null || value === '') {
      this.clear(key)
      return
    }
    if (typeof value !== 'string' || !validSecretKey(key)) throw new Error('A secret needs a key and a string value.')
    if (this.readOnly) throw new Error(READ_ONLY_SECRETS_MESSAGE)
    this.retryRead()
    this.ensureRecovered()
    if (this.vstate === 'corrupt') throw new Error(this.notOpenReason())
    // Values wait while secrets.json cannot be read: its hash is what makes a stale copy there never read as newer, so a
    // save now could later lose to an older value (rows 3 and 4).
    if (this.legacyReadError) throw new Error(this.legacyReadError)
    if (this.vstate === 'open') this.writeVault(key, value)
    else if (this.isApp) this.writeLegacyOnly(key, value)
    else if (this.vstate === 'absent') throw new VaultNotReady(key)
    else throw new Error(this.notOpenReason())
    // The stored value is the newest; an overlay value must not shadow it.
    this.overlay.delete(key)
    this.orphaned.delete(key)
  }

  /** Writes 1 and 2 of 5.5: dual-write on a host that can write back (secrets.json first), else vault only. */
  private writeVault(key: string, value: string): void {
    const v = this.vault as VaultFile
    const dek = this.dek as Buffer
    const next = cloneVault(v)
    const sealed = encryptEntry(dek, v.vaultId, key, value)
    delete next.tombstones[key]
    const dual = this.legacyCapable() && this.dualWrite && !v.legacyRetired && this.legacy.state !== 'corrupt'
    if (dual) {
      const back = this.legacyEncrypt(value)
      const legacyNext = dict<string>()
      for (const [k, l] of Object.entries(this.legacyValues())) legacyNext[k] = l
      legacyNext[key] = back
      next.entries[key] = { ...sealed, at: this.now(), lc: true }
      setBaseline(next, key, sha256Hex(back))
      this.commit([{ kind: 'legacy', next: legacyNext }, { kind: 'vault', next }])
      return
    }
    next.entries[key] = { ...sealed, at: this.now(), lc: false }
    // The stale legacy copy is never read again (it also supersedes a pending-legacy value).
    const h = this.H(key)
    if (h !== undefined) setBaseline(next, key, h)
    this.commit([{ kind: 'vault', next }])
  }

  /**
   * Write 3 of 5.5: an app host whose vault is not open writes secrets.json (the next open imports it, row 4). When
   * vault.json parses (locked, missing-key, key-mismatch) and the new value string would not read as newer than the
   * vault (its hash equals B or T.legacyHash: safeStorage is deterministic on macOS and Linux, so saving the value B was
   * taken from again gives the same string), a metadata-only vault write first drops B and T.legacyHash for the key,
   * so the save reads back now and row 4 imports it on unlock instead of row 5 writing an older vault value over it
   * (review round 1). Vault first: a failure between the two leaves the earlier secrets.json value, which then has the
   * same bytes as the new one (H = B), so reads converge to the new value; a failure at the vault write changes nothing.
   */
  private writeLegacyOnly(key: string, value: string): void {
    if (this.legacy.state === 'corrupt') throw new Error(this.legacyReadError ?? LEGACY_CORRUPT_MESSAGE)
    if (!this.cipherAvailable()) throw new Error(SECURE_STORAGE_UNAVAILABLE_MESSAGE)
    const back = this.legacyEncrypt(value)
    const next = dict<string>()
    for (const [k, l] of Object.entries(this.legacyValues())) next[k] = l
    next[key] = back
    const steps: CommitStep[] = []
    const v = this.vault
    if (v && !legacyIsNewer(v, key, sha256Hex(back))) {
      const meta = cloneVault(v)
      setBaseline(meta, key, undefined)
      const t = Object.hasOwn(meta.tombstones, key) ? meta.tombstones[key] : undefined
      if (t) delete t.legacyHash
      steps.push({ kind: 'vault', next: meta })
    }
    steps.push({ kind: 'legacy', next })
    this.commit(steps)
  }

  // ---------- Deletes (5.5 Deletes) ----------

  /**
   * A removal's delete (a project, server or library entry removed, linkLibrary, a kit replace). Never throws: a key it
   * cannot handle is left in place, logged and counted as orphaned. An explicit clear is clear() (or set(key, null)).
   */
  delete(key: string): void {
    this.overlay.delete(key)
    if (this.readOnly || typeof key !== 'string') return
    this.retryRead()
    if (this.hasReadError()) {
      // Whether the key is stored cannot be seen while a file cannot be read: left in place, retried by a later removal.
      this.leaveInPlace([key], this.readErrorReason())
      return
    }
    this.removeKeys([key])
  }

  /** A removal of every key starting with a prefix; returns how many were removed (overlay included). Never throws. */
  deletePrefix(prefix: string): number {
    const before = this.keys(prefix)
    for (const k of [...this.overlay.keys()]) if (k.startsWith(prefix)) this.overlay.delete(k)
    if (!this.readOnly) {
      this.retryRead()
      if (this.hasReadError()) {
        this.leaveInPlace([`${prefix}*`], this.readErrorReason())
        return before.filter((k) => !this.has(k)).length
      }
      const stored = new Set<string>(Object.keys(this.legacyValues()).filter((k) => k.startsWith(prefix)))
      if (this.vault) for (const k of Object.keys(this.vault.entries)) if (k.startsWith(prefix)) stored.add(k)
      if (stored.size) this.removeKeys([...stored])
    }
    return before.filter((k) => !this.has(k)).length
  }

  /**
   * An explicit clear (5.5 Deletes: `set-secret --clear`, connections:setSecret / mcp:setSecret / mcpLibrary:setSecret
   * with null or '', connectors:setToken null; set(key, null) lands here too). Unlike a removal it reports what happened
   * (review round 2): it throws clearRefusal()'s sentence before anything changes, VAULT_RECOVERY_MESSAGE while a failed
   * save is not reconciled, secretClearFailedMessage(<the disk's reason>) when the save failed before anything changed
   * (the value is still stored), and VAULT_MESSAGES.notDurable when the outcome is not known (never success). A key that
   * exists nowhere is a no-op. A read-only store only drops the overlay value.
   */
  clear(key: string): void {
    this.overlay.delete(key)
    if (this.readOnly || !validSecretKey(key)) return
    const refusal = this.clearRefusal(key)
    if (refusal) throw new Error(refusal)
    try {
      this.removeKeysOrThrow([key])
    } catch (e) {
      if (e instanceof CommitError && e.outcome === 'clean') {
        const failure = e.failure
        throw new Error(secretClearFailedMessage(failure instanceof Error ? failure.message : 'error'))
      }
      throw e
    }
    this.orphaned.delete(key)
  }

  /** The sentence for a file that cannot be read (vault.json first). */
  private readErrorReason(): string {
    return this.vaultReadError ?? this.legacyReadError ?? VAULT_NOT_OPENED_MESSAGE
  }

  /**
   * 5.5 Deletes clear check: why clearing `key` must be refused here, else undefined. Reads the files again first when
   * one could not be read; while one still cannot be, every clear is refused with that reason (whether the key is stored
   * cannot be seen, and a secrets.json copy left behind would be imported again later).
   */
  clearRefusal(key: string): string | undefined {
    this.retryRead()
    if (this.vaultReadError) return VAULT_MESSAGES.locked(this.vaultReadError)
    if (this.legacyReadError) return this.legacyReadError
    if (this.L(key) === undefined) return undefined
    if (this.vstate === 'corrupt') return VAULT_MESSAGES.clearRefusedCorrupt
    if (!this.isApp && this.vstate === 'absent') return VAULT_MESSAGES.clearRefusedLegacyOnly
    return undefined
  }

  private leaveInPlace(keys: string[], why: string): void {
    for (const k of keys) this.orphaned.add(k)
    if (keys.length) this.log(`left ${keys.length} secret${keys.length === 1 ? '' : 's'} in place (${why}): ${keys.join(', ')}`)
  }

  /** The delete rules for every state (never throws). */
  private removeKeys(keys: string[]): void {
    try {
      this.removeKeysOrThrow(keys)
    } catch (e) {
      // Left in place: keys that still read as present. A tombstoned key whose legacy copy waits for rows 1 and 2 is
      // deleted already (the recovery finishes it).
      const left = keys.filter((k) => this.resolve(k).k !== 'unset')
      this.leaveInPlace(left, e instanceof Error ? e.message : 'error')
    }
  }

  private removeKeysOrThrow(keys: string[]): void {
    const onDisk = (k: string): boolean => this.L(k) !== undefined || (this.vault !== undefined && Object.hasOwn(this.vault.entries, k))
    if (!keys.some(onDisk)) return // deleting a key that exists nowhere is a no-op in every state
    this.ensureRecovered()
    const present = keys.filter(onDisk)
    if (this.vstate === 'corrupt') {
      this.leaveInPlace(present, 'secure storage is damaged')
      return
    }
    if (this.vstate === 'absent') {
      if (!this.isApp) {
        this.leaveInPlace(present, 'saved by the OrgAI app and no vault here yet')
        return
      }
      if (this.legacy.state !== 'ok') return
      const next = dict<string>()
      for (const [k, l] of Object.entries(this.legacy.values)) if (!present.includes(k)) next[k] = l
      this.commit([{ kind: 'legacy', next }])
      for (const k of present) this.orphaned.delete(k)
      return
    }
    // vault.json parses (open, locked, missing-key, key-mismatch): three metadata-only steps, no data key needed.
    const v = this.vault as VaultFile
    const step1 = cloneVault(v)
    const now = this.now()
    const legacyTargets: string[] = []
    for (const k of present) {
      const l = this.L(k)
      const h = this.H(k)
      const e = Object.hasOwn(step1.entries, k) ? step1.entries[k] : undefined
      const old = Object.hasOwn(step1.tombstones, k) ? step1.tombstones[k] : undefined
      let t: VaultTombstone = { at: now, by: 'vault' }
      // Keep the newest value for undelete: L when it is newer than E (H != B, or pending-legacy), else E. A delete
      // that finds nothing newer keeps what an earlier tombstone of this key still holds.
      if (l !== undefined && legacyIsNewer(v, k, h)) t.prevLegacy = l
      else if (e) t.prev = { iv: e.iv, ct: e.ct, tag: e.tag }
      else if (old && (old.prev || old.prevLegacy !== undefined)) {
        t = { ...old, by: 'vault' }
        delete t.legacyHash
      }
      if (l !== undefined && h !== undefined) {
        t.legacyHash = h
        legacyTargets.push(k)
      }
      step1.tombstones[k] = t
      delete step1.entries[k]
    }
    // Step 3 drops B and T.legacyHash: the targeted legacy value is gone, and safeStorage is deterministic on macOS and
    // Linux, so a later save of the same value (an older app, or this app in legacy-only mode) has the same hash and
    // must read as new, not as this delete's target (review round 1).
    const step3 = cloneVault(step1)
    for (const k of present) {
      setBaseline(step3, k, undefined)
      const t3 = Object.hasOwn(step3.tombstones, k) ? step3.tombstones[k] : undefined
      if (t3) delete t3.legacyHash
    }
    if (!legacyTargets.length || this.legacy.state !== 'ok') {
      // No legacy copy to remove: steps 1 and 3 in one write.
      this.commit([{ kind: 'vault', next: step3 }])
    } else {
      const next = dict<string>()
      for (const [k, l] of Object.entries(this.legacy.values)) if (!legacyTargets.includes(k)) next[k] = l
      this.commit([{ kind: 'vault', next: step1 }, { kind: 'legacy', next }, { kind: 'vault', next: step3 }])
    }
    for (const k of present) this.orphaned.delete(k)
  }

  // ---------- Opening, creating, retrying (5.6) ----------

  /** Run `fn` as the one custody operation in flight; a background one holds a lease once the host exists. */
  private startFlight<T>(label: FlightLabel, fn: () => Promise<T>): Promise<T> {
    const release = this.acquireLease?.(`secure storage ${label}`)
    // fn starts on the next microtask, so `flight` is set before any of it runs.
    const p: Promise<T> = Promise.resolve()
      .then(fn)
      .finally(() => {
        if (this.flight === p) {
          this.flight = undefined
          this.flightLabel = undefined
        }
        try {
          release?.()
        } catch {
          // a lease release never fails a vault step
        }
      })
    this.flight = p
    this.flightLabel = label
    return p
  }

  /**
   * Wait until no custody step is in flight, then start `fn` as the next one. The check and the start run in the same
   * synchronous step after the last await, so two callers that waited for the same flight never both start one.
   */
  private async runExclusive<T>(label: FlightLabel, fn: () => Promise<T>): Promise<T> {
    while (this.flight) {
      try {
        await this.flight
      } catch {
        // its outcome is not ours to report; the state is re-evaluated by fn
      }
    }
    return this.startFlight(label, fn)
  }

  /**
   * The open step of openSecretStore: open an existing vault (decrypting `check`) and reconcile; on an app host create
   * one when absent (legacy-only mode and the retry timer on failure). A Node or inproc host leaves an absent vault
   * alone (lazy creation in prepareWrite). Never throws.
   */
  async openVault(): Promise<void> {
    if (this.readOnly) return
    await this.runExclusive('open', async () => {
      if (this.vault) await this.openExisting()
      else if (this.vstate === 'absent' && this.isApp) {
        try {
          await this.createVault()
        } catch (e) {
          this.noteCreateFailure(e)
        }
      }
      if (this.hasReadError()) {
        // An I/O error, not damage: read again by the next save, prepareWrite, secrets:init / status and the app's retry.
        this.logRepeated(`read:${this.readErrorReason()}`, this.readErrorReason())
        if (this.isApp && this.vstate !== 'open') this.startRetryTimer()
        return
      }
      if (this.vstate !== 'open' && !this.recoveryRequired) this.tryRecover()
    })
  }

  private failureOf(e: unknown): CustodyFailure {
    if (isCustodyFailure(e)) return { kind: e.kind, reason: e.reason }
    return { kind: 'unavailable', reason: KEY_STORE_UNREACHABLE_MESSAGE }
  }

  /** The sentence for a failed creation: the disk's reason for a failed save of vault.json, else the custodian's. */
  private createFailureReason(e: unknown): string {
    return e instanceof VaultSaveError ? e.message : this.failureOf(e).reason
  }

  /**
   * A creation failed. A failed save of the new vault.json (a disk error: VaultSaveError) is reported with the disk's
   * reason and is not a custody failure: lastFailure is cleared (the key store worked), and the key the custodian made is
   * kept for the next attempt (pendingCreate), so retries never leave one more OS key item each.
   */
  private noteCreateFailure(e: unknown): void {
    if (this.vstate === 'open') return // created, but its save was not known to be durable: the caller got that error
    if (e instanceof VaultSaveError) {
      this.createSaveError = e.message
      this.lastFailure = undefined
      this.logRepeated(`save:${e.detail}`, `could not save the new vault (${e.detail}); ${this.isApp ? 'using secrets.json only until it can' : 'nothing stored'}`)
    } else {
      const f = this.failureOf(e)
      this.lastFailure = f
      this.createSaveError = undefined
      this.logRepeated(`create:${f.kind}:${f.reason}`, `could not create the vault (${f.kind}); ${this.isApp ? 'using secrets.json only until it can' : 'nothing stored'}`)
    }
    if (this.isApp) this.startRetryTimer()
  }

  private discardPendingCreate(): void {
    if (this.pendingCreate) zeroize(this.pendingCreate.created.dek)
    this.pendingCreate = undefined
  }

  private custodyRequestFor(custody: VaultCustody, override?: CustodianRequest): { custody: VaultCustody; request: CustodianRequest } {
    if (custody.scheme !== 'key-file') return { custody, request: {} }
    const keyFile = override?.keyFile ?? this.envKeyFile() ?? custody.keyFile
    return { custody: { ...custody, ...(keyFile ? { keyFile } : {}) }, request: keyFile ? { keyFile } : {} }
  }

  /** Open the vault on disk with its recorded scheme. True when open. */
  private async openExisting(override?: CustodianRequest): Promise<boolean> {
    const v = this.vault
    if (!v) return false
    const vaultId = v.vaultId
    const { custody, request } = this.custodyRequestFor(v.custody, override)
    let dek: Buffer
    try {
      if (custody.scheme === 'key-file') {
        const problem = custody.keyFile ? this.keyFileProblem(custody.keyFile) : 'No key file is configured for this secure storage.'
        if (problem) throw new CustodyError('denied', problem)
      }
      dek = await this.factory(custody.scheme, request).open(vaultId, custody)
    } catch (e) {
      const f = this.failureOf(e)
      if (this.vault?.vaultId === vaultId) {
        this.vstate = vaultStateForFailure(f.kind)
        this.reason = f.reason
        this.lastFailure = f
        this.logRepeated(`open:${f.kind}:${f.reason}`, `vault not opened (${f.kind})`)
        if (this.isApp && (this.vstate === 'locked' || this.keyFileConfigured())) this.startRetryTimer()
      }
      return false
    }
    if (!isDek(dek) || this.vault?.vaultId !== vaultId || !checkMatches(dek, vaultId, this.vault.check)) {
      zeroize(dek)
      if (this.vault?.vaultId === vaultId) {
        this.vstate = 'key-mismatch'
        this.reason = VAULT_MESSAGES.keyMismatch
        this.lastFailure = { kind: 'missing', reason: VAULT_MESSAGES.keyMismatch }
        this.logRepeated('open:mismatch', 'the key does not match this secure storage')
      }
      return false
    }
    this.dropKey()
    this.dek = dek
    this.vstate = 'open'
    this.reason = undefined
    this.lastFailure = undefined
    this.createSaveError = undefined
    this.lastRepeatLog = undefined
    this.discardPendingCreate()
    this.stopRetryTimer()
    this.reconcileAfterOpen()
    return true
  }

  /**
   * Create a vault (never while vault.json exists): the custodian makes the key, vault.json is re-checked after that
   * call (an existing vault is opened instead), written with its check record, and then reconciled (an app host
   * imports every legacy key). Throws the custodian's failure (CustodyError), or VaultSaveError when the new vault.json
   * could not be saved; then the custodian's key is kept in memory for the next attempt (pendingCreate), so a disk error
   * that lasts never leaves one more OS key item per retry.
   */
  private async createVault(request?: CustodianRequest): Promise<'created' | 'opened'> {
    const scheme: VaultCustodyScheme | null = request?.keyFile ? 'key-file' : this.newScheme()
    if (!scheme) throw new CustodyError('unavailable', NO_CUSTODIAN_MESSAGE)
    const req: CustodianRequest = scheme === 'key-file' ? { keyFile: request?.keyFile ?? this.envKeyFile(), ...(request?.importKeyFile ? { importKeyFile: true } : {}) } : {}
    if (scheme === 'key-file') {
      const problem = req.keyFile ? this.keyFileProblem(req.keyFile) : 'No key file was named.'
      if (problem) throw new CustodyError('denied', problem)
    }
    let vaultId: string
    let created: CustodianCreated
    const pending = this.pendingCreate
    if (pending && pending.scheme === scheme && pending.keyFile === req.keyFile && pending.importKeyFile === (req.importKeyFile === true)) {
      // The key store already made a key for a vault whose save failed: use it instead of making another item.
      this.pendingCreate = undefined
      vaultId = pending.vaultId
      created = pending.created
    } else {
      // Another scheme or key file: the earlier item stays orphaned (one at most), its key leaves memory.
      this.discardPendingCreate()
      vaultId = newVaultId()
      created = await this.factory(scheme, req).create(vaultId)
      if (!isDek(created.dek)) {
        zeroize(created.dek)
        throw new CustodyError('unavailable', 'The key store returned an unusable key.')
      }
    }
    // Re-check after the custodian call: never overwrite a vault that appeared meanwhile; open it instead.
    const onDisk = readVaultFile(this.vaultPath, this.fs)
    if (onDisk.kind === 'unreadable' && this.vstate === 'absent') {
      // Whether a vault appeared cannot be seen (an I/O error): keep the key for the next attempt, write nothing.
      this.pendingCreate = {
        scheme,
        ...(req.keyFile !== undefined ? { keyFile: req.keyFile } : {}),
        importKeyFile: req.importKeyFile === true,
        vaultId,
        created
      }
      this.reload()
      throw new VaultSaveError(new Error(fileReadFailedMessage(VAULT_FILE, onDisk.code)))
    }
    if (onDisk.kind !== 'absent' || this.vstate !== 'absent') {
      zeroize(created.dek)
      this.reload()
      if (this.vault && (await this.openExisting())) return 'opened'
      throw new CustodyError(this.lastFailure?.kind ?? 'locked', this.notOpenReason())
    }
    const custody: VaultCustody = { scheme }
    if (created.wrapped !== undefined) custody.wrapped = created.wrapped
    if (scheme === 'key-file' && req.keyFile) custody.keyFile = created.keyFile ?? this.canonical(req.keyFile)
    const vault: VaultFile = {
      format: VAULT_FORMAT,
      vaultId,
      custody,
      check: makeCheck(created.dek, vaultId),
      entries: dict(),
      tombstones: dict(),
      legacy: dict(),
      legacyRetired: null
    }
    // A private copy of the key, taken before the commit: when the save fails, the commit's recovery re-reads from disk
    // and (vault.json still absent) zeroizes the store's key, which is this same buffer (review round 2 blocker). The
    // retry must reuse the key the custodian holds, never the zeroed buffer.
    const keep = Buffer.from(created.dek)
    this.dropKey()
    this.dek = created.dek
    try {
      this.commit([{ kind: 'vault', next: vault }])
    } catch (e) {
      // Recovery (an indeterminate save) may have found the new vault on disk and opened it with this key.
      if ((this.vstate as VaultState) !== 'open') {
        this.pendingCreate = {
          scheme,
          ...(req.keyFile !== undefined ? { keyFile: req.keyFile } : {}),
          importKeyFile: req.importKeyFile === true,
          vaultId,
          created: { ...created, dek: keep }
        }
        this.dropKey()
        this.vault = undefined
        this.vstate = 'absent'
      } else zeroize(keep)
      throw new VaultSaveError(e)
    }
    zeroize(keep)
    this.vstate = 'open'
    this.reason = undefined
    this.lastFailure = undefined
    this.createSaveError = undefined
    this.lastRepeatLog = undefined
    this.stopRetryTimer()
    this.log(`created a ${scheme} vault`)
    this.reconcileAfterOpen()
    return 'created'
  }

  /** What prepareWrite has to do before set() may store: create, open, or nothing. */
  private prepareNeed(): 'create' | 'open' | 'none' {
    if (this.readOnly) return 'none'
    if (this.vstate === 'absent') return this.isApp ? 'none' : 'create'
    if (this.vstate === 'locked') return 'open'
    if (this.vstate === 'missing-key' && this.keyFileConfigured()) return 'open'
    return 'none'
  }

  /** Throws the reason set() would refuse a value now; returns when it would store. */
  private writeReadiness(): void {
    if (this.readOnly) throw new Error(READ_ONLY_SECRETS_MESSAGE)
    this.retryRead()
    this.ensureRecovered()
    if (this.vstate === 'corrupt') throw new Error(this.notOpenReason())
    if (this.legacyReadError) throw new Error(this.legacyReadError)
    if (this.vstate === 'open') return
    if (this.isApp) {
      if (this.legacy.state === 'corrupt') throw new Error(this.legacyReadError ?? LEGACY_CORRUPT_MESSAGE)
      if (!this.cipherAvailable()) throw new Error(SECURE_STORAGE_UNAVAILABLE_MESSAGE)
      return
    }
    if (this.vstate === 'absent') throw new Error(this.createSaveError ?? this.lastFailure?.reason ?? VAULT_NOT_OPENED_MESSAGE)
    throw new Error(this.notOpenReason())
  }

  /** One create or open attempt (prepareWrite, retryOpen). Never throws: the outcome is in the store's state. */
  private async custodyStep(need: 'create' | 'open'): Promise<void> {
    if (need === 'create') {
      try {
        await this.createVault()
      } catch (e) {
        this.noteCreateFailure(e)
      }
    } else await this.openExisting()
  }

  /**
   * Single-flight (5.6): create the vault (absent, Node / inproc hosts) or retry opening it (locked; missing-key with a
   * key file) before a handler stores a value. Concurrent callers share one custodian call: a prepare already in flight
   * is waited for and its outcome is this call's too. Any other custody step in flight (open, retry, init, reset) is
   * waited for and the need is checked again, so a reset that left the vault absent or a failed retry never stands in
   * for the attempt this call still needs. Resolves when set() may store; rejects with the reason it may not.
   */
  async prepareWrite(): Promise<void> {
    let attempted = false
    for (;;) {
      // A file that could not be read is read again first (the need below depends on what it holds).
      if (!this.flight) this.retryRead()
      const current = this.flight
      if (current) {
        if (this.flightLabel === 'prepare') attempted = true
        try {
          await current
        } catch {
          // re-evaluated below
        }
        continue
      }
      if (attempted) break
      const need = this.prepareNeed()
      if (need === 'none') break
      attempted = true
      await this.startFlight('prepare', () => this.custodyStep(need))
    }
    this.writeReadiness()
  }

  private startRetryTimer(): void {
    // The placeholder custodian of this build never succeeds: no timer (review round 2: no failed retry every 10 minutes).
    if (!this.isApp || this.retryTimer || this.retryMs <= 0 || isPlaceholderCustodian(this.factory)) return
    this.retryTimer = setInterval(() => this.retryOpen('timer'), this.retryMs)
    this.retryTimer.unref?.()
  }

  private stopRetryTimer(): void {
    if (this.retryTimer) clearInterval(this.retryTimer)
    this.retryTimer = undefined
  }

  /**
   * 5.6 App host retries in the background: create while absent, open while locked (or missing-key with a key file).
   * 'focus' only after a lock failure (locked or timeout), at most once per FOCUS_RETRY_MIN_MS. A no-op when nothing
   * failed, on an open vault, on a corrupt or mismatched one, while another custody step runs, and on other hosts.
   */
  retryOpen(reason: 'focus' | 'timer'): void {
    if (!this.isApp || this.readOnly || this.flight) return
    // A file that could not be read (an I/O error) is read again first; a vault found again is then opened.
    const readFailed = this.hasReadError()
    if (readFailed) {
      this.retryRead()
      if (this.hasReadError()) return
    }
    // A failed save of a new vault (createSaveError, a disk error) is retried by the timer only, with the same key.
    if (!readFailed && !this.lastFailure && this.createSaveError === undefined) return
    const need = this.vstate === 'absent' ? 'create' : this.prepareNeed()
    if (need === 'none') return
    if (reason === 'focus') {
      if (!readFailed && this.lastFailure?.kind !== 'locked' && this.lastFailure?.kind !== 'timeout') return
      const now = this.now()
      if (now - this.lastFocusRetry < FOCUS_RETRY_MIN_MS) return
      this.lastFocusRetry = now
    }
    void this.startFlight('retry', () => this.custodyStep(need)).catch((e: unknown) =>
      this.log(`retry failed: ${e instanceof Error ? e.message : 'error'}`)
    )
  }

  /** Stop the retry timer (host dispose) and drop a kept creation key from memory. Reads keep working. */
  dispose(): void {
    this.stopRetryTimer()
    this.discardPendingCreate()
  }

  /** The key file paths the self-control gate protects (ORGAI_VAULT_KEY_FILE and custody.keyFile), lexical and canonical. */
  vaultKeyFiles(): string[] {
    const paths: string[] = []
    const env = this.envKeyFile()
    if (env) paths.push(env)
    const recorded = this.vault?.custody.keyFile
    if (recorded) paths.push(recorded)
    const out = new Set<string>()
    for (const p of paths) {
      out.add(resolve(p))
      out.add(this.canonical(p))
    }
    return [...out]
  }

  attachLeases(acquire: (label: string) => () => void): void {
    this.acquireLease = acquire
  }

  /**
   * The integration's busy check for secrets:reset (an OAuth flow or a token refresh in flight); the store adds its
   * own custody step in flight.
   */
  setResetBusyCheck(check: () => boolean): void {
    this.resetBusy = check
  }

  // ---------- secrets:* (5.6, 5.7) ----------

  /** Deleted secrets kept for undelete, newest first (key names only). */
  softDeletes(): SecretsSoftDelete[] {
    const v = this.vault
    if (!v) return []
    const now = this.now()
    const out: SecretsSoftDelete[] = []
    for (const [key, t] of Object.entries(v.tombstones)) {
      const expiresAt = t.by === 'vault' && t.prev && t.prevLegacy === undefined ? t.at + VAULT_TOMBSTONE_KEEP_MS : undefined
      const prev = t.prev && (expiresAt === undefined || now <= expiresAt)
      if (!prev && t.prevLegacy === undefined) continue
      const restorable: SecretsSoftDelete['restorable'] = prev ? 'here' : this.isApp ? 'here' : 'app'
      out.push({ key, by: t.by, at: t.at, restorable, ...(expiresAt !== undefined && prev ? { expiresAt } : {}) })
    }
    return out.sort((a, b) => b.at - a.at)
  }

  /** The app notice's list (5.5): soft deletes seen in secrets.json that the user has not decided yet. */
  legacySoftDeletes(): SecretsSoftDelete[] {
    return this.softDeletes().filter((s) => s.by === 'legacy')
  }

  private orphanVaults(): SecretsOrphanVault[] {
    let names: string[]
    try {
      names = this.fs.readdirSync(this.dataDir)
    } catch {
      return []
    }
    const out: SecretsOrphanVault[] = []
    for (const file of names) {
      if (!file.startsWith(`${VAULT_FILE}${VAULT_RESET_SUFFIX}`) && !file.startsWith(`${VAULT_FILE}${VAULT_CORRUPT_SUFFIX}`)) continue
      let text: string
      try {
        text = this.fs.readFileSync(join(this.dataDir, file)).toString('utf8')
      } catch {
        continue
      }
      const v = parseVaultFile(text)
      // A key file is not an OS key item; only keychain / DPAPI / Secret Service items are left behind.
      if (v && v.custody.scheme !== 'key-file') out.push({ vaultId: v.vaultId, scheme: v.custody.scheme, file })
    }
    return out.sort((a, b) => a.file.localeCompare(b.file))
  }

  private pendingLegacyCount(): number {
    if (this.vstate === 'corrupt' || this.isApp) return 0
    let n = 0
    for (const k of Object.keys(this.legacyValues())) if (legacyIsNewer(this.vault, k, this.H(k))) n++
    return n
  }

  private currentScheme(): VaultCustodyScheme | null {
    if (this.vault) return this.vault.custody.scheme
    if (this.vstate === 'corrupt') return null
    return this.newScheme()
  }

  async statusReport(input?: SecretsStatusInput): Promise<SecretsStatusResult> {
    if (!this.flight) this.retryRead()
    const scheme = this.currentScheme()
    let probe: SecretsStatusResult['probe']
    if (input?.probe === true && scheme) {
      try {
        const keyFile = scheme === 'key-file' ? (this.envKeyFile() ?? this.vault?.custody.keyFile) : undefined
        const problem = keyFile ? this.keyFileProblem(keyFile) : undefined
        if (problem) probe = { ok: false, kind: 'denied', reason: problem }
        else {
          const r = await this.factory(scheme, keyFile ? { keyFile } : {}).probe()
          probe = r.ok ? { ok: true } : { ok: false, kind: r.kind, reason: r.reason }
        }
      } catch (e) {
        const f = this.failureOf(e)
        probe = { ok: false, kind: f.kind, reason: f.reason }
      }
    }
    const keyFile = scheme === 'key-file' ? (this.envKeyFile() ?? this.vault?.custody.keyFile) : undefined
    const all = this.keys()
    const unreadable = all.filter((k) => typeof this.status(k) === 'object').length
    const legacyFile: SecretsStatusResult['legacyFile'] = this.legacy.state === 'missing' && this.vault?.legacyRetired ? 'retired' : this.legacy.state
    const state = this.state()
    const notOpen = state !== 'open' && state !== 'absent'
    const readError = this.vaultReadError ?? this.legacyReadError
    return {
      state,
      scheme,
      ...(notOpen ? { reason: this.notOpenReason() } : {}),
      ...(probe ? { probe } : {}),
      ...(keyFile ? { keyFile } : {}),
      ...(this.vault ? { vaultId: this.vault.vaultId } : {}),
      counts: {
        vault: this.vault ? Object.keys(this.vault.entries).length : 0,
        legacy: Object.keys(this.legacyValues()).length,
        unreadable,
        overlay: this.overlay.size
      },
      pendingLegacy: this.pendingLegacyCount(),
      softDeletes: this.softDeletes(),
      orphanedKeys: this.orphaned.size,
      orphanedVaults: this.orphanVaults(),
      legacyFile,
      ...(readError ? { readError } : {}),
      canWriteBack: this.legacyCapable()
    }
  }

  /** The custody recorded in secure storage on disk now, or null while there is no vault (the custodian factory reads it). */
  currentCustody(): VaultCustody | null {
    return this.vault?.custody ?? null
  }

  /** secrets:init: create a vault (absent), or retry opening it; with keyFile the key-file scheme. */
  async initVault(input: SecretsInitInput): Promise<SecretsInitResult> {
    const keyFile = input?.keyFile
    if (keyFile !== undefined && (typeof keyFile !== 'string' || keyFile.trim() === '')) throw new Error('The key file path is empty.')
    if (input?.importKeyFile && keyFile === undefined) throw new Error('--import needs --key-file <path>.')
    if (keyFile !== undefined) {
      const problem = this.keyFileProblem(keyFile)
      if (problem) throw new Error(problem)
    }
    if (this.readOnly) throw new Error(READ_ONLY_SECRETS_MESSAGE)
    const request: CustodianRequest | undefined = keyFile ? { keyFile, ...(input.importKeyFile ? { importKeyFile: true } : {}) } : undefined
    const action = await this.runExclusive('init', async (): Promise<SecretsInitResult['action']> => {
      this.retryRead()
      if (this.vstate === 'corrupt') throw new Error(this.notOpenReason())
      if (this.vault && request && this.vault.custody.scheme !== 'key-file') throw new Error(keyFileSchemeConflict(this.vault.custody.scheme))
      if (this.vstate === 'open') return 'unchanged'
      if (this.vstate === 'absent') {
        try {
          return await this.createVault(request)
        } catch (e) {
          this.noteCreateFailure(e)
          throw new Error(this.createFailureReason(e))
        }
      }
      if (await this.openExisting(request)) return 'opened'
      throw new Error(this.notOpenReason())
    })
    return { action, status: await this.statusReport() }
  }

  /**
   * secrets:reset (every state): refused while a custody step, an OAuth flow or a token refresh runs. A secrets.json
   * that does not parse is moved aside first (`secrets.json.corrupt-<time>`; review round 1: no host of this wave
   * rewrites it, so without this an app in legacy-only mode could never save again). vault.json is moved aside
   * (`vault.json.reset-<time>`, or `.corrupt-<time>`), so the store is absent; an app host then creates a fresh vault and
   * imports secrets.json. The old OS key item stays (statusReport lists it). A move whose directory fsync failed is
   * finished in memory (the file is gone on disk) and then reported as not known to be durable, never as success.
   */
  async resetVault(input: SecretsResetInput): Promise<SecretsResetResult> {
    if (input?.confirm !== true) throw new Error('Reset needs confirm: true.')
    if (this.flight || this.resetBusy?.() === true) throw new Error(VAULT_MESSAGES.resetBusy)
    const moved = await this.startFlight('reset', async (): Promise<{ vault: string | null; legacy: string | null; durable: boolean }> => {
      let durable = true
      let legacy: string | null = null
      // Strict reads: an I/O error refuses the reset (nothing moved), so a healthy file is never moved aside as damaged.
      const strict = <T>(file: string, read: () => T): T => {
        try {
          return read()
        } catch (e) {
          throw new Error(resetReadFailedMessage(file, errorCode(e) ?? 'EIO'))
        }
      }
      const legacyNow = strict(LEGACY_SECRETS_FILE, () => readLegacyFile(this.legacyPath, this.fs, true))
      const onDisk = strict(VAULT_FILE, () => readVaultFile(this.vaultPath, this.fs, true))
      if (legacyNow.state === 'corrupt') {
        const name = this.asideName(LEGACY_SECRETS_FILE, VAULT_CORRUPT_SUFFIX)
        const r = this.moveAside(this.legacyPath, name, () => readLegacyFile(this.legacyPath, this.fs).state !== 'missing', LEGACY_MOVE_FAILED_MESSAGE)
        if (r !== 'gone') legacy = name
        if (r === 'not-durable') durable = false
      }
      let vault: string | null = null
      if (onDisk.kind !== 'absent') {
        const suffix = onDisk.kind === 'corrupt' ? VAULT_CORRUPT_SUFFIX : VAULT_RESET_SUFFIX
        const name = this.asideName(VAULT_FILE, suffix)
        const r = this.moveAside(this.vaultPath, name, () => readVaultFile(this.vaultPath, this.fs).kind !== 'absent', VAULT_MOVE_FAILED_MESSAGE)
        if (r !== 'gone') vault = name
        if (r === 'not-durable') durable = false
      }
      this.dropKey()
      this.vault = undefined
      this.vstate = 'absent'
      this.reason = undefined
      this.lastFailure = undefined
      this.createSaveError = undefined
      this.recoveryRequired = false
      this.stopRetryTimer()
      this.reload()
      if (this.isApp) {
        try {
          await this.createVault()
        } catch (e) {
          this.noteCreateFailure(e)
        }
      }
      return { vault, legacy, durable }
    })
    if (moved.legacy) this.log(`secrets.json moved aside to ${moved.legacy}`)
    if (moved.vault) this.log(`vault.json moved aside to ${moved.vault}`)
    if (!moved.durable) throw new Error(VAULT_MESSAGES.notDurable)
    return { movedTo: moved.vault, ...(moved.legacy ? { legacyMovedTo: moved.legacy } : {}), status: await this.statusReport() }
  }

  /**
   * Rename `path` to `<data>/<name>` durably. 'moved'; 'not-durable' when the rename happened but its directory fsync
   * failed; 'gone' when the file vanished before the rename. Throws `failed` (after a re-read) when it is still there:
   * a rename is atomic, so then it did not happen.
   */
  private moveAside(path: string, name: string, stillThere: () => boolean, failed: string): 'moved' | 'not-durable' | 'gone' {
    try {
      renameDurable(path, join(this.dataDir, name), { fs: this.fs, platform: this.platform })
      return 'moved'
    } catch (e) {
      if (stillThere()) {
        this.reload()
        throw new Error(failed)
      }
      return e instanceof DurableFsError && e.outcome === 'unchanged' ? 'gone' : 'not-durable'
    }
  }

  private asideName(file: string, suffix: string): string {
    const d = new Date(this.now())
    const p = (n: number, w = 2): string => String(n).padStart(w, '0')
    const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${p(d.getUTCMilliseconds(), 3)}Z`
    let name = `${file}${suffix}${stamp}`
    for (let i = 1; this.fs.existsSync(join(this.dataDir, name)); i++) name = `${file}${suffix}${stamp}-${i}`
    return name
  }

  /** secrets:undelete ("Restore"): store the kept value again (a normal write, which removes the tombstone). */
  undelete(input: SecretsUndeleteInput): SecretsUndeleteResult {
    const key = input?.key
    if (!validSecretKey(key)) return { restored: false, reason: NOTHING_TO_RESTORE_MESSAGE }
    this.retryRead()
    const v = this.vault
    if (this.vstate === 'corrupt') return { restored: false, reason: this.notOpenReason() }
    const t = v && Object.hasOwn(v.tombstones, key) ? v.tombstones[key] : undefined
    const kept = t ? this.softDeletes().find((s) => s.key === key) : undefined
    if (!v || !t || !kept) return { restored: false, reason: NOTHING_TO_RESTORE_MESSAGE }
    if (!t.prev && !this.isApp) return { restored: false, reason: VAULT_MESSAGES.undeleteAppOnly }
    if (this.vstate !== 'open' || !this.dek) return { restored: false, reason: this.notOpenReason() }
    let plain: string
    if (t.prev) {
      try {
        plain = decryptEntry(this.dek, v.vaultId, key, t.prev)
      } catch {
        return { restored: false, reason: VAULT_MESSAGES.unreadableEntry }
      }
    } else {
      try {
        plain = this.legacyDecrypt(t.prevLegacy as string)
      } catch {
        return { restored: false, reason: UNDECRYPTABLE_REASON }
      }
    }
    this.set(key, plain)
    return { restored: true }
  }

  /** secrets:confirmDelete ("Keep removed"): drop the kept values of the named soft deletes (metadata only). */
  confirmDeletes(input: SecretsConfirmDeleteInput): SecretsConfirmDeleteResult {
    const keys = Array.isArray(input?.keys) ? input.keys.filter(validSecretKey) : []
    this.retryRead()
    const v = this.vault
    // While a file cannot be read nothing is confirmed: a tombstone dropped now could let its legacy copy come back.
    if (!v || this.vstate === 'corrupt' || this.vstate === 'absent' || this.hasReadError() || !keys.length) return { confirmed: [] }
    this.ensureRecovered()
    const live = this.vault as VaultFile
    const next = cloneVault(live)
    const confirmed: string[] = []
    for (const k of keys) {
      if (confirmed.includes(k)) continue
      const t = Object.hasOwn(next.tombstones, k) ? next.tombstones[k] : undefined
      if (!t || (!t.prev && t.prevLegacy === undefined)) continue
      delete t.prev
      delete t.prevLegacy
      // A tombstone rows 1 and 2 still need (its legacy copy or baseline remains) keeps its metadata.
      if (this.L(k) === undefined && baselineOf(next, k) === undefined) delete next.tombstones[k]
      confirmed.push(k)
    }
    if (confirmed.length) this.commit([{ kind: 'vault', next }])
    return { confirmed }
  }
}

/** Focus retries (5.6) at most this often, so a cancelled unlock prompt is not shown again on every focus. */
export const FOCUS_RETRY_MIN_MS = 30_000

/** openSecretStore's inputs (cli-standalone.md 5.6). */
export interface OpenSecretStoreOptions {
  /** `<userDataDir>/data`. */
  dataDir: string
  /** `<userDataDir>`: a key file anywhere inside it is refused (5.3.1). */
  userDataDir: string
  /** Decides the reconcile column (5.5 "can write back": an app host whose cipher works) and lazy creation (Node, inproc). */
  hostKind: HostKind
  /** Electron safeStorage in the app; NO_CIPHER in Node hosts. */
  cipher: SecretCipher
  /**
   * The custodian of a scheme. Default: the real ones (src/main/store/custodians: keychain, DPAPI, Secret Service, key
   * file) for this platform and `env`. Tests inject fakes; a host that must not touch an OS key store passes
   * unavailableCustodianFactory (an app host then stays in legacy-only mode).
   */
  custodian?: CustodianFactory
  /** The CLI's ORGAI_SECRET_* / --secret-env values (inproc only); they win over stored values and are never saved. */
  overlay?: ReadonlyMap<string, string>
  /** ORGAI_VAULT_KEY_FILE is read from here. Default process.env. */
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  log?: (m: string) => void
  /** Deprecated: a store that never writes. No host passes it since Node hosts write the vault. */
  readOnly?: boolean
  /** Tests: the file system, the clock, the switches, the retry period. */
  fs?: VaultFs
  now?: () => number
  vaultFlags?: VaultFlags
  retryMs?: number
}

/**
 * The async open step every host runs after acquireHostOwnership and before bootOrgAIHost (5.6): open an existing vault
 * (decrypting `check`) and reconcile with secrets.json, create one at once on an app host (legacy-only mode with
 * background retries when that fails), and hand the store to BootOrgAIHostOptions.secretStore. Never rejects for a
 * custodian failure: the store reports it through state() / statusReport().
 */
export async function openSecretStore(opts: OpenSecretStoreOptions): Promise<SecretStore> {
  // The factory reads the custody of the vault on disk at every call, so one built before the vault exists (or after a
  // reset) never probes a stale key-file path. `store` is assigned right below, before any call.
  let store: SecretStore | undefined
  const real = createCustodianFactory({
    dataDir: opts.dataDir,
    userDataDir: opts.userDataDir,
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.platform ? { platform: opts.platform } : {}),
    currentCustody: () => store?.currentCustody() ?? null
  })
  // The unit test runner sets NO_OS_KEYSTORE_ENV (vitest.config.ts): a test that forgets to inject a custodian must not
  // write a real keychain / DPAPI / Secret Service item, so the default OS schemes answer 'unavailable'. Key files work.
  const custodian: CustodianFactory =
    opts.custodian ??
    ((scheme, request) => (scheme !== 'key-file' && process.env[NO_OS_KEYSTORE_ENV] === '1' ? unavailableCustodian(scheme) : real(scheme, request)))
  store = new SecretStore(opts.dataDir, opts.cipher, {
    hostKind: opts.hostKind,
    userDataDir: opts.userDataDir,
    custodian,
    ...(opts.overlay ? { overlay: opts.overlay } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.platform ? { platform: opts.platform } : {}),
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.readOnly ? { readOnly: true } : {}),
    ...(opts.fs ? { fs: opts.fs } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.vaultFlags ? { vaultFlags: opts.vaultFlags } : {}),
    ...(opts.retryMs !== undefined ? { retryMs: opts.retryMs } : {})
  })
  await store.openVault()
  return store
}
