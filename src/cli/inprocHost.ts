/**
 * `--host inproc` (cli-spec 3.2(1), 3.5): a pure-Node OrgAI host inside the CLI process. Same ownership protocol as
 * the Electron host (refuses with exit 6 when another host owns the data dir), its own per-instance socket so
 * `orgai watch` and later `orgai decide` can attach, and a read-only SecretStore with the CLI's environment overlay
 * (no safeStorage outside Electron: stored secrets cannot be decrypted and nothing is ever saved). There is no desktop,
 * so window:openRun answers desktop_unavailable. Always loaded through a dynamic import (its own chunk,
 * out/cli/inprocHost.mjs). Electron-free; relative imports only.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootOrgAIHost, type OrgAIHost } from '../main/host/bootstrap'
import { currentHostInstanceId } from '../main/host/identity'
import { HostOwnershipError, acquireHostOwnership, type HostOwnership } from '../main/host/ownership'
import { HostSocketServer } from '../main/host/socketServer'
import { installLogging, log } from '../main/log'
import { orgaiCliRootsOf, setOrgaiCliRoots } from '../main/runtime/selfControlGate'
import type { SecretCipher } from '../main/store/secrets'
import { openUrl } from './openUrl'
import { CliError, EXIT, type InprocHostHandle } from './types'
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
  /** bootOrgAIHost's background probes and discovery. Default true; tests turn it off. */
  startBackground?: boolean
  /**
   * The terminal UI owns the screen: console output goes to main.log only, never to the terminal (installLogging's
   * console mirror writes to stderr too). Default false.
   */
  quiet?: boolean
}

/** Console methods that write to main.log only (`--host inproc` under the terminal UI). */
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
    throw new Error('Secrets cannot be encrypted outside the OrgAI app.')
  },
  decryptString: () => {
    throw new Error('Stored secrets cannot be read outside the OrgAI app.')
  }
}

/**
 * The self-control gate's CLI folders for a chunk in `moduleDir`: it sits in out/cli (bundled) or src/cli (sources),
 * two levels below the app root either way. In a packaged app that root is `<Resources>/app.asar.unpacked`, so
 * orgaiCliRootsOf adds the unpacked bundle and `<Resources>/bin` (the launcher) too.
 */
export function inprocCliRoots(moduleDir: string, platform: NodeJS.Platform = process.platform): string[] {
  return orgaiCliRootsOf(resolve(moduleDir, '..', '..'), platform)
}

export async function startInprocHost(opts: StartInprocHostOptions): Promise<InprocHost> {
  try {
    setOrgaiCliRoots(inprocCliRoots(dirname(fileURLToPath(import.meta.url))))
  } catch {
    // No module URL (an unusual loader): the gate still matches the orgai file names.
  }
  const { userDataDir, dataDir } = opts
  const logsDir = join(userDataDir, 'logs')
  if (opts.logging !== false) installLogging({ userDataDir, logsDir, appVersion: CLI_VERSION, isPackaged: false })
  if (opts.quiet) quietConsole()
  const hostInstanceId = currentHostInstanceId()
  const server = new HostSocketServer({ dataDir, hostKind: 'inproc', hostInstanceId, appVersion: CLI_VERSION, mock: opts.mock, ...(opts.log ? { log: opts.log } : {}) })

  let ownership: HostOwnership
  try {
    ownership = await acquireHostOwnership({ dataDir, hostKind: 'inproc', appVersion: CLI_VERSION, hostInstanceId, onConnection: (s) => server.accept(s) })
  } catch (e) {
    server.close()
    if (e instanceof HostOwnershipError) throw new CliError(e.message, EXIT.hostBusy)
    throw e
  }
  const onExit = (): void => ownership.release()
  process.on('exit', onExit)

  let resolveClosed!: () => void
  const closed = new Promise<void>((r) => (resolveClosed = r))
  let host: OrgAIHost | undefined
  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    server.close()
    host?.dispose()
    try {
      ownership.release()
    } catch {
      // release is best effort here; the drain already released.
    }
    process.off('exit', onExit)
    resolveClosed()
  }

  try {
    host = bootOrgAIHost({
      env: { userDataDir, logsDir, appVersion: CLI_VERSION, isPackaged: false },
      dataDir,
      hostKind: 'inproc',
      ownership,
      safeStorage: NO_CIPHER,
      secrets: { readOnly: true, overlay: opts.overlay },
      openExternal: (url) => openUrl(url),
      mock: opts.mock,
      processEnv: opts.env,
      ...(opts.startBackground === false ? { startBackground: false } : {}),
      onDrained: cleanup
    })
  } catch (e) {
    cleanup()
    throw e
  }
  server.attach(host)
  const booted = host

  return {
    host: booted,
    server,
    ownership,
    closed,
    status: () => booted.hostControl.status(),
    async stop(force: boolean): Promise<void> {
      if (cleaned) return closed
      const res = await booted.hostControl.stop({ force })
      if (!res.stopping) {
        const busy = Object.entries(res.refusedBecause ?? {})
          .map(([k, n]) => `${k} ${n}`)
          .join(', ')
        throw new CliError(`The in-process host is busy${busy ? ` (${busy})` : ''}; stop it with --force to end live runs.`, EXIT.hostBusy)
      }
      await closed
    }
  }
}
