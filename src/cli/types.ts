/**
 * The CLI's shared contract (cli-spec 6, Wave 2). The CLI never imports electron; it reaches src/main and src/shared
 * through relative imports only. Commands are `CommandFn`s over one `CliContext` built by src/cli/index.ts, so every
 * command is testable with a fake context.
 */
import type {
  DaemonInfo,
  HostClientKind,
  HostKind,
  HostRpcError,
  HostScope,
  HostStatusResult,
  Project,
  RpcHelloResult,
  RunRecord,
  RunSummary
} from '../shared/types'
import type { HostBackgroundOptions } from '../main/host/bootstrap'

/** Process exit codes (cli-spec 6.1). */
export const EXIT = {
  ok: 0,
  /** Any failure not listed below. */
  failure: 1,
  /** Bad usage: unknown command or flag, a missing argument, a refused flag combination. */
  usage: 2,
  /** A run or command needs the user (an open decision, a paused run waiting for input). */
  attention: 3,
  /** A provider usage limit stopped the work. */
  rateLimited: 4,
  /** Authentication failed (a connection or the host handshake). */
  auth: 5,
  /** The host is busy (starting, draining, refused a stop while leases are held). */
  hostBusy: 6,
  /** Ended by SIGINT (128 + 2). */
  sigint: 130,
  /** Ended by SIGTERM (128 + 15). */
  sigterm: 143
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/** A failure that carries the process exit code; index.ts prints `message` to stderr and exits with `exitCode`. */
export class CliError extends Error {
  readonly exitCode: number
  constructor(message: string, exitCode: number = EXIT.failure) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}

/** `schemaVersion` of every --output-format json / stream-json document. */
export const CLI_JSON_SCHEMA_VERSION = 1

/**
 * --host: 'auto' connects to a running host or starts a headless one; 'daemon' only connects (or starts) the shared
 * host and never runs in-process; 'inproc' runs a pure-Node host inside the CLI process.
 */
export type HostMode = 'auto' | 'daemon' | 'inproc'

/**
 * `orgai daemon start --runtime` (Wave 7, cli-standalone.md 4.2): 'app' starts the OrgAI app headless, 'node' a
 * detached pure-Node host (HostKind 'node'). Default 'app' when HostLauncher finds an app, else 'node'.
 */
export type DaemonRuntime = 'app' | 'node'

/**
 * How long a 'starting' host is waited for (Wave 7, cli-standalone.md 5.6): ensureHost, daemon.ts, doctor.ts and
 * exec.ts grow from 2 s to this, to cover the 10 s custodian timeout while a host opens its vault.
 */
export const HOST_STARTING_WAIT_MS = 15_000

/** --output-format. 'stream-json' is one JSON document per line. */
export type OutputFormat = 'text' | 'json' | 'stream-json'

/** The global flags (flags.ts splitGlobalFlags), valid anywhere before `--`. */
export interface CliGlobals {
  /** --data-dir: the userDataDir (absolute after resolution; dataDir is `<userDataDir>/data`). */
  dataDir?: string
  /** --host, default 'auto'. */
  host: HostMode
  /** --output-format, default 'text'. */
  outputFormat: OutputFormat
  /** --project <id-or-path>: overrides cwd-based project resolution. */
  project?: string
  /** false with --no-color (or NO_COLOR / a non-TTY stdout, decided by index.ts). */
  color: boolean
  /**
   * Repeated --secret-env `<owner>:<kind>:<name>=<ENV_VAR>` specs: used by an in-process host (--host inproc, or --host
   * auto with no live host), refused by any command that would attach to a live host (cli-standalone.md 4.1).
   */
  secretEnv: string[]
}

/** The process streams a command writes to (fakes in tests). */
export interface CliIo {
  stdout: { write(s: string): unknown; isTTY?: boolean; columns?: number }
  stderr: { write(s: string): unknown; isTTY?: boolean }
  stdinIsTTY: boolean
}

/** HostClient.call's rejection for a JSON-RPC error answer: `data` is the host's error (protocol.ts errorDataOf). */
export interface HostCallError extends Error {
  data: HostRpcError
}

/** An authenticated connection to a host (src/cli/hostClient.ts, W2-T4). */
export interface HostClient {
  /** The verified host.hello result (hostProof checked). */
  readonly hello: RpcHelloResult
  /** The daemon.json the client connected through. */
  readonly daemon: DaemonInfo
  /**
   * One JSON-RPC request; resolves with the result, rejects with a HostCallError for an RPC error or a plain Error
   * when the socket closes or the timeout passes.
   */
  call<T = unknown>(method: string, params?: unknown[] | Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T>
  /** Every notification the host pushes (runs:event, settings:changed...). Returns an unsubscribe function. */
  onNotification(fn: (method: string, params: unknown) => void): () => void
  /** The socket closed (err set when it failed). Returns an unsubscribe function. */
  onClose(fn: (err?: Error) => void): () => void
  /** Close the socket. Idempotent. */
  close(): void
}

/**
 * CliContext.connect's answer. On failure `reason` says why: no daemon.json / dead pid ('no_host'), host_starting past
 * waitStartingMs ('starting'), host_draining ('draining'), terminal_server_disabled ('disabled'), any other refusal
 * ('refused'), a failed proof either way ('auth_failed'), protocol_mismatch, or the endpoint did not answer
 * ('unreachable'). `daemon` is the daemon.json read, when there was one.
 */
export type ConnectResult =
  | { ok: true; client: HostClient }
  | {
      ok: false
      reason: 'no_host' | 'starting' | 'draining' | 'disabled' | 'refused' | 'auth_failed' | 'protocol_mismatch' | 'unreachable'
      message: string
      daemon?: DaemonInfo
    }

/** A read-only view of the data dir without a host (src/cli/storeReader.ts, W2-T4): never writes, never migrates. */
export interface ReadOnlySnapshot {
  /** From daemon.json (and pid liveness): 'stopped' when no live host advertises. */
  hostState: 'stopped' | 'starting' | 'ready' | 'draining'
  /** Pending decision cards live only in a host's memory. */
  liveInboxAvailable: false
  daemon?: DaemonInfo
  projects: Project[]
  /** Every stored run summary, newest first. */
  runs: RunSummary[]
  /** One stored run record, or null when missing or unreadable. */
  readRecord(runId: string): RunRecord | null
}

/** Which project a command works on (cli-spec 4): --project, else the project whose folder contains cwd. */
export interface ProjectResolution {
  project?: Project
  via: 'flag' | 'cwd' | 'none'
  /** cwd is inside an OrgAI-managed worktree (.claude/worktrees/agent-*): the project is its main checkout's. */
  managedWorktree?: { mainCheckout: string }
  /** Why --project matched nothing (or matched more than one), for a usage error. */
  error?: string
}

/**
 * HostLauncher.locate (Wave 7, cli-standalone.md 4.1 step 3). 'found': an app to spawn ('installed' is the new
 * /Applications, ~/Applications or Program Files discovery). 'absent': nothing anywhere; `--host auto` then runs an
 * in-process host. 'broken': found, but its binary or app.asar is missing; an error naming `path`, never a fallback.
 */
export type HostLauncherResolution =
  | ({ status: 'found' } & HostLauncherFound)
  | { status: 'absent'; message: string }
  | { status: 'broken'; path: string; message: string }

/** An app HostLauncher can spawn: resolve()'s success and locate()'s 'found'. */
export interface HostLauncherFound {
  command: string
  args: string[]
  source: 'env' | 'packaged' | 'dev' | 'installed'
}

/** Finds and starts the OrgAI app as a host (src/cli/launcher.ts, W2-T4). */
export interface HostLauncher {
  /**
   * The app binary, in this order: ORGAI_ELECTRON_PATH ('env'); the packaged app next to this bundle ('packaged': the
   * bundle sits in `<Resources>/app.asar.unpacked/out/cli`), only when install.json says 'app'; the dev checkout's
   * electron + out/main ('dev'), only without any install.json and with the checkout markers (electron.vite.config.ts,
   * electron in devDependencies); an installed app ('installed': /Applications or ~/Applications on macOS,
   * %LOCALAPPDATA%\Programs or %ProgramFiles% on Windows, none on Linux). Errors carry the path they are about.
   */
  resolve(): HostLauncherFound | { error: string; path?: string }
  /**
   * Wave 7: the same lookup as found / absent / broken (HostLauncherResolution): APP_NOT_FOUND is 'absent', any other
   * error 'broken' with the error's `path` (a missing packaged binary, an unbuilt checkout, an incomplete installed
   * app).
   */
  locate(): HostLauncherResolution
  /**
   * Spawn it detached: `--headless-host` when headless, else a desktop window; `run` focuses that run id. `app`: the
   * app locate() found, so the lookup that decided and the spawn cannot disagree; without it spawn() resolves again.
   */
  spawn(opts: { headless: boolean; run?: string; app?: HostLauncherFound }): { pid?: number }
  /**
   * Wave 7 (cli-standalone.md 4.1, 4.2): start a detached Node background host (`daemon run-node`) when no app was
   * found. Optional: the node runtime package (WP-E) adds it; `--host daemon` without an app fails with a clear message
   * while it is absent. Resolves once the process is spawned (callers then waitForReady on BACKGROUND_HOST_KINDS);
   * rejects with a message the CLI prints (e.g. Terminal access is off, or this install has no plain Node).
   */
  startBackground?(runtime: 'node'): Promise<{ pid?: number }>
  /** The daemon.json of the live host that owns the data folder (any state), else null. */
  current(): DaemonInfo | null
  /**
   * Poll daemon.json until a host is 'ready' (with notInstanceId, a different one; with hostKinds, one of those kinds).
   * null on timeout. Rejects with the reason when the app this launcher spawned could not start or exited non-zero
   * before a matching host was ready (exit 0 is a hand-off to a running OrgAI, so polling goes on).
   */
  waitForReady(opts: { timeoutMs: number; notInstanceId?: string; hostKinds?: readonly HostKind[] }): Promise<DaemonInfo | null>
  /** Poll until no host (or not that hostInstanceId) advertises. false on timeout. */
  waitForGone(opts: { timeoutMs: number; hostInstanceId?: string }): Promise<boolean>
}

/** A pure-Node host running inside the CLI (`--host inproc`, src/cli/inprocHost.ts, W2-T4). */
export interface InprocHostHandle {
  status(): HostStatusResult
  /** Drain (force: stop live runs) and release ownership. */
  stop(force: boolean): Promise<void>
  /** Resolves once the host drained and released the data dir. */
  readonly closed: Promise<void>
}

/** How an in-process host starts (ensureHost / withHost pass it to CliContext.startInproc). */
export interface InprocStartOptions {
  /**
   * bootOrgAIHost's background work (cli-standalone.md 4.1 step 4): management commands keep connection probes and
   * turn model discovery, community prices and the usage monitor off. Default: all on. The first start in a process
   * decides; a later call while that host is still running reuses it.
   */
  background?: HostBackgroundOptions
}

/**
 * Environment secrets this command carries under `--host auto` (cli-standalone.md 4.1, round 6 item 8), set by
 * index.ts prepareContext after collecting and scrubbing them. Absent when there are none (and under --host inproc,
 * where the secrets always go to the command's own host).
 */
export interface SecretEnvUse {
  /** --secret-env flags were given: refused (exit 2) when the command attaches to a live host. */
  explicit: boolean
  /** ORGAI_SECRET_* variables were set. */
  ambient: boolean
  /**
   * The command would use a secret on a live host (runs, Architect, assistants, credential probes, model calls): an
   * ambient secret is then refused against a live host too; otherwise it is ignored with one warning.
   */
  usesSecrets: boolean
}

/** Everything a command may use. Built once per process by index.ts; tests build fakes. */
export interface CliContext {
  globals: CliGlobals
  /** userDataDir (resolved absolute) and dataDir = `<userDataDir>/data`. */
  paths: { userDataDir: string; dataDir: string }
  env: NodeJS.ProcessEnv
  cwd: string
  platform: NodeJS.Platform
  io: CliIo
  /** CLI_VERSION. */
  version: string
  /**
   * Connect and authenticate to the running host with these scopes (clientKind default 'cli'). With waitStartingMs a
   * 'host_starting' answer is retried until that long has passed. Never starts a host.
   */
  connect(scopes: HostScope[], opts?: { clientKind?: HostClientKind; waitStartingMs?: number }): Promise<ConnectResult>
  /** The read-only store view (no host needed). */
  readStore(): Promise<ReadOnlySnapshot>
  /** cli-spec 4 resolution over these projects (globals.project, then cwd). */
  resolveProject(projects: Project[]): ProjectResolution
  launcher: HostLauncher
  /**
   * Start an in-process host (lazy-loads the inprocHost chunk): `--host inproc`, or `--host auto` when no host is live
   * and no app was found or environment secrets are set. One per process at a time; a call after that host closed
   * starts a new one (init's Architect after its withHost).
   */
  startInproc(opts?: InprocStartOptions): Promise<InprocHostHandle>
  /** Environment secrets under `--host auto` (see SecretEnvUse); undefined when there are none. */
  secretEnv?: SecretEnvUse
  /** SIGINT / SIGTERM listeners; returns an unsubscribe function. */
  signals: { onInterrupt(fn: (sig: 'SIGINT' | 'SIGTERM') => void): () => void }
}

/** One command: resolves with the exit code (or throws a CliError). `args` are the arguments after the command name. */
export type CommandFn = (ctx: CliContext, args: string[]) => Promise<number>
