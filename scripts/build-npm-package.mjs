#!/usr/bin/env node
// Builds the npm package of the orgai command (Wave 7, docs/design/cli-standalone.md 3.1) from the CLI bundle that
// `npm run build` already wrote to out/cli. Never rebuilds the bundle (so the package ships exactly what was tested).
//
//   node scripts/build-npm-package.mjs              write release/npm/package/ and pack release/npm/orgai-<version>.tgz
//   node scripts/build-npm-package.mjs --dry-run    print what it would write, change nothing
//   node scripts/build-npm-package.mjs --shrinkwrap
//                                                   also write npm-shrinkwrap.json (the full dependency tree pinned)
//
// The default leaves npm-shrinkwrap.json out (top-level versions pinned only), as ci.yml and release.yml do (owner
// decision D10 is pending). --no-shrinkwrap still works and means the default.
// Why the shrinkwrap is off by default: npm 11.12.1 installs every platform's Claude runtime (8 x about 280 MB) from a
// dependency's shrinkwrap, because it applies no os / cpu check to shrinkwrapped optional packages, and installs none
// when the shrinkwrap leaves them out (observed by verify-npm.mjs on macOS, 2026-11-05). The spec (3.1) asks for the
// shrinkwrap, so --shrinkwrap keeps that path until the owner decides; verify-npm step 1 fails on the extra platforms.
//
// release/npm/package/:
//   out/cli/**            copied from out/cli (regular files only; an install.json there is replaced)
//   out/cli/install.json  { channel: 'npm', version, commit }
//   package.json          generated: name orgai, the repo's version, type module, bin, engines, files, license,
//                         repository, dependencies pinned exactly to package-lock.json; no lifecycle scripts
//   npm-shrinkwrap.json   package-lock.json restricted to the dependency closure (lib/npmPackage.mjs)
//   README.md, LICENSE    README generated; LICENSE copied when the repo has one
// release/npm/orgai-<version>.tgz (npm pack --ignore-scripts) and orgai-<version>.tgz.sha256.
//
// Writes only under release/npm/. Spawns only git (the commit) and npm (pack). Token-free, no network.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  AGENT_SDK,
  NPM_PACKAGE_NAME,
  cliDependencyNames,
  installInfoFor,
  npmPackageJson,
  pinnedVersions,
  readmeText,
  shrinkwrapFor,
  tarballName
} from './lib/npmPackage.mjs'
import { commitOf, readVersion } from './write-install-info.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** Bundle files the package must ship (the same set verify-pack.mjs checks in the app). */
export const BUNDLE_FILES = ['orgai.mjs', 'tui.mjs', 'inprocHost.mjs']
export const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt']
/** The repository the package names when GITHUB_REPOSITORY is not set (provenance checks it matches the publisher). */
export const DEFAULT_REPOSITORY = 'perrychapman/OrgAI'

/** Every path the script writes. Pure. */
export function plan(root, name, version) {
  const npmDir = path.join(root, 'release', 'npm')
  const tgz = path.join(npmDir, tarballName(name, version))
  return { npmDir, packageDir: path.join(npmDir, 'package'), cliSource: path.join(root, 'out', 'cli'), tgz, sha256: `${tgz}.sha256` }
}

/** package.json `repository` from GITHUB_REPOSITORY (owner/name) or the default. Pure. */
export function repositoryFor(env) {
  const slug = typeof env.GITHUB_REPOSITORY === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY) ? env.GITHUB_REPOSITORY : DEFAULT_REPOSITORY
  return { type: 'git', url: `git+https://github.com/${slug}.git` }
}

/** Throws unless `p` is strictly inside `parent` (lexically). */
export function assertInside(parent, p) {
  const rel = path.relative(path.resolve(parent), path.resolve(p))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Refusing to touch ${p}: it is not inside ${parent}`)
}

/**
 * How to run npm without a shell: npm_execpath when it is npm's JS entry (under `npm run`), else npm-cli.js beside
 * this node, else `npm` on PATH (POSIX) / `cmd.exe /d /s /c npm.cmd` (Windows, fixed arguments only). Pure apart from
 * `exists`.
 */
export function npmInvocation(env, execPath, platform, exists = fs.existsSync) {
  const execpath = env.npm_execpath
  if (typeof execpath === 'string' && /npm-cli\.js$/.test(execpath) && exists(execpath)) return { command: execPath, prefix: [execpath] }
  const dir = path.dirname(execPath)
  const candidates =
    platform === 'win32'
      ? [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
      : [path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  for (const c of candidates) if (exists(c)) return { command: execPath, prefix: [c] }
  if (platform === 'win32') return { command: env.ComSpec || 'cmd.exe', prefix: ['/d', '/s', '/c', 'npm.cmd'] }
  return { command: 'npm', prefix: [] }
}

/** Copies regular files and folders of `from` into `to`; refuses links (nothing outside the bundle is followed). */
export function copyBundle(from, to, skip = new Set()) {
  fs.mkdirSync(to, { recursive: true })
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.has(ent.name)) continue
    const src = path.join(from, ent.name)
    const dst = path.join(to, ent.name)
    if (ent.isSymbolicLink()) throw new Error(`${src} is a link; the CLI bundle must hold regular files only`)
    if (ent.isDirectory()) copyBundle(src, dst)
    else if (ent.isFile()) {
      fs.copyFileSync(src, dst)
      fs.chmodSync(dst, fs.statSync(src).mode & 0o777)
    }
  }
}

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** Everything the package holds except the bundle, computed from the repo. */
export function packageContents(root, env = process.env, { shrinkwrap: withShrinkwrap = false } = {}) {
  const version = readVersion(root)
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  const sdk = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', ...AGENT_SDK.split('/'), 'package.json'), 'utf8'))
  const dependencies = pinnedVersions(lock, cliDependencyNames(sdk))
  const license = LICENSE_FILES.map((f) => path.join(root, f)).find((f) => fs.existsSync(f))
  const pkg = npmPackageJson({ version, dependencies, repository: repositoryFor(env), shrinkwrap: withShrinkwrap, license: license ? 'SEE LICENSE IN LICENSE' : 'UNLICENSED' })
  // Computed either way, so a lockfile that cannot resolve the closure fails the build even without the file.
  const shrinkwrap = shrinkwrapFor(lock, pkg)
  const commit = commitOf(root, env)
  return { version, pkg, shrinkwrap, writeShrinkwrap: withShrinkwrap, installInfo: installInfoFor('npm', version, commit), readme: readmeText({ version, shrinkwrap: withShrinkwrap }), licenseFile: license }
}

/**
 * Throws unless out/cli holds the bundle files and one of its modules carries this version as a string literal (the
 * bundler inlines package.json's version into whichever chunk holds src/cli/version.ts), so a stale bundle never ships.
 */
export function checkBundle(cliSource, version) {
  const missing = BUNDLE_FILES.filter((f) => !fs.existsSync(path.join(cliSource, f)))
  if (missing.length) throw new Error(`${cliSource} is missing ${missing.join(', ')}; run npm run build first`)
  const literal = JSON.stringify(version)
  const carries = fs
    .readdirSync(cliSource)
    .filter((f) => f.endsWith('.mjs'))
    .some((f) => fs.readFileSync(path.join(cliSource, f), 'utf8').includes(literal))
  if (!carries) throw new Error(`The CLI bundle in ${cliSource} does not carry version ${version}; it was built from another checkout. Run npm run build first`)
}

/** `options`: env, exec (execFileSync's shape), platform, execPath; for tests. */
export function main(argv = process.argv.slice(2), root = ROOT, log = console.log, options = {}) {
  const { env = process.env, exec = execFileSync, platform = process.platform, execPath = process.execPath } = options
  const unknown = argv.filter((a) => a !== '--dry-run' && a !== '--shrinkwrap' && a !== '--no-shrinkwrap')
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(' ')}. Use --dry-run and / or --shrinkwrap.`)
  if (argv.includes('--shrinkwrap') && argv.includes('--no-shrinkwrap')) throw new Error('Use either --shrinkwrap or --no-shrinkwrap, not both.')
  const dryRun = argv.includes('--dry-run')
  const contents = packageContents(root, env, { shrinkwrap: argv.includes('--shrinkwrap') })
  const p = plan(root, NPM_PACKAGE_NAME, contents.version)
  const rel = (x) => path.relative(root, x) || '.'
  const deps = Object.entries(contents.pkg.dependencies).map(([n, v]) => `${n}@${v}`).join(', ')
  const entries = Object.keys(contents.shrinkwrap.packages).length - 1
  const optional = Object.values(contents.shrinkwrap.packages).filter((e) => e.optional).length
  if (dryRun) {
    log('Dry run: nothing is changed.')
    let bundle = `from ${rel(p.cliSource)}`
    try {
      checkBundle(p.cliSource, contents.version)
    } catch (e) {
      bundle = `(a real run would stop here: ${e.message})`
    }
    log(`Would copy the CLI bundle ${bundle} to ${rel(path.join(p.packageDir, 'out', 'cli'))}`)
    log(`Would write install.json: ${JSON.stringify(contents.installInfo)}`)
    log(`Would write package.json: ${contents.pkg.name}@${contents.pkg.version}, engines.node ${contents.pkg.engines.node}, dependencies ${deps}`)
    log(
      contents.writeShrinkwrap
        ? `Would write npm-shrinkwrap.json: ${entries} package(s), ${optional} optional (per-platform)`
        : `Would leave out npm-shrinkwrap.json (the default; --shrinkwrap writes it; the closure has ${entries} package(s))`
    )
    log(`Would write README.md${contents.licenseFile ? ` and copy ${path.basename(contents.licenseFile)}` : ' (no LICENSE in the repo: license UNLICENSED)'}`)
    log(`Would run: npm pack --ignore-scripts in ${rel(p.packageDir)} -> ${rel(p.tgz)} (+ .sha256)`)
    return { dryRun: true, ...contents, plan: p }
  }
  checkBundle(p.cliSource, contents.version)
  for (const t of [p.packageDir, p.tgz, p.sha256]) assertInside(p.npmDir, t)
  try {
    if (fs.lstatSync(p.npmDir).isSymbolicLink()) throw new Error(`${p.npmDir} is a link; remove it by hand`)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  fs.rmSync(p.packageDir, { recursive: true, force: true })
  fs.rmSync(p.tgz, { force: true })
  fs.rmSync(p.sha256, { force: true })
  const cliOut = path.join(p.packageDir, 'out', 'cli')
  copyBundle(p.cliSource, cliOut, new Set(['install.json']))
  fs.writeFileSync(path.join(cliOut, 'install.json'), JSON.stringify(contents.installInfo, null, 2) + '\n')
  fs.writeFileSync(path.join(p.packageDir, 'package.json'), JSON.stringify(contents.pkg, null, 2) + '\n')
  if (contents.writeShrinkwrap) fs.writeFileSync(path.join(p.packageDir, 'npm-shrinkwrap.json'), JSON.stringify(contents.shrinkwrap, null, 2) + '\n')
  fs.writeFileSync(path.join(p.packageDir, 'README.md'), contents.readme)
  if (contents.licenseFile) fs.copyFileSync(contents.licenseFile, path.join(p.packageDir, 'LICENSE'))
  log(`Wrote ${rel(p.packageDir)} (${deps}; ${contents.writeShrinkwrap ? `${entries} shrinkwrap entries` : 'no shrinkwrap'})`)

  const npm = npmInvocation(env, execPath, platform)
  // npm pack runs prepack / prepare / postpack of the package being packed; ours has none, --ignore-scripts anyway.
  const packEnv = { ...env, npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' }
  exec(npm.command, [...npm.prefix, 'pack', '--ignore-scripts', '--pack-destination', p.npmDir], { cwd: p.packageDir, stdio: 'inherit', windowsHide: true, env: packEnv })
  if (!fs.existsSync(p.tgz)) throw new Error(`npm pack finished but ${rel(p.tgz)} is missing`)
  const sum = sha256File(p.tgz)
  fs.writeFileSync(p.sha256, `${sum}  ${path.basename(p.tgz)}\n`)
  log(`Packed ${rel(p.tgz)} (sha256 ${sum})`)
  log('Check it with node scripts/verify-npm.mjs')
  return { dryRun: false, ...contents, plan: p, sha256: sum }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main()
  } catch (e) {
    console.error(`build-npm-package: ${e.message}`)
    process.exit(1)
  }
}
