/**
 * The orgai command shim (cli-spec 7(3), Wave 6): a user-level file on PATH that runs the packaged launcher.
 * packagedLayout.ts holds the pure layout, render and parse helpers; this module does the file-system work.
 * No electron import: index.ts passes the facts in CliShimDeps.
 *
 * Rules: only a packaged app started without ORGAI_DATA_DIR, from a place that stays (not translocated, a disk image,
 * an AppImage or the portable build), with a launcher on disk, may write the shim. A file at the shim path that does
 * not carry the OrgAI marker (or is a symlink, or not a regular file) is never touched. Writes go to a temp file in the
 * same folder and are renamed over the target after a last lstat check. Nothing here edits a shell profile, the
 * registry or PATH.
 */
import * as nodeFs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { posix, win32, type PlatformPath } from 'node:path'
import type { CliShimResult, CliShimStatus } from '@shared/types'
import { platformUserDataDir } from '../../cli/client/locate'
import { log as appLog } from '../log'
import { findOrgaiOnPath, samePathKey, type FindOrgaiOptions, type OrgaiOnPathEntry } from './orgaiOnPath'
import { CLI_SHIM_VERSION, cliShimPath, isOrgaiShim, packagedLayout, parseCliShim, renderCliShim, shimMarkerVersion, transientInstallReason } from './packagedLayout'

/** The file-system calls the service makes (sync node:fs shapes); injectable so tests can simulate failures. */
export interface CliShimFs {
  lstatSync: (path: string) => nodeFs.Stats
  statSync: (path: string) => nodeFs.Stats
  readFileSync: (path: string, encoding: 'utf8') => string
  writeFileSync: (path: string, data: string, options: { mode: number; flag: string }) => void
  chmodSync: (path: string, mode: number) => void
  renameSync: (from: string, to: string) => void
  unlinkSync: (path: string) => void
  mkdirSync: (path: string, options: { recursive: true; mode: number }) => unknown
  realpathSync: (path: string) => string
}

export interface CliShimDeps {
  platform: NodeJS.Platform
  /** app.isPackaged */
  isPackaged: boolean
  /** ORGAI_DATA_DIR was set at launch (a test or second profile: never install a shim for it). */
  dataDirOverride: boolean
  /** process.resourcesPath */
  resourcesPath: string
  /** app.getPath('userData'), never <userData>/data. */
  userDataDir: string
  home: string
  env: NodeJS.ProcessEnv
  /**
   * The login shell PATH when known (the user's terminal PATH, not the one OrgAI merged for itself). '' = the login
   * shell was asked and printed nothing: onPath is then unknown. Undefined = fall back to env.PATH / env.Path.
   */
  loginPath?: string
  /**
   * Called after a successful install; its errors are logged, never fatal.
   */
  onInstalled?: () => void | Promise<void>
  /** Defaults to node:fs. */
  fs?: Partial<CliShimFs>
  /** Defaults to the app log. */
  log?: { info: (m: string) => void; warn: (m: string) => void }
  /** Temp-name suffix; defaults to random hex. */
  randomSuffix?: () => string
  /** Every orgai on a PATH (orgaiOnPath.ts); injectable for tests. */
  findOnPath?: (opts: FindOrgaiOptions) => OrgaiOnPathEntry[]
}

export interface CliShimService {
  status(): CliShimStatus
  install(): Promise<CliShimResult>
  uninstall(): Promise<CliShimResult>
  /**
   * At launch: rewrite an OrgAI shim (format version not newer than this app's) that runs this install's launcher in
   * an older form, or a launcher that no longer exists. A shim for another install still on disk is left alone.
   */
  refreshOnLaunch(): Promise<'refreshed' | 'unchanged' | 'skipped'>
}

export const CLI_SHIM_UNAVAILABLE: CliShimStatus = {
  state: 'unavailable',
  path: '',
  binDir: '',
  reason: 'The orgai command can be added only from the installed OrgAI app, not from a development build. The npm package installs its own orgai.'
}

/** A shim is a few hundred bytes: anything bigger at the path is not ours and is never read whole. */
const SHIM_MAX_BYTES = 64 * 1024

const defaultFs: CliShimFs = {
  lstatSync: (p) => nodeFs.lstatSync(p),
  statSync: (p) => nodeFs.statSync(p),
  readFileSync: (p, e) => nodeFs.readFileSync(p, e),
  writeFileSync: (p, d, o) => nodeFs.writeFileSync(p, d, o),
  chmodSync: (p, m) => nodeFs.chmodSync(p, m),
  renameSync: (a, b) => nodeFs.renameSync(a, b),
  unlinkSync: (p) => nodeFs.unlinkSync(p),
  mkdirSync: (p, o) => nodeFs.mkdirSync(p, o),
  realpathSync: (p) => nodeFs.realpathSync.native(p)
}

function pathFor(platform: NodeJS.Platform | string): PlatformPath {
  return platform === 'win32' ? win32 : posix
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function isMissing(e: unknown): boolean {
  return (e as { code?: unknown } | undefined)?.code === 'ENOENT' || (e as { code?: unknown } | undefined)?.code === 'ENOTDIR'
}

/** A comparison key for a folder: ~ expanded, normalized, trailing separators dropped, case folded on win32 and darwin. */
export function pathEntryKey(entry: string, platform: NodeJS.Platform | string, home: string): string {
  const p = pathFor(platform)
  let value = entry.trim()
  if (platform === 'win32' && value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
  if (value === '~') value = home
  else if (value.startsWith('~/') || (platform === 'win32' && value.startsWith('~\\'))) value = p.join(home, value.slice(2))
  if (!value) return ''
  let n = p.normalize(value)
  const root = p.parse(n).root
  while (n.length > root.length && /[\\/]$/.test(n)) n = n.slice(0, -1)
  return platform === 'win32' || platform === 'darwin' ? n.toLowerCase() : n
}

/** True / false when `dir` is / is not one of `pathList`'s entries; undefined when the list is unknown. */
export function dirOnPath(dir: string, pathList: string | undefined, platform: NodeJS.Platform | string, home: string): boolean | undefined {
  if (pathList === undefined || pathList === '') return undefined
  const want = pathEntryKey(dir, platform, home)
  const sep = platform === 'win32' ? ';' : ':'
  return pathList.split(sep).some((e) => e && pathEntryKey(e, platform, home) === want)
}

/** Said by install() (and shown by the row) while this install ships no orgai launcher. */
export const NO_LAUNCHER_REASON = 'The OrgAI app no longer installs the orgai command. Install it with `npm i -g orgai-cli`.'

export function createCliShimService(deps: CliShimDeps): CliShimService {
  const fs: CliShimFs = { ...defaultFs, ...(deps.fs ?? {}) }
  const log = deps.log ?? appLog
  const suffix = deps.randomSuffix ?? (() => randomBytes(6).toString('hex'))
  const { platform } = deps
  const p = pathFor(platform)

  interface Ready {
    path: string
    binDir: string
    launcher: string
    userDataDir?: string
  }

  /** Why the old shim cannot even be looked at or removed from this launch, or undefined. */
  function cleanupUnavailableReason(): string | undefined {
    if (!deps.isPackaged) return CLI_SHIM_UNAVAILABLE.reason
    if (deps.dataDirOverride) return 'OrgAI was started with ORGAI_DATA_DIR; manage the orgai command from a normal launch.'
    return undefined
  }

  /** Why the shim cannot be written from this launch, or undefined. */
  function unavailableReason(): string | undefined {
    const common = cleanupUnavailableReason()
    if (common) return common
    const transient = transientInstallReason(platform, deps.resourcesPath, deps.env)
    if (transient) return transient
    const { launcher } = packagedLayout(platform, deps.resourcesPath)
    let regular = false
    try {
      regular = fs.statSync(launcher).isFile()
    } catch {
      regular = false
    }
    if (!regular) return NO_LAUNCHER_REASON
    return undefined
  }

  function launcherExists(launcher: string): boolean {
    try {
      return fs.statSync(launcher).isFile()
    } catch {
      return false
    }
  }

  /** The userDataDir line to embed: only when it differs from the default the CLI computes itself. */
  function embeddedUserDataDir(): string | undefined {
    const own = deps.userDataDir
    if (!own) return undefined
    const def = platformUserDataDir(platform, deps.env, deps.home)
    const keys = new Set([pathEntryKey(def, platform, deps.home)])
    if (platform === process.platform) {
      try {
        keys.add(pathEntryKey(fs.realpathSync(def), platform, deps.home))
      } catch {
        /* not created yet */
      }
    }
    return keys.has(pathEntryKey(own, platform, deps.home)) ? undefined : own
  }

  function ready(): Ready | { reason: string } {
    const reason = unavailableReason()
    if (reason) return { reason }
    const path = cliShimPath(platform, deps.env, deps.home)
    const userDataDir = embeddedUserDataDir()
    return { path, binDir: p.dirname(path), launcher: packagedLayout(platform, deps.resourcesPath).launcher, ...(userDataDir ? { userDataDir } : {}) }
  }

  /** Status and removal need no launcher: an old shim can be classified and removed even though the app ships none. */
  function cleanupReady(): Ready | { reason: string } {
    const reason = cleanupUnavailableReason()
    if (reason) return { reason }
    const path = cliShimPath(platform, deps.env, deps.home)
    const userDataDir = embeddedUserDataDir()
    return { path, binDir: p.dirname(path), launcher: packagedLayout(platform, deps.resourcesPath).launcher, ...(userDataDir ? { userDataDir } : {}) }
  }

  function render(r: Ready): string {
    return renderCliShim({ platform, launcher: r.launcher, env: deps.env, ...(r.userDataDir !== undefined ? { userDataDir: r.userDataDir } : {}) })
  }

  type Found = { kind: 'none' } | { kind: 'foreign' } | { kind: 'ours'; text: string }

  /** What sits at the shim path. Never follows a symlink. */
  function inspect(path: string): Found {
    let st: nodeFs.Stats
    try {
      st = fs.lstatSync(path)
    } catch (e) {
      if (isMissing(e)) return { kind: 'none' }
      return { kind: 'foreign' }
    }
    if (st.isSymbolicLink() || !st.isFile() || st.size > SHIM_MAX_BYTES) return { kind: 'foreign' }
    let text: string
    try {
      text = fs.readFileSync(path, 'utf8')
    } catch {
      return { kind: 'foreign' }
    }
    return isOrgaiShim(text) ? { kind: 'ours', text } : { kind: 'foreign' }
  }

  const foreignReason = (path: string): string =>
    `${path} already exists and was not written by OrgAI. Remove or rename it to install the orgai command.`

  /** The 8.2 sentence for an npm or archive orgai at the shim path (main-side; the renderer words it the same way). */
  const userCliReason = (other: NonNullable<CliShimStatus['otherCli']>, path: string): string => {
    const v = other.version && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(other.version) ? ` (${other.version})` : ''
    const from = other.channel === 'npm' ? 'from npm' : 'from the portable archive'
    return `The orgai command ${from}${v} is on your PATH at ${path}. OrgAI leaves it alone.`
  }

  function onPath(binDir: string): boolean | undefined {
    const list = deps.loginPath !== undefined ? deps.loginPath : (deps.env.PATH ?? deps.env.Path)
    return dirOnPath(binDir, list, platform, deps.home)
  }

  /**
   * Wave 7 (cli-standalone.md 8.2): another orgai on the login shell PATH, i.e. one that is neither an OrgAI shim at
   * this install's shim path, nor a link to or shim of this install's launcher, nor that launcher itself. An npm or
   * archive install anywhere on PATH wins over an earlier unknown file (it is the one that blocks Install); else the
   * first other one in PATH order. Undefined when there is none or PATH could not be read; never throws.
   */
  function otherCli(r: Ready): CliShimStatus['otherCli'] {
    const pathList = deps.loginPath !== undefined ? deps.loginPath : (deps.env.PATH ?? deps.env.Path)
    if (!pathList) return undefined
    let entries: OrgaiOnPathEntry[]
    try {
      entries = (deps.findOnPath ?? findOrgaiOnPath)({ platform, pathList, env: deps.env, home: deps.home })
    } catch (e) {
      log.warn(`orgai command: reading PATH failed: ${errorText(e)}`)
      return undefined
    }
    // Both spellings: a PATH hit is read lexically, a link's target through realpath (macOS /var vs /private/var).
    const keys = (p: string): Set<string> => {
      const out = new Set([samePathKey(platform, p)])
      try {
        out.add(samePathKey(platform, fs.realpathSync(p)))
      } catch {
        /* missing */
      }
      return out
    }
    const shim = keys(r.path)
    const launcher = keys(r.launcher)
    // This install's own launcher counts as ours whether its folder is on PATH itself or a link or shim reaches it.
    // The shim path counts only while an OrgAI shim sits there (installed or outdated): npm's link at the same path
    // (npm prefix ~/.local) is another orgai, never ours (review round 2).
    const ours = (e: OrgaiOnPathEntry): boolean => {
      const ks = [...keys(e.path)]
      if (ks.some((k) => launcher.has(k))) return true
      if (e.launcher !== undefined && launcher.has(samePathKey(platform, e.launcher))) return true
      return e.kind === 'app-shim' && ks.some((k) => shim.has(k))
    }
    const others = entries.filter((e) => !ours(e))
    const other = others.find((e) => e.channel === 'npm' || e.channel === 'archive') ?? others[0]
    if (!other) return undefined
    return { path: other.path, ...(other.channel !== undefined ? { channel: other.channel } : {}), ...(other.version !== undefined ? { version: other.version } : {}) }
  }

  function statusOf(r: Ready): CliShimStatus {
    const other = otherCli(r)
    const base = { path: r.path, binDir: r.binDir, ...(other ? { otherCli: other } : {}) }
    const path = onPath(r.binDir)
    const withPath = path === undefined ? {} : { onPath: path }
    const found = inspect(r.path)
    const noLauncher = !launcherExists(r.launcher)
    if (found.kind === 'none') return { state: 'not-installed', ...base, ...withPath, ...(noLauncher ? { installable: false as const } : {}) }
    if (found.kind === 'foreign') {
      // npm's (or the archive's) own orgai at the shim path: say so (8.2) instead of asking the user to remove it.
      const atShim = other !== undefined && (other.channel === 'npm' || other.channel === 'archive') && samePathKey(platform, other.path) === samePathKey(platform, r.path)
      return { state: 'foreign', ...base, ...withPath, reason: atShim ? userCliReason(other, r.path) : foreignReason(r.path) }
    }
    const parsed = parseCliShim(found.text, platform, deps.env)
    // No launcher ships with this install: a shim of ours runs something this app cannot offer, so it is old whatever it names.
    if (!noLauncher && parsed && parsed.launcher === r.launcher && parsed.userDataDir === r.userDataDir) {
      return { state: 'installed', ...base, target: parsed.launcher, ...withPath }
    }
    return { state: 'outdated', ...base, ...(parsed ? { target: parsed.launcher } : {}), ...withPath, ...(noLauncher ? { installable: false as const } : {}) }
  }

  function status(): CliShimStatus {
    const r = cleanupReady()
    if ('reason' in r) return { ...CLI_SHIM_UNAVAILABLE, reason: r.reason }
    return statusOf(r)
  }

  /**
   * Writes `text` to a temp file beside the target and renames it over the target. The target is lstat-checked right
   * before the rename: a symlink, a non-regular file or a file without the marker is never replaced.
   */
  function writeShim(r: Ready, text: string): void {
    fs.mkdirSync(r.binDir, { recursive: true, mode: 0o755 })
    const tmp = `${r.path}.tmp-${suffix()}`
    fs.writeFileSync(tmp, text, { mode: 0o755, flag: 'wx' })
    try {
      if (platform !== 'win32') fs.chmodSync(tmp, 0o755)
      if (inspect(r.path).kind === 'foreign') throw new Error(foreignReason(r.path))
      fs.renameSync(tmp, r.path)
    } catch (e) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* already gone */
      }
      throw e
    }
  }

  async function install(): Promise<CliShimResult> {
    const r = ready()
    if ('reason' in r) {
      const s = { ...CLI_SHIM_UNAVAILABLE, reason: r.reason }
      return { ok: false, message: r.reason, status: s }
    }
    const before = statusOf(r)
    if (before.state === 'foreign') return { ok: false, message: before.reason ?? foreignReason(r.path), status: before }
    try {
      writeShim(r, render(r))
    } catch (e) {
      log.warn(`orgai command: install at ${r.path} failed: ${errorText(e)}`)
      return { ok: false, message: `OrgAI could not install the orgai command: ${errorText(e)}`, status: statusOf(r) }
    }
    log.info(`orgai command: installed at ${r.path} (launcher ${r.launcher}).`)
    try {
      await deps.onInstalled?.()
    } catch (e) {
      log.warn(`orgai command: the after-install step failed: ${errorText(e)}`)
    }
    const after = statusOf(r)
    let message = `Installed the orgai command at ${r.path}.`
    if (after.onPath === false) {
      message +=
        platform === 'win32'
          ? ` ${r.binDir} is not on your PATH yet; add it to your user Path.`
          : ` ${r.binDir} is not on your PATH yet; add it in your shell profile.`
    }
    return { ok: true, message, status: after }
  }

  async function uninstall(): Promise<CliShimResult> {
    const r = cleanupReady()
    if ('reason' in r) {
      const s = { ...CLI_SHIM_UNAVAILABLE, reason: r.reason }
      return { ok: false, message: r.reason, status: s }
    }
    const before = statusOf(r)
    if (before.state === 'not-installed') return { ok: true, message: 'The orgai command is not installed.', status: before }
    if (before.state === 'foreign') return { ok: false, message: before.reason ?? foreignReason(r.path), status: before }
    try {
      // Re-check right before the unlink: only a regular file with the marker is removed.
      if (inspect(r.path).kind !== 'ours') return { ok: false, message: foreignReason(r.path), status: statusOf(r) }
      fs.unlinkSync(r.path)
    } catch (e) {
      log.warn(`orgai command: removing ${r.path} failed: ${errorText(e)}`)
      return { ok: false, message: `OrgAI could not remove the orgai command: ${errorText(e)}`, status: statusOf(r) }
    }
    log.info(`orgai command: removed ${r.path}.`)
    return { ok: true, message: `Removed the orgai command from ${r.path}.`, status: statusOf(r) }
  }

  async function refreshOnLaunch(): Promise<'refreshed' | 'unchanged' | 'skipped'> {
    try {
      const r = ready()
      if ('reason' in r) return 'skipped'
      const found = inspect(r.path)
      if (found.kind !== 'ours') return 'skipped'
      const text = render(r)
      if (found.text === text) return 'unchanged'
      // A shim from a newer OrgAI, one this app cannot read, or one that runs another install that is still on disk
      // (two copies side by side) is left alone: only the user's Install replaces it. A shim whose launcher is this
      // install's (an older format, another data folder line) or is gone (the app moved or was replaced) is rewritten.
      const version = shimMarkerVersion(found.text)
      if (version === undefined || version > CLI_SHIM_VERSION) return 'skipped'
      const parsed = parseCliShim(found.text, platform, deps.env)
      if (!parsed) return 'skipped'
      const sameLauncher = pathEntryKey(parsed.launcher, platform, deps.home) === pathEntryKey(r.launcher, platform, deps.home)
      if (!sameLauncher && launcherExists(parsed.launcher)) return 'skipped'
      writeShim(r, text)
      return 'refreshed'
    } catch (e) {
      log.warn(`orgai command: the launch refresh failed: ${errorText(e)}`)
      return 'skipped'
    }
  }

  return { status, install, uninstall, refreshOnLaunch }
}
