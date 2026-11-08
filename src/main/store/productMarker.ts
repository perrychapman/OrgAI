/**
 * The product marker (standalone spec 3.1): `<userDataDir>/product.json` `{ "product": "orgai-cli" | "orgai-desktop",
 * "version": 1 }`, written 0600 by whichever product creates or first opens a folder. Each product refuses a folder
 * marked for the other. Electron-free; relative imports only (the CLI bundle uses it).
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, win32, posix } from 'node:path'

export type ProductId = 'orgai-cli' | 'orgai-desktop'

export const PRODUCT_MARKER_FILE = 'product.json'

export type MarkerRead = { state: 'absent' } | { state: 'invalid' } | { state: 'marked'; product: ProductId }

/** Reads the marker; a missing file is 'absent', anything not `{ product: <known> }` is 'invalid'. */
export function readProductMarker(userDataDir: string): MarkerRead {
  let text: string
  try {
    text = readFileSync(join(userDataDir, PRODUCT_MARKER_FILE), 'utf8')
  } catch (e) {
    // A path under a file (ENOTDIR) holds no marker either; any other failure (EACCES, EISDIR) is unreadable, not absent.
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? { state: 'absent' } : { state: 'invalid' }
  }
  try {
    const v = JSON.parse(text) as { product?: unknown }
    if (v && (v.product === 'orgai-cli' || v.product === 'orgai-desktop')) return { state: 'marked', product: v.product }
  } catch {
    // falls through to invalid
  }
  return { state: 'invalid' }
}

/** Writes the marker (0600), creating the folder (0700) when it is missing. Returns false when it could not be written. */
export function writeProductMarker(userDataDir: string, product: ProductId): boolean {
  try {
    mkdirSync(userDataDir, { recursive: true, mode: 0o700 })
    const file = join(userDataDir, PRODUCT_MARKER_FILE)
    // Temp file then rename, so a crash never leaves a half-written marker.
    const tmp = `${file}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, `${JSON.stringify({ product, version: 1 })}\n`, { mode: 0o600 })
      try {
        chmodSync(tmp, 0o600)
      } catch {
        // Windows ignores modes.
      }
      renameSync(tmp, file)
    } catch (e) {
      rmSync(tmp, { force: true })
      throw e
    }
    return true
  } catch {
    return false
  }
}

function real(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

/**
 * The spellings a folder is known by: its own real path, and the real path of its parent plus its name (a folder that
 * does not exist yet, or an alias reaching it through a symlinked parent).
 */
function canonicalSpellings(folder: string, platform: NodeJS.Platform): string[] {
  const api = platform === 'win32' ? win32 : posix
  const fold = platform === 'win32' || platform === 'darwin'
  const norm = (p: string): string => (fold ? p.toLowerCase() : p)
  return [real(folder), api.join(real(dirname(folder)), basename(folder))].map(norm)
}

/** True when `folder` and `other` are the same place by canonical path (symlink aliases included). */
export function sameFolder(folder: string, other: string, platform: NodeJS.Platform = process.platform): boolean {
  const a = canonicalSpellings(folder, platform)
  const b = canonicalSpellings(other, platform)
  return a.some((x) => b.includes(x))
}

/** True when `folder` is inside `parent` or is `parent` itself, by canonical spellings (any pair of spellings). */
function isInside(folder: string, parent: string, platform: NodeJS.Platform): boolean {
  const sep = platform === 'win32' ? '\\' : '/'
  const p = canonicalSpellings(parent, platform)
  return canonicalSpellings(folder, platform).some((f) => p.some((x) => f === x || f.startsWith(x.endsWith(sep) ? x : x + sep)))
}

/** True when an ancestor of `folder` carries the desktop marker (the folder sits inside an app folder). */
function insideDesktopMarkedFolder(folder: string): boolean {
  for (let dir = dirname(real(folder)); ; dir = dirname(dir)) {
    const m = readProductMarker(dir)
    if (m.state === 'marked' && m.product === 'orgai-desktop') return true
    if (dirname(dir) === dir) return false
  }
}

function dataFolderHoldsFiles(dataDir: string): boolean {
  if (!existsSync(dataDir)) return false
  try {
    if (!statSync(dataDir).isDirectory()) return true
    return readdirSync(dataDir).length > 0
  } catch {
    return true
  }
}

export interface CliFolderCheck {
  userDataDir: string
  dataDir: string
  /** The desktop app's default userDataDir on this platform: never a CLI folder. */
  desktopDefault: string
  platform?: NodeJS.Platform
}

/** The refusal when the marker cannot be written (before any other write, so a later start never misreads the folder). */
export const markerWriteRefusal = (userDataDir: string): string => `orgai cannot write ${PRODUCT_MARKER_FILE} in ${userDataDir}; choose another folder.`

/** The refusal for a marker the CLI cannot read or does not know (maybe the app's, or a newer version's): never replaced. */
export const markerUnreadableRefusal = (userDataDir: string): string =>
  `${join(userDataDir, PRODUCT_MARKER_FILE)} cannot be read or is not an OrgAI marker, so orgai will not use ${userDataDir}; choose another folder or remove that file.`

/** The refusal text of 3.1. */
export const folderRefusal = (userDataDir: string): string => `${userDataDir} belongs to the OrgAI app. orgai keeps its own data; choose another folder.`

/** The refusal for a folder that holds the app's data folder: the folder itself is not the app's, but using it would put the CLI's files around the app's. */
export const containsAppRefusal = (userDataDir: string): string =>
  `${userDataDir} contains the OrgAI app's data folder. orgai keeps its own data; choose another folder.`

/**
 * Decides whether the CLI may use the folder, before any other read or write there. Returns the refusal text, or
 * undefined when it may (an empty or missing folder gets the CLI marker; a CLI-marked one is left as it is; an unreadable marker refuses).
 */
export function checkCliFolder(c: CliFolderCheck): string | undefined {
  const platform = c.platform ?? process.platform
  const marker = readProductMarker(c.userDataDir)
  if (marker.state === 'marked' && marker.product === 'orgai-desktop') return folderRefusal(c.userDataDir)
  // The app's own folder, anything inside it and anything that contains it (G1: never write the app's data).
  if (isInside(c.userDataDir, c.desktopDefault, platform)) return folderRefusal(c.userDataDir)
  if (isInside(c.desktopDefault, c.userDataDir, platform)) return containsAppRefusal(c.userDataDir)
  if (insideDesktopMarkedFolder(c.userDataDir)) return folderRefusal(c.userDataDir)
  // The data subfolder is `<userDataDir>/data` by its real path, never a link into another place (the app's data included).
  if (existsSync(c.dataDir)) {
    const fold = platform === 'win32' || platform === 'darwin'
    const norm = (p: string): string => (fold ? p.toLowerCase() : p)
    const api = platform === 'win32' ? win32 : posix
    const expected = api.join(real(c.userDataDir), basename(c.dataDir))
    if (norm(real(c.dataDir)) !== norm(expected)) return folderRefusal(c.userDataDir)
    if (isInside(c.dataDir, c.desktopDefault, platform) || insideDesktopMarkedFolder(c.dataDir)) return folderRefusal(c.userDataDir)
  }
  if (marker.state === 'marked') return undefined
  // A marker that exists but cannot be read, or that this version does not know, is not an empty folder: leave it alone.
  if (marker.state === 'invalid') return markerUnreadableRefusal(c.userDataDir)
  if (dataFolderHoldsFiles(c.dataDir)) return folderRefusal(c.userDataDir)
  if (!writeProductMarker(c.userDataDir, 'orgai-cli')) return markerWriteRefusal(c.userDataDir)
  return undefined
}
