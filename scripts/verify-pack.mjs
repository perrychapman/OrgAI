#!/usr/bin/env node
// Checks the packaged orgai command of a local `npm run pack` (cli-spec 7, Wave 6 gate). Token-free: every run is the
// mock adapter (ORGAI_MOCK=1) on a fresh temp data folder.
//
//   npm run pack:verify                                  check release/<unpacked> of this platform
//   node scripts/verify-pack.mjs --release <dir>         check another release folder
//   node scripts/verify-pack.mjs --skip-host             leave out the exec through the spawned background app
//   node scripts/verify-pack.mjs --npm                   also run (g) with release/npm/orgai-<version>.tgz
//   node scripts/verify-pack.mjs --npm-tarball <tgz>     also run (g) with that tarball
//
// Checks, each printed as one ok / fail line; exit 0 only when all pass:
//   (a) the launcher, the app binary and out/cli/{orgai,tui,inprocHost}.mjs exist; the launcher is executable (POSIX);
//       out/cli/install.json says channel 'app' and package.json's version (Wave 7, cli-standalone.md 3.5)
//   (b) every package the CLI bundle imports is a Node builtin or unpacked from app.asar
//   (c) `orgai --version` prints package.json's version and `channel app`
//   (d) `orgai --output-format json doctor`: launcher ok from the packaged app, node ok, no check failed
//   (e) `orgai --host inproc exec --create-project` with [mock:exec-plan] in a temp git repo: exit 0, 'completed'
//   (f) the same exec with `--host daemon` (the packaged app spawned with --headless-host; `--host auto` no longer
//       starts the app, cli-standalone-default.md 4.1), then `orgai daemon status`
//       must name a running headless-host and `orgai daemon stop` must answer `stopped: true` (exit 0 alone is not
//       enough: stop also exits 0 when no host was running)
//   (g) only with --npm / --npm-tarball (Wave 7, cli-standalone.md 3.4 "Packaged integration"): the npm tarball
//       installed into a temp prefix (`npm i -g <tgz>`, so a shrinkwrap is not applied: this checks discovery, not the
//       tree), then that npm `orgai --host daemon exec` with ORGAI_ELECTRON_PATH at the packed app's binary on its own
//       temp data folder: the npm CLI must start the packaged app headless and finish the mock run; then its
//       `orgai daemon status` (a running headless-host) and `daemon stop` (`stopped: true`), as in (f). Needs npm and the registry (the dependencies are downloaded).
//
// Environment of every command: this one without ELECTRON_RUN_AS_NODE, ORGAI_SECRET_*, ORGAI_ELECTRON_PATH,
// ORGAI_APP_ROOT and ORGAI_DATA_DIR, plus ORGAI_DATA_DIR=<temp>, ORGAI_MOCK=1, NO_COLOR=1. HOME is untouched. Writes
// only its temp folders (removed at the end) and nothing under release/. A host left behind is killed in a finally
// block, by the pid in the temp data folder's daemon.json only.
//
// Windows: the .cmd launcher runs through `cmd.exe /d /s /c` with fixed arguments only. UNVERIFIED (never run).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bareImports, isNodeBuiltin, packagedPaths } from './lib/packLayout.mjs'
import { NPM_PACKAGE_NAME, globalLayout, tarballName } from './lib/npmPackage.mjs'
import { npmInvocation } from './build-npm-package.mjs'
import { DEFAULT_CHECK_TIMEOUT_MS, baseVerifyEnv, cleanupDaemon, defaultGit, daemonJsonPath, execOutcome, launchCommand, makeFixtureRepo, parseJson, spawnRunner, versionMatches } from './lib/verifyCommon.mjs'

// The helpers both checks use live in lib/verifyCommon.mjs; they are re-exported here, where verify-pack's callers and tests look.
export { cleanupDaemon, daemonJsonPath, execOutcome, launchCommand, makeFixtureRepo, spawnRunner, versionMatches }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CHECK_TIMEOUT_MS = DEFAULT_CHECK_TIMEOUT_MS
/** The CLI bundle files the pack must ship. */
export const BUNDLE_FILES = ['orgai.mjs', 'tui.mjs', 'inprocHost.mjs']
/** The launcher source word `orgai doctor` prints for a packaged app: "... (packaged)". */
export const PACKAGED_SOURCE = 'packaged'
export const EXEC_PROMPT = '[mock:exec-plan] verify the packaged app'

/** Parses the command line; throws a plain sentence for anything else. */
export function parseArgs(argv) {
  const out = { release: undefined, skipHost: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--skip-host') out.skipHost = true
    else if (a === '--npm') out.npmTarball ??= true
    else if (a === '--npm-tarball') {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new Error('--npm-tarball needs a file.')
      out.npmTarball = v
    } else if (a === '--release') {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new Error('--release needs a folder.')
      out.release = v
    } else if (a.startsWith('--release=')) {
      const v = a.slice('--release='.length)
      if (!v) throw new Error('--release needs a folder.')
      out.release = v
    } else throw new Error(`Unknown argument ${a}. Use: verify-pack [--release <dir>] [--skip-host] [--npm | --npm-tarball <tgz>]`)
  }
  return out
}

/** The environment of every checked command. Pure. */
export function verifyEnv(base, userDataDir) {
  const out = baseVerifyEnv(base)
  out.ORGAI_DATA_DIR = userDataDir
  // Never create items in the real OS keychain (a script-supplied ORGAI_VAULT_KEY_FILE still wins in the child).
  out.ORGAI_VAULT_NO_OS_KEYSTORE = '1'
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

/**
 * Plain `daemon stop` (never --force) through `orgai(args)`: a host still busy only with work that settles by itself
 * (the run title, the Team review after the finished run) is asked again, at most STOP_RETRY_MS.
 */
export async function stopHost(orgai, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const stopUntil = Date.now() + STOP_RETRY_MS
  let s = await orgai(['--output-format', 'json', 'daemon', 'stop'])
  while (s.code !== 0 && stopRefusal(s.stdout) === 'transient' && Date.now() < stopUntil) {
    await sleep(1000)
    s = await orgai(['--output-format', 'json', 'daemon', 'stop'])
  }
  return s
}

/** The host kind the packaged app reports when the CLI spawned it in the background (`--headless-host`). */
export const BACKGROUND_HOST_KIND = 'headless-host'

/**
 * The `hostKind` of the host an `orgai --output-format json daemon status` document describes, or undefined when it
 * says no host answered (`running: false`) or is not that document. Pure.
 */
export function statusHostKind(stdout) {
  const doc = parseJson(stdout)
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.running !== true) return undefined
  const kind = doc.status && typeof doc.status === 'object' ? doc.status.hostKind : undefined
  return typeof kind === 'string' ? kind : undefined
}

/**
 * True only when an `orgai --output-format json daemon stop` document says a host was stopped (`stopped: true`).
 * `daemon stop` also exits 0 when no host was running (`{ stopped: false, running: false }`), so exit 0 alone proves
 * nothing. Pure.
 */
export function hostWasStopped(stdout) {
  const doc = parseJson(stdout)
  return !!doc && typeof doc === 'object' && !Array.isArray(doc) && doc.stopped === true
}

/**
 * Proof that a background host ran the exec: `daemon status` must name a running `headless-host`, then the stop must
 * say it stopped one. Reports `<prefix> host kind` and `<prefix> daemon stop`.
 */
async function checkBackgroundHost(orgai, report, prefix, stopOk) {
  const st = await orgai(['--output-format', 'json', 'daemon', 'status'])
  const kind = statusHostKind(st.stdout)
  report(
    `${prefix} host kind`,
    kind === BACKGROUND_HOST_KIND,
    kind === BACKGROUND_HOST_KIND ? `a ${BACKGROUND_HOST_KIND} host is running` : `expected a running ${BACKGROUND_HOST_KIND} host, got ${kind ?? 'none'}: ${showRun(st)}`
  )
  const s = await stopHost(orgai)
  const stopped = s.code === 0 && hostWasStopped(s.stdout)
  report(`${prefix} daemon stop`, stopped, stopped ? stopOk : s.code === 0 ? `exit 0 but no host was stopped: ${showRun(s)}` : showRun(s))
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
  const npmDataDirs = []
  const userDataDir = fs.mkdtempSync(path.join(tmpDir, 'orgai-verify-data-'))
  made.push(userDataDir)
  const childEnv = verifyEnv(env, userDataDir)
  const orgai = (args, cwd) => {
    const cmd = launchCommand(platform, paths.launcher, args, env)
    return run({ ...cmd, cwd, env: childEnv, timeoutMs: CHECK_TIMEOUT_MS })
  }
  try {
    if (!launcherThere) {
      for (const id of ['(c) --version', '(d) doctor', '(e) exec inproc', ...(opts.skipHost ? [] : ['(f) exec host', '(f) host kind', '(f) daemon stop'])]) skipped(id)
    } else {
      // (c)
      const v = await orgai(['--version'], userDataDir)
      const vOk = v.code === 0 && versionChannelMatches(v.stdout, version, 'app')
      report('(c) --version', vOk, vOk ? `prints ${version} channel app` : `expected ${version} channel app: ${showRun(v)}`)

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
          await execCase('(f) exec host', ['--host', 'daemon'])
          await checkBackgroundHost((args) => orgai(args, repo), report, '(f)', 'the background app stopped')
        }
      }
    }

    // (g) the npm CLI finds and drives the packed app (only when asked)
    if (opts.npmTarball !== undefined) {
      const tgz = opts.npmTarball === true ? path.join(root, 'release', 'npm', tarballName(NPM_PACKAGE_NAME, version)) : path.resolve(opts.npmTarball)
      if (!fs.existsSync(tgz)) report('(g) npm exec host', false, `no npm tarball at ${tgz}; run node scripts/build-npm-package.mjs first`)
      else if (!fs.existsSync(paths.appBinary)) report('(g) npm exec host', false, `no app binary at ${paths.appBinary}`)
      else {
        const work = fs.mkdtempSync(path.join(tmpDir, 'orgai-verify-npmcli-'))
        made.push(work)
        const prefix = path.join(work, 'prefix')
        const npmData = path.join(work, 'data')
        const npmRepo = path.join(work, 'repo')
        for (const d of [prefix, npmData, npmRepo]) fs.mkdirSync(d)
        npmDataDirs.push(npmData)
        const npm = npmInvocation(env, process.execPath, platform)
        const nodeDir = path.dirname(process.execPath)
        const sep = platform === 'win32' ? ';' : ':'
        const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
        const withNode = (e) => ({ ...e, [pathKey]: e[pathKey] ? `${nodeDir}${sep}${e[pathKey]}` : nodeDir })
        const inst = await run({
          command: npm.command,
          args: [...npm.prefix, 'install', '--global', '--prefix', prefix, tgz],
          cwd: work,
          env: withNode({ ...env, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' }),
          timeoutMs: 15 * 60_000
        })
        const bin = globalLayout(platform, prefix).bin
        if (inst.code !== 0 || !fs.existsSync(bin)) report('(g) npm exec host', false, `npm install -g failed: ${showRun(inst)}`)
        else {
          let repoOk = true
          try {
            makeFixtureRepo(npmRepo, git)
          } catch (e) {
            repoOk = false
            report('(g) npm exec host', false, `could not make the fixture git repo: ${e.message}`)
          }
          if (repoOk) {
            const npmEnv = withNode({ ...verifyEnv(env, npmData), ORGAI_ELECTRON_PATH: paths.appBinary })
            const npmOrgai = (args) => run({ ...launchCommand(platform, bin, args, env), cwd: npmRepo, env: npmEnv, timeoutMs: CHECK_TIMEOUT_MS })
            const r = await npmOrgai(['--host', 'daemon', 'exec', '--create-project', '--output-format', 'json', EXEC_PROMPT])
            const o = execOutcome(r.stdout)
            const ok = r.code === 0 && o?.outcome === 'completed'
            report('(g) npm exec host', ok, ok ? "exit 0, outcome 'completed'" : `expected exit 0 and 'completed', got outcome ${o?.outcome ?? 'none'}: ${showRun(r)}`)
            // exec alone could have run in-process (a --host auto fallback): only a running headless-host that the
            // stop then stops proves the npm CLI started the packed app.
            await checkBackgroundHost(npmOrgai, report, '(g) npm', 'the npm orgai started and stopped the packed app headless')
          }
        }
      }
    }
  } finally {
    for (const d of npmDataDirs) await cleanupDaemon(d, { log, ...cleanup }).catch((e) => log(`Could not check for a leftover host: ${e.message}`))
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
