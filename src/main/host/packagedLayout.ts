/**
 * Where the packaged OrgAI keeps the orgai command (cli-spec 7, Wave 6), and the user-level shim that puts it on PATH
 * (cli-spec 7(3)). Pure: node:path only, no electron, no fs. Every function takes the platform so tests can check all
 * three layouts on one machine ('win32' uses path.win32, everything else path.posix).
 *
 * Layout (electron-builder): `<resources>/app.asar.unpacked/out/cli/orgai.mjs` is the CLI bundle, `<resources>/bin/orgai`
 * (sh) or `orgai.cmd` the launcher that runs the app binary with ELECTRON_RUN_AS_NODE=1 on it, as VS Code's `code`
 * command does. The shim is a tiny file the user's PATH finds; it only execs the launcher.
 */
import { posix, win32, type PlatformPath } from 'node:path'

/** package.json productName: the packaged app's folder / executable name on macOS and Windows. */
export const PACKAGED_PRODUCT_NAME = 'OrgAI'
/** The Linux executable name (electron-builder lowercases it). */
export const LINUX_EXECUTABLE = 'orgai'

/** The marker every OrgAI-written shim carries in its first lines (`isOrgaiShim`). */
export const CLI_SHIM_MARKER = 'orgai-shim v1'
/** The shim format version this app writes (the number in CLI_SHIM_MARKER). */
export const CLI_SHIM_VERSION = 1

const SHIM_SENTENCE =
  'written by OrgAI (App settings > General > Advanced settings > Terminal). OrgAI updates or removes this file.'

function pathFor(platform: NodeJS.Platform | string): PlatformPath {
  return platform === 'win32' ? win32 : posix
}

/** The launcher's file name: 'orgai.cmd' on Windows, else 'orgai'. */
export function cliLauncherName(platform: NodeJS.Platform | string): string {
  return platform === 'win32' ? 'orgai.cmd' : 'orgai'
}

/** The packaged app's CLI pieces, all absolute and normalized. */
export interface PackagedLayout {
  /** process.resourcesPath */
  resourcesDir: string
  /** <resources>/bin (extraResources) */
  binDir: string
  /** <bin>/orgai or <bin>/orgai.cmd */
  launcher: string
  /** <resources>/app.asar.unpacked */
  unpackedDir: string
  /** <unpacked>/out/cli */
  cliBundleDir: string
  /** <cliBundleDir>/orgai.mjs */
  cliEntry: string
  /** The app executable: darwin <res>/../MacOS/OrgAI, win32 <res>/../OrgAI.exe, linux <res>/../orgai. */
  appBinary: string
}

export function packagedLayout(platform: NodeJS.Platform | string, resourcesDir: string): PackagedLayout {
  const p = pathFor(platform)
  const res = trimTrailing(p, resourcesDir)
  const binDir = p.join(res, 'bin')
  const unpackedDir = p.join(res, 'app.asar.unpacked')
  const cliBundleDir = p.join(unpackedDir, 'out', 'cli')
  const appBinary =
    platform === 'darwin'
      ? p.join(res, '..', 'MacOS', PACKAGED_PRODUCT_NAME)
      : platform === 'win32'
        ? p.join(res, '..', `${PACKAGED_PRODUCT_NAME}.exe`)
        : p.join(res, '..', LINUX_EXECUTABLE)
  return {
    resourcesDir: res,
    binDir,
    launcher: p.join(binDir, cliLauncherName(platform)),
    unpackedDir,
    cliBundleDir,
    cliEntry: p.join(cliBundleDir, 'orgai.mjs'),
    appBinary
  }
}

/** Strips trailing separators but never reduces a root to ''. */
function trimTrailing(p: PlatformPath, value: string): string {
  const n = p.normalize(value)
  const root = p.parse(n).root
  let out = n
  while (out.length > root.length && /[\\/]$/.test(out)) out = out.slice(0, -1)
  return out
}

/**
 * The resources dir when `bundleDir` is a packaged CLI bundle (`<res>/app.asar.unpacked/out/cli`), else undefined
 * (a dev checkout's or a project's own out/cli).
 */
export function resourcesDirOfCliBundle(bundleDir: string, platform: NodeJS.Platform | string): string | undefined {
  if (!bundleDir) return undefined
  const p = pathFor(platform)
  const dir = trimTrailing(p, bundleDir)
  const cli = p.basename(dir)
  const out = p.dirname(dir)
  const unpacked = p.dirname(out)
  if (cli !== 'cli' || p.basename(out) !== 'out' || p.basename(unpacked) !== 'app.asar.unpacked') return undefined
  const res = p.dirname(unpacked)
  return res === unpacked ? undefined : res
}

/**
 * The self-control gate's CLI roots for a packaged app (`app.getAppPath()` is `<res>/app.asar`, or
 * `<res>/app.asar.unpacked`): the unpacked bundle and the launcher folder. A dev root gives [].
 */
export function packagedCliRoots(appPath: string, platform: NodeJS.Platform | string): string[] {
  if (!appPath) return []
  const p = pathFor(platform)
  const dir = trimTrailing(p, appPath)
  const base = p.basename(dir)
  if (base !== 'app.asar' && base !== 'app.asar.unpacked') return []
  const res = p.dirname(dir)
  const layout = packagedLayout(platform, res)
  return [layout.cliBundleDir, layout.binDir]
}

/**
 * Why the shim cannot point at this copy of OrgAI, as one plain sentence, or undefined. A translocated or disk-image
 * app (darwin), an AppImage (linux) and the portable build (win32) move or vanish, so a shim would break.
 */
export function transientInstallReason(
  platform: NodeJS.Platform | string,
  resourcesDir: string,
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  if (platform === 'darwin') {
    if (resourcesDir.includes('/AppTranslocation/') || resourcesDir.startsWith('/Volumes/'))
      return 'Move OrgAI to your Applications folder first, then install the orgai command.'
    return undefined
  }
  if (platform === 'win32') {
    if (env.PORTABLE_EXECUTABLE_DIR) return 'The orgai command cannot be installed from the portable OrgAI.'
    return undefined
  }
  if (platform === 'linux' && env.APPIMAGE) return 'The orgai command cannot be installed from an AppImage.'
  return undefined
}

/**
 * The shim file: `<home>/.local/bin/orgai` on macOS and Linux, `<LOCALAPPDATA>\OrgAI\bin\orgai.cmd` on Windows
 * (LOCALAPPDATA trimmed; when unset or blank, `<home>\AppData\Local`).
 */
export function cliShimPath(platform: NodeJS.Platform | string, env: Readonly<Record<string, string | undefined>>, home: string): string {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA?.trim() || win32.join(home, 'AppData', 'Local')
    return win32.join(local, PACKAGED_PRODUCT_NAME, 'bin', 'orgai.cmd')
  }
  return posix.join(home, '.local', 'bin', 'orgai')
}

export interface RenderCliShimInput {
  platform: NodeJS.Platform | string
  /** The packaged launcher (`PackagedLayout.launcher`), absolute. */
  launcher: string
  /**
   * The application userDataDir (`app.getPath('userData')`), never `<userData>/data`: the CLI derives the data
   * folder itself (cli-spec 7(3)). Given = the shim sets ORGAI_DATA_DIR when the caller has not.
   */
  userDataDir?: string
}

function checkShimPath(label: string, value: string, platform: NodeJS.Platform | string): void {
  if (!value) throw new Error(`The ${label} path is empty.`)
  if (/[\0\r\n]/.test(value)) throw new Error(`The ${label} path contains a line break or a NUL character.`)
  // On Windows a root-relative \x path depends on the current drive: only a drive path (C:\...) or UNC counts.
  const absolute = platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/.test(value) : posix.isAbsolute(value)
  if (!absolute) throw new Error(`The ${label} path is not absolute.`)
  if (platform === 'win32' && /["%]/.test(value)) throw new Error(`The ${label} path contains a quote or a percent sign.`)
}

/** POSIX single-quote quoting: ' becomes '\''. */
function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Reverses `sq` on one complete quoted word; undefined when `word` is not exactly that. */
function unSq(word: string): string | undefined {
  let out = ''
  let i = 0
  let quoted = false
  while (i < word.length) {
    if (word[i] === "'") {
      const end = word.indexOf("'", i + 1)
      if (end < 0) return undefined
      out += word.slice(i + 1, end)
      i = end + 1
      quoted = true
    } else if (word[i] === '\\' && word[i + 1] === "'") {
      out += "'"
      i += 2
    } else return undefined
  }
  return quoted ? out : undefined
}

/** The shim file text (LF on POSIX, CRLF on Windows). Throws a plain sentence for an unusable path. */
export function renderCliShim(input: RenderCliShimInput): string {
  const { platform, launcher, userDataDir } = input
  checkShimPath('launcher', launcher, platform)
  if (userDataDir !== undefined) checkShimPath('OrgAI data', userDataDir, platform)
  if (platform === 'win32') {
    const lines = ['@echo off', `rem ${CLI_SHIM_MARKER}: ${SHIM_SENTENCE}`, 'setlocal']
    if (userDataDir !== undefined) lines.push(`if not defined ORGAI_DATA_DIR set "ORGAI_DATA_DIR=${userDataDir}"`)
    // The launcher is the last command and runs without CALL: CALL would expand % in the user's arguments a second
    // time ("10% and 20%" loses its middle) and double their carets. A batch file started without CALL replaces this
    // one, keeps the SETLOCAL environment and its exit code is the command's.
    lines.push(`"${launcher}" %*`)
    return lines.join('\r\n') + '\r\n'
  }
  const lines = ['#!/bin/sh', `# ${CLI_SHIM_MARKER}: ${SHIM_SENTENCE}`]
  if (userDataDir !== undefined)
    lines.push(`if [ -z "\${ORGAI_DATA_DIR:-}" ]; then ORGAI_DATA_DIR=${sq(userDataDir)}; export ORGAI_DATA_DIR; fi`)
  lines.push(`exec ${sq(launcher)} "$@"`)
  return lines.join('\n') + '\n'
}

/** True when one of the first 5 lines carries an OrgAI shim marker (any version). */
export function isOrgaiShim(text: string): boolean {
  return text.split(/\r?\n/, 5).some((line) => line.includes('orgai-shim v'))
}

/** The highest `orgai-shim v<N>` version in the first 5 lines, or undefined without a marker. */
export function shimMarkerVersion(text: string): number | undefined {
  let best: number | undefined
  for (const line of text.split(/\r?\n/, 5)) {
    for (const m of line.matchAll(/orgai-shim v(\d{1,6})/g)) {
      const n = Number(m[1])
      if (best === undefined || n > best) best = n
    }
  }
  return best
}

export interface ParsedCliShim {
  launcher: string
  userDataDir?: string
}

/** Reads an OrgAI shim back (`renderCliShim` round-trips exactly); undefined for a foreign or unreadable file. */
export function parseCliShim(text: string, platform: NodeJS.Platform | string): ParsedCliShim | undefined {
  if (!isOrgaiShim(text)) return undefined
  const lines = text.split(/\r?\n/)
  let launcher: string | undefined
  let userDataDir: string | undefined
  if (platform === 'win32') {
    for (const line of lines) {
      // `"<launcher>" %*`; shims written before the Wave 6 review used `call "<launcher>" %*`.
      const call = /^(?:call )?"([^"]+)" %\*$/.exec(line)
      if (call) launcher = call[1]
      const data = /^if not defined ORGAI_DATA_DIR set "ORGAI_DATA_DIR=([^"]+)"$/.exec(line)
      if (data) userDataDir = data[1]
    }
  } else {
    const dataPrefix = 'if [ -z "${ORGAI_DATA_DIR:-}" ]; then ORGAI_DATA_DIR='
    const dataSuffix = '; export ORGAI_DATA_DIR; fi'
    for (const line of lines) {
      if (line.startsWith('exec ') && line.endsWith(' "$@"')) {
        const word = unSq(line.slice('exec '.length, -' "$@"'.length))
        if (word !== undefined) launcher = word
      } else if (line.startsWith(dataPrefix) && line.endsWith(dataSuffix)) {
        const word = unSq(line.slice(dataPrefix.length, -dataSuffix.length))
        if (word !== undefined) userDataDir = word
      }
    }
  }
  if (!launcher) return undefined
  return userDataDir !== undefined ? { launcher, userDataDir } : { launcher }
}
