/**
 * Synchronous, file-system-only helpers for finding agent runtimes (Wave 7, docs/design/cli-standalone.md 6.1, 6.2):
 * the absolute PATH directories (never the cwd), what kind of file a hit is (native executable or script, by content,
 * never by name) and module resolution from a bundle folder through createRequire. Nothing here spawns a process.
 *
 * Every function takes an injectable `LookupFs` / resolver so tests run on fake file systems. Electron-free; relative
 * imports only.
 */
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, posix, win32 } from 'node:path'

type Env = Readonly<Record<string, string | undefined>>

/** What a lookup needs of the file system. Every method answers undefined instead of throwing. */
export interface LookupFs {
  /** stat that follows links. */
  stat(p: string): { isFile: boolean; isDirectory: boolean; mtimeMs: number; size: number } | undefined
  /** The real path (links resolved). */
  realpath(p: string): string | undefined
  /** The first `max` bytes of a regular file. */
  readHead(p: string, max: number): Uint8Array | undefined
}

export const nodeLookupFs: LookupFs = {
  stat(p) {
    try {
      const s = statSync(p)
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), mtimeMs: s.mtimeMs, size: s.size }
    } catch {
      return undefined
    }
  },
  realpath(p) {
    try {
      return realpathSync.native(p)
    } catch {
      return undefined
    }
  },
  readHead(p, max) {
    let fd: number | undefined
    try {
      fd = openSync(p, 'r')
      const buf = Buffer.alloc(max)
      const n = readSync(fd, buf, 0, max, 0)
      return buf.subarray(0, n)
    } catch {
      return undefined
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* already closed */
        }
      }
    }
  }
}

/** Resolve a module specifier as `require.resolve` would from inside `fromDir`; undefined when it cannot. */
export type ModuleResolver = (spec: string, fromDir: string) => string | undefined

export const nodeModuleResolver: ModuleResolver = (spec, fromDir) => {
  try {
    // createRequire wants a file path; the file need not exist.
    return createRequire(join(fromDir, 'noop.js')).resolve(spec)
  } catch {
    return undefined
  }
}

/** The path module for a platform (tests run win32 lookups on POSIX and back). */
export function pathFor(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

/** A drive path (`C:\...` / `C:/...`): never relative, never root-relative, never UNC. */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/

/**
 * The PATH directories a lookup may use, in order, each once: absolute entries only (relative, empty and '.' entries
 * are skipped, so the cwd is never searched). win32: drive paths only (never UNC), quotes removed, `Path` / `PATH` /
 * `path` read in that order, as systemBinaries.ts findOnPath does.
 */
export function pathDirectories(env: Env, platform: NodeJS.Platform): string[] {
  const win = platform === 'win32'
  const raw = (win ? (env.Path ?? env.PATH ?? env.path) : env.PATH) ?? ''
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw.split(win ? ';' : ':')) {
    const dir = win ? entry.trim().replace(/^"(.*)"$/, '$1') : entry
    if (!dir || /[\0\r\n]/.test(dir)) continue
    if (win ? !DRIVE_PATH.test(dir) : !posix.isAbsolute(dir)) continue
    const key = win ? dir.toLowerCase() : dir
    if (seen.has(key)) continue
    seen.add(key)
    out.push(dir)
  }
  return out
}

/**
 * Every regular file named one of `names` in the PATH directories, directory by directory and, within one, in the
 * order of `names`. Never runs anything.
 */
export function filesOnPath(names: readonly string[], env: Env, platform: NodeJS.Platform, fs: LookupFs = nodeLookupFs): string[] {
  const p = pathFor(platform)
  const out: string[] = []
  for (const dir of pathDirectories(env, platform)) {
    for (const name of names) {
      const cand = p.join(dir, name)
      if (fs.stat(cand)?.isFile) out.push(cand)
    }
  }
  return out
}

/** What a file is, read from its first bytes: a native executable (Mach-O, ELF, PE), a '#!' script, or neither. */
export type FileKind = 'native' | 'script' | 'other'

const MACHO_MAGICS = [
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
  [0xbe, 0xba, 0xfe, 0xca]
]

export function fileKindOf(head: Uint8Array | undefined): FileKind {
  if (!head || head.length < 2) return 'other'
  const starts = (m: readonly number[]): boolean => head.length >= m.length && m.every((b, i) => head[i] === b)
  if (MACHO_MAGICS.some(starts)) return 'native'
  if (starts([0x7f, 0x45, 0x4c, 0x46])) return 'native' // ELF
  if (starts([0x4d, 0x5a])) return 'native' // PE ("MZ")
  if (starts([0x23, 0x21])) return 'script' // "#!"
  return 'other'
}

/**
 * The resources folder of a packaged app when `dir` lies inside `<res>/app.asar` or `<res>/app.asar.unpacked`, else
 * undefined. Separators of either kind; the segment must match exactly.
 */
export function asarResourcesOf(dir: string, platform: NodeJS.Platform): string | undefined {
  const p = pathFor(platform)
  const parts = p.normalize(dir).split(/[\\/]/)
  const i = parts.findIndex((s) => s === 'app.asar' || s === 'app.asar.unpacked')
  if (i <= 0) return undefined
  const res = parts.slice(0, i).join(p.sep)
  return res || p.sep
}

/** `dir` with an `app.asar` segment (not `app.asar.unpacked`) rewritten to `app.asar.unpacked` (electron-builder asarUnpack). */
export function unpackedAsarPath(dir: string): { path: string; rewritten: boolean } {
  const out = dir.replace(/([\\/])app\.asar(?=[\\/]|$)/, '$1app.asar.unpacked')
  return { path: out, rewritten: out !== dir }
}
