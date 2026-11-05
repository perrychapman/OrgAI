/**
 * A host for commands that start or continue runs (`orgai exec`, `orgai resume --exec`; cli-spec 3.2(1), 6.2).
 *
 * - `--host inproc`: start a pure-Node host in this process, then connect to its own socket.
 * - `auto` / `daemon`: connect (waiting up to 2 s while a host is starting). With no host, start the app headless
 *   (launcher) and wait up to 30 s for an Electron host (headless-host or desktop) to be ready, as `orgai daemon start`
 *   does, then connect.
 *
 * Refusals: terminal access off exits 1 naming App settings > Terminal access; a failed handshake proof exits 5; a
 * draining host, or one still starting past the wait, exits 6; anything else exits 1. The client never marks itself
 * interactive (exec runs must not hold the human grace window).
 */
import type { HostClientKind, HostKind, HostScope } from '../../shared/types'
import { CliError, EXIT, type CliContext, type ConnectResult, type HostClient, type InprocHostHandle } from '../types'

export const ENSURE_HOST_READY_TIMEOUT_MS = 30_000
export const ENSURE_HOST_STARTING_WAIT_MS = 2_000
const ELECTRON_HOST_KINDS: readonly HostKind[] = ['headless-host', 'desktop']

export const TERMINAL_ACCESS_HINT = 'Terminal access is off. Turn it on in OrgAI: App settings > General > Advanced settings > Terminal access.'

export interface EnsuredHost {
  client: HostClient
  /** Set with --host inproc: the in-process host, which the caller stops when done. */
  inproc?: InprocHostHandle
  /** True when this call started the host. */
  started: boolean
}

export interface EnsureHostOptions {
  /** Exec clients are never interactive; only `false` is accepted. */
  interactive?: false
  clientKind?: HostClientKind
}

/** The CliError for a failed connect. */
export function connectFailure(res: Extract<ConnectResult, { ok: false }>): CliError {
  switch (res.reason) {
    case 'disabled': {
      const m = res.message || ''
      return new CliError(/Terminal access/i.test(m) ? m : TERMINAL_ACCESS_HINT, EXIT.failure)
    }
    case 'auth_failed':
      return new CliError(res.message || 'The OrgAI host did not pass the handshake check.', EXIT.auth)
    case 'draining':
      return new CliError(res.message || 'OrgAI is shutting down; try again in a moment.', EXIT.hostBusy)
    case 'starting':
      return new CliError(res.message || 'OrgAI is still starting; try again in a moment.', EXIT.hostBusy)
    case 'no_host':
      return new CliError(res.message || 'No OrgAI host is running.', EXIT.failure)
    default:
      return new CliError(res.message || `Could not connect to the OrgAI host (${res.reason}).`, EXIT.failure)
  }
}

export async function ensureHost(ctx: CliContext, scopes: HostScope[], opts: EnsureHostOptions = {}): Promise<EnsuredHost> {
  const clientKind: HostClientKind = opts.clientKind ?? 'cli'
  const connect = (): Promise<ConnectResult> => ctx.connect(scopes, { clientKind, waitStartingMs: ENSURE_HOST_STARTING_WAIT_MS })

  if (ctx.globals.host === 'inproc') {
    const inproc = await ctx.startInproc()
    let res: ConnectResult
    try {
      res = await connect()
    } catch (e) {
      await inproc.stop(true).catch(() => undefined)
      throw e
    }
    if (!res.ok) {
      await inproc.stop(true).catch(() => undefined)
      throw connectFailure(res)
    }
    return { client: res.client, inproc, started: true }
  }

  const first = await connect()
  if (first.ok) return { client: first.client, started: false }
  if (first.reason !== 'no_host') throw connectFailure(first)

  const app = ctx.launcher.resolve()
  if ('error' in app) throw new CliError(app.error, EXIT.failure)
  let ready
  try {
    ctx.launcher.spawn({ headless: true })
    // Only an Electron host counts (a running desktop app takes the hand-off); an inproc host's daemon.json never does.
    ready = await ctx.launcher.waitForReady({ timeoutMs: ENSURE_HOST_READY_TIMEOUT_MS, hostKinds: ELECTRON_HOST_KINDS })
  } catch (e) {
    throw new CliError(`Could not start the OrgAI host: ${e instanceof Error ? e.message : String(e)}`, EXIT.failure)
  }
  if (!ready) throw new CliError(`The OrgAI host did not become ready within ${ENSURE_HOST_READY_TIMEOUT_MS / 1000} s. See \`orgai daemon logs\`.`, EXIT.hostBusy)
  const second = await connect()
  if (!second.ok) throw connectFailure(second)
  return { client: second.client, started: true }
}
