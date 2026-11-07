#!/usr/bin/env node
// Writes or removes out/cli/install.json (Wave 7, docs/design/cli-standalone.md 3.5): `{ channel, version, commit }`
// beside the CLI bundle, read by src/cli/installInfo.ts. The app's bundle carries channel 'app': pack-local.mjs and
// the release workflow write it after the CLI build and before electron-builder (electron-builder.yml unpacks
// out/cli/**). The npm package's copy is written by build-npm-package.mjs into its own folder, never into out/cli.
//
//   node scripts/write-install-info.mjs --channel app     write out/cli/install.json (version from package.json)
//   node scripts/write-install-info.mjs --remove          remove it again (a checkout reads as channel 'dev')
//   node scripts/write-install-info.mjs --channel app --electron-builder <args...>
//                                                          write it, run the local electron-builder with <args>, then
//                                                          remove it whatever happened (the npm run dist:* scripts)
//
// Touches only out/cli/install.json. Spawns git (the commit) and, with --electron-builder, node_modules' electron-builder.
// Token-free.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installInfoFor } from './lib/npmPackage.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const INSTALL_INFO_FILE = 'install.json'

/**
 * The commit to stamp: `git rev-parse HEAD` of the checkout that was built, else GITHUB_SHA, shortened to 12;
 * undefined when unknown. The checkout comes first: release.yml checks out the meta job's ref, which for a hand-run
 * Release with a `tag` input is the tag, while GITHUB_SHA is the head of the branch the run was dispatched from.
 */
export function commitOf(root, env = process.env, exec = execFileSync) {
  try {
    const sha = String(exec('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })).trim()
    if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha.slice(0, 12).toLowerCase()
  } catch {
    /* not a checkout, or no git: fall back to the CI variable */
  }
  const fromEnv = typeof env.GITHUB_SHA === 'string' && /^[0-9a-f]{7,40}$/i.test(env.GITHUB_SHA) ? env.GITHUB_SHA : undefined
  return fromEnv ? fromEnv.slice(0, 12).toLowerCase() : undefined
}

export function readVersion(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
}

/** Writes `<cliDir>/install.json`; refuses a missing bundle folder (build first) and a link at the target. */
export function writeInstallInfo(cliDir, info) {
  if (!fs.existsSync(path.join(cliDir, 'orgai.mjs'))) throw new Error(`${cliDir} holds no CLI bundle (orgai.mjs); build it first`)
  const target = path.join(cliDir, INSTALL_INFO_FILE)
  try {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`${target} is a link; remove it by hand`)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  const tmp = `${target}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2) + '\n')
  fs.renameSync(tmp, target)
  return target
}

/** Removes `<cliDir>/install.json` when it is there. Returns true when a file was removed. */
export function removeInstallInfo(cliDir) {
  const target = path.join(cliDir, INSTALL_INFO_FILE)
  try {
    fs.unlinkSync(target)
    return true
  } catch (e) {
    if (e.code === 'ENOENT') return false
    throw e
  }
}

/** Signals that end a build from outside (Ctrl+C, a kill, a closed terminal). SIGKILL cannot be caught. */
export const CLEANUP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']

/**
 * Runs `fn` and removes `<cliDir>/install.json` afterwards, also when the build is ended by a signal (review round 2:
 * a `finally` alone does not run when Ctrl+C ends node). While `fn` runs, a listener per CLEANUP_SIGNALS removes the
 * file, drops the listeners and re-raises the signal so the process still ends the way it was asked to. A listener
 * also stops node's default exit, so during a synchronous child (execFileSync) the child ends first (it got the same
 * Ctrl+C), the throw reaches the `finally`, and the file is gone either way. `proc` is for tests.
 */
export function withInstallInfoCleanup(cliDir, fn, proc = process) {
  const listeners = new Map()
  const drop = () => {
    for (const [sig, l] of listeners) proc.removeListener(sig, l)
    listeners.clear()
  }
  const cleanup = () => {
    try {
      removeInstallInfo(cliDir)
    } catch {
      /* best effort: the next build empties out/cli */
    }
  }
  for (const sig of CLEANUP_SIGNALS) {
    const l = () => {
      cleanup()
      drop()
      proc.kill(proc.pid, sig)
    }
    listeners.set(sig, l)
    proc.on(sig, l)
  }
  try {
    return fn()
  } finally {
    drop()
    cleanup()
  }
}

/** The local electron-builder's cli script (node_modules/electron-builder, its "electron-builder" bin). */
export function electronBuilderBin(root) {
  const dir = path.join(root, 'node_modules', 'electron-builder')
  let meta
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    throw new Error('electron-builder is not installed in node_modules; run npm install first')
  }
  const rel = typeof meta.bin === 'string' ? meta.bin : meta.bin?.['electron-builder']
  if (!rel) throw new Error('electron-builder has no "electron-builder" bin')
  return path.join(dir, rel)
}

export function main(argv = process.argv.slice(2), root = ROOT, log = console.log, env = process.env, exec = execFileSync, signalTarget = process) {
  const cliDir = path.join(root, 'out', 'cli')
  if (argv.length === 1 && argv[0] === '--remove') {
    log(removeInstallInfo(cliDir) ? `Removed ${path.relative(root, path.join(cliDir, INSTALL_INFO_FILE))}` : 'No install.json to remove.')
    return
  }
  let channel
  let builderArgs
  const ebAt = argv.indexOf('--electron-builder')
  const own = ebAt === -1 ? argv : argv.slice(0, ebAt)
  if (ebAt !== -1) builderArgs = argv.slice(ebAt + 1)
  if (own.length === 2 && own[0] === '--channel') channel = own[1]
  else if (own.length === 1 && own[0].startsWith('--channel=')) channel = own[0].slice('--channel='.length)
  else throw new Error('Use: write-install-info --channel app|npm|archive [--electron-builder <args...>], or --remove')
  const info = installInfoFor(channel, readVersion(root), commitOf(root, env))
  const bin = builderArgs ? electronBuilderBin(root) : undefined
  if (!bin) {
    const target = writeInstallInfo(cliDir, info)
    log(`Wrote ${path.relative(root, target)}: ${JSON.stringify(info)}`)
    return
  }
  // The checkout's own out/cli reads as channel 'dev' again afterwards (HostLauncher treats 'app' as a packaged
  // layout), even after Ctrl+C or a kill during electron-builder.
  withInstallInfoCleanup(
    cliDir,
    () => {
      const target = writeInstallInfo(cliDir, info)
      log(`Wrote ${path.relative(root, target)}: ${JSON.stringify(info)}`)
      try {
        exec(process.execPath, [bin, ...builderArgs], { cwd: root, stdio: 'inherit', windowsHide: true, env })
      } finally {
        log(`Removing ${path.relative(root, target)}`)
      }
    },
    signalTarget
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main()
  } catch (e) {
    console.error(`write-install-info: ${e.message}`)
    process.exit(1)
  }
}
