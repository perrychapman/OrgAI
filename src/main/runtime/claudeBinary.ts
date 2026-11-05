/**
 * The one Claude runtime resolver (Wave 7, docs/design/cli-standalone.md 6.1), used by claude.ts (runs, probes,
 * completions) and anthropicAuth.ts (the connection probe) so the two never disagree. Evaluated per call, never at
 * import.
 *
 * Order: ORGAI_CLAUDE_PATH (an absolute path to an existing regular file; when set it decides, a bad value is refused
 * and never falls through), the app.asar.unpacked native package of a packaged app, the SDK's per-platform package
 * through createRequire from the bundle (a hit inside app.asar is rewritten to app.asar.unpacked and counts as the
 * app's), else none. When resolved, callers always pass `pathToClaudeCodeExecutable`. A `claude` found on PATH (or
 * in a well-known install folder) is named in the error, never used.
 *
 * Synchronous and file-system only (statSync through LookupFs); nothing is spawned. Electron-free; relative imports
 * only.
 */
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asarResourcesOf, filesOnPath, nodeLookupFs, nodeModuleResolver, pathFor, unpackedAsarPath, type LookupFs, type ModuleResolver } from './executableLookup'

/** Where a resolved Claude executable came from. */
export type ClaudeExecutableSource = 'env' | 'app' | 'sdk'

export type ClaudeExecutableResolution =
  | { ok: true; path: string; source: ClaudeExecutableSource }
  | {
      ok: false
      /** The sentence runs and the probe both show (claudeRuntimeMissingMessage, or why ORGAI_CLAUDE_PATH was refused). */
      reason: string
      /** A `claude` on PATH that is not used ("a claude on PATH at <path> is not used; set ORGAI_CLAUDE_PATH to use it"). */
      pathCandidate?: string
    }

export interface ClaudeExecutableOptions {
  platform?: NodeJS.Platform
  arch?: string
  /** Where the CLI bundle (or main bundle) lives, for createRequire; default this module's folder. */
  bundleDir?: string
  /** File system stand-in (tests). */
  fs?: LookupFs
  /** createRequire stand-in (tests). */
  resolveModule?: ModuleResolver
  /** Linux: try the musl package first (default: as the SDK decides, no glibc in the process report). */
  preferMusl?: boolean
  /** Home folder for the well-known install folders named in the error (default os.homedir()). */
  home?: string
}

/** The variable that names a Claude executable explicitly. Not a secret: it stays in child environments. */
export const CLAUDE_PATH_ENV = 'ORGAI_CLAUDE_PATH'

/** No runtime for this platform (the SDK's optional native package is missing). */
export function claudeRuntimeMissingMessage(platform: string, arch: string): string {
  return `The Claude runtime for ${platform}-${arch} is not installed; reinstall orgai without --omit=optional, or set ${CLAUDE_PATH_ENV}.`
}

/** The sentence naming a claude on PATH that OrgAI does not use. */
export function claudePathCandidateSentence(path: string): string {
  return `A claude on PATH at ${path} is not used; set ${CLAUDE_PATH_ENV} to use it.`
}

/** The whole message for a failed resolution: the reason, then the unused PATH candidate when there is one. */
export function claudeResolutionMessage(r: Extract<ClaudeExecutableResolution, { ok: false }>): string {
  return r.pathCandidate ? `${r.reason} ${claudePathCandidateSentence(r.pathCandidate)}` : r.reason
}

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'

/** The SDK's own rule (sdk.mjs 0.3.312): on Linux musl is preferred when the process report shows no glibc. */
function detectMusl(platform: NodeJS.Platform): boolean {
  if (platform !== 'linux' || process.platform !== 'linux') return false
  try {
    const report = typeof process.report?.getReport === 'function' ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }) : null
    return report != null && report.header?.glibcVersionRuntime === undefined
  } catch {
    return false
  }
}

/** The SDK's per-platform native package names, in the order the SDK tries them (sdk.mjs 0.3.312). */
export function claudeNativePackages(platform: string, arch: string, preferMusl = false): string[] {
  if (platform === 'android') return [`${SDK_PACKAGE}-linux-${arch}-android`]
  if (platform === 'linux') {
    return preferMusl ? [`${SDK_PACKAGE}-linux-${arch}-musl`, `${SDK_PACKAGE}-linux-${arch}`] : [`${SDK_PACKAGE}-linux-${arch}`, `${SDK_PACKAGE}-linux-${arch}-musl`]
  }
  return [`${SDK_PACKAGE}-${platform}-${arch}`]
}

/** Well-known install folders of the Claude Code CLI outside PATH (native installer, Homebrew). None on Windows. */
export function claudeWellKnownPaths(platform: NodeJS.Platform, home: string): string[] {
  if (platform === 'win32') return []
  const p = pathFor(platform)
  return [p.join(home, '.claude', 'local', 'claude'), p.join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
}

function defaultBundleDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return process.cwd()
  }
}

/** The first claude on PATH, else in a well-known folder; only ever named, never run. */
export function claudeOnPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, fs: LookupFs = nodeLookupFs, home: string = homedir()): string | undefined {
  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude.ps1'] : ['claude']
  const hit = filesOnPath(names, env, platform, fs)[0]
  if (hit) return hit
  return claudeWellKnownPaths(platform, home).find((p) => fs.stat(p)?.isFile)
}

/** The Claude executable runs and the connection probe use (6.1). Never throws. */
export function claudeExecutable(env: NodeJS.ProcessEnv = process.env, opts: ClaudeExecutableOptions = {}): ClaudeExecutableResolution {
  const platform = opts.platform ?? process.platform
  const arch = opts.arch ?? process.arch
  const fs = opts.fs ?? nodeLookupFs
  const resolveModule = opts.resolveModule ?? nodeModuleResolver
  const p = pathFor(platform)

  const chosen = env[CLAUDE_PATH_ENV]?.trim()
  if (chosen) {
    if (!p.isAbsolute(chosen)) return { ok: false, reason: `${CLAUDE_PATH_ENV} must be an absolute path (it is ${chosen}).` }
    const st = fs.stat(chosen)
    if (!st) return { ok: false, reason: `${CLAUDE_PATH_ENV} names ${chosen}, which does not exist.` }
    if (!st.isFile) return { ok: false, reason: `${CLAUDE_PATH_ENV} names ${chosen}, which is not a regular file.` }
    return { ok: true, path: chosen, source: 'env' }
  }

  const exe = platform === 'win32' ? 'claude.exe' : 'claude'
  const packages = claudeNativePackages(platform, arch, opts.preferMusl ?? detectMusl(platform))
  const bundleDir = opts.bundleDir ?? defaultBundleDir()

  // A packaged app: electron-builder unpacks the native package beside the archive.
  const res = asarResourcesOf(bundleDir, platform)
  if (res !== undefined) {
    for (const pkg of packages) {
      const bin = p.join(res, 'app.asar.unpacked', 'node_modules', ...pkg.split('/'), exe)
      if (fs.stat(bin)?.isFile) return { ok: true, path: bin, source: 'app' }
    }
  }

  // The SDK's per-platform package as the bundle sees it (a dev checkout, the npm package, the archive).
  for (const pkg of packages) {
    const pkgJson = resolveModule(`${pkg}/package.json`, bundleDir)
    if (!pkgJson) continue
    const { path: dir, rewritten } = unpackedAsarPath(p.dirname(pkgJson))
    const bin = p.join(dir, exe)
    if (fs.stat(bin)?.isFile) return { ok: true, path: bin, source: rewritten ? 'app' : 'sdk' }
  }

  const pathCandidate = claudeOnPath(env, platform, fs, opts.home ?? homedir())
  return { ok: false, reason: claudeRuntimeMissingMessage(platform, arch), ...(pathCandidate ? { pathCandidate } : {}) }
}

/** The executable for this call, or an Error carrying claudeResolutionMessage (runs fail with it). */
export function requireClaudeExecutable(env: NodeJS.ProcessEnv = process.env, opts: ClaudeExecutableOptions = {}): string {
  const r = claudeExecutable(env, opts)
  if (!r.ok) throw new Error(claudeResolutionMessage(r))
  return r.path
}

/** Human label of a source (doctor, logs). */
export const CLAUDE_SOURCE_LABEL: Record<ClaudeExecutableSource, string> = {
  env: CLAUDE_PATH_ENV,
  app: 'the packaged app',
  sdk: "the Agent SDK's native package"
}
