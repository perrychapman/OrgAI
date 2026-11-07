/**
 * Shared helpers of the Wave 5 management commands (cli-spec 6.3; init, org, team, worktrees, permissions, connections,
 * models, mcp, skills, knowledge, notes, usage, kit, projects): one host connection per command (`withHost`), host
 * error mapping to exit codes (`hostCall` / `hostError`), project resolution (`requireProject`, `requireEngagement`),
 * the y/N confirmation (`confirm`), stdin and secret readers, the subcommand dispatcher, host.subscribe topics and the
 * SSH helpers of the sign-in flows (cli-spec 6.3(5)).
 *
 * Plain Node: no electron, ink, react or TUI imports (noElectronImport.test.ts, lazyTui.test.ts).
 */
import { projectKindOf } from '../shared/defaults'
import type { HostScope, HostSubscribeTopic, Project } from '../shared/types'
import { pushChannelsForTopic } from '../main/host/registry'
import { ensureHost, MANAGEMENT_INPROC, missingScopesError, TERMINAL_ACCESS_HINT, VERSION_SKEW_SCOPE_HINT } from './client/ensureHost'
import { consumeSecretEnv } from './client/launcher'
import { note, safeLine, warn } from './output'
import { checkProjectResolution, warnVersionSkew } from './runRef'
import { reservedSecretSourceProblem } from './secretOverlay'
import { CliError, EXIT, type CliContext, type HostCallError, type HostClient } from './types'

/** The most a secret read from stdin may be. */
export const SECRET_STDIN_MAX_BYTES = 64 * 1024

/** An environment variable name (as decide.ts accepts for --secret). */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/


// ---------- Replaceable process I/O ----------

/** Swappable in tests: the y/N question on the terminal and the stdin reader. */
export const manageDeps = {
  ttyConfirm: (question: string): Promise<boolean> => ttyConfirm(question),
  /**
   * Ask `prompt` on /dev/tty (the console on Windows) and read one line ('' for an empty line); undefined when no
   * terminal could be opened or it closed before a line came (Ctrl+D), so a caller never mistakes that for an answer.
   */
  ttyAsk: (prompt: string): Promise<string | undefined> => ttyAsk(prompt),
  readStdin: (maxBytes: number, label?: string): Promise<string> => readProcessStdin(maxBytes, label)
}

/** Ask `question [y/N]` on /dev/tty (the console on Windows) and read one line; only y / yes is a yes. */
async function ttyConfirm(question: string): Promise<boolean> {
  return /^y(es)?$/i.test(((await ttyAsk(`${question} [y/N] `)) ?? '').trim())
}

/** Write `prompt` on /dev/tty (the console on Windows) and read one line; undefined with no terminal or at EOF. */
async function ttyAsk(prompt: string): Promise<string | undefined> {
  const readline = await import('node:readline')
  if (process.platform === 'win32') {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true })
    try {
      return await new Promise<string | undefined>((resolve) => {
        rl.question(prompt, resolve)
        rl.once('close', () => resolve(undefined))
      })
    } finally {
      rl.close()
    }
  }
  const fs = await import('node:fs')
  const tty = await import('node:tty')
  let fd: number
  try {
    fd = fs.openSync('/dev/tty', 'r+')
  } catch {
    return undefined
  }
  const input = new tty.ReadStream(fd)
  const output = new tty.WriteStream(fd)
  const rl = readline.createInterface({ input, output, terminal: false })
  try {
    output.write(prompt)
    return await new Promise<string | undefined>((resolve) => {
      rl.once('line', resolve)
      rl.once('close', () => resolve(undefined))
    })
  } finally {
    rl.close()
    input.destroy()
  }
}

/** All of process.stdin as UTF-8; more than maxBytes is a usage error naming `label`. */
async function readProcessStdin(maxBytes: number, label = 'The input on stdin'): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += b.length
    if (size > maxBytes) {
      process.stdin.destroy()
      throw new CliError(`${label} is larger than ${Math.round(maxBytes / 1024)} KB.`, EXIT.usage)
    }
    chunks.push(b)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Read all of stdin (at most maxBytes, else exit 2). `label` names the input in that error. */
export function readStdinText(maxBytes: number, label?: string): Promise<string> {
  return manageDeps.readStdin(maxBytes, label)
}

// ---------- Host connection ----------

/**
 * Connect (ensureHost: --host inproc starts the in-process host; auto connects, or starts the headless app, or runs
 * in-process when there is no app or environment secrets are set; daemon connects or starts a background host), check
 * every requested scope was granted, run `fn`, and always clean up: close the client and stop an in-process host this
 * call started (stop(true), a warning when that fails). An in-process host here boots with MANAGEMENT_INPROC: connection
 * probes and system certificates on, model discovery, community prices and the usage monitor off.
 */
export async function withHost<T>(ctx: CliContext, scopes: HostScope[], fn: (client: HostClient) => Promise<T>): Promise<T> {
  const host = await ensureHost(ctx, scopes, { interactive: false, inproc: MANAGEMENT_INPROC })
  const cleanup = async (): Promise<void> => {
    host.client.close()
    if (host.inproc) await host.inproc.stop(true).catch((e: unknown) => warn(ctx, `Could not stop the in-process host: ${e instanceof Error ? e.message : String(e)}`))
  }
  try {
    warnVersionSkew(ctx, host.client)
    if (host.started && host.inproc === undefined) note(ctx, 'Started the OrgAI host in the background.')
    const missing = missingScopesError(host.client, scopes)
    if (missing) throw missing
    return await fn(host.client)
  } finally {
    await cleanup()
  }
}

/** A host call whose failure is a CliError (hostError). */
export async function hostCall<T>(client: HostClient, method: string, params: unknown[], opts?: { timeoutMs?: number }): Promise<T> {
  try {
    return await client.call<T>(method, params, opts)
  } catch (e) {
    throw hostError(e)
  }
}

/** A host call's failure as a CliError with the exit code of its HostRpcError code (cli-spec 6.1). */
export function hostError(e: unknown): CliError {
  if (e instanceof CliError) return e
  const data = (e as Partial<HostCallError> | undefined)?.data
  const raw = data?.message ?? (e instanceof Error ? e.message : String(e))
  const message = safeLine(raw) || 'The OrgAI host refused the request.'
  switch (data?.code) {
    case 'bad_request':
    case 'unknown_channel':
      return new CliError(message, EXIT.usage)
    case 'scope_denied':
      // A scope Terminal access withheld names its own fix; anything else is a version skew.
      return new CliError(/Terminal access/.test(message) ? message : `${message} ${VERSION_SKEW_SCOPE_HINT}`, EXIT.failure)
    case 'stale_target_digest':
    case 'stale_revision':
      return new CliError(message, EXIT.failure)
    case 'host_draining':
    case 'host_starting':
      return new CliError(message, EXIT.hostBusy)
    case 'terminal_server_disabled':
      return new CliError(TERMINAL_ACCESS_HINT, EXIT.failure)
    case 'auth_failed':
      return new CliError(message, EXIT.auth)
    default:
      return new CliError(message, EXIT.failure)
  }
}

// ---------- Projects ----------

/**
 * The project this command works on (cli-spec 4: --project, else the project containing cwd; a managed agent worktree
 * resolves to its main checkout's project, and management commands are allowed there). None is exit 2.
 */
export async function requireProject(ctx: CliContext, client: HostClient): Promise<Project> {
  const list = await hostCall<Project[]>(client, 'projects:list', [])
  const res = ctx.resolveProject(Array.isArray(list) ? list : [])
  checkProjectResolution(res)
  if (!res.project) throw new CliError('No OrgAI project here. Run this inside a project folder or pass --project <id-or-path>.', EXIT.usage)
  return res.project
}

/** Exit 2 unless the project is an engagement; `what` names the thing ("context notes", "the knowledge graph"). */
export function requireEngagement(project: Project, what: string): void {
  if (projectKindOf(project) !== 'engagement') throw new CliError(`This is a code project; ${what} belongs to engagements.`, EXIT.usage)
}

// ---------- Confirmation ----------

/**
 * true with --yes. Otherwise a y/N on /dev/tty (cli-spec 6.3(4)) whenever stdin is a terminal, so a piped or tee'd
 * stdout still asks; without a terminal on stdin (CI, scripts), exit 2 telling the user to pass --yes.
 */
export async function confirm(ctx: CliContext, question: string, yes: boolean): Promise<boolean> {
  if (yes) return true
  if (!ctx.io.stdinIsTTY) throw new CliError(`${question} Pass --yes to confirm without a terminal.`, EXIT.usage)
  return manageDeps.ttyConfirm(question)
}

// ---------- Secrets ----------

/**
 * A secret value from exactly one source: the environment variable `fromEnv` (set and non-empty) or stdin (one
 * trailing newline trimmed, at most 64 KB, never an interactive terminal: the value would echo). Secrets are never
 * accepted on argv and never printed; errors name the variable, never a value. The variable is taken out of the
 * environment once read (launcher.ts consumeSecretEnv): call this before withHost, which may start a host. An
 * ORGAI_SECRET_* name is refused with its own message (secretOverlay.ts reservedSecretSourceProblem): prepareContext has
 * already taken such variables out of the environment. `fromEnvFlag` names the option in that message.
 */
export async function readSecretValue(ctx: CliContext, opts: { fromEnv?: string; stdin?: boolean; what: string; fromEnvFlag?: string }): Promise<string> {
  const { fromEnv, stdin, what } = opts
  if (fromEnv !== undefined && stdin) throw new CliError(`Give ${what} with --from-env or --stdin, not both.`, EXIT.usage)
  if (fromEnv === undefined && !stdin) throw new CliError(`Give ${what} with --from-env <VAR> or --stdin; secrets are never taken as arguments.`, EXIT.usage)
  if (fromEnv !== undefined) {
    if (!ENV_NAME_RE.test(fromEnv)) throw new CliError(`--from-env needs an environment variable name, not "${safeLine(fromEnv).slice(0, 40)}".`, EXIT.usage)
    const reserved = reservedSecretSourceProblem(fromEnv, opts.fromEnvFlag ?? '--from-env')
    if (reserved) throw new CliError(reserved, EXIT.usage)
    // Taken out of the environment at once: a host this command starts (and its agents) never inherit it (review M13).
    const v = consumeSecretEnv(ctx.env, fromEnv)
    if (v === undefined || v === '') throw new CliError(`The environment variable ${fromEnv} is not set or empty; it should hold ${what}.`, EXIT.usage)
    return v
  }
  if (ctx.io.stdinIsTTY) throw new CliError(`--stdin needs ${what} piped in; stdin is a terminal.`, EXIT.usage)
  const raw = await manageDeps.readStdin(SECRET_STDIN_MAX_BYTES, `${what[0]?.toUpperCase() ?? ''}${what.slice(1)} on stdin`)
  const value = raw.endsWith('\r\n') ? raw.slice(0, -2) : raw.endsWith('\n') ? raw.slice(0, -1) : raw
  if (value === '') throw new CliError(`Nothing was read from stdin for ${what}.`, EXIT.usage)
  return value
}

// ---------- Subcommands ----------

export type SubcommandFn = (ctx: CliContext, args: string[]) => Promise<number>

/** Route `args[0]` to its subcommand; a missing or unknown one is exit 2 with the usage line. */
export async function runSubcommands(ctx: CliContext, args: string[], routes: Record<string, SubcommandFn>, usage: string): Promise<number> {
  const [sub, ...rest] = args
  if (sub === undefined || sub.startsWith('-')) throw new CliError(`Missing subcommand. Usage: orgai ${usage}`, EXIT.usage)
  if (!Object.hasOwn(routes, sub)) throw new CliError(`Unknown subcommand '${safeLine(sub).slice(0, 64)}'. Usage: orgai ${usage}`, EXIT.usage)
  return routes[sub](ctx, rest)
}

// ---------- host.subscribe ----------

/**
 * Subscribe this connection to host.subscribe topics and hear their push channels (e.g. 'connections' ->
 * connections:event). host.subscribe replaces the socket's topic set, so use one call per client. The listener is
 * registered before the request so nothing pushed right after it is missed. Returns an unsubscribe function (removes
 * the listener; the socket keeps its topics until it closes).
 */
export async function subscribeTopics(
  client: HostClient,
  topics: HostSubscribeTopic[],
  onEvent: (channel: string, payload: unknown) => void
): Promise<() => void> {
  const channels = new Set(topics.flatMap((t) => pushChannelsForTopic(t)))
  const off = client.onNotification((method, params) => {
    if (channels.has(method)) onEvent(method, params)
  })
  try {
    await hostCall(client, 'host.subscribe', [{ topics }])
  } catch (e) {
    off()
    throw e
  }
  return off
}

// ---------- SSH (cli-spec 6.3(5)) ----------

/** True when no browser on this machine can reach the user: an SSH session, or Linux without a display. */
export function isRemoteSession(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return true
  return platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * The command the user runs on their own computer so a browser there reaches this host's loopback OAuth callback:
 * `ssh -L <port>:127.0.0.1:<port> [-p <server_port>] [<USER>@]<server_ip>` from SSH_CONNECTION (client_ip client_port
 * server_ip server_port); `<this-host>` when it is missing. null for a redirect that is not loopback or has no port.
 */
export function sshForwardCommand(redirectUri: string, env: NodeJS.ProcessEnv): string | null {
  let url: URL
  try {
    url = new URL(redirectUri)
  } catch {
    return null
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) || !url.port) return null
  const port = url.port
  const parts = (env.SSH_CONNECTION ?? '').trim().split(/\s+/)
  const serverIp = parts.length === 4 && /^[0-9A-Fa-f:.]+$/.test(parts[2]) ? parts[2] : undefined
  const serverPort = parts.length === 4 && /^\d{1,5}$/.test(parts[3]) ? parts[3] : undefined
  const user = env.USER && /^[A-Za-z0-9._-]{1,64}$/.test(env.USER) ? env.USER : undefined
  const host = serverIp ? `${user ? `${user}@` : ''}${serverIp}` : '<this-host>'
  const p = serverIp && serverPort && serverPort !== '22' ? ` -p ${serverPort}` : ''
  return `ssh -L ${port}:127.0.0.1:${port}${p} ${host}`
}
