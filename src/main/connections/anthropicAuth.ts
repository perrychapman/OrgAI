import { exec, execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import type { ConnectionStatus, ProviderAuth } from '@shared/types'
import { isolateClaudeEnv } from '../runtime/childEnv'
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

/** Runs a CLI. `shell` is for PATH candidates that may be .cmd shims on Windows; the bundled binary runs directly. */
export type RunCli = (bin: string, args: string[], opts: { shell: boolean; env: Record<string, string>; cwd: string; timeout: number }) => Promise<CliResult>

export interface AuthStatusDeps {
  run?: RunCli
  /** Candidate list override (tests). Default: the one binary claudeExecutable resolves (the one runs use). */
  candidates?: () => Promise<{ bin: string; shell: boolean }[]>
  /** The resolver (tests). Default: claudeBinary.ts claudeExecutable over `env`. */
  executable?: () => ClaudeExecutableResolution
  env?: NodeJS.ProcessEnv
  cwd?: string
}

const NOT_LOGGED_IN = 'Not logged in for OrgAI runs. Run claude and /login, set an API key, or choose another default connection.'

export const defaultRunCli: RunCli = (bin, args, opts) =>
  new Promise((resolve) => {
    const done = (err: (Error & { code?: number | string | null }) | null, stdout: string, stderr: string): void =>
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: err ? (typeof err.code === 'number' ? err.code : 1) : 0 })
    const base = { timeout: opts.timeout, windowsHide: true, env: opts.env, cwd: opts.cwd }
    if (opts.shell) {
      // Only Windows .cmd/.bat shims get here (candidateLaunch), already checked for shell metacharacters; the
      // args are constants. Always quoted.
      if (SHELL_UNSAFE.test(bin)) {
        resolve({ stdout: '', stderr: 'unsafe path', code: 1 })
        return
      }
      exec(`"${bin}" ${args.join(' ')}`, base, (err, stdout, stderr) => done(err, stdout, stderr))
    } else {
      execFile(bin, args, base, (err, stdout, stderr) => done(err, stdout, stderr))
    }
  })

/** Characters cmd.exe would still interpret inside double quotes, plus other metacharacters. Parentheses stay allowed ("Program Files (x86)"). */
const SHELL_UNSAFE = /["%!&|<>^`$;\r\n]/

/**
 * How to launch a PATH candidate: directly (execFile) everywhere except Windows .cmd / .bat shims, which need a
 * shell. A shim whose path holds shell metacharacters is dropped (null) rather than risk command injection.
 */
export function candidateLaunch(bin: string, platform: NodeJS.Platform = process.platform): { bin: string; shell: boolean } | null {
  const shim = platform === 'win32' && /\.(cmd|bat)$/i.test(bin)
  if (!shim) return { bin, shell: false }
  return SHELL_UNSAFE.test(bin) ? null : { bin, shell: true }
}

/**
 * Whether OrgAI runs can authenticate with the Anthropic connection. Token-free (`claude auth status`), with the one
 * binary claudeBinary.ts resolves, so the probe and runs never disagree (cli-standalone 6.1). A claude on PATH is only
 * named in the error, never run. The CLI runs with user settings excluded and an isolated env, in a temp dir (never
 * the home dir: its .claude/settings.json would load as project settings), so a login or gateway that only lives in
 * ~/.claude/settings.json does not count.
 */
export async function claudeAuthStatus(deps: AuthStatusDeps = {}): Promise<ClaudeAuthStatus> {
  let candidates: { bin: string; shell: boolean }[]
  if (deps.candidates) candidates = await deps.candidates()
  else {
    const resolved = deps.executable ? deps.executable() : claudeExecutable(deps.env ?? process.env)
    if (!resolved.ok) return { loggedIn: false, unavailable: true, detail: claudeResolutionMessage(resolved) }
    // Run exactly as the SDK runs it: execFile, never a shell (a shim that needs one would fail every run).
    candidates = [{ bin: resolved.path, shell: false }]
  }
  for (const c of candidates) {
    const result = await runAuthStatus(c.bin, { ...deps, shell: c.shell })
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
export async function runAuthStatus(bin: string, deps: AuthStatusDeps & { shell?: boolean } = {}): Promise<ClaudeAuthStatus | null> {
  const run = deps.run ?? defaultRunCli
  const opts = {
    shell: deps.shell ?? false,
    env: isolateClaudeEnv(deps.env ?? process.env, { keepApiKey: false }),
    cwd: deps.cwd ?? tmpdir(),
    timeout: 15000
  }
  const first = await run(bin, ['--setting-sources', 'project', 'auth', 'status'], opts)
  if (UNKNOWN_OPTION.test(first.stderr) || UNKNOWN_OPTION.test(first.stdout)) {
    return parseStatus(await run(bin, ['auth', 'status'], opts), false)
  }
  return parseStatus(first, true)
}
