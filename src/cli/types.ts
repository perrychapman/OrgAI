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

/** How long a 'starting' host is waited for when connecting to this process's own host (the vault open can take 10 s). */
export const HOST_STARTING_WAIT_MS = 15_000

/** --output-format. 'stream-json' is one JSON document per line. */
export type OutputFormat = 'text' | 'json' | 'stream-json'

/** The global flags (flags.ts splitGlobalFlags), valid anywhere before `--`. */
export interface CliGlobals {
  /** --data-dir: the userDataDir (absolute after resolution; dataDir is `<userDataDir>/data`). */
  dataDir?: string
  /** --output-format, default 'text'. */
  outputFormat: OutputFormat
  /** --project <id-or-path>: overrides cwd-based project resolution. */
  project?: string
  /** false with --no-color (or NO_COLOR / a non-TTY stdout, decided by index.ts). */
  color: boolean
  /** Repeated --secret-env `<owner>:<kind>:<name>=<ENV_VAR>` specs: used by this process's own host. */
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
 * waitStartingMs ('starting'), host_draining ('draining'), not_owner ('not_owner': the hello carried no valid owner
 * proof), any other refusal ('refused'), a failed proof either way ('auth_failed'), protocol_mismatch, or the endpoint
 * did not answer ('unreachable'). `daemon` is the daemon.json read, when there was one.
 */
export type ConnectResult =
  | { ok: true; client: HostClient }
  | {
      ok: false
      reason: 'no_host' | 'starting' | 'draining' | 'not_owner' | 'refused' | 'auth_failed' | 'protocol_mismatch' | 'unreachable'
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

/** The pure-Node host running inside the CLI process (src/cli/inprocHost.ts). */
export interface InprocHostHandle {
  status(): HostStatusResult
  /** Drain (force: stop live runs) and release ownership. */
  stop(force: boolean): Promise<void>
  /** Resolves once the host drained and released the data dir. */
  readonly closed: Promise<void>
  /**
   * The host's in-memory owner key and instance id (inprocHost.ts): CliContext.connect proves with them that it is the
   * process that started the host; the socket serves nobody else. Never on disk.
   */
  readonly ownerKey?: string
  readonly hostInstanceId?: string
}

/** How the in-process host starts (ensureHost / withHost pass it to CliContext.startInproc). */
export interface InprocStartOptions {
  /**
   * bootOrgAIHost's background work: management commands keep connection probes and
   * turn model discovery, community prices and the usage monitor off. Default: all on. The first start in a process
   * decides; a later call while that host is still running reuses it.
   */
  background?: HostBackgroundOptions
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
   * Connect and authenticate to this process's own host with these scopes (clientKind default 'cli'), proving ownership
   * with the in-memory owner key. Never starts a host.
   */
  connect(scopes: HostScope[], opts?: { clientKind?: HostClientKind; waitStartingMs?: number }): Promise<ConnectResult>
  /** The read-only store view (no host needed). */
  readStore(): Promise<ReadOnlySnapshot>
  /** cli-spec 4 resolution over these projects (globals.project, then cwd). */
  resolveProject(projects: Project[]): ProjectResolution
  /**
   * Start this process's host (lazy-loads the inprocHost chunk). One per process at a time; a call after that host
   * closed starts a new one (init's Architect after its withHost). Throws exit 6 while another orgai owns the folder.
   */
  startInproc(opts?: InprocStartOptions): Promise<InprocHostHandle>
  /** SIGINT / SIGTERM listeners; returns an unsubscribe function. */
  signals: { onInterrupt(fn: (sig: 'SIGINT' | 'SIGTERM') => void): () => void }
}

/** One command: resolves with the exit code (or throws a CliError). `args` are the arguments after the command name. */
export type CommandFn = (ctx: CliContext, args: string[]) => Promise<number>
