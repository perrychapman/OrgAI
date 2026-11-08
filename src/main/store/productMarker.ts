/**
 * The product marker (standalone spec 3.1): `<userDataDir>/product.json` `{ "product": "orgai-cli" | "orgai-desktop",
 * "version": 1 }`, written 0600 by whichever product creates or first opens a folder. Each product refuses a folder
 * marked for the other. Electron-free; relative imports only (the CLI bundle uses it).
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
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
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'absent' } : { state: 'invalid' }
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
    writeFileSync(file, `${JSON.stringify({ product, version: 1 })}\n`, { mode: 0o600 })
    try {
      chmodSync(file, 0o600)
    } catch {
      // Windows ignores modes.
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

/** The refusal text of 3.1. */
export const folderRefusal = (userDataDir: string): string => `${userDataDir} belongs to the OrgAI app. orgai keeps its own data; choose another folder.`

/**
 * Decides whether the CLI may use the folder, before any other read or write there. Returns the refusal text, or
 * undefined when it may (an empty or missing folder gets the CLI marker; a CLI-marked one is left as it is).
 */
export function checkCliFolder(c: CliFolderCheck): string | undefined {
  const platform = c.platform ?? process.platform
  const marker = readProductMarker(c.userDataDir)
  if (marker.state === 'marked' && marker.product === 'orgai-desktop') return folderRefusal(c.userDataDir)
  if (sameFolder(c.userDataDir, c.desktopDefault, platform)) return folderRefusal(c.userDataDir)
  if (marker.state === 'marked') return undefined
  if (dataFolderHoldsFiles(c.dataDir)) return folderRefusal(c.userDataDir)
  writeProductMarker(c.userDataDir, 'orgai-cli')
  return undefined
}
