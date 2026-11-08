// Helpers both package checks use (scripts/verify-pack.mjs, the desktop app's pack; scripts/verify-npm.mjs, the orgai
// CLI's npm package): how to launch a command, run it with a timeout, read its JSON, make a fixture repo and stop a host
// left behind. Neither check imports the other; they share this module (cli-standalone-default.md 5.2).
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** The default timeout of one checked command. */
export const DEFAULT_CHECK_TIMEOUT_MS = 90_000
/** Variables a checked command never inherits: the app's and the launcher's own. */
export const DROPPED_ENV = new Set(['ELECTRON_RUN_AS_NODE', 'ORGAI_ELECTRON_PATH', 'ORGAI_APP_ROOT', 'ORGAI_DATA_DIR'])
const SECRET_PREFIX = 'ORGAI_SECRET_'

/** The environment every checked command starts from: no dropped variable, no ORGAI_SECRET_*, mock adapter, no colour. Pure. */
export function baseVerifyEnv(base) {
  const out = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || DROPPED_ENV.has(k) || k.startsWith(SECRET_PREFIX)) continue
    out[k] = v
  }
  out.ORGAI_MOCK = '1'
  out.NO_COLOR = '1'
  return out
}

/**
 * How to run the launcher with `args`. POSIX: the sh script itself. win32: `cmd.exe /d /s /c ""<launcher>" args"`
 * with verbatim arguments; every argument is fixed by this script and must not carry a quote, % or ! (refused).
 * The win32 form is UNVERIFIED.
 */
export function launchCommand(platform, launcher, args, env = {}) {
  if (platform !== 'win32') return { command: launcher, args: [...args], windowsVerbatimArguments: false }
  for (const a of [launcher, ...args]) {
    if (/["%!\r\n\0]/.test(a)) throw new Error(`Refusing to pass ${JSON.stringify(a)} through cmd.exe.`)
  }
  const line = [launcher, ...args].map((a) => `"${a}"`).join(' ')
  return { command: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true }
}

export function parseJson(text) {
  const s = String(text ?? '').trim()
  if (!s) return undefined
  try {
    return JSON.parse(s)
  } catch {
    // Anything printed before the document (a warning line) is skipped: try the last line alone.
    const last = s.split(/\r?\n/).filter(Boolean).at(-1)
    try {
      return JSON.parse(last)
    } catch {
      return undefined
    }
  }
}

/** True when `--version` output names exactly this version. Pure. */
export function versionMatches(stdout, version) {
  return String(stdout ?? '')
    .trim()
    .split(/\s+/)
    .some((w) => w === version || w === `v${version}`)
}

/** `{ outcome, exitCode }` of an `exec --output-format json` document, or undefined. Pure. */
export function execOutcome(stdout) {
  const doc = parseJson(stdout)
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return undefined
  return { outcome: typeof doc.outcome === 'string' ? doc.outcome : null, exitCode: typeof doc.exitCode === 'number' ? doc.exitCode : null }
}

/** Where a host on this userDataDir writes its daemon.json. */
export function daemonJsonPath(userDataDir) {
  return path.join(userDataDir, 'data', 'run', 'daemon.json')
}

function defaultAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

/**
 * Kills a host still alive after the checks: only the pid read from `<userDataDir>/data/run/daemon.json`, never this
 * process. SIGTERM, then SIGKILL after `graceMs`. Returns the pid it signalled, or undefined.
 */
export async function cleanupDaemon(userDataDir, deps = {}) {
  const {
    readFile = (p) => fs.readFileSync(p, 'utf8'),
    kill = (pid, sig) => process.kill(pid, sig),
    isAlive = defaultAlive,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    graceMs = 5000,
    log = () => {}
  } = deps
  let info
  try {
    info = JSON.parse(readFile(daemonJsonPath(userDataDir)))
  } catch {
    return undefined
  }
  const pid = info?.pid
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return undefined
  if (!isAlive(pid)) return undefined
  log(`A host (pid ${pid}) is still running on the temp data folder; stopping it.`)
  try {
    kill(pid, 'SIGTERM')
  } catch {
    return pid
  }
  const end = Date.now() + graceMs
  while (Date.now() < end && isAlive(pid)) await sleep(200)
  if (isAlive(pid)) {
    try {
      kill(pid, 'SIGKILL')
    } catch {
      // gone in between
    }
  }
  return pid
}

/**
 * Runs one command with a timeout; resolves { code, signal, stdout, stderr, timedOut }, never rejects. `input`, when
 * given, is written to the child's stdin and stdin is closed (else stdin is ignored).
 */
export function spawnRunner({ command, args, cwd, env, timeoutMs = DEFAULT_CHECK_TIMEOUT_MS, windowsVerbatimArguments = false, input }) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let child
    const done = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(closeGrace)
      resolve({ stdout, stderr, timedOut, ...r })
    }
    let closeGrace
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child?.kill('SIGKILL')
      } catch {
        // already gone
      }
    }, timeoutMs)
    try {
      child = spawn(command, args, { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments })
    } catch (e) {
      done({ code: null, signal: null, stderr: String(e?.message ?? e) })
      return
    }
    if (input !== undefined) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (e) => done({ code: null, signal: null, stderr: stderr + String(e?.message ?? e) }))
    // A spawned host that kept our pipes open would delay 'close'; 'exit' plus a short grace is enough.
    child.on('exit', (code, signal) => {
      closeGrace = setTimeout(() => done({ code, signal }), 3000)
    })
    child.on('close', (code, signal) => done({ code, signal }))
  })
}

export function defaultGit(cwd, args) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, timeout: 30_000 })
}

/** A tiny git repo with one commit and a local identity (as e2e/lib.mjs makeFixtureRepo does). */
export function makeFixtureRepo(dir, git = defaultGit) {
  fs.writeFileSync(path.join(dir, 'README.md'), '# verify-pack fixture\n\nA throwaway repo for `npm run pack:verify`.\n')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'verify-pack-fixture', version: '0.0.0', private: true }, null, 2) + '\n')
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.name', 'OrgAI verify-pack'])
  git(dir, ['config', 'user.email', 'verify-pack@orgai.local'])
  git(dir, ['config', 'core.autocrlf', 'false'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'fixture'])
}
