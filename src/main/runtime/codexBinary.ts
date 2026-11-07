/**
 * Finding the Codex CLI and checking its version (Wave 7, docs/design/cli-standalone.md 6.2, decision D7). Codex is not
 * a dependency of the npm package, so it may come from the user's own install.
 *
 * Resolution (`lookupCodexBinary`, synchronous, file system only, nothing spawned):
 *   1. ORGAI_CODEX_PATH: an absolute path to an existing regular file; when set it decides (a bad value is refused,
 *      never passed over). On POSIX a '#!' script there that is not an npm shim of a findable package (a user's own
 *      wrapper) is used as is.
 *   2. The per-platform package (@openai/codex-<platform>-<arch>) beside a packaged app's archive or resolved through
 *      createRequire from our bundle (the app, the archive, a dev checkout); a hit inside app.asar is rewritten to
 *      app.asar.unpacked.
 *   3. `codex` on PATH, walking the absolute PATH directories with stat (never the cwd, no where.exe). Windows tries
 *      codex.exe, codex.cmd, codex.ps1 per directory (npm's extensionless sh script is skipped); POSIX `codex`.
 * A hit is classified by content, not name: a native executable (Mach-O, ELF, PE) is used as is, with an adjacent
 * `codex-path` folder when present; an npm shim (.cmd, .ps1, a '#!' script, or a link to bin/codex.js) is mapped to its
 * package folder and then to `@openai/codex-<platform>-<arch>/vendor/<triple>/bin/codex[.exe]` and its `codex-path`
 * (nested or hoisted). A shim is never spawned: `spawn` of a .cmd without a shell fails and a shell would mangle the
 * `-c` TOML arguments. A native PATH hit that is a known launcher (Scoop's shim.exe, Volta's volta-shim) is followed to
 * the real binary (`launcherTarget`); other native launchers are not recognised and are used as is.
 *
 * Version (`checkCodexBinary`): `codex --version` (async, cached by realpath + mtime + size), run by
 * CodexAppServer.start and by the OpenAI connection probe, never by the synchronous resolver. Outside 0.166.x a binary
 * from steps 2-3 is refused ("Codex <v> is not supported; install @openai/codex@0.166.0"); one chosen through
 * ORGAI_CODEX_PATH only gets a warning.
 *
 * Electron-free; relative imports only.
 */
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, dirname as hostDirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trackChildProcess } from '../host/shutdown'
import { scrubControlEnv } from './childEnv'
import { asarResourcesOf, fileKindOf, filesOnPath, nodeLookupFs, nodeModuleResolver, pathFor, unpackedAsarPath, type LookupFs, type ModuleResolver } from './executableLookup'

/** Where a Codex binary came from. */
export type CodexBinarySource = 'env' | 'package' | 'path'

export interface CodexBinary {
  /** The native codex executable. */
  path: string
  /** Extra PATH directory the CLI expects (bundled rg), when present. */
  pathDir?: string
  /**
   * Where it came from. Every resolver result sets it and gets the version check; a binary built by hand (tests, a
   * caller's `binary` option) has none and is not checked.
   */
  source?: CodexBinarySource
  /** The PATH hit (an npm shim or a link) this binary was mapped from, when it differs from `path`. */
  via?: string
}

/** The variable that names a Codex executable explicitly. Not a secret: it stays in child environments. */
export const CODEX_PATH_ENV = 'ORGAI_CODEX_PATH'
/** The version package.json pins and OrgAI is tested with. */
export const CODEX_PINNED_VERSION = '0.166.0'
/** The tested range, as shown to users. */
export const CODEX_SUPPORTED_RANGE = '0.166.x'

export const CODEX_NOT_INSTALLED_MESSAGE = `Codex is not installed; install @openai/codex@${CODEX_PINNED_VERSION} (npm i -g @openai/codex@${CODEX_PINNED_VERSION}), or set ${CODEX_PATH_ENV}.`

export function codexUnsupportedMessage(found: string): string {
  return `Codex ${found} is not supported; install @openai/codex@${CODEX_PINNED_VERSION}`
}

/** True for 0.166.x (any patch, a pre-release or build suffix included). */
export function codexVersionSupported(version: string): boolean {
  return /^0\.166\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
}

/** The version out of `codex --version` ("codex-cli 0.166.0"), else undefined. */
export function parseCodexVersion(stdout: string): string | undefined {
  return /(?:^|\s|v)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=\s|$)/.exec(stdout.trim())?.[1]
}

const PLATFORM_TRIPLES: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc'
}

/** @openai/codex-<platform>-<arch> and its vendor triple, as @openai/codex/bin/codex.js maps them; undefined when unsupported. */
export function codexPlatformPackage(platform: string, arch: string): { pkg: string; triple: string } | undefined {
  const triple = PLATFORM_TRIPLES[`${platform}-${arch}`]
  return triple ? { pkg: `@openai/codex-${platform}-${arch}`, triple } : undefined
}

export interface CodexLookupOptions {
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  /** Where the bundle lives, for createRequire; default this module's folder. */
  bundleDir?: string
  fs?: LookupFs
  resolveModule?: ModuleResolver
}

export interface CodexLookup {
  binary?: CodexBinary
  /** Why there is none (set exactly when `binary` is undefined): the not-installed sentence or what was wrong. */
  problem?: string
}

function defaultBundleDir(): string {
  try {
    return hostDirname(fileURLToPath(import.meta.url))
  } catch {
    return process.cwd()
  }
}

/** How much of a shim is read to find the package it starts. npm's shims are well under 1 KB. */
const SHIM_READ_BYTES = 16 * 1024
/** The script npm's shims start, with '/' separators (a shim's text is searched with '\\' folded to '/'). */
const SHIM_TARGET_TAIL = '/@openai/codex/bin/codex.js'
/** How far before the target a shim's path prefix is looked for. */
const SHIM_PREFIX_MAX = 1024
/** Characters a shim path never contains (quotes, whitespace, shell and cmd metacharacters). */
const SHIM_PATH_STOP = /["'\s*?<>|`]/
/** The prefix a shim path starts with: %~dp0% / %dp0%, $basedir / ${basedir}, a drive or '/'. Sticky. */
const SHIM_PREFIX = /%~?dp0%?|\$\{?basedir\}?|[A-Za-z]:[\\/]|\//y

/**
 * Every reference to @openai/codex/bin/codex.js in a shim's text, with the prefix the shim uses (the leftmost prefix
 * in the path run before the target). A literal search first, then a bounded walk back, so a large script with many
 * '/' and no target costs one linear scan (review round 2: the old lazy regex was quadratic on such a file).
 */
export function shimTargets(text: string): string[] {
  const folded = text.replace(/\\/g, '/')
  const out: string[] = []
  let from = 0
  for (;;) {
    const at = folded.indexOf(SHIM_TARGET_TAIL, from)
    if (at < 0) break
    const end = at + SHIM_TARGET_TAIL.length
    const floor = from
    from = end
    let start = at
    while (start > floor && at - start < SHIM_PREFIX_MAX && !SHIM_PATH_STOP.test(text[start - 1])) start--
    // The prefix ends at or before the separator in front of @openai.
    for (let p = start; p < at; p++) {
      SHIM_PREFIX.lastIndex = p
      if (SHIM_PREFIX.test(text) && SHIM_PREFIX.lastIndex <= at) {
        out.push(text.slice(p, end))
        break
      }
    }
  }
  return out
}

class Resolver {
  readonly p: ReturnType<typeof pathFor>
  readonly exe: string
  readonly target: { pkg: string; triple: string } | undefined

  constructor(
    readonly platform: NodeJS.Platform,
    readonly arch: string,
    readonly fs: LookupFs
  ) {
    this.p = pathFor(platform)
    this.exe = platform === 'win32' ? 'codex.exe' : 'codex'
    this.target = codexPlatformPackage(platform, arch)
  }

  isNative(path: string): boolean {
    return !!this.fs.stat(path)?.isFile && fileKindOf(this.fs.readHead(path, 8)) === 'native'
  }

  isDir(path: string): boolean {
    return !!this.fs.stat(path)?.isDirectory
  }

  /** The native binary of a platform package root, with its codex-path folder. */
  fromPlatformRoot(root: string, source: CodexBinarySource, via?: string): CodexBinary | undefined {
    if (!this.target) return undefined
    const vendor = this.p.join(root, 'vendor', this.target.triple)
    const bin = this.p.join(vendor, 'bin', this.exe)
    if (!this.isNative(bin)) return undefined
    const pathDir = this.p.join(vendor, 'codex-path')
    return { path: bin, source, ...(this.isDir(pathDir) ? { pathDir } : {}), ...(via && via !== bin ? { via } : {}) }
  }

  /** @openai/codex's package folder -> the native binary of its platform package, nested, hoisted or legacy vendor/. */
  fromCodexPackage(pkgDir: string, source: CodexBinarySource, via: string): CodexBinary | undefined {
    if (!this.target) return undefined
    const short = this.target.pkg.split('/')[1]
    for (const root of [this.p.join(pkgDir, 'node_modules', '@openai', short), this.p.join(this.p.dirname(pkgDir), short), pkgDir]) {
      const hit = this.fromPlatformRoot(root, source, via)
      if (hit) return hit
    }
    return undefined
  }

  /** The @openai/codex package folders a shim at `hit` (real path `real`) may start. */
  shimPackageDirs(hit: string, real: string): string[] {
    const dir = this.p.dirname(hit)
    const out: string[] = []
    const head = this.fs.readHead(real, SHIM_READ_BYTES)
    const text = head ? new TextDecoder('utf-8', { fatal: false }).decode(head) : ''
    for (let ref of shimTargets(text)) {
      ref = ref.replace(/^%~?dp0%?/, `${dir}${this.p.sep}`).replace(/^\$\{?basedir\}?/, dir)
      if (!this.p.isAbsolute(ref)) continue
      const js = this.p.normalize(ref)
      out.push(this.p.dirname(this.p.dirname(js)))
    }
    // npm's default layouts: Windows prefix (<dir>\node_modules) and POSIX prefix (<prefix>/bin -> <prefix>/lib/node_modules).
    out.push(this.p.join(dir, 'node_modules', '@openai', 'codex'), this.p.join(this.p.dirname(dir), 'lib', 'node_modules', '@openai', 'codex'))
    return [...new Set(out)]
  }

  /**
   * A native PATH hit that is a launcher, not Codex: Scoop's shim.exe (a `codex.shim` beside it names the program) and
   * Volta's volta-shim (`<volta>/bin/codex`, the package in `<volta>/tools/image/packages/@openai/codex`). Each starts
   * node codex.js, which spawns the real codex as a child; on Windows killing the launcher leaves that child running,
   * so the real binary is used instead. Undefined when the hit is not a known launcher (it is then used as is).
   * Layouts from the tools' docs, never seen on a real install (unverified).
   */
  launcherTarget(hit: string): CodexBinary | undefined {
    if (this.platform === 'win32' && /\.exe$/i.test(hit)) {
      const shimFile = hit.replace(/\.exe$/i, '.shim')
      if (this.fs.stat(shimFile)?.isFile) {
        const head = this.fs.readHead(shimFile, 4096)
        const text = head ? new TextDecoder('utf-8', { fatal: false }).decode(head) : ''
        const target = /^\s*path\s*=\s*"?([^"\r\n]+?)"?\s*$/m.exec(text)?.[1]
        if (target && target !== hit && this.p.isAbsolute(target) && this.fs.stat(target)?.isFile) {
          const c = this.classify(target, 'path', false)
          if (c.binary) return { ...c.binary, via: hit }
        }
      }
    }
    const dir = this.p.dirname(hit)
    if (this.p.basename(dir) === 'bin') {
      const image = this.p.join(this.p.dirname(dir), 'tools', 'image', 'packages', '@openai', 'codex')
      if (this.isDir(image)) {
        for (const pkgDir of [this.p.join(image, 'lib', 'node_modules', '@openai', 'codex'), this.p.join(image, 'node_modules', '@openai', 'codex')]) {
          const b = this.fromCodexPackage(pkgDir, 'path', hit)
          if (b) return b
        }
      }
    }
    return undefined
  }

  /** Classify one candidate (ORGAI_CODEX_PATH or a PATH hit) by content. PATH hits follow known launchers once. */
  classify(hit: string, source: CodexBinarySource, followLaunchers = source === 'path'): { binary?: CodexBinary; problem?: string } {
    const real = this.fs.realpath(hit) ?? hit
    const kind = fileKindOf(this.fs.readHead(real, 8))
    if (kind === 'native') {
      const launched = followLaunchers ? this.launcherTarget(hit) : undefined
      if (launched) return { binary: launched }
      const dir = this.p.dirname(real)
      const dirs = [this.p.join(dir, 'codex-path'), ...(this.p.basename(dir) === 'bin' ? [this.p.join(this.p.dirname(dir), 'codex-path')] : [])]
      const pathDir = dirs.find((d) => this.isDir(d))
      return { binary: { path: real, source, ...(pathDir ? { pathDir } : {}), ...(real !== hit ? { via: hit } : {}) } }
    }
    // A link to @openai/codex/bin/codex.js (npm on POSIX).
    const linkedJs = this.p.basename(real) === 'codex.js' && this.p.basename(this.p.dirname(real)) === 'bin'
    const shim = linkedJs || kind === 'script' || /\.(cmd|ps1)$/i.test(hit)
    if (!shim) return { problem: `${hit} is neither a native Codex executable nor an npm shim` }
    if (!this.target) return { problem: `${hit} is an npm shim, and Codex has no native package for ${this.platform}-${this.arch}` }
    const dirs = linkedJs ? [this.p.dirname(this.p.dirname(real))] : this.shimPackageDirs(hit, real)
    for (const pkgDir of dirs) {
      const b = this.fromCodexPackage(pkgDir, source, hit)
      if (b) return { binary: b }
    }
    return { problem: `${hit} is an npm shim whose native package (${this.target.pkg}) was not found; reinstall @openai/codex@${CODEX_PINNED_VERSION}` }
  }
}

/** Where Codex is (6.2). Never throws and never spawns. */
export function lookupCodexBinary(opts: CodexLookupOptions = {}): CodexLookup {
  const platform = opts.platform ?? process.platform
  const arch = opts.arch ?? process.arch
  const env = opts.env ?? process.env
  const r = new Resolver(platform, arch, opts.fs ?? nodeLookupFs)

  const chosen = env[CODEX_PATH_ENV]?.trim()
  if (chosen) {
    if (!r.p.isAbsolute(chosen)) return { problem: `${CODEX_PATH_ENV} must be an absolute path (it is ${chosen}).` }
    const st = r.fs.stat(chosen)
    if (!st) return { problem: `${CODEX_PATH_ENV} names ${chosen}, which does not exist; Codex is not installed there.` }
    if (!st.isFile) return { problem: `${CODEX_PATH_ENV} names ${chosen}, which is not a regular file.` }
    const c = r.classify(chosen, 'env')
    if (c.binary) return { binary: c.binary }
    // The user's own wrapper (`#!/bin/sh` ... `exec /real/codex "$@"`) on POSIX: it cannot be mapped to a native
    // package, and POSIX spawns a '#!' file without a shell, so it is used as is (the version check still runs and only
    // warns for this source). A .cmd / .ps1 on Windows cannot be spawned without a shell and stays refused (review round 2).
    if (platform !== 'win32' && fileKindOf(r.fs.readHead(chosen, 8)) === 'script') return { binary: { path: chosen, source: 'env' } }
    return { problem: `${CODEX_PATH_ENV}: ${c.problem}.` }
  }

  if (r.target) {
    const bundleDir = opts.bundleDir ?? defaultBundleDir()
    const res = asarResourcesOf(bundleDir, platform)
    if (res !== undefined) {
      const hit = r.fromPlatformRoot(r.p.join(res, 'app.asar.unpacked', 'node_modules', ...r.target.pkg.split('/')), 'package')
      if (hit) return { binary: hit }
    }
    const pkgJson = (opts.resolveModule ?? nodeModuleResolver)(`${r.target.pkg}/package.json`, bundleDir)
    if (pkgJson) {
      const hit = r.fromPlatformRoot(unpackedAsarPath(r.p.dirname(pkgJson)).path, 'package')
      if (hit) return { binary: hit }
    }
  }

  const names = platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.ps1'] : ['codex']
  const problems: string[] = []
  for (const hit of filesOnPath(names, env, platform, r.fs)) {
    const c = r.classify(hit, 'path')
    if (c.binary) return { binary: c.binary }
    if (c.problem) problems.push(c.problem)
  }
  return { problem: problems.length ? `${CODEX_NOT_INSTALLED_MESSAGE} (${problems.join('; ')})` : CODEX_NOT_INSTALLED_MESSAGE }
}

// ---------- Version ----------

/** Runs `<binary> --version` and answers its stdout (rejects on a failed or timed-out run). */
export type CodexVersionRunner = (binary: CodexBinary) => Promise<string>

export const CODEX_VERSION_TIMEOUT_MS = 10_000

export const defaultCodexVersionRunner: CodexVersionRunner = (binary) =>
  new Promise((resolve, reject) => {
    const env: Record<string, string | undefined> = scrubControlEnv({ ...process.env })
    if (binary.pathDir) env.PATH = `${binary.pathDir}${delimiter}${env.PATH ?? env.Path ?? ''}`
    // Absolute path, no shell, a neutral cwd: nothing is looked up in a project folder.
    const child = execFile(binary.path, ['--version'], { timeout: CODEX_VERSION_TIMEOUT_MS, windowsHide: true, cwd: tmpdir(), env }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout ?? ''))
    )
    // A failed spawn (ENOENT, EACCES) emits 'error' and 'close' but no 'exit': untrack there too (review round 2).
    const untrack = trackChildProcess(child, 'codex --version')
    child.once('error', untrack)
    child.once('close', untrack)
  })

const versionCache = new Map<string, string>()
const VERSION_CACHE_MAX = 32

/** Forget cached versions (tests). */
export function clearCodexVersionCache(): void {
  versionCache.clear()
}

/**
 * The version of `binary`, cached by realpath + mtime + size (a reinstall in place changes the key). A failed or
 * unparsable answer is not cached and rejects.
 */
export async function codexVersion(binary: CodexBinary, opts: { fs?: LookupFs; run?: CodexVersionRunner } = {}): Promise<string> {
  const fs = opts.fs ?? nodeLookupFs
  const real = fs.realpath(binary.path) ?? binary.path
  const st = fs.stat(real)
  const key = `${real}\0${st?.mtimeMs ?? 0}\0${st?.size ?? 0}`
  const cached = versionCache.get(key)
  if (cached) return cached
  const out = await (opts.run ?? defaultCodexVersionRunner)(binary)
  const v = parseCodexVersion(out)
  if (!v) throw new Error(`it printed no version (${out.trim().slice(0, 80) || 'nothing'})`)
  if (versionCache.size >= VERSION_CACHE_MAX) versionCache.clear()
  versionCache.set(key, v)
  return v
}

export type CodexRuntimeCheck =
  | { ok: true; binary: CodexBinary; version?: string; warning?: string }
  | { ok: false; reason: string; binary?: CodexBinary; version?: string }

/**
 * The version policy for a resolved binary: 0.166.x passes; anything else (or a version that could not be read) is
 * refused for the package and PATH sources and only warned about for ORGAI_CODEX_PATH. A binary without `source`
 * passes unchecked.
 */
export async function checkCodexBinary(binary: CodexBinary, opts: { fs?: LookupFs; run?: CodexVersionRunner } = {}): Promise<CodexRuntimeCheck> {
  if (!binary.source) return { ok: true, binary }
  const chosen = binary.source === 'env'
  let version: string
  try {
    version = await codexVersion(binary, opts)
  } catch (e) {
    const why = (e as Error)?.message ?? String(e)
    if (chosen) return { ok: true, binary, warning: `The version of Codex at ${binary.path} (${CODEX_PATH_ENV}) could not be read (${why}); OrgAI is tested with ${CODEX_SUPPORTED_RANGE}.` }
    return { ok: false, binary, reason: `The version of Codex at ${binary.path} could not be read (${why}); install @openai/codex@${CODEX_PINNED_VERSION}` }
  }
  if (codexVersionSupported(version)) return { ok: true, binary, version }
  if (chosen) return { ok: true, binary, version, warning: `Codex ${version} at ${binary.path} (${CODEX_PATH_ENV}) is not a tested version; OrgAI is tested with ${CODEX_SUPPORTED_RANGE}.` }
  return { ok: false, binary, version, reason: codexUnsupportedMessage(version) }
}

/** Lookup plus version policy: what the OpenAI connection probe and doctor report. */
export async function checkCodexRuntime(opts: CodexLookupOptions & { run?: CodexVersionRunner } = {}): Promise<CodexRuntimeCheck> {
  const found = lookupCodexBinary(opts)
  if (!found.binary) return { ok: false, reason: found.problem ?? CODEX_NOT_INSTALLED_MESSAGE }
  return checkCodexBinary(found.binary, { fs: opts.fs, run: opts.run })
}

/** Human label of a source (doctor, logs). */
export const CODEX_SOURCE_LABEL: Record<CodexBinarySource, string> = {
  env: CODEX_PATH_ENV,
  package: 'the bundled package',
  path: 'PATH'
}
