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
import { bootOrgAIHost, type HostBackgroundOptions, type OrgAIHost } from '../main/host/bootstrap'
import { currentHostInstanceId } from '../main/host/identity'
import { HostOwnershipError, acquireHostOwnership, type HostOwnership } from '../main/host/ownership'
import { HostSocketServer } from '../main/host/socketServer'
import { installLogging, log } from '../main/log'
import { stopSystemCertRead, trustSystemCertificates } from '../main/systemCerts'
import { orgaiCliRootsOf, setOrgaiCliRoots } from '../main/runtime/selfControlGate'
import { openSecretStore, type SecretCipher } from '../main/store/secrets'
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
   * Wave 7 (cli-standalone.md 4.1 step 4): per-kind overrides of startBackground (bootOrgAIHost `background`). A
   * management command's fallback host keeps connection probes and turns off discovery, prices and the usage monitor.
   */
  background?: HostBackgroundOptions
  /**
   * Wave 7 (cli-standalone.md 4.2): 'node' for the detached Node host (`orgai daemon run-node`), which is this host plus
   * the idle exit and the stored Terminal access (WP-E). Default 'inproc'.
   */
  hostKind?: 'inproc' | 'node'
  /**
   * The terminal UI owns the screen: console output goes to main.log only, never to the terminal (installLogging's
   * console mirror writes to stderr too). Default false.
   */
  quiet?: boolean
  /**
   * Trust the OS certificate store too (corporate / inspecting root CAs, issue #16), as the desktop app does: taken once
   * this process owns the data folder, stopped when the host ends. Default: on unless `startBackground` is false
   * (tests); hooks may be injected.
   */
  systemCertificates?: boolean | SystemCertHooks
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
  const hostKind = opts.hostKind ?? 'inproc'
  const server = new HostSocketServer({ dataDir, hostKind, hostInstanceId, appVersion: CLI_VERSION, mock: opts.mock, ...(opts.log ? { log: opts.log } : {}) })

  let ownership: HostOwnership
  try {
    ownership = await acquireHostOwnership({ dataDir, hostKind, appVersion: CLI_VERSION, hostInstanceId, onConnection: (s) => server.accept(s) })
  } catch (e) {
    server.close()
    if (e instanceof HostOwnershipError) throw new CliError(e.message, EXIT.hostBusy)
    throw e
  }
  // After ownership (the in-process twin of the desktop's single-instance lock), before anything can fetch.
  const certOpt = opts.systemCertificates ?? opts.startBackground !== false
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
  const onExit = (): void => {
    stopCerts()
    ownership.release()
  }
  process.on('exit', onExit)

  let resolveClosed!: () => void
  const closed = new Promise<void>((r) => (resolveClosed = r))
  let host: OrgAIHost | undefined
  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    stopCerts()
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
    // Wave 7 (cli-standalone.md 5.6): open (and later reconcile) the secret store after ownership, before the boot.
    // Today's read-only store with the CLI's overlay; WP-G makes it the vault without touching this call.
    const secretStore = await openSecretStore({
      dataDir,
      userDataDir,
      hostKind,
      cipher: NO_CIPHER,
      readOnly: true,
      overlay: opts.overlay,
      env: opts.env,
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
