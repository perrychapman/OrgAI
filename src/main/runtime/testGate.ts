import { spawn } from 'node:child_process'
import { PROJECT_TEST_COMMAND_MAX_CHARS, type Project } from '@shared/types'
import { writesToProjectFolder } from '@shared/defaults'
import { isolateClaudeEnv } from './childEnv'
import { maskKeyLike } from './codexAppServer'
import { killProcessTree } from './worktrees'
import { system32Path } from '../host/systemBinaries'
import { trackChildProcess } from '../host/shutdown'

/**
 * The test gate (UI overhaul, Branches settings): before an integration merges a finished copy, run the project's
 * `testCommand` in that copy's directory. Provider-neutral and used by WorktreeIntegrator and the maintenance panel.
 *
 * The gate executes repository code (the project's own test command over files the agents edited) by the user's choice:
 * the user turned requireTestsPass on and wrote the command in the window. That is why the environment is scrubbed below,
 * the command is desktop-only to change, and a project with reviewMerges runs it only after the user approved the merge.
 *
 * Execution setup:
 * - shell: win32 `%SystemRoot%\System32\cmd.exe /d /s /c "<command>"` (absolute path, verbatim arguments); elsewhere
 *   `/bin/sh -c <command>`. The command is a user-written shell line only the desktop user can set (projects:save).
 * - cwd: the finished copy (its worktree directory).
 * - env: testGateEnv(process.env): an ALLOWLIST (ENV_ALLOW: PATH, the shell, home and temp folders, the locale, CI and what
 *   Node and npm need on Windows and POSIX). No other variable reaches the command, whatever its name; the provider
 *   secrets, routing and OrgAI control variables, tokens and cloud credentials are dropped a second time by name.
 * - stdin closed ('ignore'); stdout and stderr merged into a rolling tail, only the last TEST_GATE_DETAIL_CHARS kept, with
 *   obvious credentials masked (scrubTestOutput). The detail goes to the run log and to the maintenance result shown to
 *   the user; the text told to the orchestrator and the agents (integration.ts notifications) never includes it.
 * - timeout TEST_GATE_TIMEOUT_MS; on timeout the whole process tree is killed (taskkill /T /F on win32, the process
 *   group elsewhere: the child leads its own group). The shutdown registry also ends it with the host.
 */

/** Longest a gate run may take. */
export const TEST_GATE_TIMEOUT_MS = 10 * 60 * 1000
/** Characters of output kept for the detail (the end of the output). */
export const TEST_GATE_DETAIL_CHARS = 4000

export interface TestGateResult {
  outcome: 'passed' | 'failed' | 'timeout'
  /** The exit code; null on timeout, when a signal ended it or it could not start. */
  exitCode: number | null
  /** The last TEST_GATE_DETAIL_CHARS characters of output, plus a leading summary line. */
  detail: string
  durationMs: number
}

export interface TestGateDeps {
  /** Environment to derive the child's from (default process.env). */
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  platform?: NodeJS.Platform
  spawn?: typeof spawn
}

/** The command the gate runs for `project`, or null when the gate is off (flag false, no command, or an engagement). */
export function testGateCommand(project: Pick<Project, 'requireTestsPass' | 'testCommand' | 'kind'>): string | null {
  if (!writesToProjectFolder(project)) return null
  if (project.requireTestsPass !== true) return null
  const command = typeof project.testCommand === 'string' ? project.testCommand.trim() : ''
  return command ? command : null
}

/**
 * The sentence for a project that requires tests to pass but has no test command: such a gate must refuse the merge,
 * not let it through untested. Null when the gate is off or a command is set. Same on-conditions as testGateCommand.
 */
export const TEST_GATE_MISSING_COMMAND_MESSAGE = 'Tests are required before merging, but no test command is set. Add one in Settings > Branches.'
export function testGateMissingCommand(project: Pick<Project, 'requireTestsPass' | 'testCommand' | 'kind'>): string | null {
  if (!writesToProjectFolder(project)) return null
  if (project.requireTestsPass !== true) return null
  return testGateCommand(project) ? null : TEST_GATE_MISSING_COMMAND_MESSAGE
}

/**
 * The environment names a test run inherits (an allowlist, matched case-insensitively because Windows has no case in
 * names): where programs and the shell live, who and where the user is, the temp folders, the locale and CI. The command
 * runs repository code the agents edited, so it gets what Node, npm and a shell strictly need to start and nothing else:
 * no other variable reaches it, whatever its name (a deny list could never name every credential).
 */
const ENV_ALLOW = new Set(
  [
    // programs and the shell
    'PATH', 'PATHEXT', 'COMSPEC', 'SHELL', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR',
    // user and home (npm, git and Node read their per-user config from here)
    'HOME', 'USER', 'LOGNAME', 'USERNAME', 'USERDOMAIN', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ALLUSERSPROFILE', 'PUBLIC',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
    'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    // temp folders
    'TEMP', 'TMP', 'TMPDIR',
    // machine facts Node and native build tools ask for
    'OS', 'COMPUTERNAME', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'NUMBER_OF_PROCESSORS',
    // locale, time zone, terminal, CI
    'LANG', 'LANGUAGE', 'TZ', 'TERM', 'NO_COLOR', 'CI'
  ]
)

/** True for a name a gate run may inherit. */
function envAllowed(name: string): boolean {
  const n = name.toUpperCase()
  return ENV_ALLOW.has(n) || n.startsWith('LC_')
}

/**
 * Names dropped even when they pass the allowlist (it holds none today; a second check so that widening the list cannot
 * let a credential through): provider secrets, any name that says it holds a token, secret or password, and cloud /
 * source-host credentials (AWS_, AZURE_, GH_, GITHUB_, NPM_TOKEN).
 */
const SECRET_NAME = [
  /^ANTHROPIC_/i,
  /^OPENAI_/i,
  /^CODEX_/i,
  /^ORGAI_/i,
  /^CLAUDE_CODE_/i,
  /^CLAUDE_CONFIG_DIR$/i,
  /(^|_)API_?KEY$/i,
  /TOKEN|SECRET|PASSWORD/i,
  /^(AWS|AZURE|GH|GITHUB)_/i,
  /^NPM_TOKEN/i
]

/** The environment of a gate run: only the allowlisted names (ENV_ALLOW), none of them a routing, control or secret variable. */
export function testGateEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(isolateClaudeEnv(base))) {
    if (!envAllowed(name) || SECRET_NAME.some((re) => re.test(name))) continue
    out[name] = value
  }
  return out
}

/** Obvious credentials in test output (Bearer tokens, sk- keys, `token=...`, URL userinfo, GitHub / GitLab tokens) masked. */
export function scrubTestOutput(text: string): string {
  return maskKeyLike(text)
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s@/]*@/g, '$1')
    .replace(/\bgh[pousr]_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/\bglpat-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]')
    .replace(/\bnpm_[A-Za-z0-9]{20,}/g, '[redacted]')
}

/** Keep the last `max` characters (the end of the output is where a test run says what failed). */
function tail(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text
}

/** Control characters other than newline and tab, and ANSI colour escapes, out of captured output. */
function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function secondsText(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`
}

/**
 * Run `command` in `cwd`. Never throws and never rejects: a command that cannot start is a failed run. Resolves when the
 * process ends, or at the timeout right after its tree was killed (without waiting for pipes a grandchild may hold).
 */
export function runTestGate(command: string, cwd: string, deps: TestGateDeps = {}): Promise<TestGateResult> {
  const started = Date.now()
  const platform = deps.platform ?? process.platform
  const timeoutMs = deps.timeoutMs ?? TEST_GATE_TIMEOUT_MS
  const done = (outcome: TestGateResult['outcome'], exitCode: number | null, summary: string, output: string): TestGateResult => {
    const durationMs = Date.now() - started
    // Scrubbed before the cut so a key split by the cut cannot survive half masked. The detail goes to the run log and to
    // the maintenance result the user reads in OrgAI; it is never put into a message for a model (integration.ts, notifications).
    const body = tail(scrubTestOutput(clean(output)).trim(), TEST_GATE_DETAIL_CHARS)
    return { outcome, exitCode, detail: body ? `${summary}\n${body}` : summary, durationMs }
  }
  if (command.length > PROJECT_TEST_COMMAND_MAX_CHARS || /[\r\n\0]/.test(command)) {
    return Promise.resolve(done('failed', null, 'The test command is not a single line of at most ' + PROJECT_TEST_COMMAND_MAX_CHARS + ' characters, so it was not run.', ''))
  }
  return new Promise((resolve) => {
    let settled = false
    let output = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (r: TestGateResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }
    let child: ReturnType<typeof spawn>
    try {
      const run = deps.spawn ?? spawn
      const env = testGateEnv(deps.env ?? process.env)
      child =
        platform === 'win32'
          ? run(system32Path('cmd.exe'), ['/d', '/s', '/c', `"${command}"`], { cwd, env, windowsHide: true, windowsVerbatimArguments: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
          : run('/bin/sh', ['-c', command], { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve(done('failed', null, `The test command could not be started: ${e instanceof Error ? e.message : String(e)}`, ''))
      return
    }
    const spawned = child
    trackChildProcess(
      { get pid() { return spawned.pid }, kill: (signal) => killProcessTree(spawned, signal, { platform }), once: (event, listener) => spawned.once(event, listener) },
      'test gate'
    )
    const take = (chunk: Buffer | string): void => {
      output += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      // Bound memory: far more than the detail, so a multi-byte or escape split at the cut never matters.
      if (output.length > TEST_GATE_DETAIL_CHARS * 4) output = output.slice(output.length - TEST_GATE_DETAIL_CHARS * 2)
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    timer = setTimeout(() => {
      killProcessTree(spawned, 'SIGKILL', { platform })
      finish(done('timeout', null, `The tests did not finish within ${Math.round(timeoutMs / 1000)} s and were stopped.`, output))
    }, timeoutMs)
    child.on('error', (e) => finish(done('failed', null, `The test command could not be started: ${e.message}`, output)))
    child.on('close', (code, signal) => {
      const secs = secondsText(Date.now() - started)
      if (code === 0) finish(done('passed', 0, `Tests passed (exit code 0, ${secs}).`, output))
      else if (code === null) finish(done('failed', null, `The tests were ended by ${signal ?? 'a signal'} after ${secs}.`, output))
      else finish(done('failed', code, `The tests failed (exit code ${code}, ${secs}).`, output))
    })
  })
}
