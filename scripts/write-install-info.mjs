#!/usr/bin/env node
// Writes or removes out/cli/install.json (Wave 7, docs/design/cli-standalone.md 3.5): `{ channel, version, commit }`
// beside the CLI bundle, read by src/cli/installInfo.ts. The app's bundle carries channel 'app': pack-local.mjs and
// the release workflow write it after the CLI build and before electron-builder (electron-builder.yml unpacks
// out/cli/**). The npm package's copy is written by build-npm-package.mjs into its own folder, never into out/cli.
//
//   node scripts/write-install-info.mjs --channel app     write out/cli/install.json (version from package.json)
//   node scripts/write-install-info.mjs --remove          remove it again (a checkout reads as channel 'dev')
//
// Touches only out/cli/install.json. Spawns only git (the commit). Token-free.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installInfoFor } from './lib/npmPackage.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const INSTALL_INFO_FILE = 'install.json'

/** The commit to stamp: GITHUB_SHA (CI) else `git rev-parse HEAD`, shortened to 12; undefined when unknown. */
export function commitOf(root, env = process.env, exec = execFileSync) {
  const fromEnv = typeof env.GITHUB_SHA === 'string' && /^[0-9a-f]{7,40}$/i.test(env.GITHUB_SHA) ? env.GITHUB_SHA : undefined
  if (fromEnv) return fromEnv.slice(0, 12).toLowerCase()
  try {
    const sha = String(exec('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })).trim()
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 12).toLowerCase() : undefined
  } catch {
    return undefined
  }
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

export function main(argv = process.argv.slice(2), root = ROOT, log = console.log, env = process.env) {
  const cliDir = path.join(root, 'out', 'cli')
  if (argv.length === 1 && argv[0] === '--remove') {
    log(removeInstallInfo(cliDir) ? `Removed ${path.relative(root, path.join(cliDir, INSTALL_INFO_FILE))}` : 'No install.json to remove.')
    return
  }
  let channel
  if (argv.length === 2 && argv[0] === '--channel') channel = argv[1]
  else if (argv.length === 1 && argv[0].startsWith('--channel=')) channel = argv[0].slice('--channel='.length)
  else throw new Error('Use: write-install-info --channel app|npm|archive, or --remove')
  const info = installInfoFor(channel, readVersion(root), commitOf(root, env))
  const target = writeInstallInfo(cliDir, info)
  log(`Wrote ${path.relative(root, target)}: ${JSON.stringify(info)}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main()
  } catch (e) {
    console.error(`write-install-info: ${e.message}`)
    process.exit(1)
  }
}
