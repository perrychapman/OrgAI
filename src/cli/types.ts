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
  /** Repeated --secret-env `<owner>:<kind>:<name>=<ENV_VAR>` specs (only valid with --host inproc). */
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
   * The app binary: ORGAI_ELECTRON_PATH ('env'), the packaged app next to this bundle ('packaged': the bundle sits in
   * `<Resources>/app.asar.unpacked/out/cli`) or the dev checkout's electron + out/main ('dev'), in that order.
   */
  resolve(): HostLauncherFound | { error: string; path?: string }
  /**
   * Wave 7: the same lookup as found / absent / broken (HostLauncherResolution). Until WP-B adds installed-app
   * discovery (source 'installed') and the checkout marker, it maps resolve(): APP_NOT_FOUND is 'absent', any other
   * error 'broken' with the error's `path` (the missing packaged binary, the unbuilt checkout).
   */
  locate(): HostLauncherResolution
  /**
   * Spawn it detached: `--headless-host` when headless, else a desktop window; `run` focuses that run id. `app`: the
   * app locate() found, so the lookup that decided and the spawn cannot disagree; without it spawn() resolves again.
   */
  spawn(opts: { headless: boolean; run?: string; app?: HostLauncherFound }): { pid?: number }
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
  /**
   * Wave 7 (cli-standalone.md 4.2, WP-E): start a background host of this runtime, detached. 'app': the app headless
   * (as spawn({ headless: true, app })). 'node': `process.execPath <orgai.mjs> daemon run-node`, detached (setsid on
   * POSIX, windowsHide on Windows), stdio to `<userDataDir>/logs/node-host.log`; throws when this CLI runs on Electron
   * (no real Node) or the orgai.mjs bundle is not found. `hostKinds`: what waitForReady should wait for. A failed spawn
   * or early exit makes the next waitForReady reject, as for spawn(). Optional so test fakes may leave it out.
   */
  startBackground?(runtime: DaemonRuntime, opts?: { app?: HostLauncherFound }): { pid?: number; hostKinds: readonly HostKind[] }
}

/** A pure-Node host running inside the CLI (`--host inproc`, src/cli/inprocHost.ts, W2-T4). */
export interface InprocHostHandle {
  status(): HostStatusResult
  /** Drain (force: stop live runs) and release ownership. */
  stop(force: boolean): Promise<void>
  /** Resolves once the host drained and released the data dir. */
  readonly closed: Promise<void>
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
   * Start a `--host inproc` host (lazy-loads the inprocHost chunk). `hostKind: 'node'` (Wave 7, `orgai daemon run-node`
   * only) starts it as the detached Node host. One host per process: a later call returns the first one.
   */
  startInproc(opts?: { hostKind?: 'inproc' | 'node' }): Promise<InprocHostHandle>
  /** SIGINT / SIGTERM listeners; returns an unsubscribe function. */
  signals: { onInterrupt(fn: (sig: 'SIGINT' | 'SIGTERM') => void): () => void }
}

/** One command: resolves with the exit code (or throws a CliError). `args` are the arguments after the command name. */
export type CommandFn = (ctx: CliContext, args: string[]) => Promise<number>
