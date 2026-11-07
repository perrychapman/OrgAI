import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
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

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
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

function lstatOrNull(p: string): ReturnType<typeof lstatSync> | null {
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
  return rel.split(/[\\/]/).some((s) => s === '.git')
}

export interface ProducedTarget {
  /** Absolute file path to create. */
  file: string
  /** The folder holding it (already created, links-free). */
  dir: string
  /** The name chosen (differs from the request when suffixed). */
  fileName: string
  /** True when an existing file is to be replaced (overwrite allowed). */
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
  overwrite?: boolean
  /** True when the store's entry for the exact path is source 'produced' with the caller's run id. */
  mayOverwrite: (absPath: string) => boolean
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
  if (i.overwrite && firstSt.isFile() && !firstSt.isSymbolicLink() && i.mayOverwrite(first)) {
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
  const st = lstatOrNull(t.file)
  if (!st || !st.isFile() || st.isSymbolicLink()) throw new Error('The file to overwrite is no longer a regular file.')
  const tmp = join(t.dir, `.${basename(t.file)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, data, { flag: 'wx' })
    const again = lstatOrNull(t.file)
    if (!again || !again.isFile() || again.isSymbolicLink()) throw new Error('The file to overwrite is no longer a regular file.')
    renameSync(tmp, t.file)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e instanceof Error ? e : new Error(String(e))
  }
  return data.length
}

export interface CheckedFile {
  /** The real path. */
  path: string
  relPath: string
  bytes: number
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
export function checkRegisteredPath(raw: unknown, scope: PathScope, dataDir: string): CheckedFile {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('The path is empty.')
  if (raw.length > OUTPUT_PATH_MAX_CHARS) throw new Error(`The path is longer than ${OUTPUT_PATH_MAX_CHARS} characters.`)
  const hidden = hiddenCharIn(raw)
  if (hidden) throw new Error(`The path contains a hidden character (${hidden}).`)
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(scope.projectPath, raw)
  if (isNetworkPath(raw) || isNetworkPath(abs)) throw new Error('Network and device paths are not accepted.')
  const st = lstatOrNull(abs)
  if (!st) throw new Error('That file does not exist.')
  if (st.isSymbolicLink()) throw new Error('That path is a link; outputs are not registered through links.')
  if (!st.isFile()) throw new Error('That path is not a regular file.')
  if (st.size > OUTPUT_FILE_MAX_BYTES) throw new Error(`That file is larger than ${Math.round(OUTPUT_FILE_MAX_BYTES / 1024 / 1024)} MB.`)
  let real: string
  try {
    real = realpathSync.native(abs)
  } catch (e) {
    throw new Error(`Could not resolve that path: ${(e as Error).message}`)
  }
  if (isNetworkPath(real)) throw new Error('Network and device paths are not accepted.')
  // Any link along the way must resolve inside an accepted root (checked below on the real path).
  const roots = [scope.projectPath, ...scope.allowedDirectories].filter((r) => typeof r === 'string' && r.length > 0)
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
  return { path: real, relPath: relPathFor(scope.projectPath, real), bytes: st.size }
}

/** True when `a` and `b` are the same file path (case-folded where the platform folds). */
export function sameFile(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b) || samePath(a, b)
}

/**
 * The path delete may unlink: the stored path's real path must be a regular file inside `<projectPath>/outputs/`.
 * Returns null when the file is already gone. Throws a plain sentence otherwise.
 */
export function checkDeletablePath(stored: string, scope: PathScope): string | null {
  const st = lstatOrNull(stored)
  if (!st) return null
  if (st.isSymbolicLink()) throw new Error('That file is a link; OrgAI does not delete through links.')
  if (!st.isFile()) throw new Error('That path is not a regular file.')
  const outputsDir = join(scope.projectPath, OUTPUTS_DIR_NAME)
  let realDir: string
  let real: string
  try {
    if (!existsSync(outputsDir)) throw new Error('missing')
    realDir = realpathSync.native(outputsDir)
    real = realpathSync.native(stored)
  } catch {
    throw new Error("Only files in the project's outputs folder can be deleted; this one is elsewhere.")
  }
  if (!isInsideEither(realDir, real) || pathKey(realDir) === pathKey(real) || !isInsideEither(scope.projectPath, realDir)) {
    throw new Error("Only files in the project's outputs folder can be deleted; this one is elsewhere.")
  }
  // The folder itself must not be a link out of the project.
  const dst = lstatOrNull(outputsDir)
  if (!dst || dst.isSymbolicLink()) throw new Error('The outputs folder is a link; OrgAI does not delete through links.')
  return real
}
