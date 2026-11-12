#!/usr/bin/env node
// Checks a local `npm run pack` of the desktop app (cli-standalone-default.md 5.2). The packaged app does not contain the
// orgai CLI, so this proves the app is a plain desktop package: nothing from the CLI is in it, and the packed app
// still boots on the mock adapter (no token is spent, no window is shown).
//
//   npm run pack:verify                                  check release/<unpacked> of this platform
//   node scripts/verify-pack.mjs --release <dir>         check another release folder
//
// Checks, each printed as one ok / fail line; exit 0 only when all pass:
//   (a) the app binary exists
//   (b) no `out/cli` inside app.asar and none in app.asar.unpacked
//   (c) no `bin/orgai` or `bin/orgai.cmd` launcher in the app's resources
//   (d) the desktop's own runtime packages (Claude Agent SDK, Codex, zod) are unpacked beside app.asar
//   (e) the packed app boots: started on a temp ORGAI_DATA_DIR with ORGAI_MOCK=1 and ORGAI_WINDOW_HIDDEN=1 it writes
//       run/daemon.json in state 'ready' (main loads from app.asar, the preload and renderer are found), writes
//       main.log, and a polite quit (SIGTERM; taskkill without /F on Windows) removes daemon.json again. This is the
//       one check that starts the app; the child env has no ORGAI_VAULT_*, ORGAI_CLI_*, ORGAI_SECRET_* or ORGAI_DAEMON_*
//       variable and macOS gets --use-mock-keychain, so it touches nothing of the user's; it also starts the macOS certificate-reader child (RunAsNode) as any launch does.
//   (f) the certificate reader's way of starting works: the packed binary run with ELECTRON_RUN_AS_NODE=1 (as the app
//       starts its certificate reader child) executes a script and prints its answer
//   (g) the bundled Claude and Codex binaries for this platform, unpacked beside app.asar, start (`--version`)
//       Both are run directly, never through the CLI.
// The orgai npm package has its own check, scripts/verify-npm.mjs.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { packagedPaths } from './lib/packLayout.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** Packages the desktop loads from app.asar.unpacked (electron-builder.yml asarUnpack). */
export const DESKTOP_UNPACKED_PACKAGES = ['@anthropic-ai/claude-agent-sdk', '@openai/codex', 'zod']

/** Parses the command line; throws a plain sentence for anything else. */
export function parseArgs(argv) {
  const out = { release: undefined }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--release') {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new Error('--release needs a folder.')
      out.release = v
    } else if (a.startsWith('--release=')) {
      const v = a.slice('--release='.length)
      if (!v) throw new Error('--release needs a folder.')
      out.release = v
    } else throw new Error(`Unknown argument ${a}. Use: verify-pack [--release <dir>]`)
  }
  return out
}

/** The entries of an asar listing (paths with either slash, leading slash) that belong to out/cli. Pure. */
export function cliEntriesInAsar(entries) {
  return entries.map((e) => String(e).replace(/\\/g, '/').replace(/^\/+/, '')).filter((e) => e === 'out/cli' || e.startsWith('out/cli/'))
}

/** Lists an asar archive's entries. Uses @electron/asar (a dependency of electron-builder). */
export function listAsar(file) {
  const asar = createRequire(import.meta.url)('@electron/asar')
  return asar.listPackage(file, { isPack: false })
}

/** How long (e) waits for the packed app to become ready, and then to quit. */
export const BOOT_TIMEOUT_MS = 60_000
export const QUIT_TIMEOUT_MS = 20_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readDaemon(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'data', 'run', 'daemon.json'), 'utf8'))
  } catch {
    return undefined
  }
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await sleep(150)
  }
  return fn()
}

/**
 * (e): boots the packed app on a temp data folder with the mock adapter and hidden windows, waits for daemon.json
 * 'ready', then asks it to quit and waits for daemon.json to go. Returns { ok, detail }. `spawnApp(binary, args, opts)`
 * and `quit(child)` are for tests.
 */
export async function bootCheck(binary, deps = {}) {
  const { spawnApp = spawn, quit = politeQuit, bootMs = BOOT_TIMEOUT_MS, quitMs = QUIT_TIMEOUT_MS } = deps
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgai-verify-pack-'))
  let child
  let exited = false
  let output = ''
  try {
    const env = { ...process.env, ORGAI_DATA_DIR: dataDir, ORGAI_MOCK: '1', ORGAI_WINDOW_HIDDEN: '1' }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    // Nothing of the developer's vault, CLI or daemon setup reaches the packed app (it would open their real key file).
    for (const k of Object.keys(env)) if (/^ORGAI_(VAULT|CLI|SECRET|DAEMON)_/.test(k)) delete env[k]
    // macOS: Chromium's cookie encryption and safeStorage use a mock keychain, never the installed app's login-keychain item.
    const args = process.platform === 'darwin' ? ['--use-mock-keychain'] : []
    child = spawnApp(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    child.stdout?.on('data', (d) => (output += d))
    child.stderr?.on('data', (d) => (output += d))
    child.on('exit', () => (exited = true))
    child.on('error', (e) => ((output += `spawn error: ${e.message}`), (exited = true)))
    const ready = await waitFor(() => readDaemon(dataDir)?.state === 'ready' || exited, bootMs)
    const daemon = readDaemon(dataDir)
    if (!ready || daemon?.state !== 'ready') {
      return { ok: false, detail: `${exited ? 'the app exited' : 'no ready daemon.json'} within ${Math.round(bootMs / 1000)} s${output ? `: ${output.trim().slice(-300)}` : ''}` }
    }
    if (daemon.hostKind !== 'desktop') return { ok: false, detail: `daemon.json says hostKind ${daemon.hostKind}, not desktop` }
    const logOk = fs.existsSync(path.join(dataDir, 'logs', 'main.log'))
    quit(child)
    const gone = await waitFor(() => exited && !readDaemon(dataDir), quitMs)
    if (!gone) return { ok: false, detail: 'the app did not quit cleanly (daemon.json stayed or the process kept running)' }
    return logOk ? { ok: true, detail: 'booted on the mock adapter, wrote main.log, and quit cleanly' } : { ok: false, detail: 'booted but wrote no logs/main.log' }
  } finally {
    if (child && !exited) {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

/** The environment the probes run in: no ORGAI_* variable of the developer reaches them. */
function probeEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.NODE_OPTIONS
  for (const k of Object.keys(env)) if (/^ORGAI_/.test(k)) delete env[k]
  return env
}

/** (f): the packed binary as a plain Node (ELECTRON_RUN_AS_NODE=1), the way the certificate reader child is started. */
export function certReaderCheck(binary, run = spawnSync) {
  const script = "process.stdout.write('cert-reader-ok ' + typeof require('node:tls').getCACertificates)"
  const r = run(binary, ['-e', script], { env: probeEnv({ ELECTRON_RUN_AS_NODE: '1' }), cwd: os.tmpdir(), encoding: 'utf8', timeout: 30_000, windowsHide: true })
  const out = String(r.stdout ?? '')
  if (r.error) return { ok: false, detail: `could not run ${binary} as Node: ${r.error.message}` }
  if (r.status !== 0 || !out.startsWith('cert-reader-ok')) return { ok: false, detail: `exit ${r.status}${r.signal ? ` (${r.signal})` : ''}: ${(out + String(r.stderr ?? '')).trim().slice(-200)}` }
  return { ok: true, detail: `the packed binary runs as Node (${out.trim()})` }
}

/** The unpacked Claude and Codex binaries for a platform: [{ name, file }]. Pure apart from reading folders. */
export function agentBinaries(nodeModules, platform = process.platform, arch = process.arch) {
  const exe = platform === 'win32' ? '.exe' : ''
  const mine = (dir) => dir.includes(platform) && dir.includes(arch)
  const list = (d) => {
    try {
      return fs.readdirSync(d)
    } catch {
      return []
    }
  }
  const found = []
  for (const dir of list(path.join(nodeModules, '@anthropic-ai')).filter((d) => d.startsWith('claude-agent-sdk-') && mine(d))) {
    const file = path.join(nodeModules, '@anthropic-ai', dir, `claude${exe}`)
    if (fs.existsSync(file)) found.push({ name: 'claude', file })
  }
  for (const dir of list(path.join(nodeModules, '@openai')).filter((d) => d.startsWith('codex-') && mine(d))) {
    const vendor = path.join(nodeModules, '@openai', dir, 'vendor')
    for (const triple of list(vendor)) {
      const file = path.join(vendor, triple, 'bin', `codex${exe}`)
      if (fs.existsSync(file)) found.push({ name: 'codex', file })
    }
  }
  return found
}

/** (g): each bundled agent binary answers `--version`. Both must be present for this platform. */
export function agentBinaryCheck(nodeModules, platform = process.platform, arch = process.arch, run = spawnSync) {
  const bins = agentBinaries(nodeModules, platform, arch)
  const problems = []
  for (const name of ['claude', 'codex']) if (!bins.some((b) => b.name === name)) problems.push(`no ${name} binary for ${platform}-${arch} in app.asar.unpacked`)
  const versions = []
  for (const b of bins) {
    const r = run(b.file, ['--version'], { env: probeEnv(), cwd: os.tmpdir(), encoding: 'utf8', timeout: 30_000, windowsHide: true })
    const out = String(r.stdout ?? '').trim().split('\n')[0]
    if (r.error || r.status !== 0 || !out) problems.push(`${b.name} --version failed${r.error ? ` (${r.error.message})` : ` (exit ${r.status}): ${String(r.stderr ?? '').trim().slice(-120)}`}`)
    else versions.push(`${b.name} ${out}`)
  }
  return problems.length ? { ok: false, detail: problems.join('; ') } : { ok: true, detail: versions.join(', ') }
}

/** Asks the app to quit the way a user would: SIGTERM runs its shutdown; Windows has no signals, so taskkill without /F. */
function politeQuit(child) {
  // The system taskkill by absolute path (no PATH or current-folder lookup), run from the temp folder.
  if (process.platform === 'win32') spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T'], { stdio: 'ignore', windowsHide: true, cwd: os.tmpdir() })
  else child.kill('SIGTERM')
}

/**
 * Runs every check; returns the exit code (0 only when all pass). `deps` are for tests: root, platform, arch, log,
 * listAsar (file -> entries).
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const { root = ROOT, platform = process.platform, arch = process.arch, log = console.log, list = listAsar, boot = bootCheck, certReader = certReaderCheck, agents = agentBinaryCheck } = deps
  let opts
  try {
    opts = parseArgs(argv)
  } catch (e) {
    log(`verify-pack: ${e.message}`)
    return 2
  }
  const release = opts.release ? path.resolve(opts.release) : path.join(root, 'release')
  const paths = packagedPaths(platform, arch, release)
  if (!fs.existsSync(paths.unpackedDir)) {
    log(`verify-pack: no packed app at ${paths.unpackedDir}. Run npm run pack first.`)
    return 2
  }
  const results = []
  const report = (id, ok, detail) => {
    results.push({ id, ok })
    log(`${ok ? 'ok  ' : 'fail'}  ${id}  ${detail}`)
  }
  log(`Checking the packaged app in ${paths.unpackedDir}`)

  report('(a) app binary', fs.existsSync(paths.appBinary), fs.existsSync(paths.appBinary) ? 'there' : `missing (${paths.appBinary})`)

  // (b) no CLI bundle in or beside app.asar
  const asarFile = path.join(paths.resourcesDir, 'app.asar')
  const problemsB = []
  if (!fs.existsSync(asarFile)) problemsB.push(`app.asar missing (${asarFile})`)
  else {
    try {
      const inside = cliEntriesInAsar(list(asarFile))
      if (inside.length) problemsB.push(`app.asar holds ${inside.length} out/cli entr${inside.length === 1 ? 'y' : 'ies'} (first: ${inside[0]})`)
    } catch (e) {
      problemsB.push(`could not list app.asar: ${e.message}`)
    }
  }
  if (fs.existsSync(paths.cliBundleDir)) problemsB.push(`${paths.cliBundleDir} exists`)
  report('(b) no out/cli', problemsB.length === 0, problemsB.length ? problemsB.join('; ') : 'not in app.asar, not in app.asar.unpacked')

  // (c) no launcher
  const binDir = path.join(paths.resourcesDir, 'bin')
  const launchers = ['orgai', 'orgai.cmd'].map((f) => path.join(binDir, f)).filter((f) => fs.existsSync(f))
  report('(c) no orgai launcher', launchers.length === 0, launchers.length ? `found ${launchers.join(', ')}` : 'no bin/orgai, no bin/orgai.cmd')

  // (d) the desktop's own packages
  const nodeModules = path.join(paths.resourcesDir, 'app.asar.unpacked', 'node_modules')
  const missing = DESKTOP_UNPACKED_PACKAGES.filter((pkg) => !fs.existsSync(path.join(nodeModules, ...pkg.split('/'), 'package.json')))
  report('(d) desktop packages', missing.length === 0, missing.length ? `not unpacked from app.asar: ${missing.join(', ')}` : `${DESKTOP_UNPACKED_PACKAGES.join(', ')} are unpacked`)

  // (e) the packed app boots (only when the earlier checks found a binary: otherwise nothing could start)
  if (fs.existsSync(paths.appBinary)) {
    const r = await boot(paths.appBinary)
    report('(e) packed app boots', r.ok, r.detail)
  } else report('(e) packed app boots', false, 'skipped: no app binary')

  // (f) and (g): the certificate reader's start and the bundled agent binaries, run directly
  if (fs.existsSync(paths.appBinary)) {
    const f = certReader(paths.appBinary)
    report('(f) certificate reader starts', f.ok, f.detail)
  } else report('(f) certificate reader starts', false, 'skipped: no app binary')
  const g = agents(nodeModules, platform, arch)
  report('(g) claude and codex start', g.ok, g.detail)

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
