#!/usr/bin/env node
// Checks a local `npm run pack` of the desktop app (cli-standalone-default.md 5.2). The packaged app does not contain the
// orgai CLI, so this only proves the app is a plain desktop package: nothing from the CLI is in it, and nothing here
// starts the app or spends a token.
//
//   npm run pack:verify                                  check release/<unpacked> of this platform
//   node scripts/verify-pack.mjs --release <dir>         check another release folder
//
// Checks, each printed as one ok / fail line; exit 0 only when all pass:
//   (a) the app binary exists
//   (b) no `out/cli` inside app.asar and none in app.asar.unpacked
//   (c) no `bin/orgai` or `bin/orgai.cmd` launcher in the app's resources
//   (d) the desktop's own runtime packages (Claude Agent SDK, Codex, zod) are unpacked beside app.asar
// The orgai npm package has its own check, scripts/verify-npm.mjs.
import fs from 'node:fs'
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

/**
 * Runs every check; returns the exit code (0 only when all pass). `deps` are for tests: root, platform, arch, log,
 * listAsar (file -> entries).
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const { root = ROOT, platform = process.platform, arch = process.arch, log = console.log, list = listAsar } = deps
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
