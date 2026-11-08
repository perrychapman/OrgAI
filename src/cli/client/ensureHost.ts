/**
 * A host for every command that starts, continues or manages work (`orgai exec`, `resume`, the terminal UI, a bare
 * prompt and every `withHost` management command; cli-spec 3.2(1), 6.2; cli-standalone.md 4.1).
 *
 * - `--host inproc`: start a pure-Node host in this process, then connect to its own socket.
 * - `--host auto`:
 *   0. Another command's own in-process host (an 'inproc' host that is neither this context's nor marked shared by
 *      `daemon start --host inproc`, client/sharedHost.ts) is never used: it ends with that command and drains with
 *      force, stopping anything started on it. Wait for it to go (HostLauncher.waitForGone, HOST_STARTING_WAIT_MS in all,
 *      one stderr note), then go on as if no host had answered; still there: exit 6 (WP-B review round 2).
 *   1. A live host answers: connect. Environment secrets meet it here (secretOverlay.ts liveHostSecretAnswer): an
 *      explicit --secret-env, or an ambient ORGAI_SECRET_* on a command that would use it, is refused (exit 2); any other
 *      ambient one is ignored with one warning.
 *   2. A host is starting: wait up to HOST_STARTING_WAIT_MS (15 s), as connect does.
 *   3. No live host: run in-process (cli-standalone-default.md 4.1). `--host auto` never starts the desktop app, visible
 *      or hidden: the command hosts itself, so its host is its own build, runs with the terminal's own folder access,
 *      and the terminal that started it answers its approvals (ownerProof). One stderr note in text mode. The terminal
 *      UI's host (shareInproc) is shared (client/sharedHost.ts) so `orgai` in another terminal attaches to it instead of
 *      waiting; command-scoped TUIs (assistants) and other commands keep theirs.
 *      The headless app is only started on request: `--host daemon`, `orgai daemon start`, `orgai app`.
 * - `--host daemon`: never in-process (cli-spec 3.2(3)); step 0 applies too. With no live host it starts a background host: the app when
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
import { BACKGROUND_HOST_KINDS, HOST_KIND_CAPABILITIES, type HostClientKind, type HostKind, type HostScope } from '../../shared/types'
import { nodeHostDeps, nodeHostRefusal } from '../nodeHost'
import { note, warn } from '../output'
import { liveHostSecretAnswer, SECRET_ENV_IGNORED_WARNING } from '../secretOverlay'
import { CliError, EXIT, HOST_STARTING_WAIT_MS, type CliContext, type ConnectResult, type HostClient, type InprocHostHandle, type InprocStartOptions } from '../types'
import { levelNote } from '../terminalAccessSettings'
import { HostTakenError } from './launcher'
import { isSharedInprocHost } from './sharedHost'

export const ENSURE_HOST_READY_TIMEOUT_MS = 30_000
/** How long a 'starting' host is waited for (Wave 7: HOST_STARTING_WAIT_MS, 15 s; was 2 s). */
export const ENSURE_HOST_STARTING_WAIT_MS = HOST_STARTING_WAIT_MS

/** The one stderr line (text mode) when `--host auto` finds neither a host nor an app (4.1 step 4). */
export const INPROC_FALLBACK_NOTE = 'No OrgAI host is running, so this command runs its own. `orgai daemon start` keeps one running in the background.'

/** The stderr line (text mode) when environment secrets keep `--host auto` in-process (round 6 item 8). */
export const INPROC_SECRETS_NOTE = 'Environment secrets are set; running the host inside this command so they are used.'

/** The stderr line (text mode) while ensureHost waits for another command's own in-process host to end. */
export const OTHER_COMMAND_HOST_NOTE = 'Another orgai command is running its own host for this data folder; waiting for it to finish.'

/** Exit 6 when another command's own in-process host is still there after the wait. */
export const OTHER_COMMAND_HOST_MESSAGE =
  'Another orgai command is still running its own host for this data folder, and that host ends with it. Try again when it finishes, or keep a host running for every terminal with `orgai daemon start`.'

/** How many times ensureHost waits for another command's host before it gives up (each wait shares one deadline). */
const OTHER_COMMAND_HOST_ROUNDS = 5

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

/** TERMINAL_FULL_ACCESS_HINT for a Node host: no App settings on an npm-only machine (Wave 7, review round 1). */
export const NODE_TERMINAL_FULL_ACCESS_HINT =
  'Terminal access lets terminal clients watch and run work only. To answer decisions or change settings from a terminal, stop the background host (`orgai daemon stop`), then run `orgai terminal-access --level full`, or use `--host inproc`.'

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
  /** How an in-process host this call starts boots (withHost passes MANAGEMENT_INPROC). Default: everything on. */
  inproc?: InprocStartOptions
  /**
   * `--host auto` only: an in-process host this call starts serves other terminals (marked shared). The workspace
   * terminal UI passes true; command-scoped TUIs (assistants that exit when their run ends and stop on quit) and every
   * other command leave it off, so their host ends with them and other terminals wait it out (step 0).
   */
  shareInproc?: boolean
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

/** The in-process host each context started and has not seen end: the only 'inproc' host it may attach to unmarked. */
const ownInproc = new WeakMap<CliContext, InprocHostHandle>()

function inProcessKind(kind: HostKind | undefined): boolean {
  return kind !== undefined && Object.prototype.hasOwnProperty.call(HOST_KIND_CAPABILITIES, kind) && HOST_KIND_CAPABILITIES[kind].inProcess
}

function isOwnHost(ctx: CliContext, hostInstanceId: string): boolean {
  const own = ownInproc.get(ctx)
  if (!own) return false
  try {
    return own.status().hostInstanceId === hostInstanceId
  } catch {
    return false
  }
}

/**
 * The id of another command's own in-process host behind this connect answer (a live one, or one draining), else
 * undefined: an 'inproc' host that is not this context's own and not marked shared (client/sharedHost.ts).
 */
function otherCommandHost(ctx: CliContext, res: ConnectResult): string | undefined {
  const kind = res.ok ? res.client.hello.hostKind : res.reason === 'draining' ? res.daemon?.hostKind : undefined
  const id = res.ok ? res.client.hello.hostInstanceId : res.daemon?.hostInstanceId
  if (!inProcessKind(kind) || typeof id !== 'string') return undefined
  if (isOwnHost(ctx, id) || isSharedInprocHost(ctx.paths.dataDir, id)) return undefined
  return id
}

/**
 * Connect, waiting out another command's own in-process host (step 0): its id closes the client, prints the note once,
 * waits for that host to go and connects again. Gives up with exit 6 after HOST_STARTING_WAIT_MS in all.
 */
async function connectPastOtherCommandHosts(ctx: CliContext, connect: () => Promise<ConnectResult>): Promise<ConnectResult> {
  const deadline = Date.now() + ENSURE_HOST_STARTING_WAIT_MS
  let res = await connect()
  for (let round = 0; ; round++) {
    const other = otherCommandHost(ctx, res)
    if (other === undefined) return res
    if (res.ok) res.client.close()
    if (round >= OTHER_COMMAND_HOST_ROUNDS) throw new CliError(OTHER_COMMAND_HOST_MESSAGE, EXIT.hostBusy)
    if (once(ctx, OTHER_COMMAND_HOST_NOTE)) note(ctx, OTHER_COMMAND_HOST_NOTE)
    const left = deadline - Date.now()
    const gone = left > 0 && (await ctx.launcher.waitForGone({ timeoutMs: left, hostInstanceId: other }))
    if (!gone) throw new CliError(OTHER_COMMAND_HOST_MESSAGE, EXIT.hostBusy)
    res = await connect()
  }
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
  ownInproc.set(ctx, inproc)
  const forget = (): void => {
    if (ownInproc.get(ctx) === inproc) ownInproc.delete(ctx)
  }
  inproc.closed.then(forget, forget)
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

/**
 * Spawn or start a background host and wait for a host of `hostKinds` to be ready. 'taken' = the host we started handed
 * off to a live host of another kind that won the start race (review round 2): `--host daemon` takes either background
 * kind (cli-standalone.md 4.1), so the caller connects to that host.
 */
async function startBackground(ctx: CliContext, start: () => unknown, label: string, hostKinds: readonly HostKind[]): Promise<'ready' | 'taken'> {
  let ready
  try {
    const started = (await start()) as { hostKinds?: readonly HostKind[] } | undefined
    // Only a background host counts (a running desktop app takes the hand-off); an inproc host's daemon.json never does.
    ready = await ctx.launcher.waitForReady({ timeoutMs: ENSURE_HOST_READY_TIMEOUT_MS, hostKinds: started?.hostKinds ?? hostKinds })
  } catch (e) {
    if (e instanceof HostTakenError) return 'taken'
    throw new CliError(`Could not start the OrgAI ${label}: ${e instanceof Error ? e.message : String(e)}`, EXIT.failure)
  }
  if (!ready) throw new CliError(`The OrgAI ${label} did not become ready within ${ENSURE_HOST_READY_TIMEOUT_MS / 1000} s. See \`orgai daemon logs\`.`, EXIT.hostBusy)
  return 'ready'
}

export async function ensureHost(ctx: CliContext, scopes: HostScope[], opts: EnsureHostOptions = {}): Promise<EnsuredHost> {
  const clientKind: HostClientKind = opts.clientKind ?? 'cli'
  const connect = (): Promise<ConnectResult> => ctx.connect(scopes, { clientKind, waitStartingMs: ENSURE_HOST_STARTING_WAIT_MS })
  const mode = ctx.globals.host

  if (mode === 'inproc') return inprocHost(ctx, connect, opts.inproc)

  const first = await connectPastOtherCommandHosts(ctx, connect)
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

  if (mode === 'auto') {
    const line = ctx.secretEnv?.explicit || ctx.secretEnv?.ambient ? INPROC_SECRETS_NOTE : INPROC_FALLBACK_NOTE
    if (once(ctx, line)) note(ctx, line)
    // The workspace terminal UI's host serves other terminals too (they attach with what Terminal access allows); a
    // command's host ends with that command, so other terminals wait it out (step 0).
    const inprocOpts: InprocStartOptions | undefined = opts.shareInproc === true ? { ...opts.inproc, shared: true } : opts.inproc
    return inprocHost(ctx, connect, inprocOpts)
  }

  let outcome: 'ready' | 'taken'
  const app = ctx.launcher.locate()
  if (app.status === 'broken') throw new CliError(app.message, EXIT.failure)
  if (app.status === 'absent') {
    // --host daemon: a Node background host when this build can start one, never in-process.
    const startNode = ctx.launcher.startBackground?.bind(ctx.launcher)
    if (!startNode) throw new CliError(NO_BACKGROUND_HOST_MESSAGE, EXIT.failure)
    // Wave 7 (cli-standalone.md 4.1, 4.2): refused when install.json says app or Terminal access is stored off.
    const refusal = nodeHostRefusal(ctx)
    if (refusal) throw refusal
    // Nothing asks here (exec and scripts are not interactive): say which level the new host grants and how to change it.
    const stored = nodeHostDeps.terminalAccess(ctx.paths.dataDir)
    if (!stored.levelChosen) note(ctx, levelNote(stored.level))
    outcome = await startBackground(ctx, () => startNode('node'), 'background host', BACKGROUND_HOST_KINDS)
  } else {
    const { status: _found, ...found } = app
    outcome = await startBackground(ctx, () => ctx.launcher.spawn({ headless: true, app: found }), 'host', BACKGROUND_HOST_KINDS)
  }
  const second = await connect()
  if (!second.ok) throw connectFailure(second)
  return { client: second.client, started: outcome === 'ready' }
}
