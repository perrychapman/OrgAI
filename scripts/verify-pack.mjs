#!/usr/bin/env node
// Checks the packaged orgai command of a local `npm run pack` (cli-spec 7, Wave 6 gate). Token-free: every run is the
// mock adapter (ORGAI_MOCK=1) on a fresh temp data folder.
//
//   npm run pack:verify                                  check release/<unpacked> of this platform
//   node scripts/verify-pack.mjs --release <dir>         check another release folder
//   node scripts/verify-pack.mjs --skip-host             leave out the exec through the spawned background app
//
// Checks, each printed as one ok / fail line; exit 0 only when all pass:
//   (a) the launcher, the app binary and out/cli/{orgai,tui,inprocHost}.mjs exist; the launcher is executable (POSIX)
//   (b) every package the CLI bundle imports is a Node builtin or unpacked from app.asar
//   (c) `orgai --version` prints package.json's version
//   (d) `orgai --output-format json doctor`: launcher ok from the packaged app, node ok, no check failed
//   (e) `orgai --host inproc exec --create-project` with [mock:exec-plan] in a temp git repo: exit 0, 'completed'
//   (f) the same exec with the default host (the packaged app spawned with --headless-host), then `orgai daemon stop`
//
// Environment of every command: this one without ELECTRON_RUN_AS_NODE, ORGAI_SECRET_*, ORGAI_ELECTRON_PATH,
// ORGAI_APP_ROOT and ORGAI_DATA_DIR, plus ORGAI_DATA_DIR=<temp>, ORGAI_MOCK=1, NO_COLOR=1. HOME is untouched. Writes
// only its temp folders (removed at the end) and nothing under release/. A host left behind is killed in a finally
// block, by the pid in the temp data folder's daemon.json only.
//
// Windows: the .cmd launcher runs through `cmd.exe /d /s /c` with fixed arguments only. UNVERIFIED (never run).
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bareImports, isNodeBuiltin, packagedPaths } from './lib/packLayout.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CHECK_TIMEOUT_MS = 90_000
/** The CLI bundle files the pack must ship. */
export const BUNDLE_FILES = ['orgai.mjs', 'tui.mjs', 'inprocHost.mjs']
/** The launcher source word `orgai doctor` prints for a packaged app: "... (packaged)". */
export const PACKAGED_SOURCE = 'packaged'
export const EXEC_PROMPT = '[mock:exec-plan] verify the packaged app'
const DROPPED_ENV = new Set(['ELECTRON_RUN_AS_NODE', 'ORGAI_ELECTRON_PATH', 'ORGAI_APP_ROOT', 'ORGAI_DATA_DIR'])
const SECRET_PREFIX = 'ORGAI_SECRET_'

/** Parses the command line; throws a plain sentence for anything else. */
export function parseArgs(argv) {
  const out = { release: undefined, skipHost: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--skip-host') out.skipHost = true
    else if (a === '--release') {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new Error('--release needs a folder.')
      out.release = v
    } else if (a.startsWith('--release=')) {
      const v = a.slice('--release='.length)
      if (!v) throw new Error('--release needs a folder.')
      out.release = v
    } else throw new Error(`Unknown argument ${a}. Use: verify-pack [--release <dir>] [--skip-host]`)
  }
  return out
}

/** The environment of every checked command. Pure. */
export function verifyEnv(base, userDataDir) {
  const out = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || DROPPED_ENV.has(k) || k.startsWith(SECRET_PREFIX)) continue
    out[k] = v
  }
  out.ORGAI_DATA_DIR = userDataDir
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

function parseJson(text) {
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

/**
 * The `orgai --output-format json doctor` document checked: it parses, 'launcher' is ok and names the packaged source,
 * 'node' is ok, and no check is 'fail'. Returns { ok, problems }. Pure.
 */
export function checkDoctorReport(stdout) {
  const doc = parseJson(stdout)
  const checks = Array.isArray(doc?.checks) ? doc.checks : undefined
  if (!checks) return { ok: false, problems: ['the doctor output is not a JSON document with checks'] }
  const problems = []
  const byId = new Map(checks.map((c) => [c?.id, c]))
  const launcher = byId.get('launcher')
  if (!launcher) problems.push('no launcher check')
  else if (launcher.status !== 'ok') problems.push(`launcher is ${launcher.status}: ${launcher.detail}`)
  else if (!new RegExp(`\\(${PACKAGED_SOURCE}\\)\\s*$`).test(String(launcher.detail ?? '')))
    problems.push(`launcher does not name the packaged app: ${launcher.detail}`)
  const node = byId.get('node')
  if (!node) problems.push('no node check')
  else if (node.status !== 'ok') problems.push(`node is ${node.status}: ${node.detail}`)
  for (const c of checks) if (c?.status === 'fail' && c.id !== 'launcher' && c.id !== 'node') problems.push(`${c.id} failed: ${c.detail}`)
  return { ok: problems.length === 0, problems }
}

/** Lease kinds that settle on their own (a run title or the Team review after a finished run); see host/activity.ts. */
export const TRANSIENT_LEASES = ['backgroundTasks', 'inFlightRpcMutations', 'activeWorktreeOps']
/** How long (f) keeps asking a host that is busy only with transient work to stop. */
export const STOP_RETRY_MS = 30_000

/**
 * Reads an `orgai --output-format json daemon stop` refusal: 'transient' when every lease named is one that settles
 * by itself (so asking again shortly is right), 'busy' for any other refusal (a live run: never forced), undefined
 * when the output is not a refusal. Pure.
 */
export function stopRefusal(stdout) {
  const doc = parseJson(stdout)
  const leases = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc.refusedBecause : undefined
  if (!leases || typeof leases !== 'object') return undefined
  const named = Object.entries(leases).filter(([, n]) => typeof n === 'number' && n > 0).map(([k]) => k)
  if (named.length === 0) return undefined
  return named.every((k) => TRANSIENT_LEASES.includes(k)) ? 'transient' : 'busy'
}

/** `{ outcome, exitCode }` of an `exec --output-format json` document, or undefined. Pure. */
export function execOutcome(stdout) {
  const doc = parseJson(stdout)
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return undefined
  return { outcome: typeof doc.outcome === 'string' ? doc.outcome : null, exitCode: typeof doc.exitCode === 'number' ? doc.exitCode : null }
}

/** The bundle's imports that are neither builtins nor unpacked: [{ file, pkg }]. `files` are { name, text }. Pure. */
export function missingPackages(files, hasPackage) {
  const missing = []
  for (const f of files) {
    for (const pkg of bareImports(f.text)) {
      if (isNodeBuiltin(pkg)) continue
      if (!hasPackage(pkg)) missing.push({ file: f.name, pkg })
    }
  }
  return missing
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

/** Runs one command with a timeout; resolves { code, signal, stdout, stderr, timedOut }, never rejects. */
export function spawnRunner({ command, args, cwd, env, timeoutMs = CHECK_TIMEOUT_MS, windowsVerbatimArguments = false }) {
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
      child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments })
    } catch (e) {
      done({ code: null, signal: null, stderr: String(e?.message ?? e) })
      return
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

function defaultGit(cwd, args) {
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

function listBundle(dir) {
  return fs
    .readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.mjs') || f.endsWith('.js'))
    .sort()
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

const tail = (s, n = 600) => {
  const t = String(s ?? '').trim()
  return t.length > n ? `...${t.slice(-n)}` : t
}
const showRun = (r) =>
  `${r.timedOut ? 'timed out, killed' : `exit ${r.code ?? r.signal}`}${r.stdout?.trim() ? `; stdout: ${tail(r.stdout)}` : ''}${r.stderr?.trim() ? `; stderr: ${tail(r.stderr)}` : ''}`

/**
 * Runs every check; returns the exit code (0 only when all pass). `deps` are for tests: root, platform, arch, env,
 * run (spawnRunner's shape), git, log, tmpDir, cleanup options.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    root = ROOT,
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    run = spawnRunner,
    git = defaultGit,
    log = console.log,
    tmpDir = os.tmpdir(),
    cleanup = {}
  } = deps
  let opts
  try {
    opts = parseArgs(argv)
  } catch (e) {
    log(`verify-pack: ${e.message}`)
    return 2
  }
  const release = opts.release ? path.resolve(opts.release) : path.join(root, 'release')
  const paths = packagedPaths(platform, arch, release)
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  const results = []
  const report = (id, ok, detail) => {
    results.push({ id, ok })
    log(`${ok ? 'ok  ' : 'fail'}  ${id}  ${detail}`)
  }
  const shown = path.relative(root, paths.unpackedDir)
  log(`Checking the packaged orgai command in ${shown && !shown.startsWith('..') && !path.isAbsolute(shown) ? shown : paths.unpackedDir} (version ${version})`)

  // (a) files
  const required = [
    ['launcher', paths.launcher],
    ['app binary', paths.appBinary],
    ...BUNDLE_FILES.map((f) => [`out/cli/${f}`, path.join(paths.cliBundleDir, f)])
  ]
  const absent = required.filter(([, p]) => !fs.existsSync(p))
  const problemsA = absent.map(([label, p]) => `${label} missing (${p})`)
  if (!absent.some(([label]) => label === 'launcher') && platform !== 'win32' && !isExecutable(paths.launcher))
    problemsA.push(`the launcher is not executable (${paths.launcher})`)
  report('(a) files', problemsA.length === 0, problemsA.length ? problemsA.join('; ') : `launcher, app binary and ${BUNDLE_FILES.join(', ')} are there`)

  // (b) unpacked dependencies
  if (fs.existsSync(paths.cliBundleDir)) {
    const nodeModules = path.join(paths.resourcesDir, 'app.asar.unpacked', 'node_modules')
    const files = listBundle(paths.cliBundleDir).map((name) => ({ name, text: fs.readFileSync(path.join(paths.cliBundleDir, name), 'utf8') }))
    const missing = missingPackages(files, (pkg) => fs.existsSync(path.join(nodeModules, ...pkg.split('/'), 'package.json')))
    const pkgs = [...new Set(missing.map((m) => m.pkg))]
    report(
      '(b) unpacked packages',
      missing.length === 0,
      missing.length
        ? `not unpacked from app.asar: ${pkgs.map((p) => `${p} (imported by ${missing.filter((m) => m.pkg === p).map((m) => m.file).join(', ')})`).join('; ')}`
        : `every import of ${files.length} bundle file(s) is a builtin or unpacked`
    )
  } else report('(b) unpacked packages', false, `no CLI bundle at ${paths.cliBundleDir}`)

  const launcherThere = fs.existsSync(paths.launcher)
  const skipped = (id) => report(id, false, 'skipped: the launcher is missing')
  const made = []
  const userDataDir = fs.mkdtempSync(path.join(tmpDir, 'orgai-verify-data-'))
  made.push(userDataDir)
  const childEnv = verifyEnv(env, userDataDir)
  const orgai = (args, cwd) => {
    const cmd = launchCommand(platform, paths.launcher, args, env)
    return run({ ...cmd, cwd, env: childEnv, timeoutMs: CHECK_TIMEOUT_MS })
  }
  try {
    if (!launcherThere) {
      for (const id of ['(c) --version', '(d) doctor', '(e) exec inproc', ...(opts.skipHost ? [] : ['(f) exec host', '(f) daemon stop'])]) skipped(id)
    } else {
      // (c)
      const v = await orgai(['--version'], userDataDir)
      report('(c) --version', v.code === 0 && versionMatches(v.stdout, version), v.code === 0 && versionMatches(v.stdout, version) ? `prints ${version}` : `expected ${version}: ${showRun(v)}`)

      // (d)
      const d = await orgai(['--output-format', 'json', 'doctor'], userDataDir)
      const doctor = checkDoctorReport(d.stdout)
      report('(d) doctor', !d.timedOut && doctor.ok, doctor.ok ? 'launcher (packaged) and node ok, no check failed' : `${doctor.problems.join('; ')} (${showRun(d)})`)

      // (e) and (f) in a temp git repo
      const repo = fs.mkdtempSync(path.join(tmpDir, 'orgai-verify-repo-'))
      made.push(repo)
      let repoOk = true
      try {
        makeFixtureRepo(repo, git)
      } catch (e) {
        repoOk = false
        report('(e) exec inproc', false, `could not make the fixture git repo: ${e.message}`)
      }
      const execCase = async (id, hostArgs) => {
        const r = await orgai([...hostArgs, 'exec', '--create-project', '--output-format', 'json', EXEC_PROMPT], repo)
        const o = execOutcome(r.stdout)
        const ok = r.code === 0 && o?.outcome === 'completed'
        report(id, ok, ok ? "exit 0, outcome 'completed'" : `expected exit 0 and 'completed', got outcome ${o?.outcome ?? 'none'}: ${showRun(r)}`)
      }
      if (repoOk) {
        await execCase('(e) exec inproc', ['--host', 'inproc'])
        if (!opts.skipHost) {
          await execCase('(f) exec host', [])
          // Plain `daemon stop` (never --force): a host still busy only with work that settles by itself (the run
          // title, the Team review after the finished run) is asked again, at most STOP_RETRY_MS.
          const stopUntil = Date.now() + STOP_RETRY_MS
          let s = await orgai(['--output-format', 'json', 'daemon', 'stop'], repo)
          while (s.code !== 0 && stopRefusal(s.stdout) === 'transient' && Date.now() < stopUntil) {
            await new Promise((r) => setTimeout(r, 1000))
            s = await orgai(['--output-format', 'json', 'daemon', 'stop'], repo)
          }
          report('(f) daemon stop', s.code === 0, s.code === 0 ? 'the background app stopped' : showRun(s))
        }
      }
    }
  } finally {
    await cleanupDaemon(userDataDir, { log, ...cleanup }).catch((e) => log(`Could not check for a leftover host: ${e.message}`))
    for (const dir of made) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
      } catch (e) {
        log(`Could not remove ${dir}: ${e.message}`)
      }
    }
  }
  if (opts.skipHost) log('Skipped (f): the exec through the spawned background app (--skip-host).')
  if (platform === 'win32') log('Note: the Windows launcher path (cmd.exe /d /s /c) is UNVERIFIED by its author.')
  const failed = results.filter((r) => !r.ok)
  log(failed.length ? `${failed.length} check(s) failed.` : 'All checks passed.')
  return failed.length ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`verify-pack: ${e?.stack ?? e}`)
      process.exit(1)
    }
  )
}
