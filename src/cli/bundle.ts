/**
 * The client side of skillLibrary:addFromBundle (cli-spec 3.6 item 1): read one local skill folder into a
 * SkillBundleInput. The host is the validator (src/main/skills/files.ts readBundle runs the full rules over the decoded
 * bytes: paths, caps, binary refusal, SKILL.md rewrite and shell-injection refusal). This reader only walks the folder
 * safely and checks the same caps and name rules first so an obviously bad folder fails early (exit 2) without sending
 * anything. It never follows links.
 *
 * Plain Node: no electron imports.
 */
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  SKILL_BUNDLE_FILE_MAX_BYTES,
  SKILL_BUNDLE_MAX_BYTES,
  SKILL_BUNDLE_MAX_FILES,
  SKILL_BUNDLE_SKILL_MD_MAX_BYTES,
  type SkillBundleFile,
  type SkillBundleInput
} from '../shared/types'
import { hiddenCharIn } from '../main/capabilities/sanitize'
import { SKILL_MAX_DEPTH } from '../main/skills/files'
import { safeLine } from './output'
import { CliError, EXIT } from './types'

/** Folder names never read (with a note). Dot entries are skipped too. */
const SKIPPED_DIRS = new Set(['.git', 'node_modules'])
/** Windows reserved device names, with or without an extension (the host refuses them in any segment). */
const WIN_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
/** Characters Windows forbids in a name (the host refuses them too). */
const WIN_FORBIDDEN = /[<>"|?*\\]/
/** Longest relPath the host accepts (SKILL_BUNDLE_PATH_MAX). */
const REL_PATH_MAX = 200

export interface ReadSkillFolderOptions {
  /** The bundle name (default the folder's own name). */
  name?: string
  /** Receives one line per entry left out (links, special files, dot entries, .git, node_modules). */
  notes?: string[]
}

const usage = (message: string): CliError => new CliError(message, EXIT.usage)
const label = (rel: string): string => JSON.stringify(safeLine(rel).slice(0, 120))

/** Why one name segment is refused before sending, or null. */
export function segmentProblem(seg: string): string | null {
  if (hiddenCharIn(seg)) return 'contains a control or hidden character'
  if (seg.includes(':')) return "contains ':' (drive or alternate data stream syntax)"
  if (WIN_RESERVED.test(seg)) return 'is a reserved Windows device name'
  if (WIN_FORBIDDEN.test(seg)) return 'contains a character Windows does not allow in a name'
  if (/[. ]$/.test(seg)) return 'ends with a dot or a space'
  return null
}

/**
 * Read `dir` (a skill folder with SKILL.md at its top) into a bundle: regular files only, forward-slash relPaths,
 * base64 content. Links (symlinks, junctions), special files, dot entries, .git and node_modules are left out (named in
 * `opts.notes`). A refused name, a missing SKILL.md, more than SKILL_BUNDLE_MAX_FILES files, a file over its cap
 * (SKILL.md 256 KB, others 64 KB), more than 1 MB in all or folders nested past the host's depth are exit 2.
 */
export async function readSkillFolder(dir: string, opts: ReadSkillFolderOptions = {}): Promise<SkillBundleInput> {
  const notes = opts.notes ?? []
  let root: string
  try {
    const st = await lstat(dir)
    if (st.isSymbolicLink()) throw usage(`${label(dir)} is a link; give the skill folder itself.`)
    if (!st.isDirectory()) throw usage(`${label(dir)} is not a folder.`)
    root = await realpath(dir)
  } catch (e) {
    if (e instanceof CliError) throw e
    throw usage(`Cannot read the folder ${label(dir)}.`)
  }

  const found: { rel: string; abs: string; size: number }[] = []
  let total = 0
  const walk = async (absDir: string, relDir: string, depth: number): Promise<void> => {
    const names = (await readdir(absDir)).sort()
    for (const name of names) {
      const rel = relDir ? `${relDir}/${name}` : name
      const abs = join(absDir, name)
      if (SKIPPED_DIRS.has(name) || name.startsWith('.')) {
        notes.push(`Left out ${label(rel)} (hidden or not part of a skill).`)
        continue
      }
      const problem = segmentProblem(name)
      if (problem) throw usage(`The file name ${label(rel)} ${problem}; rename it before adding the skill.`)
      const st = await lstat(abs)
      if (st.isSymbolicLink()) {
        notes.push(`Left out ${label(rel)} (a link; links are never followed).`)
        continue
      }
      if (st.isDirectory()) {
        if (depth + 1 > SKILL_MAX_DEPTH) throw usage(`${label(rel)} is nested deeper than ${SKILL_MAX_DEPTH} folders.`)
        await walk(abs, rel, depth + 1)
        continue
      }
      if (!st.isFile()) {
        notes.push(`Left out ${label(rel)} (not a regular file).`)
        continue
      }
      if (rel.length > REL_PATH_MAX) throw usage(`The path ${label(rel)} is longer than ${REL_PATH_MAX} characters.`)
      const cap = rel === 'SKILL.md' ? SKILL_BUNDLE_SKILL_MD_MAX_BYTES : SKILL_BUNDLE_FILE_MAX_BYTES
      if (st.size > cap) throw usage(`${label(rel)} is larger than ${cap / 1024} KB.`)
      total += st.size
      if (total > SKILL_BUNDLE_MAX_BYTES) throw usage(`The skill is larger than ${SKILL_BUNDLE_MAX_BYTES / 1024 / 1024} MB.`)
      found.push({ rel, abs, size: st.size })
      if (found.length > SKILL_BUNDLE_MAX_FILES) throw usage(`The skill folder has more than ${SKILL_BUNDLE_MAX_FILES} files.`)
    }
  }
  try {
    await walk(root, '', 0)
  } catch (e) {
    if (e instanceof CliError) throw e
    throw usage(`Cannot read the folder ${label(dir)}: ${safeLine(e instanceof Error ? e.message : String(e))}`)
  }
  if (!found.some((f) => f.rel === 'SKILL.md')) throw usage(`There is no SKILL.md at the top of ${label(dir)}.`)

  const files: SkillBundleFile[] = []
  let read = 0
  for (const f of found) {
    let data: Buffer
    try {
      data = await readFile(f.abs)
    } catch {
      throw usage(`Cannot read ${label(f.rel)}.`)
    }
    // The file may have grown since lstat: check the caps again on what was read.
    const cap = f.rel === 'SKILL.md' ? SKILL_BUNDLE_SKILL_MD_MAX_BYTES : SKILL_BUNDLE_FILE_MAX_BYTES
    if (data.length > cap) throw usage(`${label(f.rel)} is larger than ${cap / 1024} KB.`)
    read += data.length
    if (read > SKILL_BUNDLE_MAX_BYTES) throw usage(`The skill is larger than ${SKILL_BUNDLE_MAX_BYTES / 1024 / 1024} MB.`)
    files.push({ relPath: f.rel, base64: data.toString('base64') })
  }
  // SKILL.md first, the rest by path.
  files.sort((a, b) => (a.relPath === 'SKILL.md' ? -1 : b.relPath === 'SKILL.md' ? 1 : a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
  const name = opts.name ?? basename(root)
  return { name, files }
}
