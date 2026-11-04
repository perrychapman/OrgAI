import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { SKILL_MAX_FILES, SKILL_MAX_FILE_BYTES, SKILL_MAX_TOTAL_BYTES, type SkillFileInfo } from '@shared/types'
import { isSafeId } from '@shared/defaults'
import { inGitDir } from '../setup/import/scan'

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

/** Delete a folder and everything in it (links are removed, never followed). */
export function removeFolder(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}
