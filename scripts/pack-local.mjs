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
// Never touches anything outside release/. Spawns only node (the local electron-vite and electron-builder CLI
// entries, so no .cmd shim and no shell on Windows) and git, with execFileSync. Token-free.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Where electron-builder --dir puts the app for this platform, and the entry that proves a build is there. */
export function unpackedLayout(platform, arch) {
  if (platform === 'win32') return { dir: 'win-unpacked', marker: 'OrgAI.exe' }
  if (platform === 'darwin') return { dir: arch === 'arm64' ? 'mac-arm64' : 'mac', marker: 'OrgAI.app' }
  return { dir: 'linux-unpacked', marker: 'orgai' }
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

export function main(argv = process.argv.slice(2), root = ROOT, log = console.log) {
  const unknown = argv.filter((a) => a !== '--dry-run')
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(' ')}. Only --dry-run is supported.`)
  const dryRun = argv.includes('--dry-run')
  const p = plan(root)
  const rel = (x) => path.relative(root, x)
  if (dryRun) log('Dry run: nothing is changed.')

  const steps = [
    ['electron-vite', ['build']],
    ['electron-builder', ['--dir', '--publish', 'never']]
  ]
  // Check the tools are installed before moving anything, so a broken install keeps the current build in place.
  if (!dryRun) for (const [pkg] of steps) localBin(root, pkg, pkg)

  rotate(p, { dryRun, log, root })

  for (const [pkg, args] of steps) {
    if (dryRun) {
      let shown
      try {
        shown = rel(localBin(root, pkg, pkg))
      } catch (e) {
        shown = `node_modules/${pkg} (${e.message})`
      }
      log(`Would run: node ${shown} ${args.join(' ')}`)
      continue
    }
    execFileSync(process.execPath, [localBin(root, pkg, pkg), ...args], { cwd: root, stdio: 'inherit', windowsHide: true })
  }

  const info = formatBuildInfo({ version: readVersion(root), commit: gitShortSha(root), builtAt: new Date() })
  if (dryRun) {
    log(`Would write ${rel(p.buildTxt)} (time taken when the pack finishes):\n${indent(info)}`)
    return
  }
  if (!fs.existsSync(p.marker)) throw new Error(`The pack finished but ${rel(p.marker)} is missing`)
  fs.writeFileSync(p.buildTxt, info)
  log(`Current build: ${rel(p.current)} (${rel(p.buildTxt)})`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main()
  } catch (e) {
    console.error(`pack-local: ${e.message}`)
    process.exit(1)
  }
}
