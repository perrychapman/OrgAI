import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  SKILL_BUNDLE_FILE_MAX_BYTES,
  SKILL_BUNDLE_MAX_BYTES,
  SKILL_BUNDLE_MAX_FILES,
  SKILL_BUNDLE_SKILL_MD_MAX_BYTES,
  SKILL_MAX_FILES,
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_TOTAL_BYTES,
  type SkillBundleFile,
  type SkillBundleInput,
  type SkillFileInfo
} from '@shared/types'
import { isSafeId } from '@shared/defaults'
import { inGitDir } from '../setup/import/scan'
import { hiddenCharIn } from '../capabilities/sanitize'

/**
 * Confined skill-folder I/O: reading an untrusted folder (never following links, never entering .git, capped),
 * writing OrgAI's own copies (temp folder then rename) and the content digest. No process, no network.
 */

export interface FileData {
  /** Relative to the skill folder, '/'-separated. */
  path: string
  data: Buffer
}

/** Directory depth below the skill folder that is still read (files directly in the folder are depth 0). */
export const SKILL_MAX_DEPTH = 4
/** Directory entries looked at by one FolderReader (all folders of one scan together). */
export const SKILL_MAX_ENTRIES = 5000

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

function samePath(a: string, b: string): boolean {
  return CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Whether `target` is `base` or lies inside it (lexical, both absolute). */
export function isInside(base: string, target: string): boolean {
  const rel = relative(base, target)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith('..' + sep)
}

/** `base/<id>/<id>...` with every id checked and the result confined under base. Throws on anything else. */
export function childPath(base: string, ...ids: string[]): string {
  for (const id of ids) if (!isSafeId(id)) throw new Error('Invalid id')
  const abs = resolve(base, ...ids)
  if (abs === resolve(base) || !isInside(resolve(base), abs)) throw new Error('Invalid id')
  return abs
}

/** A relative file path that stays inside its folder ('/'-separated, no '..', no drive, no absolute). */
export function safeRelPath(p: string): boolean {
  if (typeof p !== 'string' || !p || p.includes('\\') || p.includes('\0') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

const WIN_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

/**
 * `safeRelPath` plus what a file from outside (a kit) must not name on Windows: reserved device names (CON, NUL,
 * COM1-9, LPT1-9, with or without an extension), ':' in a segment (drive and stream syntax), a trailing dot or space,
 * and the characters Windows forbids in a name.
 */
export function safeKitRelPath(p: string): boolean {
  if (!safeRelPath(p)) return false
  return p.split('/').every((seg) => !seg.includes(':') && !/[. ]$/.test(seg) && !WIN_RESERVED.test(seg) && !/[<>"|?*]/.test(seg))
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

/** sha256 (hex) over the paths and contents of the files, independent of their order. */
export function digestFiles(files: FileData[]): string {
  const h = createHash('sha256')
  for (const f of [...files].sort(byPath)) {
    h.update(`${f.path}\0${f.data.length}\0`)
    h.update(f.data)
  }
  return h.digest('hex')
}

/** SkillFileInfo list, SKILL.md first and the rest by path. */
export function fileInfos(files: FileData[]): SkillFileInfo[] {
  const infos = files.map((f) => ({ path: f.path, bytes: f.data.length }))
  return [...infos.filter((f) => f.path === 'SKILL.md'), ...infos.filter((f) => f.path !== 'SKILL.md').sort(byPath)]
}

const SCRIPT_EXT = new Set(['.sh', '.bash', '.ps1', '.py', '.js', '.mjs', '.cjs', '.ts', '.rb', '.pl', '.bat', '.cmd', '.exe'])

/** Whether a file looks executable: a script extension or a "#!" first line. */
export function looksLikeScript(path: string, data: Buffer): boolean {
  const dot = path.lastIndexOf('.')
  if (dot > path.lastIndexOf('/') && SCRIPT_EXT.has(path.slice(dot).toLowerCase())) return true
  return data.length >= 2 && data[0] === 0x23 && data[1] === 0x21
}

export type FolderRead = { ok: true; files: FileData[]; notes: string[] } | { ok: false; reason: string }

/** Reads regular files through one descriptor: at most the cap + 1 bytes, 'big' over the cap, null when not a file. */
function boundedRead(abs: string): Buffer | 'big' | null {
  let fd: number | undefined
  try {
    fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const st = fstatSync(fd)
    if (!st.isFile()) return null
    if (st.size > SKILL_MAX_FILE_BYTES) return 'big'
    const buf = Buffer.alloc(SKILL_MAX_FILE_BYTES + 1)
    let len = 0
    while (len < buf.length) {
      const n = readSync(fd, buf, len, buf.length - len, len)
      if (n <= 0) break
      len += n
    }
    if (len > SKILL_MAX_FILE_BYTES) return 'big'
    return Buffer.from(buf.subarray(0, len))
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Reads skill folders under one real root. Symlinks and junctions are never followed: a link anywhere in a skill
 * folder makes it invalid with a reason that starts "symlink". Anything in or behind .git is never read.
 */
export class FolderReader {
  private visited = 0
  exhausted = false
  constructor(readonly rootReal: string) {}

  /** Counts one directory entry; false once SKILL_MAX_ENTRIES is exceeded. */
  spend(): boolean {
    if (this.exhausted) return false
    if (++this.visited > SKILL_MAX_ENTRIES) {
      this.exhausted = true
      return false
    }
    return true
  }

  /** Reads `folderAbs` (a path built from rootReal) recursively. Never throws. */
  read(folderAbs: string): FolderRead {
    try {
      let st
      try {
        st = lstatSync(folderAbs)
      } catch {
        return { ok: false, reason: 'The folder could not be read.' }
      }
      if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' }
      if (!st.isDirectory()) return { ok: false, reason: 'Not a folder.' }
      let real: string
      try {
        real = realpathSync(folderAbs)
      } catch {
        return { ok: false, reason: 'The folder could not be read.' }
      }
      if (!samePath(real, folderAbs)) return { ok: false, reason: 'symlink (the path goes through a link)' }
      if (!isInside(this.rootReal, real) || inGitDir(relative(this.rootReal, real))) return { ok: false, reason: 'Outside the project folder or inside .git.' }
      const files: FileData[] = []
      const notes: string[] = []
      let total = 0
      const walk = (dir: string, relDir: string, depth: number): string | null => {
        let names: string[]
        try {
          names = readdirSync(dir)
        } catch {
          return `${relDir || 'The folder'} could not be read.`
        }
        names.sort()
        for (const name of names) {
          if (!this.spend()) return `More than ${SKILL_MAX_ENTRIES} folder entries were looked at; the scan stopped.`
          const rel = relDir ? `${relDir}/${name}` : name
          if (inGitDir(name)) {
            notes.push(`${rel}: git internals skipped`)
            continue
          }
          const abs = join(dir, name)
          let cst
          try {
            cst = lstatSync(abs)
          } catch {
            continue
          }
          if (cst.isSymbolicLink()) return `symlink (${rel})`
          if (cst.isDirectory()) {
            if (depth >= SKILL_MAX_DEPTH) return `Folders nested deeper than ${SKILL_MAX_DEPTH} levels (${rel}).`
            const err = walk(abs, rel, depth + 1)
            if (err) return err
          } else if (cst.isFile()) {
            if (files.length >= SKILL_MAX_FILES) return `More than ${SKILL_MAX_FILES} files.`
            let data
            try {
              data = boundedRead(abs)
            } catch {
              return `${rel} could not be read.`
            }
            if (data === 'big') return `${rel} is larger than ${SKILL_MAX_FILE_BYTES / 1024} KB.`
            if (data === null) return `${rel} is not a regular file.`
            total += data.length
            if (total > SKILL_MAX_TOTAL_BYTES) return `The folder is larger than ${SKILL_MAX_TOTAL_BYTES / 1024 / 1024} MB.`
            files.push({ path: rel, data })
          } else {
            return `${rel} is not a regular file.`
          }
        }
        return null
      }
      const err = walk(folderAbs, '', 0)
      return err ? { ok: false, reason: err } : { ok: true, files, notes }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : 'The folder could not be read.' }
    }
  }
}

/** Reads one of OrgAI's own skill folders (same rules). Throws the reason when it is missing or broken. */
export function readStoredFolder(dir: string): FileData[] {
  let real: string
  try {
    real = realpathSync(dir)
  } catch {
    throw new Error('The skill files are missing.')
  }
  const r = new FolderReader(real).read(real)
  if (!r.ok) throw new Error(`The skill files could not be read: ${r.reason}`)
  return r.files
}

function rand(): string {
  return randomBytes(6).toString('hex')
}

/**
 * Writes `files` as the folder `dest`: into a temp folder beside it, then renamed into place (an existing folder is
 * moved aside first and removed after, restored when the rename fails).
 */
export function writeFolder(dest: string, files: FileData[]): void {
  for (const f of files) if (!safeRelPath(f.path)) throw new Error(`Unsafe file path: ${f.path}`)
  const parent = dirname(dest)
  mkdirSync(parent, { recursive: true })
  const tmp = `${dest}.tmp-${rand()}`
  try {
    mkdirSync(tmp)
    for (const f of files) {
      const abs = resolve(tmp, ...f.path.split('/'))
      if (!isInside(tmp, abs)) throw new Error(`Unsafe file path: ${f.path}`)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, f.data, { flag: 'wx' })
    }
    let aside: string | null = null
    try {
      lstatSync(dest)
      aside = `${dest}.old-${rand()}`
      renameSync(dest, aside)
    } catch {
      aside = null
    }
    try {
      renameSync(tmp, dest)
    } catch (e) {
      if (aside) renameSync(aside, dest)
      throw e
    }
    if (aside) rmSync(aside, { recursive: true, force: true })
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    throw e
  }
}

// ---------- skill bundles (cli-spec 3.6 item 1) ----------

/** Longest relPath a bundle may carry (the kit format's limit). */
export const SKILL_BUNDLE_PATH_MAX = 200
/** Longest bundle name bundleArgs accepts (the folder-name fallback for a SKILL.md without a name). */
const SKILL_BUNDLE_NAME_MAX = 200

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * Rebuilds a skillLibrary:addFromBundle input field by field: a plain object with a string `name` and at most
 * SKILL_BUNDLE_MAX_FILES `{ relPath, base64 }` string pairs. Extra fields are dropped. Throws a readable Error.
 * Content checks (paths, sizes, base64, text) are readBundle's.
 */
export function bundleArgs(input: unknown): SkillBundleInput {
  if (!isPlainObject(input)) throw new Error('The skill bundle is not valid.')
  const name = input.name
  if (typeof name !== 'string' || name.length > SKILL_BUNDLE_NAME_MAX) throw new Error('The skill bundle needs a name.')
  const raw = input.files
  if (!Array.isArray(raw)) throw new Error('The skill bundle has no files.')
  if (raw.length > SKILL_BUNDLE_MAX_FILES) throw new Error(`The skill bundle has more than ${SKILL_BUNDLE_MAX_FILES} files.`)
  const files: SkillBundleFile[] = []
  for (const f of raw) {
    if (!isPlainObject(f) || typeof f.relPath !== 'string' || typeof f.base64 !== 'string') throw new Error('A file of the skill bundle is not valid.')
    files.push({ relPath: f.relPath, base64: f.base64 })
  }
  return { name, files }
}

const STRICT_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** The longest base64 string that can decode to at most `maxBytes` (4 chars carry 3 bytes). */
export function base64MaxChars(maxBytes: number): number {
  return Math.ceil(maxBytes / 3) * 4
}

/**
 * Strictly decoded base64, or null: the alphabet and padding regex, length % 4 == 0, the length bounded by
 * `maxBytes` before anything is decoded, and a canonical encoding (Node silently ignores stray trailing bits).
 */
export function strictBase64(s: unknown, maxBytes: number): Buffer | null {
  if (typeof s !== 'string' || s.length % 4 !== 0 || s.length > base64MaxChars(maxBytes)) return null
  if (!STRICT_BASE64.test(s)) return null
  const data = Buffer.from(s, 'base64')
  if (data.length > maxBytes || data.toString('base64') !== s) return null
  return data
}

/**
 * Why a bundle relPath is refused, or null. `safeKitRelPath` (no '..', '.' or empty segments; no absolute, drive or
 * backslash paths; no ':' so no drive or alternate data stream syntax; no Windows reserved device names CON, PRN, AUX,
 * NUL, COM1-9, LPT1-9 with any extension in any segment, case-insensitive; no trailing dot or space; none of <>"|?*)
 * plus control and hidden characters, UNC / device prefixes, git internals and the SKILL_MAX_DEPTH cap.
 */
export function bundlePathProblem(p: unknown): string | null {
  if (typeof p !== 'string' || !p || p.length > SKILL_BUNDLE_PATH_MAX) return 'The file path is empty or too long.'
  if (/^[\\/]{2}/.test(p)) return 'Network and device paths are not allowed.'
  if (hiddenCharIn(p)) return 'The file path contains a control or hidden character.'
  if (!safeKitRelPath(p)) return 'The file path is not allowed.'
  if (inGitDir(p)) return 'Git internals are not allowed.'
  if (p.split('/').length - 1 > SKILL_MAX_DEPTH) return `Folders nested deeper than ${SKILL_MAX_DEPTH} levels.`
  return null
}

function pathLabel(p: unknown): string {
  if (typeof p !== 'string') return 'not a string'
  return JSON.stringify(p.replace(/[^\x20-\x7e]/g, '?').slice(0, 60))
}

export type BundleRead = { ok: true; files: FileData[]; notes: string[] } | { ok: false; reason: string }

/**
 * Decodes and validates a skill bundle with the rules FolderReader applies to a picked folder, plus cli-spec 3.6(1).
 * Differences from FolderReader, on purpose:
 *  - caps: SKILL.md at most SKILL_BUNDLE_SKILL_MD_MAX_BYTES (256 KB) and every other file at most
 *    SKILL_BUNDLE_FILE_MAX_BYTES (64 KB); FolderReader allows SKILL_MAX_FILE_BYTES (256 KB) for every file. 50 files
 *    and 1 MB in all are the same numbers as SKILL_MAX_FILES / SKILL_MAX_TOTAL_BYTES;
 *  - binary refusal: a file with a NUL byte or invalid UTF-8 is refused. FolderReader copies binaries; the kit format
 *    refuses them the same way as here (skillToKit / parseSkill);
 *  - git internals are refused (FolderReader skips them with a note), case-insensitive duplicate paths are refused
 *    (a folder cannot hold them on Windows / macOS), and a bundle has no links to follow;
 *  - SKILL.md must be at the root (FolderReader's caller, buildScannedSkill, requires the same).
 * Pure; never throws.
 */
export function readBundle(input: SkillBundleInput): BundleRead {
  try {
    const list = input?.files
    if (!Array.isArray(list) || list.length === 0) return { ok: false, reason: 'The skill bundle has no files.' }
    if (list.length > SKILL_BUNDLE_MAX_FILES) return { ok: false, reason: `More than ${SKILL_BUNDLE_MAX_FILES} files.` }
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const seen = new Set<string>()
    const files: FileData[] = []
    let total = 0
    for (const f of list) {
      const rel = f?.relPath
      const problem = bundlePathProblem(rel)
      if (problem) return { ok: false, reason: `${problem} (${pathLabel(rel)})` }
      const key = rel.toLowerCase()
      if (seen.has(key)) return { ok: false, reason: `Two files have the same path (${pathLabel(rel)}).` }
      seen.add(key)
      const cap = rel === 'SKILL.md' ? SKILL_BUNDLE_SKILL_MD_MAX_BYTES : SKILL_BUNDLE_FILE_MAX_BYTES
      const b64: unknown = f?.base64
      if (typeof b64 !== 'string') return { ok: false, reason: `${rel} is not valid base64.` }
      // Bounded by length before decoding: a string that would decode past the cap is refused as too large.
      if (b64.length > base64MaxChars(cap)) return { ok: false, reason: `${rel} is larger than ${cap / 1024} KB.` }
      // The length bound above leaves up to 2 bytes of slack; those are reported as too large, not as bad base64.
      const data = strictBase64(b64, cap + 2)
      if (!data) return { ok: false, reason: `${rel} is not valid base64.` }
      if (data.length > cap) return { ok: false, reason: `${rel} is larger than ${cap / 1024} KB.` }
      total += data.length
      if (total > SKILL_BUNDLE_MAX_BYTES) return { ok: false, reason: `The skill is larger than ${SKILL_BUNDLE_MAX_BYTES / 1024 / 1024} MB.` }
      let text = true
      if (data.includes(0)) text = false
      else {
        try {
          decoder.decode(data)
        } catch {
          text = false
        }
      }
      if (!text) return { ok: false, reason: `${rel} is not a text file; bundles carry text files only.` }
      files.push({ path: rel, data })
    }
    if (!files.some((f) => f.path === 'SKILL.md')) return { ok: false, reason: 'There is no SKILL.md at the root of the bundle.' }
    return { ok: true, files, notes: [] }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'The skill bundle could not be read.' }
  }
}

/** Delete a folder and everything in it (links are removed, never followed). */
export function removeFolder(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}
