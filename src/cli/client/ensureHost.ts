/**
 * The host of every command that starts, continues or manages work (`orgai exec`, `resume`, the terminal UI, a bare
 * prompt and every `withHost` management command; cli-standalone-default.md 4.1): this process's own in-process host,
 * started here and connected to over its own socket with the memory-only owner proof. There is no other kind of host,
 * no background host and no app to find. While another orgai owns the data folder the start is refused at once with
 * exit 6 (ownership `wait: 'none'`, ownedMessage.ts).
 *
 * Interactivity follows the client kind: exec, resume --exec and the other commands connect as 'cli' (the default) and
 * never count as interactive. The terminal UI connects with `clientKind: 'tui'`: the host counts 'tui' sockets as
 * interactiveClients and fills `decidedBy.surface` 'tui' on the decisions it sends.
 */
import type { HostClientKind, HostScope } from '../../shared/types'
import { CliError, EXIT, HOST_STARTING_WAIT_MS, type CliContext, type ConnectResult, type HostClient, type InprocHostHandle, type InprocStartOptions } from '../types'

/** How long a 'starting' host is waited for when connecting to this process's own host. */
export const ENSURE_HOST_STARTING_WAIT_MS = HOST_STARTING_WAIT_MS

/**
 * The background options of a management command's host: connection status probes stay on, model discovery, community
 * prices and the usage monitor are off (system certificates stay on in inprocHost.ts).
 */
export const MANAGEMENT_INPROC: InprocStartOptions = {
  background: { connectionProbes: true, modelDiscovery: false, communityPrices: false, usageMonitor: false }
}

/**
 * The background options of a headless `orgai exec` / `resume --exec` host: no model discovery (a first sweep 20 s
 * after boot, then hourly) and no plan-usage monitor (a provider probe at boot and every 10 minutes): nothing a
 * one-shot run reads. Connection probes and community prices stay (the run's connection status and its cost / budget
 * math); system certificates still load once the process owns the folder, before any provider call.
 */
export const EXEC_INPROC: InprocStartOptions = {
  background: { connectionProbes: true, modelDiscovery: false, communityPrices: true, usageMonitor: false }
}

export interface EnsuredHost {
  client: HostClient
  /** The in-process host, which the caller stops when done. */
  inproc: InprocHostHandle
}

export interface EnsureHostOptions {
  /** Exec clients are never interactive; only `false` is accepted (it changes nothing; 'cli' clients never are). */
  interactive?: false
  /** 'cli' (default; non-interactive) or 'tui' (the interactive terminal UI; counted as an interactive client). */
  clientKind?: HostClientKind
  /** How the host this call starts boots (withHost passes MANAGEMENT_INPROC). Default: everything on. */
  inproc?: InprocStartOptions
}

/** The CliError for a failed connect to this process's own host. */
export function connectFailure(res: Extract<ConnectResult, { ok: false }>): CliError {
  switch (res.reason) {
    case 'auth_failed':
      return new CliError(res.message || 'The orgai host did not pass the handshake check.', EXIT.auth)
    case 'draining':
      return new CliError(res.message || 'orgai is shutting down; try again in a moment.', EXIT.hostBusy)
    case 'starting':
      return new CliError(res.message || 'orgai is still starting; try again in a moment.', EXIT.hostBusy)
    default:
      return new CliError(res.message || `Could not connect to the orgai host (${res.reason}).`, EXIT.failure)
  }
}

/**
 * Throws a CliError for a scope the host did not grant. The orgai host grants its own process every scope, so this only
 * guards a host that answered with less.
 */
export function missingScopesError(client: Pick<HostClient, 'hello'>, wanted: readonly HostScope[]): CliError | undefined {
  const granted = client.hello.grantedScopes
  const missing = Array.isArray(granted) ? wanted.filter((s) => !granted.includes(s)) : []
  if (!missing.length) return undefined
  return new CliError(`The orgai host did not grant the ${missing.map((s) => `'${s}'`).join(', ')} access this needs.`, EXIT.failure)
}

/** Start this process's host and connect to it; a failed connect stops it again. */
export async function ensureHost(ctx: CliContext, scopes: HostScope[], opts: EnsureHostOptions = {}): Promise<EnsuredHost> {
  const clientKind: HostClientKind = opts.clientKind ?? 'cli'
  const inproc = await ctx.startInproc(opts.inproc)
  let res: ConnectResult
  try {
    res = await ctx.connect(scopes, { clientKind, waitStartingMs: ENSURE_HOST_STARTING_WAIT_MS })
  } catch (e) {
    await inproc.stop(true).catch(() => undefined)
    throw e
  }
  if (!res.ok) {
    await inproc.stop(true).catch(() => undefined)
    throw connectFailure(res)
  }
  return { client: res.client, inproc }
}
