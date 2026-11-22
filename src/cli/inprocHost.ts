/**
 * The orgai host (cli-standalone-default.md 4.1): a pure-Node OrgAI host inside the CLI process, the only host there is.
 *
 * Sessions (docs/design/cli-sessions.md): any number of orgai processes share one data folder. Each is a session
 * (main/host/sessions.ts): it registers under the startup mutex, routes every shared file through the data folder's
 * write lock (main/store/shared/storeSync.ts), hosts its own runs and holds the projects it works in. A second orgai is
 * therefore not refused; what is refused (exit 6, naming the other session's folder and pid) is a second session on
 * the same project, and changing a run another session hosts. An orgai from before sessions, or one started with
 * `listen: true`, still owns the folder alone and is refused, or refuses, as before (ownedMessage.ts).
 *
 * By default the host listens on nothing (`listen: false`: no Unix socket or named pipe, no
 * daemon.secret, no icacls, and no lsof / ps peer check): this process's own commands and the terminal UI reach it
 * through `connectLocal`, an in-memory stream pair served by the same HostSocketServer code (surface 'inproc'), which
 * keeps the JSON codec, frame caps, run subscriptions and journal of the socket path. With `listen: true` it also binds
 * the socket, and that socket serves its own process only: a hello needs the memory-only `ownerKey` proof, which is how
 * this process's client gets every scope (anything else is refused `not_owner`). Secure storage is the
 * CLI's own vault (product 'cli') with the CLI's environment overlay: no safeStorage outside Electron, and values this
 * host stores go to vault.json (created lazily by prepareWrite). There is no desktop, so window:openRun answers
 * desktop_unavailable. Always loaded through a dynamic import (its own chunk, out/cli/inprocHost.mjs). Electron-free;
 * relative imports only.
 */
import { writeSync } from 'node:fs'
import { Duplex } from 'node:stream'
import type { Socket } from 'node:net'
import { dirname, join, posix, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootOrgAIHost, type HostBackgroundOptions, type OrgAIHost } from '../main/host/bootstrap'
import { currentHostInstanceId } from '../main/host/identity'
import { HostAlreadyRunningError, HostOwnershipError, HostStartingOrBusyError, acquireHostOwnership, runDirHint, runDirOf, type HostOwnership } from '../main/host/ownership'
import { isSessionLive, registerSession, sweepDeadSessions, type ClaimResult, type SessionHandle, type SessionRecord } from '../main/host/sessions'
import { sweepStaleSkillDirsAsync } from '../main/runtime/claudeSkills'
import { createSharedStoreSync, enableStoreSync } from '../main/store/shared/storeSync'
import { LineReader, newNonce } from '../main/host/protocol'
import { ShutdownRefusedError } from '../main/host/shutdown'
import { HostSocketServer } from '../main/host/socketServer'
import { installLogging, log } from '../main/log'
import { stopSystemCertRead, trustSystemCertificates } from '../main/systemCerts'
import { orgaiCliRootsOf, setOrgaiCliRoots } from '../main/runtime/selfControlGate'
import { openSecretStore, type SecretCipher } from '../main/store/secrets'
import type { CustodianFactory } from '../main/store/vaultTypes'
import { ownedMessage, ownerWordsOf } from './ownedMessage'
import { openUrl } from './openUrl'
import { unavailableCustodianFactory } from '../main/store/unavailableCustodian'
import { DEFAULT_CALL_TIMEOUT_MS, SocketHostClient } from './client/hostClient'
import { CliError, EXIT, type ConnectResult, type InprocHostHandle } from './types'
import { RPC_BULK_FRAME_MAX_BYTES, type DaemonInfo, type HostClientKind, type HostScope } from '../shared/types'
import { CLI_VERSION } from './version'

export interface StartInprocHostOptions {
  userDataDir: string
  dataDir: string
  /** The process environment the host reads (already scrubbed of ORGAI_SECRET_* and consumed variables). */
  env: NodeJS.ProcessEnv
  mock: boolean
  overlay: ReadonlyMap<string, string>
  log?: (m: string) => void
  /** installLogging (main.log under `<userDataDir>/logs`, console patches). Default true; tests turn it off. */
  logging?: boolean
  /** bootOrgAIHost's background probes and discovery (its `startBackground`). Default true; tests turn it off. */
  startBackground?: boolean
  /**
   * Wave 7 (cli-standalone.md 4.1 step 4): per-kind overrides of the switch above (bootOrgAIHost `background`). A
   * management command's fallback host keeps connection probes and turns off discovery, prices and the usage monitor.
   */
  background?: HostBackgroundOptions
  /**
   * Bind the owner-only socket (and write daemon.secret) as before. Default false: the process serves itself through
   * connectLocal, and a second orgai on the folder is still refused through daemon.json (`listening: false`) and the
   * live pid. Tests of the raw socket pass true.
   */
  listen?: boolean
  /** This process's cwd, written to daemon.json as `ownerCwd` for the refusal other terminals print. Default process.cwd(). */
  cwd?: string
  /** What this process is, in a word or two, for the other sessions' status and refusals ('tui', 'exec', 'projects set'). Default 'orgai'. */
  command?: string
  /**
   * Sweep stale run skill folders out of the temp folder after the start, when this is the only session (a folder read
   * off the start path; a management command's short host skips it). Default true.
   */
  tempSweep?: boolean
  /** How often a session checks that daemon.json still names a running one, and takes it over if not (ms). Default 2000; 0 = never. */
  adoptEveryMs?: number
  /** This host's instance id. Default: the process's own (currentHostInstanceId). Tests that put two hosts in one process give each its own. */
  hostInstanceId?: string
  /**
   * The terminal UI owns the screen: console output goes to main.log only, never to the terminal (installLogging's
   * console mirror writes to stderr too). Default false.
   */
  quiet?: boolean
  /**
   * Trust the OS certificate store too (corporate / inspecting root CAs, issue #16), as the desktop app does: taken once
   * this process owns the data folder, stopped when the host ends. Default on (Wave 7, cli-standalone.md 4.1 step 4: it
   * no longer follows `startBackground`, so a management command's host still trusts a corporate root CA); tests pass
   * false or inject hooks.
   */
  systemCertificates?: boolean | SystemCertHooks
  /**
   * Wave 7 (cli-standalone.md 5.3): the vault's key custodian per scheme. Default: openSecretStore's (unavailable until
   * the platform custodians are wired in); tests inject fakes.
   */
  custodian?: CustodianFactory
  /**
   * The shutdown's hard limit (cli-standalone.md 4.3): writers still in flight after SHUTDOWN_HARD_LIMIT_MS, the host's
   * descendants killed. Default `inprocHardLimitExit`: tell the terminal and end the process with EXIT.failure, so the
   * process 'exit' hook releases the data folder only once no in-process writer can run any more. Tests pass their own.
   */
  exitAtHardLimit?: () => void
  /** The shutdown's hard limit and tree-kill waits (bootOrgAIHost shutdownLimits); tests shorten them. */
  shutdownLimits?: { hardLimitMs?: number; kill?: { termGraceMs?: number; waitMs?: number; stepMs?: number } }
}

/** What the terminal is told when the in-process host ends at its hard limit. */
export const INPROC_HARD_LIMIT_MESSAGE =
  "orgai: the in-process host's work did not finish in time; its child processes were ended and the command exits now. See main.log."

/**
 * The in-process and Node hosts' exit at the hard limit (4.3: "kills ... and exits; the exit hooks release"). The CLI
 * only sets process.exitCode and lets the event loop drain, which a hung writer (a worktree operation behind another
 * process's repo lock) would keep alive, still writing after a release; so the process ends here. The message is
 * written from the last 'exit' listener, after the terminal UI restored the screen. Never returns (process.exit).
 */
export function inprocHardLimitExit(proc: Pick<NodeJS.Process, 'once' | 'exit'> = process, write: (s: string) => void = (s) => void writeSync(2, s)): void {
  log.warn('In-process host: writers still in flight at the hard limit; exiting now.')
  proc.once('exit', () => {
    try {
      write(`${INPROC_HARD_LIMIT_MESSAGE}\n`)
    } catch {
      // stderr closed: nothing left to tell.
    }
  })
  proc.exit(EXIT.failure)
}

/** The certificate setup the in-process host calls (src/main/systemCerts.ts). */
export interface SystemCertHooks {
  trust(env: NodeJS.ProcessEnv): void
  stop(): void
}

const SYSTEM_CERTS: SystemCertHooks = {
  // The macOS reader child gets a minimal environment built from the host's own (childEnvFor), never NODE_OPTIONS.
  trust: (env) => void trustSystemCertificates({ env }),
  stop: () => stopSystemCertRead()
}

/** Console methods that write to main.log only (the terminal UI owns the screen). */
export function quietConsole(target: Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug'> = console): void {
  target.log = (...args: unknown[]): void => log.info(...args)
  target.info = (...args: unknown[]): void => log.info(...args)
  target.debug = (...args: unknown[]): void => log.debug(...args)
  target.warn = (...args: unknown[]): void => log.warn(...args)
  target.error = (...args: unknown[]): void => log.error(...args)
}

/** The handle plus the host and server themselves (tests, and commands that need the dispatcher directly). */
export interface InprocHost extends InprocHostHandle {
  readonly host: OrgAIHost
  readonly server: HostSocketServer
  readonly ownership: HostOwnership
  /** This process's session; undefined with `listen: true` (the folder is then owned alone). */
  readonly session?: SessionHandle
}

/** How long a starting orgai waits for another one that is starting at the same moment (it holds the startup mutex for a moment). */
export const SESSION_START_WAIT_MS = 15_000

/** daemon.json for a session that takes over advertising the folder (ownership.ts `successor` and `adopt`). */
export function daemonInfoOfSession(s: SessionRecord, endpointFallback: string): DaemonInfo {
  return {
    hostInstanceId: s.hostInstanceId,
    pid: s.pid,
    ...(s.processStartTime ? { processStartTime: s.processStartTime } : {}),
    endpoint: s.endpoint || endpointFallback,
    listening: false,
    ...(s.endpoint && s.livenessProbe ? { livenessProbe: true as const } : {}),
    state: 'ready',
    startedAt: s.startedAt,
    hostKind: 'inproc',
    appVersion: s.appVersion,
    ...(s.cwd ? { ownerCwd: s.cwd } : {}),
    sessions: true
  }
}

/** No safeStorage outside Electron: nothing can be encrypted, and stored values cannot be decrypted. */
export const NO_CIPHER: SecretCipher = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error('Secrets cannot be encrypted by this legacy cipher; orgai keeps its secrets in its own vault.')
  },
  decryptString: () => {
    throw new Error('Stored secrets cannot be read by this legacy cipher; orgai keeps its secrets in its own vault.')
  }
}

/**
 * The self-control gate's CLI folders for a chunk in `moduleDir`: it sits in out/cli (bundled) or src/cli (sources),
 * two levels below the app root either way.
 */
export function inprocCliRoots(moduleDir: string, platform: NodeJS.Platform = process.platform): string[] {
  const p = platform === 'win32' ? win32 : posix
  return orgaiCliRootsOf(p.resolve(moduleDir, '..', '..'), platform)
}

/**
 * Two connected in-memory duplexes (a stand-in for a connected socket pair): what one writes the other reads, and ending
 * or destroying either side closes both. Backpressure works as on a socket: when the reader's buffer is full (push
 * returns false), the writer's callback waits until the reader asks for more (its read()), so a writer that respects
 * write() / 'drain' (the host's outbound queue) never has more than one buffer of unread data in flight.
 */
export function memoryStreamPair(highWaterMark = 1024 * 1024): [Duplex, Duplex] {
  /** Per reader: the write callback of its peer, waiting for this side to read. */
  const waiting = new Map<Duplex, () => void>()
  const make = (peer: () => Duplex): Duplex =>
    new Duplex({
      highWaterMark,
      read() {
        const cb = waiting.get(this)
        if (cb) {
          waiting.delete(this)
          cb()
        }
      },
      write(chunk: Buffer, _enc, cb) {
        const other = peer()
        if (other.push(chunk)) cb()
        else waiting.set(other, cb)
      },
      final(cb) {
        peer().push(null)
        cb()
      },
      destroy(err, cb) {
        const other = peer()
        // A write parked on a full reader settles now (it would otherwise wait for a read that never comes).
        for (const side of [this, other]) {
          const parked = waiting.get(side)
          if (parked) {
            waiting.delete(side)
            parked()
          }
        }
        if (!other.destroyed) queueMicrotask(() => other.destroy())
        cb(err)
      }
    })
  const a: Duplex = make(() => b)
  const b: Duplex = make(() => a)
  return [a, b]
}

export async function startInprocHost(opts: StartInprocHostOptions): Promise<InprocHost> {
  try {
    setOrgaiCliRoots(inprocCliRoots(dirname(fileURLToPath(import.meta.url))))
  } catch {
    // No module URL (an unusual loader): the gate still matches the orgai file names.
  }
  const { userDataDir, dataDir } = opts
  const logsDir = join(userDataDir, 'logs')
  const hostInstanceId = opts.hostInstanceId ?? currentHostInstanceId()
  const hostKind = 'inproc' as const
  // In memory only (never daemon.json, daemon.secret or a log): this process's proof that it started the host, so its
  // own commands get every scope; any other client of the socket is refused as not_owner (spec 4.1).
  const ownerKey = newNonce()
  const server = new HostSocketServer({
    dataDir,
    hostKind,
    hostInstanceId,
    appVersion: CLI_VERSION,
    mock: opts.mock,
    ...(ownerKey ? { ownerKey } : {}),
    // Ownership restricts daemon.secret before it binds; the server only refuses while that reported a problem.
    secretAclProblem: () => ownershipRef?.secretAclWarning,
    ...(opts.log ? { log: opts.log } : {})
  })

  let ownershipRef: HostOwnership | undefined
  let ownership: HostOwnership
  // Ownership warnings wait in memory: before installLogging the logger has no folder (it would fall back to the shared
  // <tmpdir>/orgai-logs), and the console may be the terminal UI's screen. They go to main.log once it is open, or to
  // stderr when ownership is refused.
  const heldWarnings: string[] = []
  // Sessions: every orgai that does not serve a socket shares the folder. A socket (`listen: true`, tests of the raw
  // protocol) needs daemon.secret, which is one file for the folder, so that host owns the folder alone as before.
  const sharing = opts.listen !== true
  const cwd = opts.cwd ?? process.cwd()
  let session: SessionHandle | undefined
  try {
    ownership = await acquireHostOwnership({
      dataDir,
      hostKind,
      appVersion: CLI_VERSION,
      hostInstanceId,
      // Alone on the folder (listen: true): another orgai, starting or running, is refused at once (spec 4.2). Sharing
      // it: an orgai that is starting right now holds the startup mutex for a moment, and this one waits its turn.
      ...(sharing ? { wait: 'wait' as const, liveWaitMs: SESSION_START_WAIT_MS, retryMs: 25 } : { wait: 'none' as const }),
      listen: opts.listen === true,
      warn: (m) => void heldWarnings.push(m),
      ownerCwd: cwd,
      onConnection: (s) => server.accept(s),
      ...(sharing
        ? {
            sessions: {
              // Under the startup mutex: what dead sessions left goes first, then this one registers.
              register: (facts) => {
                sweepDeadSessions(dataDir)
                session = registerSession(dataDir, {
                  hostInstanceId,
                  pid: process.pid,
                  ...(facts.processStartTime ? { processStartTime: facts.processStartTime } : {}),
                  startedAt: Date.now(),
                  appVersion: CLI_VERSION,
                  cwd,
                  command: opts.command ?? 'orgai',
                  endpoint: facts.endpoint,
                  ...(facts.livenessProbe ? { livenessProbe: true } : {})
                })
              },
              isLive: (id) => id === hostInstanceId || isSessionLive(dataDir, id),
              // The oldest other session takes over advertising the folder when this one leaves.
              successor: () => {
                const next = session?.others()[0]
                return next ? daemonInfoOfSession(next, ownershipRef?.endpoint ?? '') : undefined
              }
            }
          }
        : {})
    })
    ownershipRef = ownership
  } catch (e) {
    ;(session as SessionHandle | undefined)?.release()
    server.close()
    for (const m of heldWarnings) process.stderr.write(`${m}\n`)
    // Each "owned" refusal names the way out when nothing is really running: delete the run folder (review M2 on PR 49).
    const runDir = runDirOf(dataDir)
    if (e instanceof HostAlreadyRunningError) throw new CliError(`${ownedMessage(ownerWordsOf(e.info))} ${runDirHint(runDir)}`, EXIT.hostBusy)
    if (e instanceof HostStartingOrBusyError) throw new CliError(`${ownedMessage(e.ownerPid ? { pid: e.ownerPid } : {})} ${runDirHint(runDir)}`, EXIT.hostBusy)
    // An unreadable record that is not provably stale is "owned" (spec 4.2); other ownership failures keep their message.
    if (e instanceof HostOwnershipError && e.code === 'daemon_json_unreadable') throw new CliError(`${ownedMessage(e.ownerPid ? { pid: e.ownerPid } : {})} ${runDirHint(runDir)}`, EXIT.hostBusy)
    if (e instanceof HostOwnershipError) throw new CliError(e.message, EXIT.hostBusy)
    throw e
  }
  // From here on every store of this data folder reads and writes through the session's sync (set before any is built).
  const held = session as SessionHandle | undefined
  const sync = held ? createSharedStoreSync(held) : undefined
  const disableSync = sync ? enableStoreSync(dataDir, sync) : undefined
  // After a crash of the session daemon.json names, a survivor takes the record over, so the folder never looks free
  // to an orgai from before sessions for longer than this check's period.
  const adoptEveryMs = opts.adoptEveryMs ?? 2000
  const adoptTimer = held && adoptEveryMs > 0 ? setInterval(() => void ownership.adopt(), adoptEveryMs) : undefined
  adoptTimer?.unref()
  const endSession = (): void => {
    if (adoptTimer) clearInterval(adoptTimer)
    disableSync?.()
    sync?.close()
    held?.release()
  }
  // Logging only once ownership is held: a refused second orgai must not create logs/ or rotate main.log under the owner
  // (it reports on stderr only; spec 4.2).
  if (opts.logging !== false) installLogging({ userDataDir, logsDir, appVersion: CLI_VERSION, isPackaged: false })
  if (opts.quiet) quietConsole()
  for (const m of heldWarnings) log.warn(m)
  // After ownership (the in-process twin of the desktop's single-instance lock), before anything can fetch.
  const certOpt = opts.systemCertificates ?? true
  const certs = certOpt === true ? SYSTEM_CERTS : certOpt === false ? undefined : certOpt
  const stopCerts = (): void => {
    try {
      certs?.stop()
    } catch {
      // stopping a finished read is a no-op
    }
  }
  try {
    certs?.trust(opts.env)
  } catch (e) {
    log.warn(`System certificates not added: ${e instanceof Error ? e.message : String(e)}`)
  }
  // The exit hook releases only when the process ends without the shutdown sequence (a crash, process.exit elsewhere):
  // the process's own writes end with it.
  const onExit = (): void => {
    stopCerts()
    ownership.release()
    endSession()
  }
  process.on('exit', onExit)

  let resolveClosed!: () => void
  const closed = new Promise<void>((r) => (resolveClosed = r))
  let host: OrgAIHost | undefined
  let cleaned = false
  // Wave 7 (cli-standalone.md 4.3): reached through the shutdown coordinator once it released ownership (the writers
  // settled and the socket closed gracefully), or directly when the boot failed. At the hard limit the process exits
  // instead (exitAtHardLimit) and onExit releases.
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    stopCerts()
    server.close()
    host?.dispose()
    try {
      ownership.release()
    } catch {
      // release is best effort here; the shutdown already released.
    }
    // After the release (which hands daemon.json to another session while this one is still listed among them).
    endSession()
    process.off('exit', onExit)
    resolveClosed()
  }

  try {
    // Wave 7 (cli-standalone.md 5.6): open and reconcile secure storage after ownership, before the boot. A Node or
    // inproc host never creates a vault here: the first stored value does (prepareWrite, awaited by invokeRpc).
    const secretStore = await openSecretStore({
      dataDir,
      userDataDir,
      hostKind,
      product: 'cli',
      cipher: NO_CIPHER,
      overlay: opts.overlay,
      env: opts.env,
      // A mock host (e2e, verify-pack) never writes an OS key item for a throwaway data folder unless a key file is named.
      ...(opts.custodian ? { custodian: opts.custodian } : opts.mock && !((opts.env?.ORGAI_CLI_VAULT_KEY_FILE ?? '').trim()) ? { custodian: unavailableCustodianFactory } : {}),
      log: (m) => log.info(m)
    })
    host = bootOrgAIHost({
      env: { userDataDir, logsDir, appVersion: CLI_VERSION, isPackaged: false },
      dataDir,
      hostKind,
      ownership,
      safeStorage: NO_CIPHER,
      secretStore,
      openExternal: (url) => openUrl(url),
      mock: opts.mock,
      processEnv: opts.env,
      ...(opts.startBackground === false ? { startBackground: false } : {}),
      ...(opts.background ? { background: opts.background } : {}),
      // The shutdown sequence: flush the host.stop reply, then release, then this cleanup.
      closeSocket: (graceMs) => server.closeGracefully(graceMs),
      terminalSessions: () => server.terminalSessionCount(),
      // At the hard limit the process ends (its exit hook releases), never a release with writers still alive.
      exitAtHardLimit: opts.exitAtHardLimit ?? (() => inprocHardLimitExit()),
      ...(opts.shutdownLimits ? { shutdownLimits: opts.shutdownLimits } : {}),
      // Sharing the folder: housekeeping deletes what no run in the index points to, so it runs below, and only alone.
      ...(held ? { deferHousekeeping: true } : {}),
      onDrained: cleanup
    })
    if (held) {
      // The only session: clean up what earlier ones left, inside the startup mutex so that nobody can join meanwhile
      // (a session registers inside it). With others running, or the mutex busy, this start skips it; the next lone one does it.
      const booted = host
      const alone = ownership.tryUnderStartupMutex(() => {
        if (held.others().length > 0) return false
        booted.housekeep()
        return true
      })
      // Stale run skill folders in the temp folder: read off the start path. Folders are judged by age, so a session
      // that starts meanwhile loses nothing.
      if (alone?.value === true && opts.tempSweep !== false) void sweepStaleSkillDirsAsync().catch(() => undefined)
    }
  } catch (e) {
    cleanup()
    throw e
  }
  server.attach(host)
  const booted = host
  const connectLocal: NonNullable<InprocHostHandle['connectLocal']> = async (scopes: HostScope[], local: { clientKind?: HostClientKind; cwd?: string } = {}): Promise<ConnectResult> => {
    const daemon = ownership.info
    const [clientSide, serverSide] = memoryStreamPair()
    const clientKind = local.clientKind ?? 'cli'
    const accepted = server.acceptLocal(serverSide as unknown as Socket, { clientKind, pid: process.pid, requestedScopes: scopes })
    if (!accepted.ok) {
      clientSide.destroy()
      const code = accepted.error.code
      return { ok: false, reason: code === 'host_draining' ? 'draining' : code === 'host_starting' ? 'starting' : 'refused', message: accepted.error.message, daemon }
    }
    const hello = {
      protocolVersion: 1 as const,
      hostInstanceId,
      hostKind,
      appVersion: CLI_VERSION,
      dataDir,
      mock: opts.mock,
      grantedScopes: accepted.grantedScopes,
      // No handshake took place (the stream pair is in-process), so there is no proof to carry.
      hostProof: ''
    }
    const reader = new LineReader()
    reader.maxLineBytes = RPC_BULK_FRAME_MAX_BYTES
    return { ok: true, client: new SocketHostClient(clientSide, reader, hello, daemon, DEFAULT_CALL_TIMEOUT_MS) }
  }

  return {
    host: booted,
    server,
    ownership,
    ...(held ? { session: held } : {}),
    // The project a command works in, claimed up front so that a second session on it is told at once (exit 6).
    claimProject: (projectId: string): ClaimResult => (held ? held.claimProject(projectId) : { ok: true }),
    otherSessions: (): SessionRecord[] => (held ? held.others() : []),
    closed,
    ownerKey,
    hostInstanceId,
    connectLocal,
    status: () => booted.hostControl.status(),
    async stop(force: boolean): Promise<void> {
      if (cleaned) return closed
      try {
        // The coordinator's sequence (drain, writers settle, socket closes, release), then cleanup resolves `closed`.
        await booted.shutdown.shutdown('inproc-cleanup', { force })
      } catch (e) {
        if (!(e instanceof ShutdownRefusedError)) throw e
        const busy = Object.entries(e.result.refusedBecause ?? {})
          .map(([k, n]) => `${k} ${n}`)
          .join(', ')
        throw new CliError(`The in-process host is busy${busy ? ` (${busy})` : ''}; stop it with --force to end live runs.`, EXIT.hostBusy)
      }
      await closed
    }
  }
}
