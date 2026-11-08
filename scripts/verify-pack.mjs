#!/usr/bin/env node
// Checks the packaged orgai command of a local `npm run pack` (cli-spec 7, Wave 6 gate). Token-free: every run is the
// mock adapter (ORGAI_MOCK=1) on a fresh temp data folder.
//
//   npm run pack:verify                                  check release/<unpacked> of this platform
//   node scripts/verify-pack.mjs --release <dir>         check another release folder
//
// Checks, each printed as one ok / fail line; exit 0 only when all pass:
//   (a) the launcher, the app binary and out/cli/{orgai,tui,inprocHost}.mjs exist; the launcher is executable (POSIX);
//       out/cli/install.json says channel 'app' and package.json's version (Wave 7, cli-standalone.md 3.5)
//   (b) every package the CLI bundle imports is a Node builtin or unpacked from app.asar
//   (c) `orgai --version` prints package.json's version and `channel app`
//   (d) `orgai --output-format json doctor`: node ok, no check failed
//   (e) `orgai exec --create-project` with [mock:exec-plan] in a temp git repo: exit 0, 'completed'
// The old (f)/(g) steps (exec through a spawned background app, `orgai daemon`, the npm CLI driving the packed app)
// are gone: the orgai command runs its own host and shares nothing with the app (cli-standalone-default.md 4.1, 5.2).
// The npm package has its own check, scripts/verify-npm.mjs.
//
// Environment of every command: this one without ELECTRON_RUN_AS_NODE, ORGAI_SECRET_*, ORGAI_ELECTRON_PATH,
// ORGAI_APP_ROOT and ORGAI_DATA_DIR, plus ORGAI_CLI_DATA_DIR=<temp>, ORGAI_MOCK=1, NO_COLOR=1. HOME is untouched. Writes
// only its temp folders (removed at the end) and nothing under release/. A host left behind is killed in a finally
// block, by the pid in the temp data folder's daemon.json only.
//
// Windows: the .cmd launcher runs through `cmd.exe /d /s /c` with fixed arguments only. UNVERIFIED (never run).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bareImports, isNodeBuiltin, packagedPaths } from './lib/packLayout.mjs'
import { DEFAULT_CHECK_TIMEOUT_MS, baseVerifyEnv, cleanupDaemon, defaultGit, daemonJsonPath, execOutcome, launchCommand, makeFixtureRepo, parseJson, spawnRunner, versionMatches } from './lib/verifyCommon.mjs'

// The helpers both checks use live in lib/verifyCommon.mjs; they are re-exported here, where verify-pack's callers and tests look.
export { cleanupDaemon, daemonJsonPath, execOutcome, launchCommand, makeFixtureRepo, spawnRunner, versionMatches }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CHECK_TIMEOUT_MS = DEFAULT_CHECK_TIMEOUT_MS
/** The CLI bundle files the pack must ship. */
export const BUNDLE_FILES = ['orgai.mjs', 'tui.mjs', 'inprocHost.mjs']
export const EXEC_PROMPT = '[mock:exec-plan] verify the packaged app'

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

/** The environment of every checked command. Pure. */
export function verifyEnv(base, userDataDir) {
  const out = baseVerifyEnv(base)
  // The CLI ignores ORGAI_DATA_DIR (cli-standalone-default.md 3.1): its own folder is the temp one, never the user's.
  out.ORGAI_CLI_DATA_DIR = userDataDir
  // Never create items in the real OS keychain (a script-supplied ORGAI_CLI_VAULT_KEY_FILE still wins in the child).
  out.ORGAI_CLI_VAULT_NO_OS_KEYSTORE = '1'
  return out
}




/** True when `--version` output names this version and the install channel (`0.1.7 channel app commit ...`). Pure. */
export function versionChannelMatches(stdout, version, channel = 'app') {
  return versionMatches(stdout, version) && new RegExp(`(^|\\s)channel ${channel}(\\s|$)`).test(String(stdout ?? '').trim())
}

/**
 * What is wrong with the app bundle's install.json (cli-standalone.md 3.5): missing, not JSON, a channel other than
 * 'app' or another version. Undefined when it is right.
 */
export function appInstallInfoProblem(cliBundleDir, version) {
  const file = path.join(cliBundleDir, 'install.json')
  let info
  try {
    info = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    return e?.code === 'ENOENT' ? 'out/cli/install.json missing (the app would read as channel dev)' : `out/cli/install.json is not valid JSON (${e.message})`
  }
  if (info?.channel !== 'app') return `out/cli/install.json says channel ${JSON.stringify(info?.channel)}, expected "app"`
  if (info.version !== version) return `out/cli/install.json says version ${JSON.stringify(info.version)}, expected ${version}`
  return undefined
}

/**
 * The `orgai --output-format json doctor` document checked: it parses, 'node' is ok and no check is 'fail'. Returns
 * { ok, problems }. Pure.
 */
export function checkDoctorReport(stdout) {
  const doc = parseJson(stdout)
  const checks = Array.isArray(doc?.checks) ? doc.checks : undefined
  if (!checks) return { ok: false, problems: ['the doctor output is not a JSON document with checks'] }
  const problems = []
  const node = checks.find((c) => c?.id === 'node')
  if (!node) problems.push('no node check')
  else if (node.status !== 'ok') problems.push(`node is ${node.status}: ${node.detail}`)
  for (const c of checks) if (c?.status === 'fail' && c.id !== 'node') problems.push(`${c.id} failed: ${c.detail}`)
  return { ok: problems.length === 0, problems }
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
  if (fs.existsSync(paths.cliBundleDir)) {
    const infoProblem = appInstallInfoProblem(paths.cliBundleDir, version)
    if (infoProblem) problemsA.push(infoProblem)
  }
  report('(a) files', problemsA.length === 0, problemsA.length ? problemsA.join('; ') : `launcher, app binary, ${BUNDLE_FILES.join(', ')} and install.json (channel app) are there`)

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
      for (const id of ['(c) --version', '(d) doctor', '(e) exec']) skipped(id)
    } else {
      // (c)
      const v = await orgai(['--version'], userDataDir)
      const vOk = v.code === 0 && versionChannelMatches(v.stdout, version, 'app')
      report('(c) --version', vOk, vOk ? `prints ${version} channel app` : `expected ${version} channel app: ${showRun(v)}`)

      // (d)
      const d = await orgai(['--output-format', 'json', 'doctor'], userDataDir)
      const doctor = checkDoctorReport(d.stdout)
      report('(d) doctor', !d.timedOut && doctor.ok, doctor.ok ? 'node ok, no check failed' : `${doctor.problems.join('; ')} (${showRun(d)})`)

      // (e) in a temp git repo
      const repo = fs.mkdtempSync(path.join(tmpDir, 'orgai-verify-repo-'))
      made.push(repo)
      let repoOk = true
      try {
        makeFixtureRepo(repo, git)
      } catch (e) {
        repoOk = false
        report('(e) exec', false, `could not make the fixture git repo: ${e.message}`)
      }
      if (repoOk) {
        const r = await orgai(['exec', '--create-project', '--output-format', 'json', EXEC_PROMPT], repo)
        const o = execOutcome(r.stdout)
        const ok = r.code === 0 && o?.outcome === 'completed'
        report('(e) exec', ok, ok ? "exit 0, outcome 'completed'" : `expected exit 0 and 'completed', got outcome ${o?.outcome ?? 'none'}: ${showRun(r)}`)
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
