import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  HostKind,
  McpSecretKind,
  SecretStatus,
  SecretsConfirmDeleteInput,
  SecretsConfirmDeleteResult,
  SecretsInitInput,
  SecretsInitResult,
  SecretsResetInput,
  SecretsResetResult,
  SecretsStatusInput,
  SecretsStatusResult,
  SecretsUndeleteInput,
  SecretsUndeleteResult,
  VaultState
} from '@shared/types'
import type { CustodianFactory, SecretStoreApi } from './vaultTypes'

/**
 * Encrypted secrets (the LiteLLM key, MCP server env vars and headers). Values are encrypted with Electron
 * safeStorage (DPAPI on Windows, Keychain on macOS, libsecret on Linux) and kept in secrets.json in the data
 * dir, never in settings.json or projects.json. Values never cross IPC and are never logged; callers ask
 * only for has-flags unless they are about to hand the value to a child process.
 */

/** The part of Electron's safeStorage this store uses; tests pass a fake. */
export interface SecretCipher {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** Key of the LiteLLM proxy key. */
export const LITELLM_KEY = 'connection:litellm:apiKey'

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

/**
 * Optional SecretStore behaviour for the pure-Node `--host inproc` host (cli-spec 3.5). Without options the store is
 * the desktop / headless host's read-write store, unchanged.
 */
export interface SecretStoreOptions {
  /**
   * Never write secrets.json: available() is false, set() with a value throws, and delete / deletePrefix / set(null)
   * only drop overlay entries (a value on disk stays readable). Stored values are still read (and decrypted, when the
   * cipher can).
   */
  readOnly?: boolean
  /**
   * Plain values kept in memory only (the CLI's ORGAI_SECRET_* / --secret-env secrets); they win over disk values in
   * get / has / keys and are never persisted. The map is copied at construction.
   */
  overlay?: ReadonlyMap<string, string>
}

/** set() refusal of a read-only store. */
export const READ_ONLY_SECRETS_MESSAGE = 'This OrgAI host runs inside the CLI (--host inproc) and cannot save secrets.'

/** What the Wave 7 vault channels answer until the vault lands (cli-standalone.md 5.6; WP-G). */
export const VAULT_NOT_AVAILABLE_MESSAGE = 'The secret vault is not available in this build yet.'

/** Reason status() gives for a stored value this host cannot decrypt (until WP-G's vault reasons replace it). */
const UNDECRYPTABLE_REASON = 'Saved by the OrgAI app and cannot be read here'

export class SecretStore implements SecretStoreApi {
  private file: string
  /** key -> base64 ciphertext */
  private values: Record<string, string> = {}
  private readonly readOnly: boolean
  /** key -> plain value, memory only. */
  private readonly overlay = new Map<string, string>()

  constructor(
    dataDir: string,
    private cipher: SecretCipher,
    opts: SecretStoreOptions = {}
  ) {
    this.file = join(dataDir, 'secrets.json')
    this.readOnly = opts.readOnly === true
    for (const [k, v] of opts.overlay ?? []) if (typeof k === 'string' && typeof v === 'string' && v !== '') this.overlay.set(k, v)
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { secrets?: unknown }
      const raw = parsed.secrets
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string') this.values[k] = v
      }
    } catch (e) {
      // Never print the file: it holds ciphertext only, but there is nothing useful in it for a log either.
      console.error('Failed to read secrets.json, starting empty:', (e as Error).message)
      this.values = {}
    }
  }

  private persist(): void {
    if (this.readOnly) return
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, secrets: this.values }, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.file)
  }

  /** False when the OS offers no encryption (e.g. Linux without a keyring); set() then throws. */
  available(): boolean {
    if (this.readOnly) return false
    try {
      return this.cipher.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  has(key: string): boolean {
    return this.overlay.has(key) || Object.hasOwn(this.values, key)
  }

  /** The decrypted value, or undefined when none is stored or it cannot be decrypted (another user, a new OS keyring). */
  get(key: string): string | undefined {
    const o = this.overlay.get(key)
    if (o !== undefined) return o
    if (!Object.hasOwn(this.values, key)) return undefined
    const v = this.values[key]
    if (v === undefined) return undefined
    try {
      return this.cipher.decryptString(Buffer.from(v, 'base64'))
    } catch {
      return undefined
    }
  }

  /** Store a value, or delete it with null or ''. Throws when encryption is unavailable (never stores plain text). */
  set(key: string, value: string | null): void {
    if (value === null || value === '') {
      this.delete(key)
      return
    }
    if (this.readOnly) throw new Error(READ_ONLY_SECRETS_MESSAGE)
    if (!this.available()) throw new Error('Secure storage is not available on this system, so OrgAI cannot store secrets.')
    this.values[key] = this.cipher.encryptString(value).toString('base64')
    // The stored value is the newest; an overlay value must not shadow it.
    this.overlay.delete(key)
    this.persist()
  }

  /** Delete a value (read-only store: the overlay entry only). */
  delete(key: string): void {
    this.overlay.delete(key)
    if (this.readOnly || !Object.hasOwn(this.values, key)) return
    delete this.values[key]
    this.persist()
  }

  /** Keys (stored and overlay) starting with a prefix. */
  keys(prefix = ''): string[] {
    const out = new Set<string>()
    for (const k of this.overlay.keys()) if (k.startsWith(prefix)) out.add(k)
    for (const k of Object.keys(this.values)) if (k.startsWith(prefix)) out.add(k)
    return [...out]
  }

  /** Delete every key starting with a prefix (read-only store: overlay entries only); returns how many were removed. */
  deletePrefix(prefix: string): number {
    const removed = new Set<string>()
    for (const k of [...this.overlay.keys()]) {
      if (!k.startsWith(prefix)) continue
      this.overlay.delete(k)
      removed.add(k)
    }
    if (this.readOnly) return removed.size
    const doomed = Object.keys(this.values).filter((k) => k.startsWith(prefix))
    if (!doomed.length) return removed.size
    for (const k of doomed) {
      delete this.values[k]
      removed.add(k)
    }
    this.persist()
    return removed.size
  }

  // ---------- Wave 7 (cli-standalone.md 5.4, 5.6): minimal stubs until the vault lands (WP-G) ----------

  /** 'set' when readable here, unreadable when stored but not decryptable, else 'unset'. */
  status(key: string): SecretStatus {
    if (!this.has(key)) return 'unset'
    return this.get(key) !== undefined ? 'set' : { unreadable: UNDECRYPTABLE_REASON }
  }

  /** No vault yet: always 'absent'. */
  state(): VaultState {
    return 'absent'
  }

  /** No vault yet, so nothing to refuse: a clear behaves as before (WP-G returns the 5.5 refusals). */
  clearRefusal(key: string): string | undefined {
    void key
    return undefined
  }

  /** Nothing to prepare before the vault exists: set() behaves as before. */
  prepareWrite(): Promise<void> {
    return Promise.resolve()
  }

  /** No vault, so no key file. */
  vaultKeyFiles(): string[] {
    return []
  }

  /** No background vault work yet. */
  attachLeases(acquire: (label: string) => () => void): void {
    // Nothing runs in the background before the vault lands (WP-G).
    void acquire
  }

  /** No vault to create or open yet: a no-op. */
  retryOpen(reason: 'focus' | 'timer'): void {
    void reason
  }

  /** secrets:status of a host without a vault: the legacy file and the overlay only. */
  statusReport(input?: SecretsStatusInput): Promise<SecretsStatusResult> {
    // No custodian to probe before the vault lands (WP-G).
    void input
    const stored = Object.keys(this.values)
    let legacyFile: SecretsStatusResult['legacyFile'] = 'missing'
    try {
      if (existsSync(this.file)) legacyFile = 'ok'
    } catch {
      legacyFile = 'missing'
    }
    const unreadable = this.keys().filter((k) => typeof this.status(k) === 'object').length
    return Promise.resolve({
      state: 'absent',
      scheme: null,
      counts: { vault: 0, legacy: stored.length, unreadable, overlay: this.overlay.size },
      pendingLegacy: 0,
      softDeletes: [],
      orphanedKeys: 0,
      orphanedVaults: [],
      legacyFile,
      canWriteBack: this.available()
    })
  }

  initVault(input: SecretsInitInput): Promise<SecretsInitResult> {
    void input
    return Promise.reject(new Error(VAULT_NOT_AVAILABLE_MESSAGE))
  }

  resetVault(input: SecretsResetInput): Promise<SecretsResetResult> {
    void input
    return Promise.reject(new Error(VAULT_NOT_AVAILABLE_MESSAGE))
  }

  undelete(input: SecretsUndeleteInput): SecretsUndeleteResult {
    void input
    throw new Error(VAULT_NOT_AVAILABLE_MESSAGE)
  }

  confirmDeletes(input: SecretsConfirmDeleteInput): SecretsConfirmDeleteResult {
    void input
    throw new Error(VAULT_NOT_AVAILABLE_MESSAGE)
  }
}

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
  /** The custodian of a scheme (default: the platform's helpers, WP-G); tests inject fakes. */
  custodian?: CustodianFactory
  /** The CLI's ORGAI_SECRET_* / --secret-env values (inproc only); they win over stored values and are never saved. */
  overlay?: ReadonlyMap<string, string>
  /** ORGAI_VAULT_KEY_FILE is read from here. Default process.env. */
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  log?: (m: string) => void
  /** Today's `--host inproc` store (never writes). WP-G drops it once Node hosts write the vault. */
  readOnly?: boolean
}

/**
 * The async open step every host runs after acquireHostOwnership and before bootOrgAIHost (5.6): open an existing vault
 * (decrypting `check`), reconcile with secrets.json, create one at once on an app host, and only then hand the store to
 * BootOrgAIHostOptions.secretStore. Already called by every host entry (src/main/index.ts for desktop and
 * --headless-host, src/cli/inprocHost.ts for inproc and node), so WP-G changes only this file and its custodians.
 * Today (contracts only) it returns the existing store unchanged.
 */
export async function openSecretStore(opts: OpenSecretStoreOptions): Promise<SecretStore> {
  return new SecretStore(opts.dataDir, opts.cipher, {
    ...(opts.readOnly ? { readOnly: true } : {}),
    ...(opts.overlay ? { overlay: opts.overlay } : {})
  })
}
