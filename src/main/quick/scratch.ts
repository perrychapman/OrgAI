import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type { RunSummary } from '@shared/types'
import { newId } from '@shared/defaults'

/**
 * Scratch directories for runs without a folder of their own: Chat runs with no folder (QuickRunInfo.scratch) and
 * MCP assistant sessions started with allowBuild (RunSummary.buildWorkspace). Every one lives directly under
 * `<data>/quick/`, is named `quick_<id>` (its own newId, not a run id: continuations reuse the dir), and is removed
 * only when no run record points to it. Nothing outside `<data>/quick` is ever removed.
 */

/** The only names a scratch dir can have: newId('quick') output. */
const SCRATCH_NAME = /^quick_[a-z0-9]+$/

/** `<data>/quick`. */
export function scratchRoot(dataDir: string): string {
  return join(dataDir, 'quick')
}

const win = (): boolean => process.platform === 'win32'

/**
 * A path as a comparison key: resolved, trailing separators dropped, case-folded on Windows. A root keeps its
 * separator (`C:\`, `/`): stripped it would be `c:` / '' and `relative` would resolve that against the cwd, so a
 * drive root would no longer contain the data dir (M3 fail-open).
 */
export function pathKey(p: string): string {
  const r = resolve(p)
  const root = parse(r).root
  const k = r.length > root.length ? r.replace(/[\\/]+$/, '') : root
  return win() ? k.toLowerCase() : k
}

/** True when `child` is `parent` or inside it (lexical, after resolve). */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(pathKey(parent), pathKey(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** The path as the file system spells it; the input when it cannot be resolved. */
function canonical(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

/**
 * True for a path that may reach the network when touched: on win32 anything starting with two separators (UNC,
 * `\\?\UNC\`, `\\.\`), on darwin the automount prefixes `/net/` and `/Network/`. Such a path is never handed to the
 * file system (an SMB connection would leak NTLM credentials before any approval).
 */
export function isNetworkPath(p: string): boolean {
  if (process.platform === 'win32') return /^[\\/]{2}/.test(p)
  if (process.platform === 'darwin') return /^\/(?:net|network)(?:\/|$)/i.test(p)
  return false
}

/**
 * The path as the file system would spell it even when it does not exist yet: the real path of the nearest existing
 * ancestor with the rest re-appended (macOS `/var/...` becomes `/private/var/...` for a not-yet-created data dir).
 * The resolved input when no ancestor can be resolved.
 */
export function canonicalDeep(p: string): string {
  let probe = resolve(p)
  if (isNetworkPath(probe)) return probe

  const rest: string[] = []
  for (let i = 0; i < 256; i++) {
    if (existsSync(probe)) break
    const parent = resolve(probe, '..')
    if (parent === probe) break
    rest.unshift(basename(probe))
    probe = parent
  }
  return rest.length ? join(canonical(probe), ...rest) : canonical(probe)
}

/** The lexical and the canonical spelling of a path (one entry when they agree). */
function spellings(p: string): string[] {
  const a = resolve(p)
  const b = canonicalDeep(p)
  return pathKey(a) === pathKey(b) ? [a] : [a, b]
}

/**
 * True when `child` is `parent` or inside it, comparing every lexical / canonical spelling of both sides (so a path
 * behind a link such as macOS `/var` -> `/private/var` matches either way).
 */
export function isInsideEither(parent: string, child: string): boolean {
  const children = spellings(child)
  return spellings(parent).some((pa) => children.some((c) => isInside(pa, c)))
}

/** True when `a` and `b` name the same place, lexically or through their canonical spellings. */
export function samePath(a: string, b: string): boolean {
  const keys = new Set(spellings(a).map(pathKey))
  return spellings(b).some((s) => keys.has(pathKey(s)))
}

/**
 * Create a fresh scratch dir `<data>/quick/<newId('quick')>` (mode 0o700; Windows ignores the mode) and return its
 * canonical absolute path (what the run works in and its record stores). That spelling may differ from
 * `scratchRoot(dataDir)` (macOS /var -> /private/var, Windows 8.3 short names), so compare it with `isInsideEither`,
 * `scratchDirFor` or `isReferencedScratch`, never with the lexical `isInside`.
 */
export function createScratchDir(dataDir: string): string {
  const root = scratchRoot(dataDir)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const dir = join(root, newId('quick'))
  mkdirSync(dir, { mode: 0o700 })
  return canonical(dir)
}

/**
 * The scratch dirs some run record points to: quick.folder of a scratch quick run, and buildWorkspace. Returned as
 * pathKey values of both the stored and the canonical spelling; test a dir with `isReferencedScratch`.
 */
export function referencedScratch(runs: readonly RunSummary[]): Set<string> {
  const out = new Set<string>()
  const add = (p: string): void => {
    for (const s of spellings(p)) out.add(pathKey(s))
  }
  for (const r of runs) {
    if (r.quick?.scratch && typeof r.quick.folder === 'string') add(r.quick.folder)
    if (typeof r.buildWorkspace === 'string') add(r.buildWorkspace)
  }
  return out
}

/** True when any spelling of `dir` is in `refs` (from referencedScratch). */
export function isReferencedScratch(refs: ReadonlySet<string>, dir: string): boolean {
  return spellings(dir).some((s) => refs.has(pathKey(s)))
}

/**
 * The directory `<data>/quick/<basename>` that `dir` stands for, or null when `dir` is not exactly a direct child of
 * the scratch root with a scratch name (so a `..` path, a nested path, another folder or a user folder is never
 * removed). Recomputed from the basename, never trusted as given.
 */
export function scratchDirFor(dataDir: string, dir: string): string | null {
  if (typeof dir !== 'string' || !dir || !isAbsolute(dir)) return null
  const name = basename(dir)
  if (!SCRATCH_NAME.test(name)) return null
  const root = scratchRoot(dataDir)
  const expected = join(root, name)
  const given = [pathKey(dir), pathKey(canonicalDeep(dir))]
  // The data dir itself may sit behind a link (macOS /tmp): accept the canonical spelling of the root too.
  const expectedKeys = [pathKey(expected), pathKey(join(canonicalDeep(root), name))]
  if (!given.some((g) => expectedKeys.includes(g))) return null
  return expected
}

/**
 * Remove a scratch dir when `isReferenced` says no run record points to it. Returns whether it was removed. Anything
 * that is not a direct `quick_<id>` child of `<data>/quick`, a link, or a still referenced dir is left alone.
 */
export function removeScratchDir(dataDir: string, dir: string, isReferenced: (dir: string) => boolean): boolean {
  const target = scratchDirFor(dataDir, dir)
  if (!target) return false
  try {
    if (!existsSync(target)) return false
    // A link or a file is never followed or deleted here.
    if (!lstatSync(target).isDirectory()) return false
    if (isReferenced(target)) return false
    rmSync(target, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Boot sweep: remove every `quick_<id>` dir under `<data>/quick` that no run in `runs` points to. Returns how many
 * were removed. Other entries are left alone.
 */
export function sweepScratchDirs(dataDir: string, runs: readonly RunSummary[]): number {
  const root = scratchRoot(dataDir)
  if (!existsSync(root)) return 0
  const referenced = referencedScratch(runs)
  let removed = 0
  let names: string[] = []
  try {
    names = readdirSync(root)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!SCRATCH_NAME.test(name)) continue
    const dir = join(root, name)
    if (removeScratchDir(dataDir, dir, (d) => isReferencedScratch(referenced, d))) removed++
  }
  return removed
}

// ---------- trust helpers (shared by RunManager and every adapter) ----------

/**
 * True for runs that work in a folder OrgAI does not trust as configuration: a Chat (quick) run, or an MCP assistant
 * build session (buildWorkspace, an agent-writable scratch dir). Such runs get the run's own grants only (never
 * saved rules read from the folder), no project-scope grants (downgraded to session), and on Claude settingSources [].
 */
export function isTrustRestrictedRun(run: Pick<RunSummary, 'quick' | 'buildWorkspace'> | undefined | null): boolean {
  return !!run && (!!run.quick || typeof run.buildWorkspace === 'string')
}

/**
 * True when `target` (absolute, or relative to `workspace`) is `<workspace>/.claude` or anything under it, compared
 * lexically and through the real path of the nearest existing ancestor (so a link inside the workspace pointing at its
 * .claude dir is caught too). Build sessions must never write there: a planted settings file could pre-approve tools
 * or register hooks. Non-string or empty input counts as protected (fail closed).
 */
export function isWorkspaceConfigPath(workspace: string, target: unknown): boolean {
  if (typeof target !== 'string' || !target) return true
  const abs = isAbsolute(target) ? target : join(workspace, target)
  const roots = [join(workspace, '.claude'), join(canonical(workspace), '.claude')]
  if (roots.some((r) => isInside(r, abs))) return true
  // Resolve the nearest existing ancestor through links, then re-append the rest.
  const real = canonicalDeep(abs)
  return roots.some((r) => isInside(r, real))
}

// ---------- folder validation ----------

/** What validateQuickFolder found. `folder` is the canonical path (what the run works in and the run record stores). */
export interface QuickFolderCheck {
  folder: string
  gitRepo: boolean
}

/**
 * Why a folder could not be read, by errno (cli-standalone-default.md 4.4). On macOS EPERM is the privacy protection
 * (TCC) on Documents, Desktop, Downloads, removable volumes and the like: Unix permissions allow it, but the process
 * running OrgAI's host was not granted that folder. EACCES is the folder's own permissions. The executable is named because
 * that is the program the user grants access to (the OrgAI app, or the program that started orgai).
 */
export function unreadableFolderMessage(text: string, err: unknown, platform: NodeJS.Platform = process.platform, execPath: string = process.execPath): string {
  const code = typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : undefined
  if (code === 'EPERM' && platform === 'darwin') {
    return `macOS blocked OrgAI from reading ${text}. Allow it in System Settings > Privacy & Security > Files and Folders (or Full Disk Access) for the program running OrgAI's host (${execPath}): for orgai in a terminal, that terminal app.`
  }
  if (code === 'EACCES') return `You do not have permission to read ${text}. Check the folder's permissions.`
  return `OrgAI cannot read ${text}${code ? ` (${code})` : ''}. Check its permissions.`
}

/**
 * Validate a user-chosen folder for a Chat run, in the main process only. Throws a readable message for: a
 * non-string or empty value, a relative path, a UNC or device path (`\\server\share`, `\\?\`, `\\.\`, also when the
 * real path of a mapped drive turns out to be one), a missing folder, a file, the data dir, anything under it or a folder that contains it,
 * and a folder that cannot be read.
 */
export function validateQuickFolder(raw: unknown, dataDir: string): QuickFolderCheck {
  if (typeof raw !== 'string') throw new Error('Choose a folder as text.')
  let text = raw.trim()
  const quoted = /^"(.*)"$/.exec(text) ?? /^'(.*)'$/.exec(text)
  if (quoted) text = quoted[1].trim()
  if (!text) throw new Error('Choose a folder.')
  if (text.includes('\0')) throw new Error('That folder path is not valid.')
  if (/^[\\/]{2}/.test(text)) throw new Error('Network shares and device paths are not allowed. Choose a folder on this computer.')
  if (!isAbsolute(text) && !/^[a-zA-Z]:[\\/]/.test(text)) {
    throw new Error(`Use a full path, for example ${process.platform === 'win32' ? 'C:\\Projects\\shop' : '/Users/you/projects/shop'}.`)
  }
  let real: string
  try {
    real = realpathSync.native(text)
  } catch {
    throw new Error(`There is no folder at ${text}. Check the path.`)
  }
  if (/^[\\/]{2}/.test(real)) throw new Error('Network shares and device paths are not allowed. Choose a folder on this computer.')
  let stat
  try {
    stat = statSync(real)
  } catch {
    throw new Error(`There is no folder at ${text}. Check the path.`)
  }
  if (!stat.isDirectory()) throw new Error(`${text} is a file, not a folder. Choose a folder.`)
  // Both checks compare the lexical and canonical spellings of both sides: the data dir may not exist yet and may sit
  // behind a link (macOS /var -> /private/var), and a miss here would fail open.
  let inData: boolean
  let holdsData: boolean
  try {
    inData = isInsideEither(dataDir, real) || isInsideEither(dataDir, text)
    holdsData = isInsideEither(real, dataDir) || isInsideEither(text, dataDir)
  } catch {
    throw new Error('OrgAI could not check that folder against its data folder. Choose another folder.')
  }
  if (inData) {
    throw new Error("That is OrgAI's own data folder. Choose another folder, or leave it empty to work in a scratch area.")
  }
  // M3: a folder that contains the data dir (Home, a drive root) would expose runs, settings and secrets ciphertext.
  if (holdsData) {
    throw new Error("That folder contains OrgAI's data; choose a folder outside it or a subfolder.")
  }
  let entries: string[]
  try {
    accessSync(real, constants.R_OK)
    entries = readdirSync(real)
  } catch (e) {
    throw new Error(unreadableFolderMessage(text, e))
  }
  return { folder: real, gitRepo: entries.includes('.git') || existsSync(join(real, '.git')) }
}
