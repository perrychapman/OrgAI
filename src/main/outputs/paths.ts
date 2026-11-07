import { type Stats, chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { OutputProduceKind } from '@shared/types'
import { OUTPUTS_DIR_NAME, OUTPUT_FILE_MAX_BYTES, OUTPUT_PATH_MAX_CHARS, OUTPUT_PRODUCE_EXTENSIONS } from '@shared/types'
import { hiddenCharIn } from '../capabilities/sanitize'
import { canonicalDeep, isInsideEither, isNetworkPath, pathKey, samePath } from '../quick/scratch'

/**
 * Every path rule of the outputs module (types.ts "Run outputs"). Produced files go to `<project>/outputs/<fileName>`
 * through links-free folder creation and an exclusive create; registered files are lstat-checked regular files whose
 * real path is inside the project or an allowed folder. Refusals throw Error(one plain sentence).
 */

export interface PathScope {
  projectPath: string
  allowedDirectories: readonly string[]
  referenceDirectories: readonly string[]
}

const RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)$/i

/**
 * Extensions OrgAI hands to the OS default handler (outputs:open). Anything else (.lnk, .bat, .hta, .js, .url, .exe,
 * .msi, .scr, .cpl, .docm ...) can only be revealed or saved, never launched. Checked on the REAL file's extension.
 * Residual risk (review L7): the checks are made before the OS acts, so an attacker who can swap a folder for a
 * junction between check and use needs shell access in the project already; agent-written files carry no
 * Mark-of-the-Web, which is why this list exists.
 */
export const OPENABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  'docx', 'xlsx', 'pptx', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'md', 'markdown', 'txt', 'csv', 'json', 'mmd', 'mermaid'
])
// svg is deliberately absent (review N1): the OS handler (Edge on Windows) runs embedded script from file://, and an
// agent can rewrite the file after produce checked it. The in-app preview re-runs svgProblem and stays.

export const NOT_OPENABLE_MESSAGE = 'OrgAI does not open this kind of file. Use Show in folder instead.'

/** True when the file's final extension (case-insensitive) is on OPENABLE_EXTENSIONS. No extension, or a trailing dot or space, is not. */
export function isOpenablePath(file: string): boolean {
  const m = /\.([A-Za-z0-9]+)$/.exec(basename(file))
  return !!m && OPENABLE_EXTENSIONS.has(m[1].toLowerCase())
}
const BAD_CHARS = /[<>:"|?*]/

/** A safe file name slug from a title: ASCII-folded, at most 80 chars, fallback "output". */
export function slugFromTitle(title: string): string {
  const folded = title.normalize('NFKD').replace(/[̀-ͯ]/g, '')
  const slug = folded
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
  return slug || 'output'
}

/** Split a produced fileName into checked segments; throws on anything unsafe. */
export function checkFileNameSegments(fileName: string): string[] {
  if (typeof fileName !== 'string' || !fileName.trim()) throw new Error('The file name is empty.')
  if (fileName.length > OUTPUT_PATH_MAX_CHARS) throw new Error(`The file name is longer than ${OUTPUT_PATH_MAX_CHARS} characters.`)
  const hidden = hiddenCharIn(fileName)
  if (hidden) throw new Error(`The file name contains a hidden character (${hidden}).`)
  if (/^[\\/]/.test(fileName)) throw new Error('The file name must be relative to the outputs folder (no absolute, UNC or device paths).')
  if (/^[A-Za-z]:/.test(fileName)) throw new Error('The file name must be relative to the outputs folder (no drive letters).')
  const segs = fileName.split(/[\\/]/)
  for (const s of segs) {
    if (s === '') throw new Error('The file name has an empty folder name.')
    if (s === '.' || s === '..') throw new Error('The file name may not contain "." or ".." parts.')
    if (s.toLowerCase() === '.git') throw new Error('The file name may not use a ".git" folder.')
    if (BAD_CHARS.test(s)) throw new Error('The file name may not contain < > : " | ? or *.')
    if (/[. ]$/.test(s)) throw new Error('A file or folder name may not end in a dot or a space.')
    const stem = s.includes('.') ? s.slice(0, s.indexOf('.')) : s
    if (RESERVED.test(stem.trim())) throw new Error(`"${s}" is a reserved device name.`)
  }
  return segs
}

/** Force the kind's extension: replace a different extension, keep a matching one (case-insensitive). */
export function withKindExtension(leaf: string, kind: OutputProduceKind): string {
  const ext = OUTPUT_PRODUCE_EXTENSIONS[kind]
  const m = /\.([A-Za-z0-9]+)$/.exec(leaf)
  if (m && m[1].toLowerCase() === ext) return leaf
  const stem = m && m.index > 0 ? leaf.slice(0, m.index) : leaf
  return `${stem}.${ext}`
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

/** The folders no output may be written to or registered from. */
function forbiddenRoots(scope: PathScope, dataDir: string): string[] {
  return [dataDir, ...scope.referenceDirectories].filter((d) => typeof d === 'string' && d.length > 0)
}

function checkNotForbidden(p: string, scope: PathScope, dataDir: string): void {
  if (isInsideEither(dataDir, p)) throw new Error("That path is inside OrgAI's data folder; outputs are not kept there.")
  for (const r of scope.referenceDirectories) {
    if (r && isInsideEither(r, p)) throw new Error('That path is inside a reference folder; reference folders are read only.')
  }
}

function checkProjectDir(projectPath: string): string {
  const st = lstatOrNull(projectPath)
  if (!st || !st.isDirectory()) throw new Error("The project folder does not exist, so nothing can be written there.")
  return projectPath
}

/** True when a `.git` segment lies between `root` and `real` (or `real` is under a .git of its own root). */
function hasGitSegment(root: string, real: string): boolean {
  const rel = relative(pathKey(root), pathKey(real))
  return rel.split(/[\\/]/).some((s) => s.toLowerCase() === '.git')
}

export interface ProducedTarget {
  /** Absolute file path to create. */
  file: string
  /** The folder holding it (already created, links-free). */
  dir: string
  /** The name chosen (differs from the request when suffixed). */
  fileName: string
  /** True when the target is an existing indexed file the caller will replace (a new version of it). */
  overwrite: boolean
  /** True when " (n)" was added because the file existed. */
  renamed: boolean
}

/** Create each missing component under projectPath with plain mkdir, refusing links on the way. */
function ensureLinkFreeDir(projectPath: string, segments: string[]): string {
  let cur = projectPath
  for (const seg of segments) {
    cur = join(cur, seg)
    const st = lstatOrNull(cur)
    if (st) {
      if (st.isSymbolicLink()) throw new Error(`${seg} is a link; outputs are not written through links.`)
      if (!st.isDirectory()) throw new Error(`${seg} exists and is not a folder.`)
    } else {
      try {
        mkdirSync(cur)
      } catch (e) {
        const again = lstatOrNull(cur)
        if (!again || again.isSymbolicLink() || !again.isDirectory()) throw new Error(`Could not create the folder ${seg}: ${(e as Error).message}`)
      }
    }
  }
  return cur
}

export interface ResolveProducedInput {
  scope: PathScope
  dataDir: string
  kind: OutputProduceKind
  title: string
  fileName?: string
  /** Identity rule: true when the path (logical spelling) is an indexed output of this project, from any run. */
  known: (absPath: string) => boolean
  /** Always take the " (n)" suffix route for an existing file, even an indexed one. */
  separate?: boolean
}

/** Resolve (and create the folders of) the produced target. Throws a plain sentence on any refusal. */
export function resolveProducedTarget(i: ResolveProducedInput): ProducedTarget {
  const project = checkProjectDir(i.scope.projectPath)
  const requested = i.fileName !== undefined && i.fileName !== '' ? i.fileName : slugFromTitle(i.title)
  const segs = checkFileNameSegments(requested)
  const leaf = withKindExtension(segs[segs.length - 1], i.kind)
  if (RESERVED.test(leaf.slice(0, leaf.indexOf('.')))) throw new Error(`"${leaf}" is a reserved device name.`)
  const folders = [OUTPUTS_DIR_NAME, ...segs.slice(0, -1)]
  const logical = join(project, ...folders, leaf)
  if (logical.length > OUTPUT_PATH_MAX_CHARS + project.length) throw new Error('The file path is too long.')
  // Refuse before creating anything when the logical target is in a forbidden folder.
  checkNotForbidden(join(project, ...folders), i.scope, i.dataDir)
  const dir = ensureLinkFreeDir(project, folders)
  let realDir: string
  try {
    realDir = realpathSync.native(dir)
  } catch (e) {
    throw new Error(`Could not resolve the outputs folder: ${(e as Error).message}`)
  }
  let realProject: string
  try {
    realProject = realpathSync.native(project)
  } catch {
    realProject = project
  }
  if (!isInsideEither(realProject, realDir)) throw new Error('The outputs folder resolves outside the project folder; nothing was written.')
  checkNotForbidden(realDir, i.scope, i.dataDir)

  const stem = leaf.slice(0, leaf.lastIndexOf('.'))
  const ext = leaf.slice(leaf.lastIndexOf('.'))
  const first = join(dir, leaf)
  const firstSt = lstatOrNull(first)
  if (!firstSt) return { file: first, dir, fileName: leaf, overwrite: false, renamed: false }
  if (!i.separate && firstSt.isFile() && !firstSt.isSymbolicLink() && i.known(first)) {
    return { file: first, dir, fileName: leaf, overwrite: true, renamed: false }
  }
  for (let n = 2; n <= 999; n++) {
    const name = `${stem} (${n})${ext}`
    const f = join(dir, name)
    if (!lstatOrNull(f)) return { file: f, dir, fileName: name, overwrite: false, renamed: true }
  }
  throw new Error('Too many files with that name already exist in the outputs folder; choose another file name.')
}

/** Write a produced file: exclusive create, or temp + rename over a regular file. Returns bytes written. */
export function writeProduced(t: ProducedTarget, data: Buffer): number {
  if (!t.overwrite) {
    let fd: number | undefined
    try {
      fd = openSync(t.file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644)
      writeFileSync(fd, data)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('A file with that name appeared while writing; try again.')
      throw new Error(`Could not write the file: ${(e as Error).message}`)
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    return data.length
  }
  writeFileAtomic(t.file, data)
  return data.length
}

/**
 * Replace (or create) a regular file through a temp file in the same folder and a rename. Refuses a link or a
 * non-file at the target, and never writes through one. Throws a plain sentence.
 */
export function writeFileAtomic(file: string, data: Buffer): void {
  const st = lstatOrNull(file)
  if (st && (!st.isFile() || st.isSymbolicLink())) throw new Error('The file to write is no longer a regular file.')
  if (st && st.nlink > 1) throw new Error(HARDLINK_MESSAGE)
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, data, { flag: 'wx' })
    // Keep the old file's permissions (a replace must not widen or narrow them); POSIX only.
    if (st && process.platform !== 'win32') chmodSync(tmp, st.mode & 0o7777)
    const again = lstatOrNull(file)
    if (again && (!again.isFile() || again.isSymbolicLink())) throw new Error('The file to write is no longer a regular file.')
    if (again && again.nlink > 1) throw new Error(HARDLINK_MESSAGE)
    renameSync(tmp, file)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e instanceof Error ? e : new Error(String(e))
  }
}

export interface CheckedFile {
  /** The real path. */
  path: string
  relPath: string
  bytes: number
  /** Identity from the lstat the check made; pass it to readRegularCapped so a swapped file is refused. */
  dev: number
  ino: number
}

const HARDLINK_MESSAGE = 'That file has more than one hard link, so it may be the same file as one elsewhere; OrgAI does not use it.'

/**
 * Read a regular file through ONE descriptor: opened with O_NOFOLLOW and O_NONBLOCK where the platform has them (a FIFO
 * or device swapped in after a check then cannot block the main thread), fstat-ed (regular file, size <= cap, one hard
 * link, and the same dev/ino as the earlier lstat when `expect` is given), then read for at most `cap` bytes. Throws a
 * plain sentence.
 */
export function readRegularCapped(file: string, cap: number, expect?: { dev: number; ino: number }): Buffer {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  let fd: number
  try {
    fd = openSync(file, flags)
  } catch (e) {
    throw new Error(`Could not read the file: ${(e as Error).message}`)
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new Error('That path is not a regular file.')
    if (st.nlink > 1) throw new Error(HARDLINK_MESSAGE)
    if (st.size > cap) throw new Error(`That file is larger than ${Math.round(cap / 1024 / 1024)} MB.`)
    if (expect && (st.dev !== expect.dev || st.ino !== expect.ino)) throw new Error('That file changed while OrgAI was reading it.')
    const buf = Buffer.alloc(st.size)
    let got = 0
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got)
      if (n <= 0) break
      got += n
    }
    return got === buf.length ? buf : buf.subarray(0, got)
  } finally {
    closeSync(fd)
  }
}

/** relPath: relative to the project with forward slashes when inside it, else the absolute real path. */
export function relPathFor(projectPath: string, real: string): string {
  if (isInsideEither(projectPath, real)) {
    for (const root of [resolve(projectPath), canonicalDeep(projectPath)]) {
      const rel = relative(root, real)
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/')
    }
  }
  return real
}

/** The rules for a registered (or re-checked) path. Throws a plain sentence. */
export function checkRegisteredPath(raw: unknown, scope: PathScope, dataDir: string, opts: { strictNames?: boolean } = {}): CheckedFile {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('The path is empty.')
  if (raw.length > OUTPUT_PATH_MAX_CHARS) throw new Error(`The path is longer than ${OUTPUT_PATH_MAX_CHARS} characters.`)
  const hidden = hiddenCharIn(raw)
  if (hidden) throw new Error(`The path contains a hidden character (${hidden}).`)
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(scope.projectPath, raw)
  if (isNetworkPath(raw) || isNetworkPath(abs)) throw new Error('Network and device paths are not accepted.')
  // NTFS alternate data streams (a.txt:x.exe): no ':' after the drive prefix on win32.
  if (process.platform === 'win32' && abs.replace(/^[A-Za-z]:/, '').includes(':')) throw new Error('A path with ":" after the drive letter (an alternate data stream) is not accepted.')
  // Containment first, on the lexical path and on the real path of the nearest existing ancestor, so a refusal for a
  // path outside the scope never says whether the file exists, is a link, or how big it is.
  const roots = [scope.projectPath, ...scope.allowedDirectories].filter((r) => typeof r === 'string' && r.length > 0)
  let canon = abs
  try {
    canon = canonicalDeep(abs)
  } catch {
    throw new Error('OrgAI could not check that path against the project folder.')
  }
  if (isNetworkPath(canon)) throw new Error('Network and device paths are not accepted.')
  const lexRoot = roots.find((r) => isInsideEither(r, abs) && isInsideEither(r, canon))
  if (!lexRoot) throw new Error('That file is outside the project folder and its allowed folders.')
  checkNotForbidden(abs, scope, dataDir)
  checkNotForbidden(canon, scope, dataDir)
  if (hasGitSegment(lexRoot, abs)) throw new Error('Files under .git are not accepted.')
  if (opts.strictNames) {
    const rel = relative(pathKey(lexRoot), pathKey(abs))
    const hiddenName = rel.split(/[\\/]/).find((s) => s.startsWith('.') && s !== '.' && s !== '..')
    if (hiddenName) throw new Error(`Files and folders whose name starts with a dot (${hiddenName}) hold settings or secrets and are not accepted as outputs. Copy the content to a normal file name first.`)
  }
  const st = lstatOrNull(abs)
  if (!st) throw new Error('That file does not exist.')
  if (st.isSymbolicLink()) throw new Error('That path is a link; outputs are not registered through links.')
  if (!st.isFile()) throw new Error('That path is not a regular file.')
  if (st.nlink > 1) throw new Error(HARDLINK_MESSAGE)
  if (st.size > OUTPUT_FILE_MAX_BYTES) throw new Error(`That file is larger than ${Math.round(OUTPUT_FILE_MAX_BYTES / 1024 / 1024)} MB.`)
  let real: string
  try {
    real = realpathSync.native(abs)
  } catch (e) {
    throw new Error(`Could not resolve that path: ${(e as Error).message}`)
  }
  if (isNetworkPath(real)) throw new Error('Network and device paths are not accepted.')
  // Any link along the way must resolve inside an accepted root (checked below on the real path).
  const root = roots.find((r) => isInsideEither(r, real))
  if (!root) throw new Error('That file is outside the project folder and its allowed folders.')
  checkNotForbidden(real, scope, dataDir)
  let realRoot = root
  try {
    realRoot = realpathSync.native(root)
  } catch {
    /* keep */
  }
  if (hasGitSegment(realRoot, real) || hasGitSegment(root, real)) throw new Error('Files under .git are not accepted.')
  return { path: real, relPath: relPathFor(scope.projectPath, real), bytes: st.size, dev: st.dev, ino: st.ino }
}

/** True when `a` and `b` are the same file path (case-folded where the platform folds). */
export function sameFile(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b) || samePath(a, b)
}

/**
 * The path delete may trash or unlink: the stored path re-checked with the register rules (regular file, no link, real
 * path inside the project or an allowed folder, not a reference folder, data folder or .git) whose real path must still
 * be the stored one. Returns null when the file is already gone. Throws a plain sentence otherwise.
 */
export function checkDeletableFile(stored: string, scope: PathScope, dataDir: string): string | null {
  const st = lstatOrNull(stored)
  if (!st) return null
  if (st.isSymbolicLink()) throw new Error('That file is a link; OrgAI does not delete through links.')
  if (!st.isFile()) throw new Error('That path is not a regular file.')
  const checked = checkRegisteredPath(stored, scope, dataDir)
  if (!sameFile(checked.path, stored)) throw new Error('That file is no longer where the list says it is; nothing was deleted.')
  return checked.path
}

/**
 * The path an output's file may be written to (saveEdit, restore): the stored path re-checked by the register rules
 * when the file exists (its real path must still be the stored one), or, for a file that vanished, a plain folder
 * (no link) whose real path is inside the project or an allowed folder, not a reference folder, the data folder or
 * .git, spelled the same as the stored path. Returns the real path. Throws a plain sentence.
 */
export function checkWritablePath(stored: string, scope: PathScope, dataDir: string): string {
  if (lstatOrNull(stored)) {
    const c = checkRegisteredPath(stored, scope, dataDir)
    if (!sameFile(c.path, stored)) throw new Error('That file is no longer where the list says it is.')
    return c.path
  }
  const parent = dirname(stored)
  const pst = lstatOrNull(parent)
  if (!pst || pst.isSymbolicLink() || !pst.isDirectory()) throw new Error('The folder that held this file is gone or is a link.')
  let realParent: string
  try {
    realParent = realpathSync.native(parent)
  } catch (e) {
    throw new Error(`Could not resolve the folder: ${(e as Error).message}`)
  }
  if (isNetworkPath(realParent)) throw new Error('Network and device paths are not accepted.')
  const roots = [scope.projectPath, ...scope.allowedDirectories].filter((r) => typeof r === 'string' && r.length > 0)
  const root = roots.find((r) => isInsideEither(r, realParent))
  if (!root) throw new Error('That file is outside the project folder and its allowed folders.')
  checkNotForbidden(realParent, scope, dataDir)
  if (hasGitSegment(root, realParent)) throw new Error('Files under .git are not accepted.')
  const real = join(realParent, basename(stored))
  if (!sameFile(real, stored)) throw new Error('That file is no longer where the list says it is.')
  return real
}
