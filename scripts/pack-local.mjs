#!/usr/bin/env node
// Local unpacked build that keeps exactly two builds: the current one and the previous one.
//
//   npm run pack                              rotate, build, pack, record
//   node scripts/pack-local.mjs --dry-run     print what it would do, change nothing
//
// Layout (all under <repo>/release/, gitignored):
//   release/<unpacked>/                       current build (win-unpacked on Windows)
//   release/BUILD.txt                         version, commit and time of the current build
//   release/previous/<unpacked>/ + BUILD.txt  the build before it
//
// Steps: electron-vite build (main, preload, renderer), then electron-builder --dir --publish never. The app ships no
// orgai CLI (cli-standalone-default.md 5.2: electron-builder.yml excludes out/cli), so no CLI bundle is built and no
// install.json is written. On macOS the children get CSC_IDENTITY_AUTO_DISCOVERY=false unless the caller set it, so a local pack never signs, never
// contacts a timestamp server and never notarizes. Check the result with `npm run pack:verify`.
//
// Never touches anything outside release/ (and out/, which the builds write). Spawns only node (the local
// electron-vite, vite and electron-builder CLI entries, so no .cmd shim and no shell on Windows) and git, with
// execFileSync. Token-free.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { unpackedLayout } from './lib/packLayout.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export { unpackedLayout }

/** The build steps in order: [package, bin name, args]. Pure. */
export function buildSteps() {
  return [
    ['electron-vite', 'electron-vite', ['build']],
    ['electron-builder', 'electron-builder', ['--dir', '--publish', 'never']]
  ]
}

/**
 * The children's environment and a sentence saying what was chosen. On darwin CSC_IDENTITY_AUTO_DISCOVERY is set to
 * false unless the caller set it (any value the caller set is kept). Pure.
 */
export function childEnv(platform, env) {
  const out = { ...env }
  if (platform !== 'darwin') return { env: out, note: undefined }
  if (env.CSC_IDENTITY_AUTO_DISCOVERY !== undefined) {
    return { env: out, note: `CSC_IDENTITY_AUTO_DISCOVERY=${env.CSC_IDENTITY_AUTO_DISCOVERY} (set by the caller, kept)` }
  }
  out.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  return { env: out, note: 'CSC_IDENTITY_AUTO_DISCOVERY=false (no signing, no timestamp server, no notarization)' }
}

/** BUILD.txt contents. Pure; `builtAt` is a Date or an ISO string. */
export function formatBuildInfo({ version, commit, builtAt, note }) {
  const when = builtAt instanceof Date ? builtAt.toISOString() : String(builtAt)
  const lines = [`version: ${version || 'unknown'}`, `commit: ${commit || 'unknown'}`, `built: ${when}`]
  if (note) lines.push(`note: ${note}`)
  return lines.join('\n') + '\n'
}

/** Throws unless `p` is strictly inside `parent` (lexically). */
export function assertInside(parent, p) {
  const rel = path.relative(path.resolve(parent), path.resolve(p))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to touch ${p}: it is not inside ${parent}`)
  }
}

/** Every path the script reads or writes. Pure. */
export function plan(root, platform = process.platform, arch = process.arch) {
  const release = path.join(root, 'release')
  const { dir, marker } = unpackedLayout(platform, arch)
  const current = path.join(release, dir)
  const previous = path.join(release, 'previous')
  return {
    release,
    current,
    marker: path.join(current, marker),
    buildTxt: path.join(release, 'BUILD.txt'),
    previous,
    previousDir: path.join(previous, dir),
    previousTxt: path.join(previous, 'BUILD.txt')
  }
}

function readVersion(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
}

function gitShortSha(root) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return 'unknown'
  }
}

/** Absolute path of a local package's CLI entry, run with this node. */
function localBin(root, pkg, name) {
  const dir = path.join(root, 'node_modules', pkg)
  let meta
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    throw new Error(`${pkg} is not installed in node_modules; run npm install first`)
  }
  const rel = typeof meta.bin === 'string' ? meta.bin : meta.bin?.[name]
  if (!rel) throw new Error(`${pkg} has no "${name}" bin`)
  return path.join(dir, rel)
}

/** True for a real folder, false when missing; throws on a link or junction so we never delete through one. */
function isRealDir(p) {
  let st
  try {
    st = fs.lstatSync(p)
  } catch (e) {
    if (e.code === 'ENOENT') return false
    throw e
  }
  if (st.isSymbolicLink()) throw new Error(`${p} is a link; remove it by hand`)
  if (!st.isDirectory()) throw new Error(`${p} exists and is not a folder; remove it by hand`)
  return true
}

function indent(s) {
  return s
    .trimEnd()
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')
}

function rotate(p, { dryRun, log, root }) {
  for (const t of [p.current, p.previous, p.previousDir, p.previousTxt, p.buildTxt]) assertInside(p.release, t)
  const rel = (x) => path.relative(root, x)
  if (!fs.existsSync(p.marker)) {
    log(`No current build at ${rel(p.marker)}; nothing to keep as previous.`)
    return
  }
  isRealDir(p.current)
  // The previous build's record: its own BUILD.txt when there is one, else what is known now.
  const info = fs.existsSync(p.buildTxt)
    ? fs.readFileSync(p.buildTxt, 'utf8')
    : formatBuildInfo({
        version: readVersion(root),
        commit: gitShortSha(root),
        builtAt: fs.statSync(p.marker).mtime,
        note: 'recorded when moved (no BUILD.txt): version and commit are the checkout at that time, built is the exe date'
      })
  const hadPrevious = isRealDir(p.previous)
  if (dryRun) {
    if (hadPrevious) log(`Would delete ${rel(p.previous)}`)
    log(`Would move ${rel(p.current)} -> ${rel(p.previousDir)}`)
    log(`Would write ${rel(p.previousTxt)}:\n${indent(info)}`)
    return
  }
  if (hadPrevious) fs.rmSync(p.previous, { recursive: true, force: true })
  fs.mkdirSync(p.previous, { recursive: true })
  try {
    fs.renameSync(p.current, p.previousDir)
  } catch (e) {
    throw new Error(
      `Could not move ${rel(p.current)} to ${rel(p.previousDir)} (${e.code || e.message}). ` +
        'Close OrgAI if it runs from that folder (and any window open in it), then try again. Nothing was built.'
    )
  }
  fs.writeFileSync(p.previousTxt, info)
  if (fs.existsSync(p.buildTxt)) fs.rmSync(p.buildTxt)
  log(`Kept the previous build in ${rel(p.previous)}`)
}

/**
 * `options.platform` / `options.env` are for tests (default: this process); `options.exec` replaces execFileSync.
 */
export function main(argv = process.argv.slice(2), root = ROOT, log = console.log, options = {}) {
  const { platform = process.platform, env = process.env, exec = execFileSync } = options
  const unknown = argv.filter((a) => a !== '--dry-run')
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(' ')}. Only --dry-run is supported.`)
  const dryRun = argv.includes('--dry-run')
  const p = plan(root, platform)
  const rel = (x) => path.relative(root, x)
  if (dryRun) log('Dry run: nothing is changed.')

  const steps = buildSteps()
  const child = childEnv(platform, env)
  // Check the tools are installed before moving anything, so a broken install keeps the current build in place.
  if (!dryRun) for (const [pkg, bin] of steps) localBin(root, pkg, bin)

  rotate(p, { dryRun, log, root })

  if (child.note) log(`${dryRun ? 'Would set' : 'Setting'} for every step: ${child.note}`)
  {
    for (const [pkg, bin, args] of steps) {
      if (dryRun) {
        let shown
        try {
          shown = rel(localBin(root, pkg, bin))
        } catch (e) {
          shown = `node_modules/${pkg} (${e.message})`
        }
        log(`Would run: node ${shown} ${args.join(' ')}`)
        continue
      }
      exec(process.execPath, [localBin(root, pkg, bin), ...args], { cwd: root, stdio: 'inherit', windowsHide: true, env: child.env })
    }
  }

  const info = formatBuildInfo({ version: readVersion(root), commit: gitShortSha(root), builtAt: new Date() })
  if (dryRun) {
    log(`Would write ${rel(p.buildTxt)} (time taken when the pack finishes):\n${indent(info)}`)
    log('Then check it with npm run pack:verify')
    return
  }
  if (!fs.existsSync(p.marker)) throw new Error(`The pack finished but ${rel(p.marker)} is missing`)
  fs.writeFileSync(p.buildTxt, info)
  log(`Current build: ${rel(p.current)} (${rel(p.buildTxt)})`)
  log('Check it with npm run pack:verify')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main()
  } catch (e) {
    console.error(`pack-local: ${e.message}`)
    process.exit(1)
  }
}
