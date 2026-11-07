import { execFile } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionStatus, ProviderAuth } from '@shared/types'
import { isolateClaudeEnv } from '../runtime/childEnv'
import { system32Path } from '../host/systemBinaries'
import { parseWhoamiUser } from '../store/custodians/keyFile'
import { claudeExecutable, claudeResolutionMessage, type ClaudeExecutableResolution } from '../runtime/claudeBinary'

export type ClaudeAuthStatus = {
  loggedIn: boolean
  /** Human label of the login source, e.g. 'Claude Code login (claude.ai)'. */
  method?: string
  /** One line for the UI: what is connected, or what to do. */
  detail?: string
  /** Raw `authMethod` and `apiProvider` from the CLI. */
  authMethod?: string
  apiProvider?: string
  /** True when the CLI was run with `--setting-sources project` (user settings excluded, as runs do). */
  restricted?: boolean
  /**
   * True when no CLI gave an answer (none found, every candidate timed out, failed or printed no JSON): the login
   * state is unknown, not "logged out". anthropicStatus reports it as 'error', never 'disconnected'.
   */
  unavailable?: boolean
}

export interface CliResult {
  stdout: string
  stderr: string
  code: number | null
}

/** Runs a CLI directly (execFile, never a shell: the SDK runs the same binary the same way). */
export type RunCli = (bin: string, args: string[], opts: { env: Record<string, string>; cwd: string; timeout: number; signal?: AbortSignal }) => Promise<CliResult>

export interface AuthStatusDeps {
  run?: RunCli
  /** Candidate list override (tests). Default: the one binary claudeExecutable resolves (the one runs use). */
  candidates?: () => Promise<{ bin: string }[]>
  /** The resolver (tests). Default: claudeBinary.ts claudeExecutable over `env`. */
  executable?: () => ClaudeExecutableResolution
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** OrgAI's data folder: the CLI then runs in a private empty folder under it (privateAuthCwd). */
  dataDir?: string
  /** Aborts the CLI child (the connection service's dispose, at host stop): a child must not outlive the host. */
  signal?: AbortSignal
  /** win32 fallback folder: runs whoami.exe / icacls.exe (tests). */
  winRun?: WinRun
}

const NOT_LOGGED_IN = 'Not logged in for OrgAI runs. Run claude and /login, set an API key, or choose another default connection.'

let inFlight = 0
/**
 * `claude auth status` children still running (counted until their exit). The host counts them as background work, so
 * a drain waits for them before it releases the data folder: a running child's cwd lives in it.
 */
export function authChildrenInFlight(): number {
  return inFlight
}

/** How long a pipe may stay open after the direct child exited before its streams are destroyed. */
export const EXIT_PIPE_GRACE_MS = 2000

/** The slice of a child process runCli uses (tests fake it). */
export interface AuthChild {
  pid?: number
  exitCode: number | null
  signalCode: NodeJS.Signals | string | null
  stdout?: { destroy(): void } | null
  stderr?: { destroy(): void } | null
  kill(): unknown
  once(event: 'exit', cb: () => void): unknown
}
export interface RunCliDeps {
  exec: (bin: string, args: string[], o: { windowsHide: boolean; env: Record<string, string>; cwd: string }, cb: (err: Error | null, stdout: string, stderr: string) => void) => AuthChild
  /** win32 tree kill by pid (taskkill /T /F); calls back when done. */
  killTree: (pid: number, done: () => void) => void
  platform: NodeJS.Platform
}

/**
 * The in-flight count drops in execFile's callback (stdio closed), not at 'exit': a grandchild that keeps the pipe open
 * after claude exited may also hold the cwd, so the host drain keeps waiting for it. To bound that wait, 'exit' clears
 * the kill timer (the pid may be reused from then on, so nothing is killed by pid any more) and starts a short grace
 * after which the pipes are destroyed, which ends the callback.
 */
export function makeRunCli(deps: RunCliDeps): RunCli {
  return (bin, args, opts) =>
    new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined
      let grace: NodeJS.Timeout | undefined
      let done = false
      const exited = (): boolean => child.exitCode !== null || child.signalCode !== null
      const stop = (): void => {
        // Once claude exited its pid may belong to someone else: never taskkill /T it.
        if (done || exited()) return
        const pid = child.pid
        if (deps.platform === 'win32' && pid) deps.killTree(pid, () => child.kill())
        else child.kill()
      }
      // Never start a child once the host is stopping: nothing would be left to end it before the folder is removed.
      if (opts.signal?.aborted) return resolve({ stdout: '', stderr: '', code: 1 })
      inFlight++
      const child = deps.exec(bin, args, { windowsHide: true, env: opts.env, cwd: opts.cwd }, (err, stdout, stderr) => {
        done = true
        inFlight--
        if (timer) clearTimeout(timer)
        if (grace) clearTimeout(grace)
        opts.signal?.removeEventListener('abort', stop)
        const e = err as (Error & { code?: number | string | null }) | null
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: e ? (typeof e.code === 'number' ? e.code : 1) : 0 })
      })
      timer = setTimeout(stop, opts.timeout)
      opts.signal?.addEventListener('abort', stop, { once: true })
      child.once('exit', () => {
        if (done) return
        if (timer) clearTimeout(timer)
        timer = undefined
        opts.signal?.removeEventListener('abort', stop)
        grace = setTimeout(() => {
          child.stdout?.destroy()
          child.stderr?.destroy()
        }, EXIT_PIPE_GRACE_MS)
      })
    })
}

export const defaultRunCli: RunCli = makeRunCli({
  exec: (bin, args, o, cb) => execFile(bin, args, o, (err, stdout, stderr) => cb(err, String(stdout ?? ''), String(stderr ?? ''))) as unknown as AuthChild,
  killTree: (pid, done) => {
    execFile(system32Path('taskkill.exe'), ['/pid', String(pid), '/T', '/F'], { windowsHide: true, cwd: tmpdir() }, () => done())
  },
  platform: process.platform
})

/** Runs a Windows system program by absolute path (execFile, no shell, cwd the temp dir) and returns stdout. */
export type WinRun = (bin: string, args: string[]) => Promise<string>

const defaultWinRun: WinRun = (bin, args) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { windowsHide: true, cwd: tmpdir(), timeout: 15000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout ?? ''))))
  })

export interface PrivateCwdOptions {
  dataDir?: string
  tmp?: string
  platform?: NodeJS.Platform
  winRun?: WinRun
  /** Owner id to require on POSIX (tests). Default process.getuid(). */
  uid?: number
}

const cwdCache = new Map<string, string>()

function ownedByUs(st: { uid: number }, o: PrivateCwdOptions): boolean {
  if ((o.platform ?? process.platform) === 'win32') return true
  const uid = o.uid ?? process.getuid?.()
  return uid === undefined || st.uid === uid
}

function usableEmptyDir(dir: string, o: PrivateCwdOptions): boolean {
  try {
    const st = lstatSync(dir)
    if (!st.isDirectory() || st.isSymbolicLink() || !ownedByUs(st, o)) return false
    // POSIX: a folder others can enter or write is not private.
    if ((o.platform ?? process.platform) !== 'win32' && (st.mode & 0o077) !== 0) return false
    return readdirSync(dir).length === 0
  } catch {
    return false
  }
}

/**
 * Removes `dir` without ever following a link: a symlink or junction (lstat reports both as symbolic links on win32) is
 * unlinked itself, a real directory is removed recursively only after lstat confirmed it is not a link.
 */
function removeWithoutFollowing(dir: string): void {
  let st
  try {
    st = lstatSync(dir)
  } catch {
    return
  }
  if (st.isSymbolicLink()) {
    try {
      unlinkSync(dir)
    } catch {
      rmdirSync(dir) // a win32 directory link may need rmdir; neither call touches the target
    }
    return
  }
  if (st.isDirectory()) {
    // Re-check right before the recursive remove: a link swapped in since is never recursed into.
    if (lstatSync(dir).isSymbolicLink()) return removeWithoutFollowing(dir)
    rmSync(dir, { recursive: true, force: true })
  } else unlinkSync(dir)
}

/**
 * The folder `claude auth status` runs in. `--setting-sources project` reads <cwd>/.claude/settings.json, so it must be
 * a folder nobody else can plant files in: `<data>/auth-cwd` (0o700; outside `<data>/run`, the host-ownership folder; it
 * must be an empty real directory of ours, else it is removed and recreated), or without a data folder a 0o700 mkdtemp
 * in the temp dir whose owner is checked on POSIX. On win32 the temp dir can grant other accounts inheritable write, so
 * that fallback gets a protected DACL for this user's SID only (icacls, SID from whoami). Never the shared temp dir
 * itself. Rejects when no safe folder can be made (the probe then answers 'error').
 */
export async function privateAuthCwd(o: PrivateCwdOptions = {}): Promise<string> {
  if (o.dataDir) {
    const dir = join(o.dataDir, 'auth-cwd')
    mkdirSync(o.dataDir, { recursive: true })
    if (!usableEmptyDir(dir, o)) {
      removeWithoutFollowing(dir)
      mkdirSync(dir, { mode: 0o700 })
    }
    return dir
  }
  const base = o.tmp ?? tmpdir()
  const cached = cwdCache.get(base)
  if (cached && usableEmptyDir(cached, o)) return cached
  const made = mkdtempSync(join(base, 'orgai-auth-'))
  try {
    chmodSync(made, 0o700)
    if (!ownedByUs(lstatSync(made), o)) throw new Error('The temporary folder for the Claude check is not owned by this user.')
    if ((o.platform ?? process.platform) === 'win32') await restrictToUser(made, o.winRun ?? defaultWinRun)
    // Another account could plant files between mkdtemp and the ACL change (they keep their own ACL): fail closed.
    if (readdirSync(made).length > 0) throw new Error('The temporary folder for the Claude check was not empty.')
  } catch (e) {
    rmSync(made, { recursive: true, force: true })
    throw e
  }
  cwdCache.set(base, made)
  return made
}

/** Protected DACL: this user's SID only, inherited by children. Throws when it cannot be set. */
async function restrictToUser(dir: string, run: WinRun): Promise<void> {
  const user = parseWhoamiUser(await run(system32Path('whoami.exe'), ['/user', '/fo', 'csv', '/nh']))
  if (!user) throw new Error('whoami named no user, so the folder for the Claude check cannot be restricted.')
  await run(system32Path('icacls.exe'), [dir, '/inheritance:r', '/grant:r', `*${user.sid}:(OI)(CI)F`])
}

/**
 * Whether OrgAI runs can authenticate with the Anthropic connection. Token-free (`claude auth status`), with the one
 * binary claudeBinary.ts resolves, so the probe and runs never disagree (cli-standalone 6.1). A claude on PATH is only
 * named in the error, never run. The CLI runs with user settings excluded and an isolated env, in a private empty folder
 * (privateAuthCwd; never the home dir or the shared temp dir: a .claude/settings.json there would load as project settings), so a login or gateway that only lives in
 * ~/.claude/settings.json does not count.
 */
export async function claudeAuthStatus(deps: AuthStatusDeps = {}): Promise<ClaudeAuthStatus> {
  let candidates: { bin: string }[]
  if (deps.candidates) candidates = await deps.candidates()
  else {
    const resolved = deps.executable ? deps.executable() : claudeExecutable(deps.env ?? process.env)
    if (!resolved.ok) return { loggedIn: false, unavailable: true, detail: claudeResolutionMessage(resolved) }
    // Run exactly as the SDK runs it: execFile, never a shell (a shim that needs one would fail every run).
    candidates = [{ bin: resolved.path }]
  }
  for (const c of candidates) {
    const result = await runAuthStatus(c.bin, deps)
    if (result) return result
  }
  return {
    loggedIn: false,
    unavailable: true,
    detail: candidates.length
      ? `The Claude runtime at ${candidates.map((c) => c.bin).join(', ')} gave no answer to auth status. Try again, set an API key, or choose another default connection.`
      : 'No Claude runtime was found. Set an API key, or choose another default connection.'
  }
}

/** Live status of the Anthropic connection. apiKey: the env var must be set; subscription: the CLI login. */
export async function anthropicStatus(
  auth: ProviderAuth,
  env: NodeJS.ProcessEnv = process.env,
  deps: AuthStatusDeps = {}
): Promise<ConnectionStatus> {
  const checkedAt = Date.now()
  if (auth.kind === 'apiKey') {
    const set = !!env[auth.envVar]?.trim()
    if (!set) return { state: 'disconnected', detail: `${auth.envVar} is not set in OrgAI's environment`, checkedAt }
    // An API key still runs through the Claude runtime: without one, runs fail, so the probe says so too (6.1).
    const resolved = deps.executable ? deps.executable() : claudeExecutable(deps.env ?? env)
    if (!resolved.ok) return { state: 'error', detail: claudeResolutionMessage(resolved), checkedAt }
    return { state: 'connected', detail: `Using ${auth.envVar}`, checkedAt }
  }
  const s = await claudeAuthStatus(deps)
  if (s.loggedIn) return { state: 'connected', detail: s.detail ?? s.method ?? 'Claude Code login', checkedAt }
  // No CLI answered (missing, timed out, no JSON): not a definite logout, so never 'disconnected' (it would move an
  // automatic default connection away).
  return { state: s.unavailable ? 'error' : 'disconnected', detail: s.detail ?? NOT_LOGGED_IN, checkedAt }
}

interface CliAuthJson {
  loggedIn?: boolean
  authMethod?: string
  apiProvider?: string
  apiKeySource?: string
}

/** Label for the login source. */
export function describeAuthMethod(j: CliAuthJson): string {
  switch (j.authMethod) {
    case 'claude.ai':
      return 'Claude Code login (claude.ai)'
    case 'oauth_token':
      return 'OAuth token (CLAUDE_CODE_OAUTH_TOKEN)'
    case 'api_key':
      return `API key (${j.apiKeySource ?? 'ANTHROPIC_API_KEY'})`
    default:
      return j.authMethod ? `Claude Code login (${j.authMethod})` : 'Claude Code login'
  }
}

function parseStatus(out: CliResult, restricted: boolean): ClaudeAuthStatus | null {
  let j: CliAuthJson
  try {
    j = JSON.parse(out.stdout) as CliAuthJson
  } catch {
    return null
  }
  if (!j || typeof j !== 'object') return null
  const loggedIn = !!j.loggedIn
  const provider = j.apiProvider && j.apiProvider !== 'firstParty' ? ` via ${j.apiProvider}` : ''
  const caveat = restricted ? '' : ' (user settings could not be excluded)'
  const method = describeAuthMethod(j)
  return {
    loggedIn,
    method: loggedIn ? method : undefined,
    detail: loggedIn ? `${method}${provider}${caveat}` : `${NOT_LOGGED_IN}${caveat}`,
    authMethod: j.authMethod,
    apiProvider: j.apiProvider,
    restricted
  }
}

const UNKNOWN_OPTION = /unknown option/i

/**
 * One CLI's answer, or null when it gave none. Parses the JSON even when the exit code is non-zero (`auth status`
 * exits 1 when logged out). A CLI that rejects `--setting-sources` is retried without it, marked restricted: false.
 */
export async function runAuthStatus(bin: string, deps: AuthStatusDeps = {}): Promise<ClaudeAuthStatus | null> {
  const run = deps.run ?? defaultRunCli
  let cwd: string
  try {
    cwd = deps.cwd ?? (await privateAuthCwd({ dataDir: deps.dataDir, winRun: deps.winRun }))
  } catch {
    return null
  }
  const opts = {
    env: isolateClaudeEnv(deps.env ?? process.env, { keepApiKey: false }),
    cwd,
    timeout: 15000,
    signal: deps.signal
  }
  const first = await run(bin, ['--setting-sources', 'project', 'auth', 'status'], opts)
  if (UNKNOWN_OPTION.test(first.stderr) || UNKNOWN_OPTION.test(first.stdout)) {
    return parseStatus(await run(bin, ['auth', 'status'], opts), false)
  }
  return parseStatus(first, true)
}
