import { exec, execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ConnectionStatus, ProviderAuth } from '@shared/types'
import { isolateClaudeEnv } from '../runtime/childEnv'

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
  /** Candidate list override (tests). Default: the bundled CLI, then the PATH candidates. */
  candidates?: () => Promise<{ bin: string; shell: boolean }[]>
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

/** The CLI the SDK runs use, shipped beside the SDK. Dev and packaged (app.asar.unpacked). Existing files only. */
export function bundledClaudeBinary(): string | undefined {
  try {
    const req = createRequire(import.meta.url)
    const pkgJson = req.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)
    const dir = dirname(pkgJson).replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked')
    const bin = join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude')
    return existsSync(bin) ? bin : undefined
  } catch {
    return undefined
  }
}

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

async function defaultCandidates(): Promise<{ bin: string; shell: boolean }[]> {
  const bundled = bundledClaudeBinary()
  const path = await listClaudeBinaries()
  const rest = path.filter((p) => p !== bundled).map((p) => candidateLaunch(p)).filter((c): c is { bin: string; shell: boolean } => !!c)
  return [...(bundled ? [{ bin: bundled, shell: false }] : []), ...rest]
}

/**
 * Whether OrgAI runs can authenticate with the Anthropic connection. Token-free (`claude auth status`). The bundled
 * CLI (the one runs use) is tried first, then the PATH candidates; the first that answers wins. The CLI runs with
 * user settings excluded and an isolated env, in a temp dir (never the home dir: its .claude/settings.json would
 * load as project settings), so a login or gateway that only lives in ~/.claude/settings.json does not count.
 */
export async function claudeAuthStatus(deps: AuthStatusDeps = {}): Promise<ClaudeAuthStatus> {
  const candidates = await (deps.candidates ?? defaultCandidates)()
  for (const c of candidates) {
    const result = await runAuthStatus(c.bin, { ...deps, shell: c.shell })
    if (result) return result
  }
  return { loggedIn: false, detail: 'Claude Code CLI not found. Install it and run claude /login, set an API key, or choose another default connection.' }
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
    return set
      ? { state: 'connected', detail: `Using ${auth.envVar}`, checkedAt }
      : { state: 'disconnected', detail: `${auth.envVar} is not set in OrgAI's environment`, checkedAt }
  }
  const s = await claudeAuthStatus(deps)
  return s.loggedIn
    ? { state: 'connected', detail: s.detail ?? s.method ?? 'Claude Code login', checkedAt }
    : { state: 'disconnected', detail: s.detail ?? NOT_LOGGED_IN, checkedAt }
}

/**
 * Where the Claude Code CLI usually lives on macOS and Linux when it is not on the PATH a GUI app inherits:
 * the native installer (~/.claude/local, ~/.local/bin) and Homebrew (Apple silicon, Intel). Existing files only.
 */
export function claudeCandidatePaths(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  exists: (p: string) => boolean = existsSync
): string[] {
  if (platform === 'win32') return []
  const paths = [join(home, '.claude', 'local', 'claude'), join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
  return paths.filter((p) => {
    try {
      return exists(p)
    } catch {
      return false
    }
  })
}

/**
 * Drop entries that resolve to a file already listed (Homebrew's /opt/homebrew/bin/claude symlink and its Cellar
 * target, ~/.local/bin/claude and ~/.claude/local/claude). The first spelling wins; unresolvable paths stay as given.
 */
export function dedupeByRealpath(paths: string[], realpath: (p: string) => string = (p) => realpathSync.native(p)): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    let key = p
    try {
      key = realpath(p)
    } catch {
      /* not a file path (bare "claude") or gone: compare as given */
    }
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

export function listClaudeBinaries(): Promise<string[]> {
  const cmd = process.platform === 'win32' ? 'where claude' : 'which -a claude'
  return new Promise((resolve) => {
    // Pass process.env explicitly (exec's default too): on macOS applyShellPath has already merged the login shell's
    // PATH into it, which is what lets a Finder-launched app see Homebrew, nvm and ~/.local/bin.
    exec(cmd, { timeout: 8000, windowsHide: true, env: process.env }, (err, stdout) => {
      const found = err ? [] : stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      const all = dedupeByRealpath([...new Set([...found, ...claudeCandidatePaths()])])
      resolve(all.length ? all : ['claude'])
    })
  })
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
    shell: deps.shell ?? true,
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
