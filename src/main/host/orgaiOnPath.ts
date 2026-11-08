/**
 * Every `orgai` on a PATH, in the order a shell finds them (Wave 7, docs/design/cli-standalone.md 8.2), with the
 * install channel, version and commit each one runs, read from the install.json beside the bundle it reaches
 * (src/cli/installInfo.ts). Used by `orgai doctor` (src/cli/doctor/installChecks.ts) and by the app's Terminal row
 * (shimInstaller.ts `otherCli`).
 *
 * Read only and bounded: network folders (UNC, /net) are skipped untouched; one lstat / stat per PATH entry and candidate name, at most SHIM_TEXT_MAX_BYTES read from a
 * candidate, at most ORGAI_PATH_MAX_ENTRIES PATH entries. Nothing is executed. Electron-free; injectable fs for tests.
 *
 * How a hit is read:
 * - An OrgAI shim (packagedLayout.ts marker): its launcher, then `<Resources>/app.asar.unpacked/out/cli/install.json`.
 * - A link (npm's POSIX bin) or a file whose real path is `.../out/cli/orgai.mjs`: the install.json beside it.
 * - A packaged launcher (`<Resources>/bin/orgai[.cmd]`, its folder on PATH or a link to it), recognised by its text or
 *   the app's CLI bundle beside it: that app's bundle. Any other `<X>/bin/orgai` is not one.
 * - npm's Windows `orgai.cmd` (it names `node_modules\orgai-cli\out\cli\orgai.mjs` under its own folder): that bundle.
 * - Anything else: kind 'unknown' (no channel, no version).
 */
import * as nodeFs from 'node:fs'
import { posix, win32, type PlatformPath } from 'node:path'
import type { InstallChannel } from '../../shared/types'
import { readInstallInfo } from '../../cli/installInfo'
import { isOrgaiShim, packagedLayout, parseCliShim } from './packagedLayout'

/** Candidates larger than this are never read (a shim or npm's .cmd is well under 4 KB; a bundle is read only by path). */
export const SHIM_TEXT_MAX_BYTES = 64 * 1024
/** PATH entries looked at, at most. */
export const ORGAI_PATH_MAX_ENTRIES = 256
/**
 * A line of the packaged launcher (build/bin/orgai and orgai.cmd); the same text as doctor.ts PACKAGED_LAUNCHER_MARK
 * (a test keeps them equal).
 */
export const PACKAGED_LAUNCHER_MARK = 'The orgai command of a packaged OrgAI'

/**
 * True for a PATH folder that may reach the network when touched (scratch.ts `isNetworkPath`, with the platform passed
 * in): on win32 anything starting with two separators (UNC, `\\?\UNC\`, `\\.\`), on darwin `/net/` and `/Network/`.
 * Such a folder is never stat'ed: this runs on the app's main thread, and an offline file server would stall it.
 */
export function isNetworkPathFor(platform: NodeJS.Platform | string, path: string): boolean {
  if (platform === 'win32') return /^[\\/]{2}/.test(path)
  if (platform === 'darwin') return /^\/(?:net|network)(?:\/|$)/i.test(path)
  return false
}

export type OrgaiOnPathKind = 'npm' | 'app-shim' | 'app-launcher' | 'archive' | 'dev' | 'unknown'

export interface OrgaiOnPathEntry {
  /** The file the shell runs (`<dir>/orgai`, `<dir>\orgai.cmd`). */
  path: string
  kind: OrgaiOnPathKind
  /** The CLI bundle folder it reaches (`.../out/cli`), when known. */
  bundleDir?: string
  /** The packaged launcher an OrgAI shim runs. */
  launcher?: string
  channel?: InstallChannel
  version?: string
  commit?: string
}

export interface OrgaiPathFs {
  /** lstat: isFile / isSymbolicLink / size; throws as node:fs does. */
  lstat: (path: string) => { isFile(): boolean; isSymbolicLink(): boolean; size: number }
  /** stat (follows links). */
  stat: (path: string) => { isFile(): boolean; size: number; mode?: number }
  readText: (path: string) => string
  realpath: (path: string) => string
}

const defaultFs: OrgaiPathFs = {
  lstat: (p) => nodeFs.lstatSync(p),
  stat: (p) => nodeFs.statSync(p),
  readText: (p) => nodeFs.readFileSync(p, 'utf8'),
  realpath: (p) => nodeFs.realpathSync.native(p)
}

export interface FindOrgaiOptions {
  platform: NodeJS.Platform | string
  /** The PATH value (login shell PATH in the app; process PATH in the CLI). Empty or undefined finds nothing. */
  pathList: string | undefined
  env?: Readonly<Record<string, string | undefined>>
  home?: string
  fs?: Partial<OrgaiPathFs>
}

function pathFor(platform: NodeJS.Platform | string): PlatformPath {
  return platform === 'win32' ? win32 : posix
}

/** The file names looked for in each PATH folder: `orgai` on POSIX, `orgai<ext>` per PATHEXT on Windows. */
export function orgaiCandidateNames(platform: NodeJS.Platform | string, env: Readonly<Record<string, string | undefined>> = {}): string[] {
  if (platform !== 'win32') return ['orgai']
  const raw = env.PATHEXT ?? Object.entries(env).find(([k]) => k.toUpperCase() === 'PATHEXT')?.[1] ?? '.COM;.EXE;.BAT;.CMD'
  const exts = raw
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^\.[a-z0-9]{1,8}$/.test(e))
  return [...new Set(exts)].map((e) => `orgai${e}`)
}

function folderKey(p: PlatformPath, platform: NodeJS.Platform | string, dir: string, home: string): string {
  let v = dir.trim()
  if (platform === 'win32' && v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
  if (v === '~') v = home
  else if (home && (v.startsWith('~/') || (platform === 'win32' && v.startsWith('~\\')))) v = p.join(home, v.slice(2))
  if (!v) return ''
  let n = p.normalize(v)
  const root = p.parse(n).root
  while (n.length > root.length && /[\\/]$/.test(n)) n = n.slice(0, -1)
  return n
}

/** A key comparing two paths the way the platform does (case folded on win32 and darwin). */
export function samePathKey(platform: NodeJS.Platform | string, path: string): string {
  const p = pathFor(platform)
  const n = folderKey(p, platform, path, '')
  return platform === 'win32' || platform === 'darwin' ? n.toLowerCase() : n
}

const NPM_CMD_BUNDLE_RE = /node_modules[\\/](orgai(?:-cli)?)[\\/]out[\\/]cli[\\/]orgai\.mjs/i

/** The version of an `orgai-cli` package.json (name checked, size bounded), else undefined. Reads one small file. */
function npmPackageOf(fs: OrgaiPathFs, file: string): { version?: string } | undefined {
  try {
    // Regular file only: a link, a FIFO or a device could make the read unbounded or block.
    const st = fs.lstat(file)
    if (!st.isFile() || st.isSymbolicLink() || st.size > SHIM_TEXT_MAX_BYTES) return undefined
    const j = JSON.parse(fs.readText(file)) as { name?: unknown; version?: unknown }
    if (j.name !== 'orgai-cli') return undefined
    return typeof j.version === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(j.version) ? { version: j.version } : {}
  } catch {
    return undefined
  }
}

function kindOfChannel(channel: InstallChannel | undefined): OrgaiOnPathKind {
  if (channel === 'npm') return 'npm'
  if (channel === 'archive') return 'archive'
  if (channel === 'app') return 'app-launcher'
  if (channel === 'dev') return 'dev'
  return 'unknown'
}

/** Every orgai on `pathList`, in PATH order; a folder listed twice counts once. Never throws. */
export function findOrgaiOnPath(opts: FindOrgaiOptions): OrgaiOnPathEntry[] {
  const { platform } = opts
  const env = opts.env ?? {}
  const home = opts.home ?? ''
  const fs: OrgaiPathFs = { ...defaultFs, ...(opts.fs ?? {}) }
  const p = pathFor(platform)
  if (!opts.pathList) return []
  const names = orgaiCandidateNames(platform, env)
  const seen = new Set<string>()
  const out: OrgaiOnPathEntry[] = []
  const entries = opts.pathList.split(platform === 'win32' ? ';' : ':').slice(0, ORGAI_PATH_MAX_ENTRIES)
  for (const raw of entries) {
    const dir = folderKey(p, platform, raw, home)
    // Relative PATH entries depend on the cwd; a shell would search them, but nothing here guesses a cwd.
    if (!dir || !p.isAbsolute(dir)) continue
    // Never touch a network folder (UNC, /net automounts): see isNetworkPathFor. A mapped drive letter is not detected.
    if (isNetworkPathFor(platform, raw.trim().replace(/^"(.*)"$/, '$1')) || isNetworkPathFor(platform, dir)) continue
    const key = samePathKey(platform, dir)
    if (seen.has(key)) continue
    seen.add(key)
    for (const name of names) {
      const file = p.join(dir, name)
      const hit = inspectCandidate(file, platform, env, fs, p)
      if (hit) {
        out.push(hit)
        break
      }
    }
  }
  return out
}

function inspectCandidate(
  file: string,
  platform: NodeJS.Platform | string,
  env: Readonly<Record<string, string | undefined>>,
  fs: OrgaiPathFs,
  p: PlatformPath
): OrgaiOnPathEntry | undefined {
  let st: { isFile(): boolean; size: number; mode?: number }
  let link = false
  try {
    const l = fs.lstat(file)
    link = l.isSymbolicLink()
    st = link ? fs.stat(file) : l
  } catch {
    return undefined
  }
  if (!st.isFile()) return undefined
  // A POSIX shell skips a file with no execute bit; an unknown mode (a fake fs) counts as executable.
  if (platform !== 'win32' && typeof st.mode === 'number' && (st.mode & 0o111) === 0) return undefined
  const isFile = (x: string): boolean => {
    try {
      return fs.lstat(x).isFile()
    } catch {
      return false
    }
  }
  const withBundle = (entry: OrgaiOnPathEntry, bundleDir: string, fallback: OrgaiOnPathKind): OrgaiOnPathEntry => {
    const info = readInstallInfo({ bundleDir, fs: { size: (x) => fs.lstat(x).size, isFile: (x) => fs.lstat(x).isFile(), readText: (x) => fs.readText(x) } })
    let kind = entry.kind !== 'unknown' ? entry.kind : info.source === 'file' ? kindOfChannel(info.channel) : fallback
    // npm's package.json beside the bundle (<pkg>/out/cli): the package is orgai-cli. It names the install even when
    // install.json is missing, and its version is the one shown (5.3).
    const pkg = kind === 'archive' || kind === 'app-shim' || kind === 'app-launcher' ? undefined : npmPackageOf(fs, p.join(p.dirname(p.dirname(bundleDir)), 'package.json'))
    if (pkg) kind = 'npm'
    const version = pkg?.version ?? info.version
    return {
      ...entry,
      kind,
      bundleDir,
      ...(pkg ? { channel: 'npm' as const } : info.source !== 'invalid' ? { channel: info.channel } : {}),
      ...(version ? { version } : {}),
      ...(info.commit ? { commit: info.commit } : {})
    }
  }
  let real = file
  if (link) {
    try {
      real = fs.realpath(file)
    } catch {
      real = file
    }
  }
  // npm's POSIX bin is a link straight to the bundle entry; so is a hand-made link to a checkout's out/cli/orgai.mjs.
  if (p.basename(real) === 'orgai.mjs' && p.basename(p.dirname(real)) === 'cli' && p.basename(p.dirname(p.dirname(real))) === 'out') {
    return withBundle({ path: file, kind: 'unknown' }, p.dirname(real), 'dev')
  }
  // Read through links: a link to a shim is read as that shim, a link to the launcher as the launcher.
  const text = (() => {
    if (st.size > SHIM_TEXT_MAX_BYTES) return undefined
    try {
      return fs.readText(file)
    } catch {
      return undefined
    }
  })()
  if (text !== undefined && isOrgaiShim(text)) {
    const parsed = parseCliShim(text, platform, env)
    if (!parsed) return { path: file, kind: 'app-shim' }
    const resources = p.dirname(p.dirname(parsed.launcher))
    return withBundle({ path: file, kind: 'app-shim', launcher: parsed.launcher }, packagedLayout(platform, resources).cliBundleDir, 'app-shim')
  }
  // A packaged app's launcher (<Resources>/bin/orgai[.cmd]): its folder on PATH (VS Code style) or a link to it. Only
  // when it really is one: the launcher's own text, or the app's CLI bundle beside it. Any other <X>/bin/orgai is not.
  if (p.basename(p.dirname(real)) === 'bin') {
    const layout = packagedLayout(platform, p.dirname(p.dirname(real)))
    if (samePathKey(platform, layout.launcher) === samePathKey(platform, real) && ((text !== undefined && text.includes(PACKAGED_LAUNCHER_MARK)) || isFile(layout.cliEntry))) {
      return withBundle({ path: file, kind: 'app-launcher', launcher: real }, layout.cliBundleDir, 'app-launcher')
    }
  }
  if (text === undefined) return { path: file, kind: 'unknown' }
  const npmCmd = platform === 'win32' ? NPM_CMD_BUNDLE_RE.exec(text) : null
  if (npmCmd) {
    // The package folder is named after the package: orgai-cli (owner decision 2026-11-06), orgai for an older install.
    return withBundle({ path: file, kind: 'unknown' }, p.join(p.dirname(file), 'node_modules', npmCmd[1].toLowerCase(), 'out', 'cli'), 'npm')
  }
  return { path: file, kind: 'unknown' }
}

/**
 * Compares two versions (`MAJOR.MINOR.PATCH[-prerelease]`, semver precedence: a prerelease sorts before its release,
 * numeric identifiers numerically, and words carrying numbers naturally: `-dev2` before `-dev10`). Returns -1, 0 or 1; undefined when either does not parse.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | undefined {
  const parse = (v: string): { core: number[]; pre: string[] } | undefined => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim())
    if (!m) return undefined
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
  }
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return undefined
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1
  if (x.pre.length === 0 || y.pre.length === 0) return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const s = x.pre[i]
    const t = y.pre[i]
    if (s === undefined) return -1
    if (t === undefined) return 1
    const sn = /^\d+$/.test(s)
    const tn = /^\d+$/.test(t)
    if (sn && tn) {
      if (Number(s) !== Number(t)) return Number(s) < Number(t) ? -1 : 1
    } else if (sn !== tn) return sn ? -1 : 1
    else if (s !== t) {
      // Natural order for words with numbers (dev2 < dev10), unlike strict semver's ASCII order: OrgAI's dev builds.
      const c = s.localeCompare(t, 'en', { numeric: true })
      if (c !== 0) return c < 0 ? -1 : 1
    }
  }
  return 0
}

/** Later entries whose version is newer than the first one's (the one a shell runs): shadowed by it. */
export function shadowedNewer(entries: readonly OrgaiOnPathEntry[]): OrgaiOnPathEntry[] {
  const first = entries[0]
  if (!first?.version) return []
  return entries.slice(1).filter((e) => e.version !== undefined && compareVersions(e.version, first.version as string) === 1)
}

/** Words for where an orgai came from: 'from npm', 'of an OrgAI app', ... */
export function orgaiSourceWords(entry: Pick<OrgaiOnPathEntry, 'kind' | 'channel'>): string {
  switch (entry.kind) {
    case 'npm':
      return 'from npm'
    case 'archive':
      return 'from the portable archive'
    case 'app-shim':
    case 'app-launcher':
      return 'of an OrgAI app'
    case 'dev':
      return 'of a development checkout'
    default:
      return 'of unknown origin'
  }
}
