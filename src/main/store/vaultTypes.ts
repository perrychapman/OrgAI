/**
 * Wave 7 (standalone CLI) contracts: the secret vault's file format, the key custodians and the SecretStore API that
 * every host kind sees (docs/design/cli-standalone.md sections 5.2-5.7). Types, constants and tiny pure helpers only:
 * no file I/O, no child process, no Electron. Relative imports only.
 *
 * CONTRACTS (Wave 7). Every new export of the contracts commit, its file, and the work package that implements it:
 *
 * | Export | File | Owner |
 * | --- | --- | --- |
 * | HostKind 'node', HostClientKind 'desktop', HOST_KINDS, HOST_CLIENT_KINDS | src/shared/types.ts | B (launcher, waits), E (node host), F (desktop hello) |
 * | BACKGROUND_HOST_KINDS | src/shared/types.ts | B (ensureHost, daemon start waits) |
 * | HostKindCapabilities, HOST_KIND_CAPABILITIES, hostCanOpenWindows | src/shared/types.ts | done (registry gate); E uses inProcess |
 * | InstallChannel, INSTALL_CHANNELS, INSTALL_INFO_FILE, InstallInfo | src/shared/types.ts | A (builders write it; --version, doctor) |
 * | readInstallInfo | src/cli/installInfo.ts | done (reader); A (writers), B (launcher uses it) |
 * | HostStopInput.handoff, HostStopResult.handoffBlockers, HostStatusResult.handoff, HostHandoffFacts, HostHandoffBlocker, HOST_HANDOFF_BLOCKERS | src/shared/types.ts | F |
 * | RpcHelloResult.handoff, HOST_HANDOFF_METHODS, HOST_HANDOFF_SCOPES, DESKTOP_HELLO_PEER_CHECK_MS | src/shared/types.ts | F |
 * | HostProofFields.handoff (bound only when true), parseHelloResult keeps handoff | src/main/host/protocol.ts, src/cli/client/hostClient.ts | done; F sets it in socketServer.ts |
 * | CliShimStatus.otherCli | src/shared/types.ts | A (PATH lookup in shimInstaller), app Terminal row |
 * | helloProblem accepts clientKind 'desktop'; DESKTOP_HANDOFF_UNAVAILABLE_MESSAGE refuses it after the proof | src/main/host/socketServer.ts | F (replace the refusal with the handoff grant) |
 * | VaultState, VAULT_STATES, VaultCustodyScheme, VAULT_CUSTODY_SCHEMES, CustodyFailureKind, SecretStatus, LegacySecretsFileState | src/shared/types.ts | G |
 * | SecretsStatusResult, SecretsSoftDelete, SecretsOrphanVault, SecretsInit/Reset/Undelete/ConfirmDelete Input and Result | src/shared/types.ts | G (store side), H (channels, CLI), app notice "Restore / Keep removed" (H) |
 * | SECRETS_IPC (secrets:status / init / reset / undelete / confirmDelete), SecretsIpcChannel | src/shared/types.ts | H (handlers are stubs) |
 * | VaultFile and its parts, VAULT_* constants, vaultEntryAad, vaultCheckAad, dpapiEntropy, vaultStateForFailure, VAULT_MESSAGES | this file | G |
 * | KeyCustodian, CustodyFailure, CustodyError, isCustodyFailure, CustodianProbe, CustodianCreated, CustodianFactory, CustodianRequest | this file | G (custodians), D (gate rules for their tools); WP-G1 added CustodianRequest (key-file path, --import) and CustodianCreated.keyFile |
 * | VaultNotReady | this file | G (set() on an absent vault in a Node / inproc host) |
 * | SecretStoreApi (status, state, clear, clearRefusal, prepareWrite, vaultKeyFiles, attachLeases, retryOpen, statusReport, initVault, resetVault, undelete, confirmDeletes) | this file; SecretStore implements it in secrets.ts (WP-G1: vaultFile.ts, vaultCrypto.ts, reconcile.ts, durableFs.ts; extras setResetBusyCheck, softDeletes, legacySoftDeletes, dispose) | done (store, WP-G1); H (callers: clearRefusal then clear() in explicit-clear handlers, delete / deletePrefix only in removals, setResetBusyCheck for OAuth / refresh); retryOpen('focus') wired in index.ts |
 * | VaultMetadata | this file | G |
 * | readVaultMetadata | src/main/store/vaultMetadata.ts (the store's own validator, vaultFile.ts validateVaultFile) | done (WP-G1); H (doctor without a host) |
 * | McpService.refreshingCount | src/main/mcp/service.ts | done; H (secrets:reset busy check) |
 * | OpenSecretStoreOptions, openSecretStore | src/main/store/secrets.ts (opens, reconciles, creates on app hosts) | done (WP-G1): called by every host entry after acquireHostOwnership and before bootOrgAIHost (index.ts desktop and --headless-host with safeStorage, inprocHost.ts inproc and node with NO_CIPHER, no longer readOnly); custodian factory defaults to the real custodians (store/custodians createCustodianFactory; wired at the Wave 7 integration); unavailableCustodian.ts is for hosts that must not touch an OS key store (a mock desktop launch) and for tests |
 * | BootOrgAIHostOptions.secretStore, HostBackgroundOptions / BootOrgAIHostOptions.background | src/main/host/bootstrap.ts | G (secretStore), B (background split) |
 * | HostServices.secrets (bootstrap passes the store; secrets.attachLeases gets backgroundTasks leases) | src/main/host/types.ts, bootstrap.ts | H |
 * | secrets:* dispatcher handlers (status answers statusReport, the rest refuse 'not available in this build yet') | src/main/host/dispatcher.ts registerSecretsIpc | H |
 * | HostStopInput.handoff passed through by the host.stop handler | src/main/host/dispatcher.ts | F (predicate in activity.ts) |
 * | RequestChannelEntry.storesSecret, StoresSecretFn, StoresSecretHostView, STORES_SECRET (stub predicates) | src/main/host/registry.ts, src/main/host/storesSecret.ts | H (predicates only) |
 * | invokeRpc awaits secrets.prepareWrite() when the entry's storesSecret is true (inside the mutation lease) | src/main/host/dispatcher.ts | done |
 * | ControlProtectedExtras, controlProtectedPaths(..., { vaultKeyFiles }) | src/main/runtime/selfControlGate.ts (bootstrap passes secrets.vaultKeyFiles()) | done (exact files); D (basename, glob, word and tool rules) |
 * | trackChildProcess, killTrackedChildren, trackedChildCount, shutdown constants and ShutdownCoordinatorApi | src/main/host/shutdown.ts | F (coordinator, kill at the hard limit); G and C register their children |
 * | claudeExecutable, ClaudeExecutableResolution, claudeRuntimeMissingMessage | src/main/runtime/claudeBinary.ts (stub) | C |
 * | StartInprocHostOptions.hostKind / background | src/cli/inprocHost.ts | E (node), B (background flags) |
 * | HostLauncherResolution, HostLauncherFound, HostLauncher.locate, resolve() source 'installed' and `path` on errors, spawn({ app }), DaemonRuntime, HOST_STARTING_WAIT_MS | src/cli/types.ts (locate maps resolve()) | B (discovery), E (--runtime) |
 * | `secrets` and `terminal-access` command entries (available: false) and routes | src/cli/entries, src/cli/commands/secrets.ts, terminalAccess.ts | H (secrets), E (terminal-access) |
 * | DoctorGroupInput, DoctorCheckGroup; installChecks, runtimeChecks, secretsChecks (return [] today, called by runDoctor) | src/cli/doctor/*.ts | A, C, H |
 *
 * Retirement of secrets.json (5.5) ships behind VAULT_RETIREMENT_ENABLED = false; the dual-write window (D6) is
 * VAULT_DUAL_WRITE = true for this release and the next.
 */
import type {
  CustodyFailureKind,
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
  VaultCustodyScheme,
  VaultState
} from '../../shared/types'

export type { CustodyFailureKind, SecretStatus, VaultCustodyScheme, VaultState } from '../../shared/types'

// ---------- Format (5.2) ----------

/** vault.json `format`. */
export const VAULT_FORMAT = 'orgai.vault/1'
/** `<data>/vault.json`. */
export const VAULT_FILE = 'vault.json'
/** `<data>/secrets.json`, the app's safeStorage file (never given a new shape). */
export const LEGACY_SECRETS_FILE = 'secrets.json'
/** The plaintext of the check record, encrypted at creation. */
export const VAULT_CHECK_PLAINTEXT = 'orgai-vault-check'
/** AES-256-GCM: a fresh 96-bit IV per write, a 128-bit tag, a 256-bit data key; vaultId is 16 random bytes in hex. */
export const VAULT_IV_BYTES = 12
export const VAULT_TAG_BYTES = 16
export const VAULT_DEK_BYTES = 32
export const VAULT_ID_BYTES = 16
/** How long a `by: 'vault'` tombstone keeps its value for `secrets undelete` (30 days). 'legacy' ones never expire. */
export const VAULT_TOMBSTONE_KEEP_MS = 30 * 24 * 60 * 60 * 1000
/** Every custodian helper's timeout (5.3). */
export const CUSTODIAN_TIMEOUT_MS = 10_000
/** How often an app host in legacy-only mode retries creating or opening the vault (5.6). */
export const VAULT_RETRY_MS = 10 * 60_000
/** D6: hosts that can write back keep secrets.json in step this release and the next. */
export const VAULT_DUAL_WRITE = true
/** 5.5 Retirement (deleting secrets.json) is built but stays off this release. */
export const VAULT_RETIREMENT_ENABLED = false
/** The environment variable naming a key file (5.3); scrubbed from every child (childEnv ORGAI_VAULT_ pattern, WP-C). */
export const VAULT_KEY_FILE_ENV = 'ORGAI_VAULT_KEY_FILE'
/** macOS keychain item service name (`security ... -s "OrgAI Vault" -a <vaultId>`). */
export const KEYCHAIN_SERVICE = 'OrgAI Vault'
/** Linux Secret Service attributes: `service orgai vault <vaultId>`; label "OrgAI vault". */
export const SECRET_SERVICE_ATTRIBUTE = 'orgai'
export const SECRET_SERVICE_LABEL = 'OrgAI vault'
/** Prefix of a moved-aside vault (`vault.json.reset-<time>`, `vault.json.corrupt-<time>`). */
export const VAULT_RESET_SUFFIX = '.reset-'
export const VAULT_CORRUPT_SUFFIX = '.corrupt-'

/** One AES-256-GCM ciphertext, every field base64 (iv 12 bytes, tag 16 bytes). */
export interface VaultCipherText {
  iv: string
  ct: string
  tag: string
}

/** One stored secret. `lc` ("legacy current"): secrets.json holds the same value. */
export interface VaultEntry extends VaultCipherText {
  /** Epoch ms of the write. */
  at: number
  lc: boolean
}

/**
 * A deleted key (5.2 tombstones, 5.5 Deletes). `by: 'vault'`: a delete made through this wave (`prev` kept
 * VAULT_TOMBSTONE_KEEP_MS). `by: 'legacy'`: a disappearance seen in secrets.json, kept until the user confirms or
 * restores it. At most one of `prev` / `prevLegacy` is kept: the newest value.
 */
export interface VaultTombstone {
  at: number
  by: 'vault' | 'legacy'
  /** The vault ciphertext kept for undelete. */
  prev?: VaultCipherText
  /** A secrets.json value string a Node host deleted without being able to decrypt it; only the app restores it. */
  prevLegacy?: string
  /**
   * sha256 hex of the secrets.json value string this delete targeted (rows 1 and 4 of 5.5). Kept only until the delete
   * is finished (delete step 3, or reconcile rows 1 and 2): safeStorage is deterministic on macOS and Linux, so a later
   * save of the same value has the same hash and must not read as this delete's target (WP-G1 review round 1).
   */
  legacyHash?: string
}

/** Where the data key lives (5.3). `wrapped` only for dpapi-user, `keyFile` (canonical path at init) only for key-file. */
export interface VaultCustody {
  scheme: VaultCustodyScheme
  wrapped?: string
  keyFile?: string
}

/** Set once secrets.json was retired (5.5 Retirement; off this release). */
export interface VaultLegacyRetired {
  at: number
  /** sha256 hex of the exact retired secrets.json bytes. */
  digest: string
  /** key -> sha256 hex of its value string at retirement (updated by later imports). */
  keys: Record<string, string>
}

/** `<data>/vault.json`. Validation on load: anything off this shape is 'corrupt'. */
export interface VaultFile {
  format: typeof VAULT_FORMAT
  /** 16 random bytes, hex. */
  vaultId: string
  custody: VaultCustody
  /** VAULT_CHECK_PLAINTEXT encrypted with vaultCheckAad. */
  check: VaultCipherText
  entries: Record<string, VaultEntry>
  tombstones: Record<string, VaultTombstone>
  /** key -> sha256 hex of the secrets.json value string at the last reconcile (the baseline B of 5.5). */
  legacy: Record<string, string>
  legacyRetired: VaultLegacyRetired | null
}

/** AAD of an entry: `orgai.vault/1\0<vaultId>\0<key>`. */
export function vaultEntryAad(vaultId: string, key: string): string {
  return `${VAULT_FORMAT}\u0000${vaultId}\u0000${key}`
}

/** AAD of the check record: `orgai.vault/1\0<vaultId>\0\0check` (no key can produce it: keys never start with NUL). */
export function vaultCheckAad(vaultId: string): string {
  return `${VAULT_FORMAT}\u0000${vaultId}\u0000\u0000check`
}

/** DPAPI entropy (UTF-8): `orgai.vault/1:<vaultId>`. */
export function dpapiEntropy(vaultId: string): string {
  return `${VAULT_FORMAT}:${vaultId}`
}

// ---------- Custody (5.3) ----------

/** A custodian's classified failure; stderr is reduced to this, never logged raw. */
export interface CustodyFailure {
  kind: CustodyFailureKind
  /** A sentence to show the user (e.g. how to unlock the keychain over SSH). */
  reason: string
}

/** What KeyCustodian.open throws (and create, on failure). */
export class CustodyError extends Error implements CustodyFailure {
  constructor(
    readonly kind: CustodyFailureKind,
    readonly reason: string
  ) {
    super(reason)
    this.name = 'CustodyError'
  }
}

/** True for a CustodyError or any object with a known `kind` and a string `reason`. */
export function isCustodyFailure(v: unknown): v is CustodyFailure {
  if (!v || typeof v !== 'object') return false
  const { kind, reason } = v as { kind?: unknown; reason?: unknown }
  return typeof reason === 'string' && (kind === 'unavailable' || kind === 'locked' || kind === 'missing' || kind === 'denied' || kind === 'timeout')
}

export type CustodianProbe = { ok: true } | ({ ok: false } & CustodyFailure)

export interface CustodianCreated {
  /** The new data key (VAULT_DEK_BYTES). Never logged, never sent anywhere but the custodian's stdin. */
  dek: Buffer
  /** dpapi-user: the protected blob for custody.wrapped. */
  wrapped?: string
  /**
   * key-file: the canonical path of the key file in use (5.3.1), for custody.keyFile. The store records this value
   * as it is, never a spelling of its own, so the self-control gate protects the same path.
   */
  keyFile?: string
}

/**
 * What the store asks a custodian for beyond the scheme (WP-G1 addition, optional so a one-argument factory still
 * fits). Only the key-file scheme reads it: the path `secrets init --key-file` named (or ORGAI_VAULT_KEY_FILE), and
 * `--import` (take an existing file instead of creating one). At open the store also passes the same path as
 * custody.keyFile (ORGAI_VAULT_KEY_FILE overrides the recorded one, 5.3.1).
 */
export interface CustodianRequest {
  keyFile?: string
  importKeyFile?: boolean
}

/**
 * Holds one vault's data key (5.3). Helpers run as child processes (D3): absolute executable, no shell, cwd
 * os.tmpdir(), values on stdin / stdout only, CUSTODIAN_TIMEOUT_MS, a per-scheme environment allowlist, and they are
 * registered with src/main/host/shutdown.ts trackChildProcess.
 */
export interface KeyCustodian {
  readonly scheme: VaultCustodyScheme
  /** Can a key be created and read now? */
  probe(): Promise<CustodianProbe>
  /** Creates the key for a new vault. Refuses (throws CustodyError) when an item for vaultId already exists. */
  create(vaultId: string): Promise<CustodianCreated>
  /** Reads the key of an existing vault. Throws CustodyError. */
  open(vaultId: string, custody: VaultCustody): Promise<Buffer>
}

/** The custodian of a scheme on this platform (tests inject fakes). `request` carries the key-file path (WP-G1). */
export type CustodianFactory = (scheme: VaultCustodyScheme, request?: CustodianRequest) => KeyCustodian

/** The vault state a custodian failure leads to (5.4): locked for unavailable / locked / timeout, else missing-key. */
export function vaultStateForFailure(kind: CustodyFailureKind): Extract<VaultState, 'locked' | 'missing-key'> {
  return kind === 'missing' || kind === 'denied' ? 'missing-key' : 'locked'
}

/** The fixed sentences of 5.4 - 5.6, shared by the store (G), the services that show status (H) and the CLI (H). */
export const VAULT_MESSAGES = {
  pendingLegacy: 'Saved by the OrgAI app and not yet shared with the orgai command: open the app once',
  locked: (reason: string): string => `Secure storage is locked: ${reason}`,
  missingKey: "The key for this secure storage is not available for this user on this computer. Sign in to the account that created it or restore its key file. `orgai secrets reset` starts over",
  keyMismatch: 'The key does not match this secure storage, or it is damaged. Restore the matching key file. `orgai secrets reset` starts over',
  corrupt: "Secure storage is damaged. Run `orgai secrets reset` to start over from the OrgAI app's older copies (App settings > General > Advanced > Terminal installs the orgai command)",
  unreadableEntry: 'This saved secret is damaged and cannot be read',
  notDurable: 'The secret may or may not have been saved. Set it again to be sure (`orgai secrets status` shows the state)',
  clearRefusedCorrupt: 'Secure storage is damaged. Reset it first with `orgai secrets reset` (App settings > General > Advanced > Terminal installs the orgai command)',
  clearRefusedLegacyOnly: 'Saved by the OrgAI app: open the app once, or run `orgai secrets init` first',
  undeleteAppOnly: 'This deleted secret was saved by the OrgAI app. Open the app to restore it',
  resetBusy: 'A sign-in or save is in progress. Try again when it ends',
  resetWarning: "Secrets saved only through the orgai command are lost. The OrgAI app's older copies, which may be outdated, are used instead.",
  legacyRemovedNotice: (n: number): string => `${n} saved secret${n === 1 ? ' was' : 's were'} removed by an older version of OrgAI.`,
  moveRefused: (slot: string, server: string, reason: string): string =>
    `${slot} of ${server} cannot be read here (${reason}). Open the OrgAI app once, or unlock secure storage (\`orgai secrets status\` shows how) and try again.`
} as const

/** set() with a value on an 'absent' vault in a Node or inproc host: prepareWrite() was not awaited first (a bug trap, 5.6). */
export class VaultNotReady extends Error {
  constructor(key?: string) {
    super(`Secure storage is not ready${key ? ` for ${key}` : ''}; prepareWrite() must run before set().`)
    this.name = 'VaultNotReady'
  }
}

// ---------- The store every host sees (5.4, 5.6) ----------

/**
 * SecretStore's public API (src/main/store/secrets.ts implements it). The first block is today's synchronous API,
 * unchanged for its callers (R6); the second block is Wave 7.
 */
export interface SecretStoreApi {
  /** False when nothing can be stored here (no cipher, a read-only store, or a vault that is not writable). */
  available(): boolean
  /** A value exists somewhere (vault, secrets.json or the overlay), readable or not. */
  has(key: string): boolean
  /** The plain value, or undefined when unset or unreadable (status() says which). */
  get(key: string): string | undefined
  /**
   * Store a value, or clear it with null or '' (the same as clear(key)). Throws when the value cannot be stored, or the
   * clear is refused or its save failed (see clear()).
   */
  set(key: string, value: string | null): void
  /**
   * A removal's delete (a project, server or library entry removed, linkLibrary, a kit replace; 5.5 Deletes): never
   * throws in any vault state, so a removal that already changed other stores is never left half done. A key it cannot
   * handle (vault 'corrupt' or unreadable, a Node host with an 'absent' vault and a legacy-only key, a failed save) is
   * left in place, logged and counted in SecretsStatusResult.orphanedKeys. Not for explicit clears: use clear().
   */
  delete(key: string): void
  keys(prefix?: string): string[]
  /** A removal of every key under a prefix: never throws, as delete(). Returns how many were removed. */
  deletePrefix(prefix: string): number
  /**
   * An explicit clear (WP-G1 review round 2; 5.5 Deletes and Durability): connections:setSecret / mcp:setSecret /
   * mcpLibrary:setSecret with null or '' (set(key, null) calls it), connectors:setToken null, `set-secret --clear`.
   * Unlike delete() it reports what happened: it throws clearRefusal()'s sentence before anything changes, the recovery
   * refusal while a failed save is not reconciled yet, "OrgAI could not remove the secret (<the disk's reason>); it is
   * still saved." when the save failed before anything changed, and VAULT_MESSAGES.notDurable when the outcome is not
   * known (never success). A key that exists nowhere is a no-op. Handlers still call clearRefusal() before changing any
   * record of their own, then clear().
   */
  clear(key: string): void

  /** 'set', 'unset' or unreadable with the reason to show (5.4). Never the value. */
  status(key: string): SecretStatus
  /** The vault's state on this host. */
  state(): VaultState
  /**
   * 5.5 Deletes, explicit clears: why clearing `key` must be refused here, else undefined. Handlers of an explicit
   * clear (connections:setSecret / mcp:setSecret / mcpLibrary:setSecret with null or '', connectors:setToken null; the
   * service method behind each) call it before changing any record and throw the sentence: VAULT_MESSAGES.
   * clearRefusedCorrupt while the vault is 'corrupt', VAULT_MESSAGES.clearRefusedLegacyOnly on a Node or inproc host
   * whose vault is 'absent' for a key that exists only in secrets.json, and every clear (with the read error's sentence)
   * while vault.json or secrets.json cannot be read (an I/O error; it is read again first). Removals (project, server or
   * library delete, linkLibrary, kit replace) never call it. A key that exists nowhere is otherwise never refused.
   */
  clearRefusal(key: string): string | undefined
  /**
   * Single-flight: create the vault (absent, Node / inproc hosts) or retry opening it (locked; missing-key with a key
   * file) before a handler stores a value. Re-checks vault.json after the custodian call and opens an existing vault
   * instead of overwriting it. Resolves when set() may store; rejects with the reason it may not.
   */
  prepareWrite(): Promise<void>
  /**
   * The key file paths the self-control gate protects (ORGAI_VAULT_KEY_FILE and custody.keyFile), each lexical and
   * canonical; [] when the vault uses no key file. Re-read on every call (the vault may change).
   */
  vaultKeyFiles(): string[]
  /** Background vault work (creation, reconciliation, write-back) holds a backgroundTasks lease once the host exists. */
  attachLeases(acquire: (label: string) => () => void): void
  /**
   * 5.6 App host creation: retry creating ('absent') or opening ('locked') the vault in the background, single-flight
   * with prepareWrite and secrets:init; a success reconciles in place. index.ts calls it with 'focus' on window focus
   * after a lock failure; the store's own VAULT_RETRY_MS timer uses 'timer'. A no-op when nothing failed, on a vault
   * already open, and on hosts that cannot write back.
   */
  retryOpen(reason: 'focus' | 'timer'): void
  /** secrets:status. Probes the custodian when `input.probe` is true. */
  statusReport(input?: SecretsStatusInput): Promise<SecretsStatusResult>
  /** secrets:init. */
  initVault(input: SecretsInitInput): Promise<SecretsInitResult>
  /**
   * secrets:reset (served in every state). The caller refuses with VAULT_MESSAGES.resetBusy while an OAuth flow
   * (McpService.activeAuthorizationCount) or a token refresh (McpService.refreshingCount) is in flight; the store
   * itself refuses while one of its own writes is.
   */
  resetVault(input: SecretsResetInput): Promise<SecretsResetResult>
  /** secrets:undelete ("Restore"). */
  undelete(input: SecretsUndeleteInput): SecretsUndeleteResult
  /** secrets:confirmDelete ("Keep removed"): drops the kept values of the named soft deletes (SecretsConfirmDeleteInput). */
  confirmDeletes(input: SecretsConfirmDeleteInput): SecretsConfirmDeleteResult
}

/**
 * vault.json metadata read without decrypting anything (5.7: `orgai doctor` with no host running). 'absent': no file.
 * 'corrupt': it does not parse or validate (the same rule the store applies on load). 'present': a valid vault; the
 * counts and ids are from the file, never a value. src/main/store/vaultMetadata.ts readVaultMetadata.
 */
export interface VaultMetadata {
  state: 'absent' | 'corrupt' | 'present'
  vaultId?: string
  scheme?: VaultCustodyScheme
  /** Entries in vault.json (0 unless 'present'). */
  entries: number
  /** Tombstones in vault.json (0 unless 'present'). */
  tombstones: number
  /** legacyRetired is set (5.5 Retirement). */
  legacyRetired: boolean
}
