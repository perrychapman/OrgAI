/**
 * Where the packaged OrgAI keeps the orgai command (cli-spec 7, Wave 6), and the user-level shim that puts it on PATH
 * (cli-spec 7(3)); the app no longer writes it, the cleanup only reads it. Pure: node:path only, no electron, no fs. Every function takes the platform so tests can check all
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
 * Where an older OrgAI app put its shim: `<home>/.local/bin/orgai` on macOS and Linux, `<LOCALAPPDATA>\OrgAI\bin\orgai.cmd` on Windows
 * (LOCALAPPDATA trimmed; when unset or blank, `<home>\AppData\Local`). Only read and removed now.
 */
export function cliShimPath(platform: NodeJS.Platform | string, env: Readonly<Record<string, string | undefined>>, home: string): string {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA?.trim() || win32.join(home, 'AppData', 'Local')
    return win32.join(local, PACKAGED_PRODUCT_NAME, 'bin', 'orgai.cmd')
  }
  return posix.join(home, '.local', 'bin', 'orgai')
}

/** win32: the variables an old shim line may start with (`%LOCALAPPDATA%\...`). */
const SHIM_PATH_VARS = ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'ProgramFiles'] as const

/** A leading `%NAME%` of {@link SHIM_PATH_VARS} is replaced by its value in `env`. */
function expandBatchPath(value: string, env: Readonly<Record<string, string | undefined>> | undefined): string {
  const m = /^%([A-Za-z]+)%/.exec(value)
  if (!m || !env) return value
  const name = SHIM_PATH_VARS.find((n) => n.toLowerCase() === m[1].toLowerCase())
  const v = name ? env[name]?.trim().replace(/[\\/]+$/, '') : undefined
  return v ? v + value.slice(m[0].length) : value
}

/** Reverses POSIX single-quote quoting (' written as '\\'') on one complete quoted word; undefined when `word` is not exactly that. */
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

/** True when one of the first 5 lines carries an OrgAI shim marker (any version). */
export function isOrgaiShim(text: string): boolean {
  return text.split(/\r?\n/, 5).some((line) => line.includes('orgai-shim v'))
}

export interface ParsedCliShim {
  launcher: string
  userDataDir?: string
}

/**
 * Reads an old OrgAI app shim (on win32 a leading `%LOCALAPPDATA%`-style
 * variable is expanded from `env`); undefined for a foreign or unreadable file.
 */
export function parseCliShim(text: string, platform: NodeJS.Platform | string, env?: Readonly<Record<string, string | undefined>>): ParsedCliShim | undefined {
  if (!isOrgaiShim(text)) return undefined
  const lines = text.split(/\r?\n/)
  let launcher: string | undefined
  let userDataDir: string | undefined
  if (platform === 'win32') {
    for (const line of lines) {
      // `"<launcher>" %*`; shims written before the Wave 6 review used `call "<launcher>" %*`.
      const call = /^(?:call )?"([^"]+)" %\*$/.exec(line)
      if (call) launcher = expandBatchPath(call[1], env)
      const data = /^if not defined ORGAI_DATA_DIR set "ORGAI_DATA_DIR=([^"]+)"$/.exec(line)
      if (data) userDataDir = expandBatchPath(data[1], env)
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
