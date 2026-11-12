/**
 * The orgai host (cli-standalone-default.md 4.1): a pure-Node OrgAI host inside the CLI process, the only host there is.
 * Ownership is taken with `wait: 'none'`, so another orgai on the data folder is refused at once with exit 6 (its pid and
 * cwd come from daemon.json). By default the host listens on nothing (`listen: false`: no Unix socket or named pipe, no
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
import { HostAlreadyRunningError, HostOwnershipError, HostStartingOrBusyError, acquireHostOwnership, type HostOwnership } from '../main/host/ownership'
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
import { RPC_BULK_FRAME_MAX_BYTES, type HostClientKind, type HostScope } from '../shared/types'
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
 * or destroying either side closes both. The write callback runs once the chunk is queued on the peer, so the host's
 * outbound queue never waits for a 'drain' that depends on the reader.
 */
export function memoryStreamPair(): [Duplex, Duplex] {
  const make = (peer: () => Duplex): Duplex =>
    new Duplex({
      highWaterMark: 64 * 1024 * 1024,
      read() {},
      write(chunk: Buffer, _enc, cb) {
        peer().push(chunk)
        cb()
      },
      final(cb) {
        peer().push(null)
        cb()
      },
      destroy(err, cb) {
        const other = peer()
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
  const hostInstanceId = currentHostInstanceId()
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
  try {
    // wait: 'none' (spec 4.2): another orgai, starting or running, is refused at once; a provably stale record is reclaimed.
    ownership = await acquireHostOwnership({
      dataDir,
      hostKind,
      appVersion: CLI_VERSION,
      hostInstanceId,
      wait: 'none',
      listen: opts.listen === true,
      warn: (m) => void heldWarnings.push(m),
      ownerCwd: opts.cwd ?? process.cwd(),
      onConnection: (s) => server.accept(s)
    })
    ownershipRef = ownership
  } catch (e) {
    server.close()
    for (const m of heldWarnings) process.stderr.write(`${m}\n`)
    if (e instanceof HostAlreadyRunningError) throw new CliError(ownedMessage(ownerWordsOf(e.info)), EXIT.hostBusy)
    if (e instanceof HostStartingOrBusyError) throw new CliError(ownedMessage(e.ownerPid ? { pid: e.ownerPid } : {}), EXIT.hostBusy)
    // An unreadable record that is not provably stale is "owned" (spec 4.2); other ownership failures keep their message.
    if (e instanceof HostOwnershipError && e.code === 'daemon_json_unreadable') throw new CliError(ownedMessage(e.ownerPid ? { pid: e.ownerPid } : {}), EXIT.hostBusy)
    if (e instanceof HostOwnershipError) throw new CliError(e.message, EXIT.hostBusy)
    throw e
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
      onDrained: cleanup
    })
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
