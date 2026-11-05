import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { DaemonInfo, HostKind, HostState } from '@shared/types'
import { HOST_INSTANCE_ID_RE, currentHostInstanceId } from './identity'
import { renameSyncRetry } from './fsRetry'
import { processLivenessCachedAsync, selfStartTime, type Liveness } from './processInfo'
import { restrictDaemonSecretAcl } from './protocol'

/**
 * Pre-store host ownership of a data dir (cli-spec 3.2(2), Step 0 of booting a host). Runs before any store
 * constructor or boot sweep, because RunStore's constructor rewrites non-terminal runs: a second host must never get
 * that far while another one owns the data dir.
 *
 * On disk, under `<dataDir>/run/` (mode 0700, owned by this user):
 * - `startup.mkdir/` is a short mutex (mkdir is atomic). Its `owner.json` names the holder ({ pid, processStartTime,
 *   hostInstanceId, createdAt }). A live holder is never robbed, however long it takes; a provably dead one (or a
 *   dir whose owner.json is still missing or corrupt after startupYoungMs) is reclaimed by renaming it to
 *   `startup.mkdir.stale-<uuid>` and removing the renamed copy, so two contenders can never both remove it.
 * - `daemon.json` ({@link DaemonInfo}) advertises the live host, written by tmp + rename, `state` 'starting' ->
 *   'ready' -> 'draining'. Only the host whose hostInstanceId it carries ever rewrites or removes it.
 * - `daemon.secret` is a fresh 32-byte hex secret (mode 0600) for the socket handshake (a later wave).
 * - `d-<hostInstanceId>.sock` is this host's own listener (POSIX). When that path would be 100 bytes or longer, the
 *   socket lives in `<XDG_RUNTIME_DIR or tmpdir>/orgai-<hostInstanceId>/d.sock` instead (a 0700 dir with its own
 *   owner.json). Windows uses the named pipe from {@link pipeNameFor} (UNVERIFIED: never run on Windows).
 *
 * Decided here where the spec leaves room: a daemon.json whose pid is live with a matching start time but whose
 * endpoint answers ENOENT or ECONNREFUSED is still treated as a running host (HostAlreadyRunningError): a confirmed
 * live pid is never robbed. Likewise a socket that connects while the pid reads dead counts as running (something
 * answers there). A pid that exists but whose start time cannot be compared (unknown on either side; on Windows
 * another user's process, or a pid reused quickly) is 'unconfirmed' (review M9): with a dead endpoint it is reclaimed
 * only when daemon.json says the endpoint is bound (no `listening: false`; a listening host publishes daemon.json only
 * after it listens and writes `listening: false` before it closes, so a published listening host with no listener is
 * gone). An unconfirmed pid whose daemon.json says `listening: false` (an Electron host with Terminal access off,
 * review M11) is a running host whatever the probe says: only a 'dead' pid is reclaimed then. An unconfirmed startup.mkdir owner is reclaimed once the mutex is older than
 * `unconfirmedStaleMs`. A daemon.json that exists but cannot be read or parsed is never taken for "no host": it is
 * reclaimed only when it still names a dead pid, else ownership is refused with the file named. The user's way out of
 * a wedged state is quitting that process, or deleting `<dataDir>/run` by hand (every refusal names it).
 *
 * Windows (UNVERIFIED on Windows): renames retry transient EPERM / EBUSY / EACCES (fsRetry.ts, review M6); icacls runs
 * by absolute path from the temp dir (review H1), and its failure is fatal only for hosts that serve terminals (review
 * M8, `secretAcl`).
 *
 * Pure Node (fs, net, crypto, path): never imports electron, so a pure-Node host can use it.
 */

/** Named points in {@link acquireHostOwnership} where `faultAt` throws, to test crash recovery. */
export type OwnershipBoundary =
  | 'after-run-dir'
  | 'after-startup-mkdir'
  | 'after-owner-tmp'
  | 'after-owner-rename'
  | 'after-probe'
  | 'after-secret'
  | 'after-listen'
  | 'after-daemon-tmp'
  | 'after-daemon-starting'
  | 'before-startup-release'
  | 'after-ready'

/** Named points in {@link HostOwnership.release} where `faultAt` throws (a crash while giving up ownership). */
export type ReleaseBoundary =
  | 'release-after-startup-mkdir'
  | 'release-after-owner-tmp'
  | 'release-after-owner-rename'
  | 'release-after-secret-removed'
  | 'release-after-daemon-unlink'
  | 'release-after-close'
  | 'release-before-startup-release'

export const RELEASE_BOUNDARIES: readonly ReleaseBoundary[] = [
  'release-after-startup-mkdir',
  'release-after-owner-tmp',
  'release-after-owner-rename',
  'release-after-secret-removed',
  'release-after-daemon-unlink',
  'release-after-close',
  'release-before-startup-release'
]

export const OWNERSHIP_BOUNDARIES: readonly OwnershipBoundary[] = [
  'after-run-dir',
  'after-startup-mkdir',
  'after-owner-tmp',
  'after-owner-rename',
  'after-probe',
  'after-secret',
  'after-listen',
  'after-daemon-tmp',
  'after-daemon-starting',
  'before-startup-release',
  'after-ready'
]

export type ProbeResult = 'connected' | 'refused' | 'enoent' | 'eacces' | 'timeout'

export type HostOwnershipErrorCode =
  | 'unsafe_run_dir'
  | 'unsafe_runtime_dir'
  | 'socket_path_too_long'
  | 'secret_acl_failed'
  | 'already_running'
  | 'starting_or_busy'
  | 'daemon_json_unreadable'

/** Any failure to take ownership. The host exits with `exitCode` (6, cli-spec exit codes). */
export class HostOwnershipError extends Error {
  readonly exitCode = 6
  constructor(
    readonly code: HostOwnershipErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'HostOwnershipError'
  }
}

/** The way out a refusal names (review M9): the run folder, deleted only when no OrgAI uses the data folder. */
export function runDirHint(runDir: string): string {
  return `If you are sure no OrgAI (and no orgai terminal host) is running for this data folder, delete the folder ${runDir}, then start OrgAI again.`
}

/** A live host already owns the data dir (its daemon.json pid is live, or its endpoint answers). */
export class HostAlreadyRunningError extends HostOwnershipError {
  constructor(
    readonly info: DaemonInfo,
    readonly runDir?: string
  ) {
    super(
      'already_running',
      `OrgAI is already running for this data folder (pid ${info.pid}, ${info.hostKind ?? 'host'} ${info.hostInstanceId}).${runDir ? ` ${runDirHint(runDir)}` : ''}`
    )
    this.name = 'HostAlreadyRunningError'
  }
}

/** Another live process has held the startup mutex for longer than liveWaitMs. */
export class HostStartingOrBusyError extends HostOwnershipError {
  constructor(
    readonly ownerPid: number | undefined,
    readonly runDir?: string
  ) {
    super(
      'starting_or_busy',
      `Another OrgAI process${ownerPid ? ` (pid ${ownerPid})` : ''} is still starting for this data folder.${runDir ? ` ${runDirHint(runDir)}` : ''}`
    )
    this.name = 'HostStartingOrBusyError'
  }
}

/** Thrown at an injected {@link OwnershipBoundary}. Nothing on disk is cleaned up after it, like a real crash. */
export class OwnershipFaultError extends Error {
  /** Tests: make the in-process listener die like a crashed process's (its socket file stays). Idempotent. */
  crash: () => Promise<void> = () => Promise.resolve()
  constructor(readonly boundary: OwnershipBoundary | ReleaseBoundary) {
    super(`Injected ownership fault at ${boundary}`)
    this.name = 'OwnershipFaultError'
  }
}

export interface OwnershipOptions {
  /** `<userDataDir>/data`; should already be canonical (realpath). */
  dataDir: string
  hostKind: HostKind
  appVersion: string
  /** Defaults to currentHostInstanceId(). */
  hostInstanceId?: string
  /** Base for the long-path runtime dir; defaults to $XDG_RUNTIME_DIR, else os.tmpdir(). */
  runtimeBase?: string
  // Injectable for tests.
  /** Boolean liveness (true = the recorded process, 'same'; false = 'dead'). `liveness` wins when both are given. */
  isLiveProcess?: (pid: number, startTime?: string) => boolean
  /** Three-way liveness ({@link Liveness}); default processLivenessCachedAsync (never blocks the event loop, M10). */
  liveness?: (pid: number, startTime?: string) => Liveness | Promise<Liveness>
  /** This process's start time stand-in (only ever asked for process.pid). */
  startTimeOf?: (pid: number) => string | undefined
  /**
   * An unconfirmed startup.mkdir owner (pid exists, start time not comparable) is reclaimed once the mutex is this
   * old (default 60000): startup holds it for seconds, and a stranger that reused the pid would otherwise block every
   * launch (review M9).
   */
  unconfirmedStaleMs?: number
  /**
   * win32: what an icacls failure on daemon.secret does when the listener is bound at once (listen not false).
   * 'required' throws HostOwnershipError('secret_acl_failed'); 'best-effort' warns, goes on and sets
   * HostOwnership.secretAclWarning. Default: 'best-effort' for the desktop host, 'required' for headless and inproc
   * hosts, which exist to serve the orgai command. setListening(true) is always 'required' (a failure keeps the
   * listener off; the Electron hosts acquire with listen: false, so a desktop launch never fails on it, review M8).
   */
  secretAcl?: 'required' | 'best-effort'
  /** Where warnings go (default console.warn). */
  warn?: (message: string) => void
  /**
   * win32 whoami + icacls stand-in (tests; default protocol.ts restrictDaemonSecretAcl): restrict `path` (a folder when
   * `directory`) to the current user's SID. Resolves undefined on success, else the reason.
   */
  restrictAcl?: (path: string, directory: boolean) => Promise<string | undefined>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  connectProbe?: (endpoint: string, timeoutMs: number) => Promise<ProbeResult>
  /** Every accepted connection. Default: destroyed at once (Wave 0 has no RPC; the socket server plugs in here). */
  onConnection?: (socket: Socket) => void
  /** startup.mkdir with no owner.json younger than this is a writer between mkdir and rename (default 2000). */
  startupYoungMs?: number
  /** Poll interval while waiting on startup.mkdir (default 100). */
  retryMs?: number
  /** Longest wait on a live startup.mkdir owner (default 30000). */
  liveWaitMs?: number
  /** Connection probe of the incumbent's endpoint (default 1500). */
  probeTimeoutMs?: number
  /** Crash injection (tests only). */
  faultAt?: OwnershipBoundary | ReleaseBoundary
  /** Platform override (tests only; the win32 pipe path is UNVERIFIED and not exercised live). */
  platform?: NodeJS.Platform
  /**
   * Write daemon.secret and bind the listener now (default true). false (review M11; the Electron hosts, whose
   * Terminal access may be off): neither exists until setListening(true); daemon.json carries `listening: false` and
   * the endpoint the listener will use.
   */
  listen?: boolean
}

export interface HostOwnership {
  readonly info: DaemonInfo
  /** The listener's socket path or pipe name (the same whether or not it is bound right now). */
  readonly endpoint: string
  readonly secretPath: string
  /** The long-path runtime dir, when the socket lives (or will live) there. */
  readonly runtimeDir?: string
  /**
   * win32: why daemon.secret could not be given a current-user-only DACL when acquireHostOwnership bound the listener
   * at once in best-effort mode (review M8); undefined when it was protected. setListening(true) never sets it: there
   * an ACL failure rejects and the listener stays off.
   */
  readonly secretAclWarning?: string
  /** True while daemon.secret exists and the listener is bound. */
  readonly listening: boolean
  /**
   * Bind the listener and write daemon.secret (on), or close the listener and remove daemon.secret (off), then rewrite
   * daemon.json's `listening` (review M11: only while Terminal access is on). Calls run one at a time in call order; a
   * call that matches the current state does nothing. The secret keeps its value for this host instance. Rejects when
   * the bind (or, on Windows, the secret's ACL) fails; the listener is then off. After release() it does nothing.
   */
  setListening(on: boolean): Promise<void>
  /** Rewrite daemon.json with state 'ready' (only while it still carries our hostInstanceId). True when written. */
  markReady(): boolean
  /** Rewrite daemon.json with state 'draining' (same rule). */
  markDraining(): boolean
  /** Give up ownership (synchronous, idempotent; for will-quit and process 'exit'). */
  release(): void
}

const STARTUP_DIR = 'startup.mkdir'
const DAEMON_JSON = 'daemon.json'
const DAEMON_SECRET = 'daemon.secret'
const OWNER_JSON = 'owner.json'
/** Leave headroom under macOS's 104-byte and Linux's 108-byte sun_path. */
const SOCKET_PATH_MAX = 100
const DAEMON_JSON_MAX_BYTES = 64 * 1024
const RUNTIME_DIR_RE = /^orgai-[0-9a-f]{12}$/
const HOST_STATES: readonly HostState[] = ['starting', 'ready', 'draining']
const HOST_KINDS: readonly HostKind[] = ['desktop', 'headless-host', 'inproc']

export function runDirOf(dataDir: string): string {
  return join(dataDir, 'run')
}

/** The POSIX socket path of host `id` in `dataDir` (before the long-path fallback). */
export function socketPathFor(dataDir: string, id: string): string {
  return join(runDirOf(dataDir), `d-${id}.sock`)
}

/**
 * The Windows named pipe of host `id`: `\\.\pipe\orgai-<sha256(dataDir).slice(0,20)>-<id>`. `dataDir` should be
 * canonical already; it is resolved here and, on win32, lower-cased so both spellings name one pipe. UNVERIFIED on
 * Windows (only the name derivation is unit-tested).
 */
export function pipeNameFor(dataDir: string, id: string, platform: NodeJS.Platform = process.platform): string {
  let canonical = resolve(dataDir)
  if (platform === 'win32') canonical = canonical.toLowerCase()
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 20)
  return `\\\\.\\pipe\\orgai-${hash}-${id}`
}

/** `<runtimeBase>/orgai-<id>`: the long-path socket dir. */
export function runtimeDirFor(id: string, runtimeBase: string = defaultRuntimeBase()): string {
  return join(runtimeBase, `orgai-${id}`)
}

function defaultRuntimeBase(): string {
  const xdg = process.env.XDG_RUNTIME_DIR?.trim()
  return xdg ? xdg : tmpdir()
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A validated DaemonInfo, or null for anything else (unknown fields dropped). */
export function parseDaemonInfo(raw: unknown): DaemonInfo | null {
  if (!isObject(raw)) return null
  const { hostInstanceId, pid, processStartTime: start, endpoint, listening, state, startedAt, hostKind, appVersion } = raw
  if (typeof hostInstanceId !== 'string' || !HOST_INSTANCE_ID_RE.test(hostInstanceId)) return null
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  if (typeof endpoint !== 'string' || !endpoint || endpoint.length > 1024 || endpoint.includes('\0')) return null
  if (typeof state !== 'string' || !HOST_STATES.includes(state as HostState)) return null
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null
  if (start !== undefined && (typeof start !== 'string' || start.length > 200)) return null
  if (hostKind !== undefined && (typeof hostKind !== 'string' || !HOST_KINDS.includes(hostKind as HostKind))) return null
  if (appVersion !== undefined && (typeof appVersion !== 'string' || appVersion.length > 200)) return null
  return {
    hostInstanceId,
    pid,
    ...(start !== undefined ? { processStartTime: start } : {}),
    endpoint,
    // Only an explicit false means "not listening"; anything else reads as listening (older hosts never write it).
    ...(listening === false ? { listening: false as const } : {}),
    state: state as HostState,
    startedAt,
    ...(hostKind !== undefined ? { hostKind: hostKind as HostKind } : {}),
    ...(appVersion !== undefined ? { appVersion } : {})
  }
}

function readJsonFile(path: string, maxBytes: number): unknown {
  try {
    const st = lstatSync(path)
    if (!st.isFile() || st.size > maxBytes) return undefined
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** `<dataDir>/run/daemon.json`, validated, or null when missing or malformed. Never throws. */
export function readDaemonInfo(dataDir: string): DaemonInfo | null {
  return parseDaemonInfo(readJsonFile(join(runDirOf(dataDir), DAEMON_JSON), DAEMON_JSON_MAX_BYTES))
}

/**
 * What `<dataDir>/run/daemon.json` holds, telling a missing file apart from one that exists but is unusable (review
 * M9: an unreadable file must never count as "no incumbent"). For an unusable file, `pid` / `processStartTime` /
 * `endpoint` are whatever plausible values could still be read from it (a newer or damaged record), so a caller can
 * still tell a dead holder. Never throws.
 */
export type DaemonFileState =
  | { kind: 'missing' }
  | { kind: 'ok'; info: DaemonInfo }
  | { kind: 'unusable'; reason: string; pid?: number; processStartTime?: string; endpoint?: string }

export function readDaemonFileState(dataDir: string): DaemonFileState {
  const path = join(runDirOf(dataDir), DAEMON_JSON)
  let st
  try {
    st = lstatSync(path)
  } catch (e) {
    if (errCode(e) === 'ENOENT') return { kind: 'missing' }
    return { kind: 'unusable', reason: `it could not be checked (${errCode(e) ?? (e as Error).message})` }
  }
  if (!st.isFile()) return { kind: 'unusable', reason: 'it is not a regular file' }
  // An empty file names no host (an interrupted write on a file system that lost the data); it is replaced.
  if (st.size === 0) return { kind: 'missing' }
  if (st.size > DAEMON_JSON_MAX_BYTES) return { kind: 'unusable', reason: `it is larger than ${DAEMON_JSON_MAX_BYTES} bytes` }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    return { kind: 'unusable', reason: e instanceof SyntaxError ? 'it is not valid JSON' : `it could not be read (${errCode(e) ?? (e as Error).message})` }
  }
  const info = parseDaemonInfo(raw)
  if (info) return { kind: 'ok', info }
  const loose: { pid?: number; processStartTime?: string; endpoint?: string } = {}
  if (isObject(raw)) {
    if (typeof raw.pid === 'number' && Number.isInteger(raw.pid) && raw.pid > 0) loose.pid = raw.pid
    if (typeof raw.processStartTime === 'string' && raw.processStartTime.length <= 200) loose.processStartTime = raw.processStartTime
    if (typeof raw.endpoint === 'string' && raw.endpoint && raw.endpoint.length <= 1024 && !raw.endpoint.includes('\0')) loose.endpoint = raw.endpoint
  }
  return { kind: 'unusable', reason: 'it does not hold a host record this OrgAI understands', ...loose }
}

interface OwnerRecord {
  pid: number
  processStartTime?: string
  hostInstanceId?: string
  createdAt?: number
}

function parseOwner(raw: unknown): OwnerRecord | null {
  if (!isObject(raw)) return null
  const { pid, processStartTime: start, hostInstanceId, createdAt } = raw
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  return {
    pid,
    ...(typeof start === 'string' ? { processStartTime: start } : {}),
    ...(typeof hostInstanceId === 'string' ? { hostInstanceId } : {}),
    ...(typeof createdAt === 'number' ? { createdAt } : {})
  }
}

function sameOwner(a: OwnerRecord, b: OwnerRecord): boolean {
  return a.pid === b.pid && a.processStartTime === b.processStartTime && a.hostInstanceId === b.hostInstanceId && a.createdAt === b.createdAt
}

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code
}

/** tmp + rename, mode `mode` (chmod after write so the umask cannot widen it). */
function writeAtomic(path: string, body: string, mode: number, tmpTag: string, fault?: () => void): void {
  const tmp = `${path}.tmp-${tmpTag}`
  writeFileSync(tmp, body, { mode })
  chmodSync(tmp, mode)
  fault?.()
  renameSyncRetry(tmp, path)
}

/** A real, non-symlink directory owned by this user (POSIX), else throws HostOwnershipError(code). */
function assertSafeDir(dir: string, code: 'unsafe_run_dir' | 'unsafe_runtime_dir', platform: NodeJS.Platform): void {
  let st
  try {
    st = lstatSync(dir)
  } catch (e) {
    throw new HostOwnershipError(code, `${dir} could not be checked: ${(e as Error).message}`)
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new HostOwnershipError(code, `${dir} is not a real directory.`)
  if (platform !== 'win32' && typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new HostOwnershipError(code, `${dir} is owned by another user.`)
  }
  if (platform !== 'win32' && (st.mode & 0o077) !== 0) chmodSync(dir, 0o700)
}

/** Default probe: a connect attempt with a timeout, every failure mapped onto {@link ProbeResult}. */
export function connectProbe(endpoint: string, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((done) => {
    let settled = false
    const socket = connect(endpoint)
    const finish = (r: ProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      done(r)
    }
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    socket.once('connect', () => finish('connected'))
    socket.once('error', (e) => {
      const code = errCode(e)
      if (code === 'ENOENT') finish('enoent')
      else if (code === 'ECONNREFUSED' || code === 'ENOTSOCK') finish('refused')
      else if (code === 'EACCES' || code === 'EPERM') finish('eacces')
      // Anything else is unclear: answer like a slow live host, never like a dead one.
      else finish('timeout')
    })
  })
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Take ownership of `opts.dataDir` (cli-spec 3.2(2) Step 0). See the module comment. */
export async function acquireHostOwnership(opts: OwnershipOptions): Promise<HostOwnership> {
  const platform = opts.platform ?? process.platform
  const id = opts.hostInstanceId ?? currentHostInstanceId()
  if (!HOST_INSTANCE_ID_RE.test(id)) throw new Error(`Invalid host instance id: ${id}`)
  const boolLive = opts.isLiveProcess
  const liveness = async (p: number, start?: string): Promise<Liveness> => {
    if (opts.liveness) return opts.liveness(p, start)
    if (boolLive) return boolLive(p, start) ? 'same' : 'dead'
    return processLivenessCachedAsync(p, start)
  }
  const warn = opts.warn ?? ((m: string) => console.warn(m))
  const secretAclMode = opts.secretAcl ?? (opts.hostKind === 'desktop' ? 'best-effort' : 'required')
  const unconfirmedStaleMs = opts.unconfirmedStaleMs ?? 60_000
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? defaultSleep
  const probe = opts.connectProbe ?? connectProbe
  const startupYoungMs = opts.startupYoungMs ?? 2000
  const retryMs = opts.retryMs ?? 100
  const liveWaitMs = opts.liveWaitMs ?? 30_000
  const probeTimeoutMs = opts.probeTimeoutMs ?? 1500
  const runtimeBase = opts.runtimeBase ?? defaultRuntimeBase()
  const fault = (b: OwnershipBoundary | ReleaseBoundary): void => {
    if (opts.faultAt === b) throw new OwnershipFaultError(b)
  }

  const dataDir = resolve(opts.dataDir)
  const runDir = runDirOf(dataDir)
  const startupDir = join(runDir, STARTUP_DIR)
  const daemonPath = join(runDir, DAEMON_JSON)
  const secretPath = join(runDir, DAEMON_SECRET)
  const pid = process.pid
  const myStart = opts.startTimeOf ? opts.startTimeOf(pid) : selfStartTime()
  const listenNow = opts.listen !== false
  /** This host instance's handshake secret: written while the listener is bound, the same value each time. */
  const secretValue = randomBytes(32).toString('hex')

  // (1) <dataDir>/run, 0700, a real dir owned by us.
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  assertSafeDir(runDir, 'unsafe_run_dir', platform)
  fault('after-run-dir')

  // (2) The startup mutex.
  await takeStartupMutex()

  let server: Server | undefined
  let endpoint = ''
  let runtimeDir: string | undefined
  let wroteSecret = false
  let published = false
  let secretAclWarning: string | undefined
  try {
    // (3) The incumbent.
    const file = readDaemonFileState(dataDir)
    if (file.kind === 'ok') {
      const incumbent = file.info
      const live = await liveness(incumbent.pid, incumbent.processStartTime)
      const answer = await probe(incumbent.endpoint, probeTimeoutMs)
      const reachable = answer === 'connected' || answer === 'eacces' || answer === 'timeout'
      // A dead pid with a dead endpoint is reclaimed, and so is an unconfirmed pid (it may be a stranger that reused
      // the pid, review M9) with a dead endpoint that daemon.json says is bound. A confirmed live pid, or an endpoint
      // that answers, is a running host. So is an unconfirmed pid whose daemon.json says `listening: false` (review
      // M11: an Electron host with Terminal access off has no listener at all, so a dead endpoint proves nothing; a
      // slow or unreadable start time must never let a second host write the same data folder).
      const unboundButMaybeLive = live === 'unconfirmed' && incumbent.listening === false
      if (live === 'same' || reachable || unboundButMaybeLive) {
        removeStartupDir()
        throw new HostAlreadyRunningError(incumbent, runDir)
      }
      if (live === 'unconfirmed') {
        warn(`OrgAI host ownership: daemon.json names pid ${incumbent.pid}, which exists but could not be confirmed as that host, and its endpoint does not answer (${answer}); taking over.`)
      }
      unlinkStaleEndpoint(incumbent.endpoint)
    } else if (file.kind === 'unusable') {
      // Never "no incumbent" (review M9): reclaimed only while it still names a pid that is provably gone and an
      // endpoint (if any) that does not answer.
      const dead = file.pid !== undefined && (await liveness(file.pid, file.processStartTime)) === 'dead'
      const answer = dead && file.endpoint ? await probe(file.endpoint, probeTimeoutMs) : undefined
      if (!dead || answer === 'connected' || answer === 'eacces' || answer === 'timeout') {
        removeStartupDir()
        throw new HostOwnershipError('daemon_json_unreadable', `${daemonPath} could not be used: ${file.reason}. ${runDirHint(runDir)}`)
      }
      warn(`OrgAI host ownership: replacing an unusable daemon.json (${file.reason}) that names pid ${file.pid}, which is gone.`)
      if (file.endpoint) unlinkStaleEndpoint(file.endpoint)
    }
    // No live host owns the data dir from here on, and we hold the mutex.
    await sweepLeftovers()
    fault('after-probe')

    if (listenNow) {
      // The handshake secret (win32: the run folder and the file restricted to the current user first, review H2 / M8).
      secretAclWarning = await writeSecret(secretAclMode, () => (wroteSecret = true))
      fault('after-secret')

      // The per-instance listener.
      const bound = await bindListener()
      server = bound.server
      endpoint = bound.endpoint
      runtimeDir = bound.runtimeDir
      fault('after-listen')
    } else {
      // Review M11: no secret and no listener until setListening(true); daemon.json names the endpoint it will use.
      const planned = plannedEndpoint()
      endpoint = planned.endpoint
      runtimeDir = planned.runtimeDir
    }

    const info: DaemonInfo = {
      hostInstanceId: id,
      pid,
      ...(myStart ? { processStartTime: myStart } : {}),
      endpoint,
      ...(listenNow ? {} : { listening: false }),
      state: 'starting',
      startedAt: now(),
      hostKind: opts.hostKind,
      appVersion: opts.appVersion
    }
    writeAtomic(daemonPath, JSON.stringify(info, null, 2), 0o600, id, () => fault('after-daemon-tmp'))
    published = true
    fault('after-daemon-starting')
    fault('before-startup-release')
    removeStartupDir()
    return ownershipHandle(info, server, runtimeDir, secretAclWarning)
  } catch (e) {
    if (e instanceof OwnershipFaultError) {
      const srv = server
      const path = endpoint
      e.crash = () => simulateCrash(srv, path)
      await e.crash()
      throw e
    }
    if (e instanceof HostAlreadyRunningError) throw e
    if (e instanceof HostOwnershipError && e.code === 'daemon_json_unreadable') throw e
    // A real failure after the mutex: undo what we made, then let go of the mutex.
    try {
      server?.close()
    } catch {
      /* already closed */
    }
    if (endpoint && platform !== 'win32') rmSync(endpoint, { force: true })
    if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true })
    if (published && readDaemonInfo(dataDir)?.hostInstanceId === id) rmSync(daemonPath, { force: true })
    if (wroteSecret && !published) rmSync(secretPath, { force: true })
    removeStartupDir()
    throw e
  }

  async function takeStartupMutex(): Promise<void> {
    let liveSince: number | undefined
    for (;;) {
      try {
        mkdirSync(startupDir, { mode: 0o700 })
      } catch (e) {
        if (errCode(e) !== 'EEXIST') throw e
        const owner = parseOwner(readJsonFile(join(startupDir, OWNER_JSON), 4096))
        if (owner) {
          const state = await liveness(owner.pid, owner.processStartTime)
          if (state === 'unconfirmed' && mutexAge(owner) >= unconfirmedStaleMs) {
            // Startup holds the mutex for seconds; a pid that cannot be confirmed holding it this long is most likely a
            // stranger that reused a crashed holder's pid (review M9).
            warn(`OrgAI host ownership: startup.mkdir has been held by pid ${owner.pid} (not confirmed as an OrgAI host) for over ${Math.round(unconfirmedStaleMs / 1000)} s; reclaiming it.`)
            reclaimStartupDir({ owner })
            continue
          }
          if (state !== 'dead') {
            // Never steal from a live owner, however long it takes; give up after liveWaitMs.
            liveSince ??= now()
            if (now() - liveSince >= liveWaitMs) throw new HostStartingOrBusyError(owner.pid, runDir)
            await sleep(retryMs)
            continue
          }
          reclaimStartupDir({ owner })
          continue
        }
        // owner.json missing or corrupt: a writer between mkdir and rename while the dir is young.
        let mtime: number
        try {
          mtime = statSync(startupDir).mtimeMs
        } catch (err) {
          if (errCode(err) === 'ENOENT') continue
          throw err
        }
        if (now() - mtime < startupYoungMs) {
          await sleep(retryMs)
          continue
        }
        reclaimStartupDir({ owner: null })
        continue
      }
      fault('after-startup-mkdir')
      const record = { pid, ...(myStart ? { processStartTime: myStart } : {}), hostInstanceId: id, createdAt: now() }
      const ownerTmp = join(startupDir, `${OWNER_JSON}.tmp`)
      writeFileSync(ownerTmp, JSON.stringify(record), { mode: 0o600 })
      fault('after-owner-tmp')
      renameSyncRetry(ownerTmp, join(startupDir, OWNER_JSON))
      fault('after-owner-rename')
      return
    }
  }

  /** How long `owner` has held startup.mkdir: from its createdAt, else the owner file's mtime (0 when unknown). */
  function mutexAge(owner: OwnerRecord): number {
    if (owner.createdAt !== undefined && Number.isFinite(owner.createdAt)) return now() - owner.createdAt
    try {
      return Date.now() - statSync(join(startupDir, OWNER_JSON)).mtimeMs
    } catch {
      return 0
    }
  }

  /**
   * Rename a dead mutex out of the way (atomic: one contender wins), then remove the renamed copy. With `judged`, the
   * copy is first compared with what was judged dead (its owner, or still no owner and not young): when another
   * contender reclaimed it and took a fresh one between our check and the rename, the fresh one is put back.
   */
  function reclaimStartupDir(judged?: { owner: OwnerRecord | null }): void {
    const stale = `${startupDir}.stale-${randomUUID()}`
    try {
      renameSyncRetry(startupDir, stale)
    } catch (e) {
      if (errCode(e) === 'ENOENT') return // another contender won the rename; loop
      throw e
    }
    if (judged && !stillJudged(stale, judged)) {
      try {
        renameSync(stale, startupDir)
      } catch {
        // A newer mutex is already there; the moved one is lost and its holder goes on without it.
        rmSync(stale, { recursive: true, force: true })
      }
      return
    }
    rmSync(stale, { recursive: true, force: true })
  }

  function stillJudged(moved: string, judged: { owner: OwnerRecord | null }): boolean {
    const owner = parseOwner(readJsonFile(join(moved, OWNER_JSON), 4096))
    if (judged.owner) return !!owner && sameOwner(owner, judged.owner)
    if (owner) return false
    try {
      // Still as old as when it was judged; a fresh mkdir by another contender is young.
      return now() - statSync(moved).mtimeMs >= startupYoungMs
    } catch {
      return false
    }
  }

  /** Our own mutex, released the same atomic way. */
  function removeStartupDir(): void {
    try {
      const owner = parseOwner(readJsonFile(join(startupDir, OWNER_JSON), 4096))
      if (owner && owner.hostInstanceId !== id) return // not ours (cannot happen while we hold it)
      reclaimStartupDir()
    } catch {
      /* best effort */
    }
  }

  /** A dead host's socket: unlinked only when it is inside our run dir or an orgai-* runtime dir. */
  function unlinkStaleEndpoint(stale: string): void {
    if (platform === 'win32') return // pipes vanish with their process
    const parent = dirname(stale)
    const inRunDir = parent === runDir
    const inRuntimeDir = dirname(parent) === runtimeBase && RUNTIME_DIR_RE.test(basename(parent))
    if (!inRunDir && !inRuntimeDir) return
    try {
      if (lstatSync(stale).isSocket()) unlinkSync(stale)
    } catch {
      /* already gone */
    }
  }

  /**
   * With no live incumbent and the mutex held: remove leftovers of crashed hosts and contenders. `.stale-*` mutex
   * copies, `*.tmp-*` files (only ever written by an owner), `d-*.sock` files nobody listens on (a host that crashed
   * before publishing daemon.json; a socket that answers, or might, is never touched), and orgai-* runtime dirs whose
   * owner pid is dead.
   */
  async function sweepLeftovers(): Promise<void> {
    let names: string[] = []
    try {
      names = readdirSync(runDir)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(runDir, name)
      try {
        if (name.startsWith(`${STARTUP_DIR}.stale-`)) rmSync(path, { recursive: true, force: true })
        else if (/\.tmp-[0-9a-f]{12}$/.test(name)) rmSync(path, { force: true })
        else if (/^d-[0-9a-f]{12}\.sock$/.test(name) && name !== `d-${id}.sock` && lstatSync(path).isSocket()) {
          const answer = await probe(path, probeTimeoutMs)
          if (answer === 'refused' || answer === 'enoent') rmSync(path, { force: true })
        }
      } catch {
        /* best effort */
      }
    }
    if (platform === 'win32') return
    let base: string[] = []
    try {
      base = readdirSync(runtimeBase)
    } catch {
      return
    }
    for (const name of base) {
      if (!RUNTIME_DIR_RE.test(name) || name === `orgai-${id}`) continue
      const dir = join(runtimeBase, name)
      try {
        const st = lstatSync(dir)
        if (st.isSymbolicLink() || !st.isDirectory()) continue
        if (typeof process.getuid === 'function' && st.uid !== process.getuid()) continue
        const owner = parseOwner(readJsonFile(join(dir, OWNER_JSON), 4096))
        // No owner.json: maybe a host between mkdir and rename; leave it.
        if (!owner || (await liveness(owner.pid, owner.processStartTime)) !== 'dead') continue
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  }

  /** Where bindListener will listen, computed without touching the disk (review M11: daemon.json names it while off). */
  function plannedEndpoint(): { endpoint: string; runtimeDir?: string } {
    if (platform === 'win32') return { endpoint: pipeNameFor(dataDir, id, platform) }
    const path = socketPathFor(dataDir, id)
    if (Buffer.byteLength(path) < SOCKET_PATH_MAX) return { endpoint: path }
    const rtDir = runtimeDirFor(id, runtimeBase)
    const inRt = join(rtDir, 'd.sock')
    if (Buffer.byteLength(inRt) >= SOCKET_PATH_MAX) throw new HostOwnershipError('socket_path_too_long', `The socket path ${inRt} is too long.`)
    return { endpoint: inRt, runtimeDir: rtDir }
  }

  async function bindListener(): Promise<{ server: Server; endpoint: string; runtimeDir?: string }> {
    let path: string
    let rtDir: string | undefined
    if (platform === 'win32') {
      path = pipeNameFor(dataDir, id, platform)
    } else {
      path = socketPathFor(dataDir, id)
      if (Buffer.byteLength(path) >= SOCKET_PATH_MAX) {
        rtDir = runtimeDirFor(id, runtimeBase)
        try {
          mkdirSync(rtDir, { mode: 0o700 })
        } catch (e) {
          throw new HostOwnershipError('unsafe_runtime_dir', `Could not create ${rtDir}: ${(e as Error).message}`)
        }
        assertSafeDir(rtDir, 'unsafe_runtime_dir', platform)
        const record = { pid, ...(myStart ? { processStartTime: myStart } : {}), hostInstanceId: id }
        writeAtomic(join(rtDir, OWNER_JSON), JSON.stringify(record), 0o600, id)
        path = join(rtDir, 'd.sock')
        if (Buffer.byteLength(path) >= SOCKET_PATH_MAX) {
          rmSync(rtDir, { recursive: true, force: true })
          throw new HostOwnershipError('socket_path_too_long', `The socket path ${path} is too long.`)
        }
      }
    }
    const srv = createServer((socket) => {
      if (opts.onConnection) opts.onConnection(socket)
      else socket.destroy()
    })
    try {
      await new Promise<void>((ok, fail) => {
        srv.once('error', fail)
        srv.listen(path, () => {
          srv.off('error', fail)
          ok()
        })
      })
    } catch (e) {
      if (rtDir) rmSync(rtDir, { recursive: true, force: true })
      throw e
    }
    if (platform !== 'win32') chmodSync(path, 0o600)
    return { server: srv, endpoint: path, ...(rtDir ? { runtimeDir: rtDir } : {}) }
  }

  /**
   * An injected fault leaves disk as a crash would. The listener dies with a crashed process but its socket file
   * stays; Node's close() unlinks the file, so move it aside around the close and put it back (stale, refusing).
   */
  async function simulateCrash(srv: Server | undefined, path: string): Promise<void> {
    if (!srv?.listening) return
    const aside = platform !== 'win32' && path ? `${path}.crash` : undefined
    try {
      if (aside) renameSync(path, aside)
    } catch {
      /* nothing to keep */
    }
    await new Promise<void>((r) => srv.close(() => r()))
    try {
      if (aside) renameSync(aside, path)
    } catch {
      /* best effort */
    }
  }

  /**
   * Write daemon.secret (this instance's value). win32: the run folder, then the file, get a current-user-only DACL
   * (protectSecretOnWindows); 'required' throws on a failure, 'best-effort' returns the warning.
   */
  async function writeSecret(mode: 'required' | 'best-effort', onWritten: () => void = () => {}): Promise<string | undefined> {
    const write = (): void => {
      writeAtomic(secretPath, secretValue, 0o600, id)
      onWritten()
    }
    if (platform !== 'win32') {
      write()
      return undefined
    }
    return protectSecretOnWindows(runDir, write, { mode, warn, ...(opts.restrictAcl ? { restrict: opts.restrictAcl } : {}) })
  }

  function ownershipHandle(info: DaemonInfo, initialServer: Server | undefined, rtDir: string | undefined, aclWarning: string | undefined): HostOwnership {
    let current = info
    let released = false
    /** The bound listener; undefined while Terminal access is off (review M11). */
    let srv = initialServer
    /** setListening calls, one at a time. */
    let listenChain: Promise<void> = Promise.resolve()
    const write = (next: DaemonInfo): boolean => {
      if (released) return false
      if (readDaemonInfo(dataDir)?.hostInstanceId !== id) return false
      current = next
      writeAtomic(daemonPath, JSON.stringify(current, null, 2), 0o600, id)
      return true
    }
    const rewrite = (state: HostState): boolean => write({ ...current, state })
    const withListening = (on: boolean): DaemonInfo => {
      const { listening: _was, ...rest } = current
      return on ? rest : { ...rest, listening: false }
    }
    const removeSecretIfOurs = (): void => {
      try {
        if (readDaemonInfo(dataDir)?.hostInstanceId === id) rmSync(secretPath, { force: true })
      } catch {
        /* best effort */
      }
    }
    const removeEndpointFiles = (): void => {
      try {
        if (platform !== 'win32') rmSync(info.endpoint, { force: true })
        if (rtDir) rmSync(rtDir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
    async function openListener(): Promise<void> {
      if (released || srv) return
      let bound: Awaited<ReturnType<typeof bindListener>>
      try {
        // Terminal access is being turned on: an ACL failure keeps the listener off (never a fatal launch, review M8).
        await writeSecret('required')
        bound = await bindListener()
      } catch (e) {
        removeSecretIfOurs()
        throw e
      }
      if (released) {
        // Released while binding: undo it.
        await new Promise<void>((r) => bound.server.close(() => r()))
        removeEndpointFiles()
        return
      }
      srv = bound.server
      write(withListening(true))
    }
    async function closeListener(): Promise<void> {
      if (released || !srv) return
      const closing = srv
      srv = undefined
      // daemon.json first, so a client from now on reads "Terminal access is off" instead of a dead socket.
      write(withListening(false))
      removeSecretIfOurs()
      await new Promise<void>((r) => closing.close(() => r()))
      removeEndpointFiles()
    }
    return {
      get info() {
        return current
      },
      endpoint: info.endpoint,
      secretPath,
      ...(rtDir ? { runtimeDir: rtDir } : {}),
      ...(aclWarning ? { secretAclWarning: aclWarning } : {}),
      get listening() {
        return !!srv && !released
      },
      setListening(on: boolean) {
        const step = listenChain.then(() => (on ? openListener() : closeListener()))
        listenChain = step.catch(() => {})
        return step
      },
      markReady() {
        const wrote = rewrite('ready')
        try {
          fault('after-ready')
        } catch (e) {
          // A crash right after 'ready': the handle is abandoned, nothing is cleaned up (tests call e.crash()).
          released = true
          if (e instanceof OwnershipFaultError) e.crash = () => simulateCrash(srv, info.endpoint)
          throw e
        }
        return wrote
      },
      markDraining() {
        return rewrite('draining')
      },
      release() {
        if (released) return
        released = true
        try {
          releaseNow()
        } catch (e) {
          // A crash injected while releasing: nothing more is cleaned up (tests call e.crash()).
          if (e instanceof OwnershipFaultError) e.crash = () => simulateCrash(srv, info.endpoint)
          throw e
        }
      }
    }

    function releaseNow(): void {
      // One try at the mutex so a host starting right now does not read a half-removed state; go on regardless.
      let tookMutex = false
      try {
        mkdirSync(startupDir, { mode: 0o700 })
        tookMutex = true
      } catch {
        /* busy (or unwritable): go on anyway */
      }
      if (tookMutex) {
        fault('release-after-startup-mkdir')
        // tmp + rename like acquisition, so a contender never reads a half-written owner.json.
        try {
          const ownerTmp = join(startupDir, `${OWNER_JSON}.tmp`)
          writeFileSync(ownerTmp, JSON.stringify({ pid, ...(myStart ? { processStartTime: myStart } : {}), hostInstanceId: id, createdAt: now() }), { mode: 0o600 })
          fault('release-after-owner-tmp')
          renameSyncRetry(ownerTmp, join(startupDir, OWNER_JSON))
        } catch (e) {
          if (e instanceof OwnershipFaultError) throw e
          /* unwritable: the dir alone still marks the mutex taken */
        }
        fault('release-after-owner-rename')
      }
      let ours = false
      try {
        ours = readDaemonInfo(dataDir)?.hostInstanceId === id
      } catch {
        /* unreadable: not provably ours */
      }
      // The secret goes first, while daemon.json still names us: once daemon.json is gone a newer host may write its
      // own daemon.secret (same file name), and removing it afterwards would delete that one.
      if (ours) {
        try {
          rmSync(secretPath, { force: true })
        } catch {
          /* best effort */
        }
      }
      fault('release-after-secret-removed')
      if (ours) {
        try {
          unlinkSync(daemonPath)
        } catch {
          /* gone */
        }
      }
      fault('release-after-daemon-unlink')
      try {
        srv?.close()
      } catch {
        /* already closed */
      }
      srv = undefined
      fault('release-after-close')
      try {
        if (platform !== 'win32') rmSync(info.endpoint, { force: true })
        if (rtDir) rmSync(rtDir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
      if (tookMutex) {
        fault('release-before-startup-release')
        try {
          rmSync(startupDir, { recursive: true, force: true })
        } catch {
          /* best effort */
        }
      }
    }
  }
}

export interface ProtectSecretOptions {
  mode: 'required' | 'best-effort'
  warn?: (message: string) => void
  env?: NodeJS.ProcessEnv
  /** whoami + icacls stand-in (tests). Default: protocol.ts restrictDaemonSecretAcl (absolute System32 paths, H1). */
  restrict?: (path: string, directory: boolean) => Promise<string | undefined>
}

/**
 * win32 only: give the run folder a current-user-only DACL inherited by new files, call `write` (daemon.secret is then
 * born with that ACL, never an inherited broader one), then restrict the secret file itself too. The grant names the
 * user's SID from `whoami /user` (never USERDOMAIN / USERNAME from the environment), run by absolute path from the temp
 * folder (review H1, H2 (3)). This runs wherever the data folder lives, %APPDATA% included, like the socket server's
 * own check before the first hello. A failure (whoami or icacls missing or refusing: a junctioned profile, FAT / exFAT,
 * a network drive) throws HostOwnershipError('secret_acl_failed') in 'required' mode; in 'best-effort' mode it is
 * logged and returned as a warning sentence (review M8), and the secret is written regardless. Same-user programs are
 * not kept out by any ACL: the Terminal access level and the self-control gate are for those.
 * UNVERIFIED: never run on Windows from this code.
 */
export async function protectSecretOnWindows(runDir: string, write: () => void, opts: ProtectSecretOptions): Promise<string | undefined> {
  const restrict = opts.restrict ?? ((path: string, directory: boolean) => restrictDaemonSecretAcl(path, { directory, ...(opts.env ? { env: opts.env } : {}) }))
  const attempt = async (path: string, directory: boolean): Promise<string | undefined> => {
    try {
      return await restrict(path, directory)
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }
  let problem = await attempt(runDir, true)
  if (problem && opts.mode === 'required') throw new HostOwnershipError('secret_acl_failed', `Could not restrict the run folder: ${problem}`)
  write()
  if (!problem) problem = await attempt(join(runDir, DAEMON_SECRET), false)
  if (!problem) return undefined
  const sentence = `Could not restrict daemon.secret to the current Windows user: ${problem}`
  if (opts.mode === 'required') throw new HostOwnershipError('secret_acl_failed', sentence)
  const warning = `${sentence} Terminal access should stay off for this data folder (${dirname(runDir)}) until it is on a disk that keeps file permissions.`
  ;(opts.warn ?? ((m: string) => console.warn(m)))(`OrgAI host ownership: ${warning}`)
  return warning
}
