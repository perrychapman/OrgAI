/**
 * A host for commands that start or continue runs (`orgai exec`, `orgai resume --exec`; cli-spec 3.2(1), 6.2).
 *
 * - `--host inproc`: start a pure-Node host in this process, then connect to its own socket.
 * - `auto` / `daemon`: connect (waiting up to 2 s while a host is starting). With no host, start the app headless
 *   (launcher) and wait up to 30 s for an Electron host (headless-host or desktop) to be ready, as `orgai daemon start`
 *   does, then connect.
 *
 * Refusals: terminal access off exits 1 naming App settings > Terminal access; a failed handshake proof exits 5; a
 * draining host, or one still starting past the wait, exits 6; anything else exits 1.
 *
 * Interactivity follows the client kind: exec, resume --exec and the other commands connect as 'cli' (the default) and
 * never count as interactive (exec runs must not hold the human grace window). The terminal UI connects with
 * `clientKind: 'tui'`: the host counts 'tui' sockets as interactiveClients (a person is watching) and fills
 * `decidedBy.surface` 'tui' on the decisions it sends.
 */
import type { HostClientKind, HostKind, HostScope } from '../../shared/types'
import { HostTakenError } from './launcher'
import { nodeHostDeps, nodeHostRefusal } from '../nodeHost'
import { note } from '../output'
import { levelNote } from '../terminalAccessSettings'
import { CliError, EXIT, type CliContext, type ConnectResult, type HostClient, type InprocHostHandle } from '../types'

export const ENSURE_HOST_READY_TIMEOUT_MS = 30_000
export const ENSURE_HOST_STARTING_WAIT_MS = 2_000
const ELECTRON_HOST_KINDS: readonly HostKind[] = ['headless-host', 'desktop']

export const TERMINAL_ACCESS_HINT = 'Terminal access is off. Turn it on in OrgAI: App settings > General > Advanced settings > Terminal access.'

/**
 * Why a host withheld 'decide' / 'configure' (AppSettings.terminalAccessLevel 'operate', the default; review H2). Only
 * the OrgAI window raises it, never a terminal client.
 */
export const TERMINAL_FULL_ACCESS_HINT =
  'Terminal access lets terminal clients watch and run work only. To answer decisions or change settings from a terminal, allow it in OrgAI: App settings > General > Advanced settings > Terminal access, or use `--host inproc`.'

/** TERMINAL_FULL_ACCESS_HINT for a Node host: no App settings on an npm-only machine (Wave 7, review round 1). */
export const NODE_TERMINAL_FULL_ACCESS_HINT =
  'Terminal access lets terminal clients watch and run work only. To answer decisions or change settings from a terminal, stop the Node host (`orgai daemon stop`), then run `orgai terminal-access --level full`, or use `--host inproc`.'

/** A host of another version grants this CLI only read, operate, decide and host.stop. */
export const VERSION_SKEW_SCOPE_HINT = 'A host of another version accepts only read, operate and decide from this CLI.'

/**
 * The CliError when a host granted fewer scopes than asked (`missing`), or undefined when nothing is missing: the
 * version-skew hint for a skewed host, else the Terminal access level hint (for a Node host, the orgai commands that
 * change it).
 */
export function missingScopesError(client: Pick<HostClient, 'hello'>, wanted: readonly HostScope[]): CliError | undefined {
  const granted = client.hello.grantedScopes
  const missing = Array.isArray(granted) ? wanted.filter((s) => !granted.includes(s)) : []
  if (!missing.length) return undefined
  const hint = client.hello.versionSkewWarning
    ? VERSION_SKEW_SCOPE_HINT
    : client.hello.hostKind === 'node'
      ? NODE_TERMINAL_FULL_ACCESS_HINT
      : TERMINAL_FULL_ACCESS_HINT
  return new CliError(`The OrgAI host did not grant the ${missing.map((s) => `'${s}'`).join(', ')} access this needs. ${hint}`, EXIT.failure)
}

export interface EnsuredHost {
  client: HostClient
  /** Set with --host inproc: the in-process host, which the caller stops when done. */
  inproc?: InprocHostHandle
  /** True when this call started the host. */
  started: boolean
}

export interface EnsureHostOptions {
  /** Exec clients are never interactive; only `false` is accepted (it changes nothing; 'cli' clients never are). */
  interactive?: false
  /** 'cli' (default; non-interactive) or 'tui' (the interactive terminal UI; counted as an interactive client). */
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

  // The background host we started handed off to a live host of another kind that won the start race (review round 2):
  // `--host daemon` takes either background kind (cli-standalone.md 4.1), so use that host.
  const useIncumbent = async (): Promise<EnsuredHost> => {
    const res = await connect()
    if (!res.ok) throw connectFailure(res)
    return { client: res.client, started: false }
  }

  let ready
  // Wave 7 (cli-standalone.md 4.1, 4.2): `--host daemon` never runs a host in-process; with no app anywhere it starts the
  // detached Node host (refused when install.json says app or Terminal access is stored off; nodeHost.ts).
  if (ctx.globals.host === 'daemon' && ctx.launcher.startBackground && ctx.launcher.locate().status === 'absent') {
    const refusal = nodeHostRefusal(ctx)
    if (refusal) throw refusal
    // Nothing asks here (exec and scripts are not interactive): say which level the new host grants and how to change it.
    const stored = nodeHostDeps.terminalAccess(ctx.paths.dataDir)
    if (!stored.levelChosen) note(ctx, levelNote(stored.level))
    try {
      const started = ctx.launcher.startBackground('node')
      ready = await ctx.launcher.waitForReady({ timeoutMs: ENSURE_HOST_READY_TIMEOUT_MS, hostKinds: started.hostKinds })
    } catch (e) {
      if (e instanceof HostTakenError) return useIncumbent()
      throw new CliError(`Could not start the OrgAI Node host: ${e instanceof Error ? e.message : String(e)}`, EXIT.failure)
    }
    if (!ready) throw new CliError(`The OrgAI Node host did not become ready within ${ENSURE_HOST_READY_TIMEOUT_MS / 1000} s. See \`orgai daemon logs\`.`, EXIT.hostBusy)
    const second = await connect()
    if (!second.ok) throw connectFailure(second)
    return { client: second.client, started: true }
  }

  const app = ctx.launcher.resolve()
  if ('error' in app) throw new CliError(app.error, EXIT.failure)
  try {
    ctx.launcher.spawn({ headless: true })
    // Only an Electron host counts (a running desktop app takes the hand-off); an inproc host's daemon.json never does.
    ready = await ctx.launcher.waitForReady({ timeoutMs: ENSURE_HOST_READY_TIMEOUT_MS, hostKinds: ELECTRON_HOST_KINDS })
  } catch (e) {
    if (e instanceof HostTakenError) return useIncumbent()
    throw new CliError(`Could not start the OrgAI host: ${e instanceof Error ? e.message : String(e)}`, EXIT.failure)
  }
  if (!ready) throw new CliError(`The OrgAI host did not become ready within ${ENSURE_HOST_READY_TIMEOUT_MS / 1000} s. See \`orgai daemon logs\`.`, EXIT.hostBusy)
  const second = await connect()
  if (!second.ok) throw connectFailure(second)
  return { client: second.client, started: true }
}
