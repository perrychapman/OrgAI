import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, type Stats, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import {
  TEAM_FILES_AGENTS_DIR,
  TEAM_FILES_JSON,
  TEAM_FILES_MAX_ROLES,
  TEAM_FILES_MAX_ROLE_BYTES,
  TEAM_FILES_MAX_JSON_BYTES,
  TEAM_FILES_MAX_TOTAL_BYTES,
  TEAM_FILES_MCP_JSON,
  TEAM_FILES_SKILLS_DIR,
  type TeamFileProblem
} from '@shared/types'
import { FolderReader, safeRelPath } from '../skills/files'
import { isNetworkOrDevicePath } from '../skills/scan'
import type { TeamFile, TeamFilesStamp } from './doc'

/**
 * The team files' file system side. The repository is untrusted: nothing here follows a link (`.orgai` itself, a role file,
 * a skill folder or a file inside one), every read is bounded, the real path must stay inside the project folder, and a
 * per-file refusal becomes a problem naming that path, never an exception. No process, no network.
 */

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'
const ORGAI = '.orgai'
/** Directory entries looked at in one read (a hostile folder cannot cost unbounded work). */
const ENTRIES_MAX = 5000

export interface TeamFolderRead {
  files: TeamFile[]
  readProblems: TeamFileProblem[]
  /** `.orgai/agents` exists (as a folder or a link). */
  agentsDirExists: boolean
  /** `.orgai` is absent or a plain folder inside the project. False: it is a link or not a folder; nothing was read. */
  orgaiOk: boolean
  /** The stamp taken before reading. */
  stamp: TeamFilesStamp
}

const lower = (p: string): string => (CASE_INSENSITIVE ? p.toLowerCase() : p)

/** Text safe to show in a problem: printable ASCII only, cut. */
export function plainName(s: string, max = 80): string {
  const t = s.replace(/[^\x20-\x7e]/g, '?')
  return t.length > max ? `${t.slice(0, max)}...` : t
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

/** Reads a regular file through one descriptor: at most `max` + 1 bytes; null when it is not a regular file or cannot be read. */
function boundedRead(abs: string, max: number): Buffer | null {
  let fd: number | undefined
  try {
    fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const st = fstatSync(fd)
    if (!st.isFile()) return null
    const cap = max + 1
    const buf = Buffer.alloc(Math.min(cap, Math.max(0, st.size) + 1))
    let len = 0
    while (len < buf.length) {
      const n = readSync(fd, buf, len, buf.length - len, len)
      if (n <= 0) break
      len += n
    }
    return Buffer.from(buf.subarray(0, Math.min(len, cap)))
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

/** Real path of the project folder, or null (missing, unreadable, network or device path). */
function realRootOf(projectPath: string): string | null {
  if (typeof projectPath !== 'string' || !projectPath || projectPath.includes('\0') || !isAbsolute(projectPath) || isNetworkOrDevicePath(projectPath)) return null
  try {
    const st = lstatSync(projectPath)
    if (!st.isDirectory() && !st.isSymbolicLink()) return null
    return realpathSync(projectPath)
  } catch {
    return null
  }
}

/** `.orgai` of this project is a plain folder whose real path is `<real project>/.orgai`. */
function plainOrgai(realRoot: string): 'absent' | 'ok' | 'bad' {
  const dir = join(realRoot, ORGAI)
  const st = lstatOrNull(dir)
  if (!st) return 'absent'
  if (st.isSymbolicLink() || !st.isDirectory()) return 'bad'
  try {
    return lower(realpathSync(dir)) === lower(dir) ? 'ok' : 'bad'
  } catch {
    return 'bad'
  }
}

/**
 * A cheap identity of the team files: path, size and mtime of every entry under `.orgai/team.json`, `mcp.json`, `agents`
 * and `skills`, by lstat only (nothing is read). Changes whenever a file is added, removed, resized or touched; '' for a
 * folder that cannot be used.
 */
export function teamFilesStampOf(projectPath: string): TeamFilesStamp {
  const root = realRootOf(projectPath)
  if (!root) return 'unusable'
  const state = plainOrgai(root)
  if (state === 'absent') return 'absent'
  if (state === 'bad') return 'bad'
  const h = createHash('sha256')
  let visited = 0
  const add = (rel: string, st: Stats): void => {
    h.update(`${rel}\0${st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : st.isFile() ? 'f' : 'o'}\0${st.size}\0${Math.round(st.mtimeMs)}\n`)
  }
  const walk = (dir: string, rel: string, depth: number): void => {
    let names: string[]
    try {
      names = readdirSync(dir).sort()
    } catch {
      h.update(`${rel}\0unreadable\n`)
      return
    }
    for (const name of names) {
      if (++visited > ENTRIES_MAX) {
        h.update('more\n')
        return
      }
      const abs = join(dir, name)
      const st = lstatOrNull(abs)
      if (!st) continue
      add(`${rel}/${name}`, st)
      if (st.isDirectory() && !st.isSymbolicLink() && depth < 6) walk(abs, `${rel}/${name}`, depth + 1)
    }
  }
  const base = join(root, ORGAI)
  for (const name of ['team.json', 'mcp.json']) {
    const st = lstatOrNull(join(base, name))
    h.update(`${name}:`)
    if (st) add(name, st)
    else h.update('missing\n')
  }
  for (const dir of ['agents', 'skills']) {
    const abs = join(base, dir)
    const st = lstatOrNull(abs)
    h.update(`${dir}:`)
    if (!st) {
      h.update('missing\n')
      continue
    }
    add(dir, st)
    if (st.isDirectory() && !st.isSymbolicLink()) walk(abs, dir, 0)
  }
  return h.digest('hex')
}

/** Message for a skill folder the reader refused, without any text from the repository. */
function folderMessage(reason: string): string {
  if (/^symlink/.test(reason)) return 'It is, or contains, a link. Links are not followed, so it was not read.'
  if (/larger than|More than/.test(reason)) return 'It is too large to read.'
  if (/nested deeper/.test(reason)) return 'It has folders nested too deeply to read.'
  return 'It could not be read.'
}

/**
 * Reads the team files of a project folder. Confinement: `.orgai` must be a plain folder (absent is fine), no link anywhere,
 * real paths inside the project, bounded reads (the TEAM_FILES_MAX_* caps; the whole team over TEAM_FILES_MAX_TOTAL_BYTES
 * is one problem and nothing is read). A refused file or skill folder is a problem naming its path; the rest is still read.
 */
export function readTeamFolder(projectPath: string): TeamFolderRead {
  const stamp = teamFilesStampOf(projectPath)
  const out: TeamFolderRead = { files: [], readProblems: [], agentsDirExists: false, orgaiOk: true, stamp }
  const problem = (file: string, message: string): void => {
    out.readProblems.push({ file, message })
  }
  const root = realRootOf(projectPath)
  if (!root) {
    out.orgaiOk = false
    problem(ORGAI, 'The project folder cannot be used for team files.')
    return out
  }
  const orgai = plainOrgai(root)
  if (orgai === 'absent') return out
  if (orgai === 'bad') {
    out.orgaiOk = false
    problem(ORGAI, 'The .orgai folder is a link or not a folder, so nothing was read or written.')
    return out
  }
  const base = join(root, ORGAI)
  let total = 0
  let tooBig = false
  const take = (rel: string, abs: string, max: number): void => {
    if (tooBig) return
    const st = lstatOrNull(abs)
    if (!st) return
    if (st.isSymbolicLink()) {
      problem(rel, 'It is a link. Links are not followed, so it was not read.')
      return
    }
    if (!st.isFile()) {
      problem(rel, 'It is not a regular file.')
      return
    }
    const data = boundedRead(abs, max)
    if (!data) {
      problem(rel, 'It could not be read.')
      return
    }
    total += data.length
    if (total > TEAM_FILES_MAX_TOTAL_BYTES) {
      tooBig = true
      return
    }
    out.files.push({ path: rel, data })
  }

  take(TEAM_FILES_JSON, join(base, 'team.json'), TEAM_FILES_MAX_JSON_BYTES)
  take(TEAM_FILES_MCP_JSON, join(base, 'mcp.json'), TEAM_FILES_MAX_JSON_BYTES)

  // agents
  const agents = join(base, 'agents')
  const ast = lstatOrNull(agents)
  if (ast) {
    out.agentsDirExists = true
    if (ast.isSymbolicLink() || !ast.isDirectory()) problem(TEAM_FILES_AGENTS_DIR, 'It is a link or not a folder, so it was not read.')
    else {
      let names: string[] = []
      try {
        names = readdirSync(agents).sort()
      } catch {
        problem(TEAM_FILES_AGENTS_DIR, 'It could not be read.')
      }
      if (names.length > ENTRIES_MAX) {
        problem(TEAM_FILES_AGENTS_DIR, 'It has too many entries to read.')
        names = names.slice(0, ENTRIES_MAX)
      }
      let roleFiles = 0
      for (const name of names) {
        const abs = join(agents, name)
        const st = lstatOrNull(abs)
        if (!st || st.isDirectory()) continue
        // Only role files are counted against the role cap; anything else is read small so parse can note it.
        const isRole = name.endsWith('.md')
        if (isRole && ++roleFiles > TEAM_FILES_MAX_ROLES + 1) continue
        const rel = `${TEAM_FILES_AGENTS_DIR}/${name}`
        // A name with unusual characters cannot be shown or held as a path: it is only read when it is plain.
        if (!/^[\x21-\x7e]+$/.test(name) || name.includes('\\')) {
          if (st.isSymbolicLink()) problem(`${TEAM_FILES_AGENTS_DIR}/${plainName(name, 40)}`, 'It is a link. Links are not followed, so it was not read.')
          continue
        }
        take(rel, abs, TEAM_FILES_MAX_ROLE_BYTES)
      }
    }
  }

  // skills
  const skills = join(base, 'skills')
  const sst = lstatOrNull(skills)
  if (sst) {
    if (sst.isSymbolicLink() || !sst.isDirectory()) problem(TEAM_FILES_SKILLS_DIR, 'It is a link or not a folder, so it was not read.')
    else {
      let names: string[] = []
      try {
        names = readdirSync(skills).sort()
      } catch {
        problem(TEAM_FILES_SKILLS_DIR, 'It could not be read.')
      }
      if (names.length > ENTRIES_MAX) {
        problem(TEAM_FILES_SKILLS_DIR, 'It has too many entries to read.')
        names = names.slice(0, ENTRIES_MAX)
      }
      const reader = new FolderReader(root)
      for (const name of names) {
        if (tooBig) break
        const abs = join(skills, name)
        const st = lstatOrNull(abs)
        if (!st) continue
        const plain = /^[a-z0-9][a-z0-9-]{0,63}$/.test(name)
        const rel = plain ? `${TEAM_FILES_SKILLS_DIR}/${name}` : `${TEAM_FILES_SKILLS_DIR}/${plainName(name, 40)}`
        if (st.isSymbolicLink()) {
          problem(rel, 'It is a link. Links are not followed, so it was not read.')
          continue
        }
        if (st.isFile()) {
          // A loose file: parse notes it and ignores it.
          if (plain || /^[\x21-\x7e]+$/.test(name)) take(`${TEAM_FILES_SKILLS_DIR}/${name}`, abs, TEAM_FILES_MAX_ROLE_BYTES)
          continue
        }
        if (!st.isDirectory()) continue
        const r = reader.read(abs)
        if (!r.ok) {
          problem(rel, folderMessage(r.reason))
          continue
        }
        for (const f of r.files) {
          total += f.data.length
          if (total > TEAM_FILES_MAX_TOTAL_BYTES) {
            tooBig = true
            break
          }
          // A skill name that is not a plain skill name is read so parse reports it (it refuses the folder name).
          if (!safeRelPath(f.path)) continue
          out.files.push({ path: `${TEAM_FILES_SKILLS_DIR}/${name}/${f.path}`, data: f.data })
        }
      }
    }
  }

  if (tooBig) {
    out.files = []
    problem(TEAM_FILES_JSON, `The team files together are larger than ${TEAM_FILES_MAX_TOTAL_BYTES / 1024 / 1024} MB, so nothing was read. The last approved team stays.`)
  }
  return out
}

// ---------- writing ----------

export interface WriteTeamResult {
  /** Folder-relative paths actually written. */
  written: string[]
  /** Folder-relative paths actually removed. */
  removed: string[]
  /** Paths that were asked for but refused (a link, a non-file, a held path or a failure). */
  skipped: string[]
}

const isHeld = (path: string, held: readonly string[]): boolean => held.some((h) => path === h || path.startsWith(`${h}/`) || h.startsWith(`${path}/`))

/** `.orgai/...` paths only, safe segments. */
function safeTeamPath(p: string): boolean {
  return typeof p === 'string' && p.startsWith(`${ORGAI}/`) && safeRelPath(p) && !p.split('/').some((seg) => seg.length > 200)
}

/** Makes sure every folder on the way to `rel`'s parent exists as a plain folder (never through a link). False when one is not. */
function ensureParents(realRoot: string, rel: string): boolean {
  const segs = rel.split('/').slice(0, -1)
  let cur = realRoot
  for (const seg of segs) {
    cur = join(cur, seg)
    const st = lstatOrNull(cur)
    if (!st) {
      try {
        mkdirSync(cur)
      } catch {
        return false
      }
      continue
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return false
  }
  return true
}

/** True when `abs` holds nothing but plain files and folders (no link, device or odd entry) at any depth. */
function plainTree(abs: string, budget = { n: ENTRIES_MAX }): boolean {
  const st = lstatOrNull(abs)
  if (!st) return true
  if (st.isSymbolicLink()) return false
  if (st.isFile()) return true
  if (!st.isDirectory()) return false
  let names: string[]
  try {
    names = readdirSync(abs)
  } catch {
    return false
  }
  for (const name of names) {
    if (--budget.n < 0) return false
    if (!plainTree(join(abs, name), budget)) return false
  }
  return true
}

function writeAtomic(abs: string, data: Buffer): boolean {
  const tmp = `${abs}.${randomBytes(8).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, data, { flag: 'wx' })
    renameSync(tmp, abs)
    return true
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    return false
  }
}

/**
 * Writes and removes team files. Each file is a temp file ('wx', random name) renamed into place after an lstat that
 * refuses a link or a non-file; `held` paths (and anything under them, or a folder holding them) are never touched;
 * only the given paths are removed (a skill folder only when nothing in it is a link). `.orgai` is created only as a plain
 * folder and never through a link. A skill that is written is replaced as a unit: files of its folder that the new content
 * does not contain are removed. Never throws.
 */
export function writeTeamFiles(projectPath: string, write: TeamFile[], remove: string[], held: string[]): WriteTeamResult {
  const result: WriteTeamResult = { written: [], removed: [], skipped: [] }
  const root = realRootOf(projectPath)
  if (!root) {
    result.skipped.push(...write.map((f) => f.path), ...remove)
    return result
  }
  const orgai = plainOrgai(root)
  if (orgai === 'bad') {
    result.skipped.push(...write.map((f) => f.path), ...remove)
    return result
  }
  for (const f of write) {
    if (!safeTeamPath(f.path) || isHeld(f.path, held) || !Buffer.isBuffer(f.data)) {
      result.skipped.push(f.path)
      continue
    }
    if (!ensureParents(root, f.path)) {
      result.skipped.push(f.path)
      continue
    }
    const abs = join(root, ...f.path.split('/'))
    const st = lstatOrNull(abs)
    if (st && (st.isSymbolicLink() || !st.isFile())) {
      result.skipped.push(f.path)
      continue
    }
    if (writeAtomic(abs, f.data)) result.written.push(f.path)
    else result.skipped.push(f.path)
  }
  // Skill folders written as a unit: stray files of the old version go.
  const skillFolders = new Set<string>()
  for (const p of result.written) {
    const m = /^\.orgai\/skills\/([^/]+)\//.exec(p)
    if (m) skillFolders.add(`${TEAM_FILES_SKILLS_DIR}/${m[1]}`)
  }
  for (const folder of skillFolders) {
    if (isHeld(folder, held)) continue
    const keep = new Set(write.map((f) => f.path))
    const abs = join(root, ...folder.split('/'))
    if (!plainTree(abs)) continue
    const strays: string[] = []
    const collect = (dir: string, rel: string): void => {
      for (const name of readdirSync(dir)) {
        const a = join(dir, name)
        const r = `${rel}/${name}`
        const st = lstatOrNull(a)
        if (!st) continue
        if (st.isDirectory()) collect(a, r)
        else if (st.isFile() && !keep.has(r) && !r.endsWith('.tmp')) strays.push(r)
      }
    }
    try {
      collect(abs, folder)
    } catch {
      continue
    }
    for (const r of strays) {
      if (isHeld(r, held)) continue
      try {
        rmSync(join(root, ...r.split('/')), { force: true })
        result.removed.push(r)
      } catch {
        result.skipped.push(r)
      }
    }
  }
  for (const rel of remove) {
    if (!safeTeamPath(rel) || isHeld(rel, held)) {
      result.skipped.push(rel)
      continue
    }
    const abs = join(root, ...rel.split('/'))
    const st = lstatOrNull(abs)
    if (!st) continue
    // Parents must be plain folders: a removal never travels through a link.
    const parentOk = rel.split('/').slice(0, -1).every((_, i, a) => {
      const p = lstatOrNull(join(root, ...a.slice(0, i + 1)))
      return !!p && !p.isSymbolicLink() && p.isDirectory()
    })
    if (!parentOk || st.isSymbolicLink() || !plainTree(abs)) {
      result.skipped.push(rel)
      continue
    }
    try {
      rmSync(abs, { recursive: true, force: true })
      result.removed.push(rel)
    } catch {
      result.skipped.push(rel)
    }
  }
  return result
}

/**
 * Removes the team files of a folder (maintenance "Remove OrgAI files"): team.json, mcp.json, agents and skills. Nothing is
 * followed: a link is unlinked, never entered. Returns the folder-relative names removed (a folder as `.orgai/agents`).
 */
export function removeTeamFolderFiles(projectPath: string): string[] {
  const root = realRootOf(projectPath)
  if (!root || plainOrgai(root) !== 'ok') return []
  const removed: string[] = []
  for (const rel of [TEAM_FILES_JSON, TEAM_FILES_MCP_JSON, TEAM_FILES_AGENTS_DIR, TEAM_FILES_SKILLS_DIR]) {
    const abs = join(root, ...rel.split('/'))
    const st = lstatOrNull(abs)
    if (!st) continue
    try {
      if (st.isSymbolicLink() || st.isFile()) rmSync(abs, { force: true })
      else if (st.isDirectory()) rmSync(abs, { recursive: true, force: true })
      else continue
      removed.push(rel)
    } catch {
      /* leave it */
    }
  }
  return removed
}

/** Removes `.orgai` when nothing but OS litter is left in it. Never follows a link. */
export function removeOrgaiIfEmpty(projectPath: string): boolean {
  const root = realRootOf(projectPath)
  if (!root || plainOrgai(root) !== 'ok') return false
  const dir = join(root, ORGAI)
  try {
    const names = readdirSync(dir).filter((n) => n !== '.DS_Store')
    if (names.length) return false
    rmSync(join(dir, '.DS_Store'), { force: true })
    rmdirSync(dir)
    return true
  } catch {
    return false
  }
}

/** Whether `child` (absolute) lies inside `parent`. */
export function insideFolder(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
