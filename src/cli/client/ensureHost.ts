/**
 * A host for every command that starts, continues or manages work (`orgai exec`, `resume`, the terminal UI, a bare
 * prompt and every `withHost` management command; cli-spec 3.2(1), 6.2; cli-standalone.md 4.1).
 *
 * - `--host inproc`: start a pure-Node host in this process, then connect to its own socket.
 * - `--host auto`:
 *   1. A live host answers: connect. Environment secrets meet it here (secretOverlay.ts liveHostSecretAnswer): an
 *      explicit --secret-env, or an ambient ORGAI_SECRET_* on a command that would use it, is refused (exit 2); any other
 *      ambient one is ignored with one warning.
 *   2. A host is starting: wait up to HOST_STARTING_WAIT_MS (15 s), as connect does.
 *   3. No live host and environment secrets present: run in-process so they are used (never spawn the app).
 *   4. Else HostLauncher.locate(): 'found' spawns the app headless and waits up to 30 s for a background host
 *      (BACKGROUND_HOST_KINDS); 'broken' is an error naming the path; 'absent' runs in-process with one stderr note in
 *      text mode.
 * - `--host daemon`: never in-process (cli-spec 3.2(3)). With no live host it starts a background host: the app when
 *   locate() finds one, else a Node host through `launcher.startBackground('node')` when this build has it, else an
 *   error; then it waits for any BACKGROUND_HOST_KINDS host.
 *
 * Refusals: terminal access off exits 1 naming App settings > Terminal access; a failed handshake proof exits 5; a
 * draining host, or one still starting past the wait, exits 6; anything else exits 1.
 *
 * Interactivity follows the client kind: exec, resume --exec and the other commands connect as 'cli' (the default) and
 * never count as interactive (exec runs must not hold the human grace window). The terminal UI connects with
 * `clientKind: 'tui'`: the host counts 'tui' sockets as interactiveClients (a person is watching) and fills
 * `decidedBy.surface` 'tui' on the decisions it sends.
 */
import { BACKGROUND_HOST_KINDS, type HostClientKind, type HostScope } from '../../shared/types'
import { note, warn } from '../output'
import { liveHostSecretAnswer, SECRET_ENV_IGNORED_WARNING } from '../secretOverlay'
import { CliError, EXIT, HOST_STARTING_WAIT_MS, type CliContext, type ConnectResult, type HostClient, type InprocHostHandle, type InprocStartOptions } from '../types'

export const ENSURE_HOST_READY_TIMEOUT_MS = 30_000
/** How long a 'starting' host is waited for (Wave 7: HOST_STARTING_WAIT_MS, 15 s; was 2 s). */
export const ENSURE_HOST_STARTING_WAIT_MS = HOST_STARTING_WAIT_MS

/** The one stderr line (text mode) when `--host auto` finds neither a host nor an app (4.1 step 4). */
export const INPROC_FALLBACK_NOTE = 'No OrgAI app or background host found; running the host inside this command. `orgai daemon start` keeps one running.'

/** The stderr line (text mode) when environment secrets keep `--host auto` in-process (round 6 item 8). */
export const INPROC_SECRETS_NOTE = 'Environment secrets are set; running the host inside this command so they are used.'

/** `--host daemon` with no app and no Node background host in this build. */
export const NO_BACKGROUND_HOST_MESSAGE =
  'No OrgAI app was found to start as a background host, and this orgai cannot start a Node background host. Install OrgAI or set ORGAI_ELECTRON_PATH, or use --host auto or --host inproc.'

/**
 * The background options of a management command's in-process host (cli-standalone.md 4.1 step 4): connection status
 * probes stay on, model discovery, community prices and the usage monitor are off (system certificates stay on in
 * inprocHost.ts).
 */
export const MANAGEMENT_INPROC: InprocStartOptions = {
  background: { connectionProbes: true, modelDiscovery: false, communityPrices: false, usageMonitor: false }
}

export const TERMINAL_ACCESS_HINT = 'Terminal access is off. Turn it on in OrgAI: App settings > General > Advanced settings > Terminal access.'

/**
 * Why a host withheld 'decide' / 'configure' (AppSettings.terminalAccessLevel 'operate', the default; review H2). Only
 * the OrgAI window raises it, never a terminal client.
 */
export const TERMINAL_FULL_ACCESS_HINT =
  'Terminal access lets terminal clients watch and run work only. To answer decisions or change settings from a terminal, allow it in OrgAI: App settings > General > Advanced settings > Terminal access, or use `--host inproc`.'

/** A host of another version grants this CLI only read, operate, decide and host.stop. */
export const VERSION_SKEW_SCOPE_HINT = 'A host of another version accepts only read, operate and decide from this CLI.'

/**
 * The CliError when a host granted fewer scopes than asked (`missing`), or undefined when nothing is missing: the
 * version-skew hint for a skewed host, else the Terminal access level hint.
 */
export function missingScopesError(client: Pick<HostClient, 'hello'>, wanted: readonly HostScope[]): CliError | undefined {
  const granted = client.hello.grantedScopes
  const missing = Array.isArray(granted) ? wanted.filter((s) => !granted.includes(s)) : []
  if (!missing.length) return undefined
  const hint = client.hello.versionSkewWarning ? VERSION_SKEW_SCOPE_HINT : TERMINAL_FULL_ACCESS_HINT
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
  /** How an in-process host this call starts boots (withHost passes MANAGEMENT_INPROC). Default: everything on. */
  inproc?: InprocStartOptions
}

/** Contexts that already printed a one-time line (the secret warning, an in-process note); several calls per command. */
const saidOnce = new WeakMap<CliContext, Set<string>>()
function once(ctx: CliContext, line: string): boolean {
  let said = saidOnce.get(ctx)
  if (!said) saidOnce.set(ctx, (said = new Set()))
  if (said.has(line)) return false
  said.add(line)
  return true
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

/** Start an in-process host and connect to it; a failed connect stops it again. */
async function inprocHost(ctx: CliContext, connect: () => Promise<ConnectResult>, opts: InprocStartOptions | undefined): Promise<EnsuredHost> {
  const inproc = await ctx.startInproc(opts)
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

/** Spawn or start a background host and wait for any BACKGROUND_HOST_KINDS host to be ready. */
async function startBackground(ctx: CliContext, start: () => unknown): Promise<void> {
  let ready
  try {
    await start()
    // Only a background host counts (a running desktop app takes the hand-off); an inproc host's daemon.json never does.
    ready = await ctx.launcher.waitForReady({ timeoutMs: ENSURE_HOST_READY_TIMEOUT_MS, hostKinds: BACKGROUND_HOST_KINDS })
  } catch (e) {
    throw new CliError(`Could not start the OrgAI host: ${e instanceof Error ? e.message : String(e)}`, EXIT.failure)
  }
  if (!ready) throw new CliError(`The OrgAI host did not become ready within ${ENSURE_HOST_READY_TIMEOUT_MS / 1000} s. See \`orgai daemon logs\`.`, EXIT.hostBusy)
}

export async function ensureHost(ctx: CliContext, scopes: HostScope[], opts: EnsureHostOptions = {}): Promise<EnsuredHost> {
  const clientKind: HostClientKind = opts.clientKind ?? 'cli'
  const connect = (): Promise<ConnectResult> => ctx.connect(scopes, { clientKind, waitStartingMs: ENSURE_HOST_STARTING_WAIT_MS })
  const mode = ctx.globals.host

  if (mode === 'inproc') return inprocHost(ctx, connect, opts.inproc)

  const first = await connect()
  if (first.ok) {
    const answer = liveHostSecretAnswer(ctx.secretEnv)
    if (answer === 'warn') {
      if (once(ctx, SECRET_ENV_IGNORED_WARNING)) warn(ctx, SECRET_ENV_IGNORED_WARNING)
    } else if (answer !== null) {
      first.client.close()
      throw new CliError(answer, EXIT.usage)
    }
    return { client: first.client, started: false }
  }
  if (first.reason !== 'no_host') throw connectFailure(first)

  if (mode === 'auto' && (ctx.secretEnv?.explicit || ctx.secretEnv?.ambient)) {
    if (once(ctx, INPROC_SECRETS_NOTE)) note(ctx, INPROC_SECRETS_NOTE)
    return inprocHost(ctx, connect, opts.inproc)
  }

  const app = ctx.launcher.locate()
  if (app.status === 'broken') throw new CliError(app.message, EXIT.failure)
  if (app.status === 'absent') {
    if (mode === 'auto') {
      if (once(ctx, INPROC_FALLBACK_NOTE)) note(ctx, INPROC_FALLBACK_NOTE)
      return inprocHost(ctx, connect, opts.inproc)
    }
    // --host daemon: a Node background host when this build can start one, never in-process.
    const startNode = ctx.launcher.startBackground?.bind(ctx.launcher)
    if (!startNode) throw new CliError(NO_BACKGROUND_HOST_MESSAGE, EXIT.failure)
    await startBackground(ctx, () => startNode('node'))
  } else {
    const { status: _found, ...found } = app
    await startBackground(ctx, () => ctx.launcher.spawn({ headless: true, app: found }))
  }
  const second = await connect()
  if (!second.ok) throw connectFailure(second)
  return { client: second.client, started: true }
}
