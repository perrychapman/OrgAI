import { homedir } from 'node:os'
import { isAbsolute, join, posix, win32 } from 'node:path'
import { canonicalDeep, isInside } from '../quick/scratch'
import { SHELL_TOOLS, segmentWords, splitCommand, unwrapShellCommand } from './ruleMatch'

/**
 * Reference folders (Project.referenceDirectories, RuntimeContext.referenceDirectories): agents may read them, never
 * change them. Provider-neutral helpers every adapter calls from its edit gate (Claude PreToolUse, Codex file
 * approvals, the mock).
 *
 * Edit tools are gated by path (referenceEditDenial). Shell commands are gated by naming (commandReferenceTouch): a
 * command touches a folder when the agent's working folder is at or under it, or any word of any segment names a path
 * at, under or above it (`rm -rf ..`, `del /s C:\Clients`, a glob's static prefix). Reads are not told apart from
 * writes: every touching command asks. Honest limits: a command that reaches a folder through a variable ($VAR, %VAR%),
 * a relative path from an unknown cwd, a symlink not resolvable at check time, or a program's own config (a script
 * that deletes files, a makefile) is not detected.
 *
 * ruleMatch.ts calls this module (shellRulesFor) and this module calls ruleMatch.ts (splitting): each side uses the
 * other only inside function bodies, never at module load.
 */

/** The edit tools refused under a reference folder. */
export const REFERENCE_EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** The one refusal text: "<folder> is a reference folder: agents may read it, not change it". */
export function referenceFolderMessage(folder: string): string {
  return `${folder} is a reference folder: agents may read it, not change it`
}

/**
 * The reference folder that contains `target`, or null. A relative target resolves against `cwd` (the agent's
 * working folder; without one a relative target is checked as given). Compared lexically and through the real path of
 * the nearest existing ancestor (scratch.ts canonicalDeep), against each folder as given and as its own real path, so
 * a link or junction into a reference folder is caught. A non-string or empty target returns null: callers that must
 * fail closed use referenceEditDenial.
 */
export function referenceFolderOf(target: unknown, refs: readonly string[], cwd?: string): string | null {
  if (typeof target !== 'string' || !target || target.includes('\0')) return null
  const usable = refs.filter((r) => typeof r === 'string' && r !== '' && isAbsolute(r))
  if (!usable.length) return null
  const abs = isAbsolute(target) ? target : cwd ? join(cwd, target) : target
  let real = abs
  try {
    real = canonicalDeep(abs)
  } catch {
    // Unresolvable: the lexical check alone.
  }
  for (const ref of usable) {
    let refReal = ref
    try {
      refReal = canonicalDeep(ref)
    } catch {
      // Keep the given spelling.
    }
    if ([ref, refReal].some((r) => isInside(r, abs) || isInside(r, real))) return ref
  }
  return null
}

/** The path an edit tool's input names: NotebookEdit's notebook_path, else file_path (either key as a fallback). */
export function editTargetOf(toolName: string, input: unknown): unknown {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  return toolName === 'NotebookEdit' ? (i.notebook_path ?? i.file_path) : (i.file_path ?? i.notebook_path)
}

/**
 * Why this tool call must be refused, or null. Only the REFERENCE_EDIT_TOOLS and only when `refs` is non-empty:
 * a path under a reference folder is refused with referenceFolderMessage(folder); a missing, empty or non-string path
 * is refused too (fails closed) with a message naming the first reference folder.
 */
export function referenceEditDenial(toolName: string, input: unknown, refs: readonly string[] | undefined, cwd?: string): string | null {
  if (!REFERENCE_EDIT_TOOLS.has(toolName) || !refs?.length) return null
  const target = editTargetOf(toolName, input)
  if (typeof target !== 'string' || !target) return `${referenceFolderMessage(refs[0])}; this ${toolName} call names no file path, so it was refused`
  if (target.includes('\0')) return `${referenceFolderMessage(refs[0])}; this ${toolName} call names a path with a NUL character, so it was refused`
  const hit = referenceFolderOf(target, refs, cwd)
  return hit ? referenceFolderMessage(hit) : null
}

// ---- Shell commands ----------------------------------------------------------------------------------------------

export interface ReferenceCheckOptions {
  /** Path rules to apply; default process.platform. */
  platform?: NodeJS.Platform
  /** The shell reading the command; on win32 MSYS `/c/x` means `C:\x` only in bash. Missing = bash. */
  shell?: 'bash' | 'powershell'
  /** The home folder `~` expands to; default os.homedir(). */
  home?: string
}

/** Words checked per command; past this the check fails closed (asks). */
const MAX_WORDS = 2000
/** Nested command texts (a word that itself holds a command) are scanned this deep. */
const MAX_NEST = 3
const CD_NAMES: ReadonlySet<string> = new Set(['cd', 'pushd', 'set-location', 'sl', 'chdir'])
const PUNCTUATION = /[<>|&;(){}`]|\$\(/
const GLOB_CHAR = /[*?[]/

type PathModule = typeof posix

interface RefEntry {
  ref: string
  abs: string
  real?: string
}

interface CheckState {
  p: PathModule
  platform: NodeJS.Platform
  shell: 'bash' | 'powershell'
  home: string | undefined
  refs: RefEntry[]
  real: boolean
  cache: Map<string, string>
  words: number
}

function fold(s: CheckState, v: string): string {
  return s.platform === 'win32' || s.platform === 'darwin' ? v.toLowerCase() : v
}

/** True when `child` is `parent` or inside it (path.relative, never a string prefix). */
function within(s: CheckState, parent: string, child: string): boolean {
  const r = s.p.relative(fold(s, parent), fold(s, child))
  return r === '' || (r !== '..' && !r.startsWith(`..${s.p.sep}`) && !s.p.isAbsolute(r))
}

function realOf(s: CheckState, abs: string): string {
  const hit = s.cache.get(abs)
  if (hit !== undefined) return hit
  let real = abs
  try {
    real = canonicalDeep(abs)
  } catch {
    // Unresolvable: the lexical spelling alone.
  }
  s.cache.set(abs, real)
  return real
}

/** The reference folder `abs` is at or under (or, with `ancestor`, above), lexically and through real paths. */
function touchOf(s: CheckState, abs: string, ancestor: boolean): string | null {
  for (const r of s.refs) {
    if (within(s, r.abs, abs) || (ancestor && within(s, abs, r.abs))) return r.ref
  }
  if (!s.real) return null
  const ra = realOf(s, abs)
  for (const r of s.refs) {
    r.real ??= realOf(s, r.abs)
    const rr = r.real
    if (within(s, r.abs, ra) || within(s, rr, abs) || within(s, rr, ra)) return r.ref
    if (ancestor && (within(s, ra, r.abs) || within(s, abs, rr) || within(s, ra, rr))) return r.ref
  }
  return null
}

/** One word as an absolute path against `cwd`, or null when it names no resolvable path. */
function resolveWord(s: CheckState, raw: string, cwd: string | undefined): string | null {
  let w = raw
  if (!w || w.includes('\0')) return null
  if (w === '~' || /^~[\\/]/.test(w)) {
    if (!s.home || !s.p.isAbsolute(s.home)) return null
    w = s.p.join(s.home, w.slice(1))
  }
  if (s.platform === 'win32') {
    if (s.shell !== 'powershell') {
      const msys = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(w)
      if (msys) w = `${msys[1].toUpperCase()}:\\${(msys[2] ?? '').replace(/\//g, '\\')}`
    }
    // Provider paths (HKCU:\..., Microsoft.PowerShell.Core\FileSystem::C:\...): a ':' only as a drive prefix.
    if (w.replace(/^[a-zA-Z]:/, '').includes(':')) return null
    // win32 drops trailing dots and spaces from a name (`Acme.` opens `Acme`).
    w = w
      .split(/[\\/]/)
      .map((part) => (part === '.' || part === '..' ? part : part.replace(/[. ]+$/, '') || part))
      .join('\\')
  }
  if (cwd && s.p.isAbsolute(cwd)) return s.p.resolve(cwd, w)
  const qualified = s.platform === 'win32' ? /^(?:[a-zA-Z]:[\\/]|[\\/]{2})/.test(w) : w.startsWith('/')
  return qualified ? s.p.resolve(w) : null
}

/** The static directory of a glob word (everything up to the last separator before the first glob character). */
function globDir(s: CheckState, w: string): string {
  const idx = w.search(GLOB_CHAR)
  const prefix = w.slice(0, idx)
  const sep = s.platform === 'win32' ? Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\')) : prefix.lastIndexOf('/')
  return sep >= 0 ? prefix.slice(0, sep + 1) : '.'
}

function checkPart(s: CheckState, part: string, cwd: string | undefined): string | null {
  if (!part || part.includes('://')) return null
  const full = resolveWord(s, part, cwd)
  if (GLOB_CHAR.test(part)) {
    if (full) {
      const hit = touchOf(s, full, false)
      if (hit) return hit
    }
    const dir = resolveWord(s, globDir(s, part), cwd)
    return dir ? touchOf(s, dir, true) : null
  }
  return full ? touchOf(s, full, true) : null
}

/** The pieces of a word a path may hide in: split on shell punctuation, plus the part after the first `=`. */
function partsOf(word: string): string[] {
  const out: string[] = []
  for (const piece of word.split(PUNCTUATION)) {
    if (piece) out.push(piece)
    const eq = piece.indexOf('=')
    if (eq >= 0 && eq < piece.length - 1) out.push(piece.slice(eq + 1))
  }
  return out
}

type Touch = { folder: string; how: 'names' | 'runs-in' }

function scanCommand(s: CheckState, text: string, startCwd: string | undefined, depth: number): Touch | null {
  let cwd = startCwd
  for (const segment of splitCommand(text)) {
    const words = segmentWords(segment)
    if (!words.length) continue
    const head = (words[0].split(/[\\/]/).pop() ?? words[0]).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '')
    if (CD_NAMES.has(head)) {
      // A cd only moves the tracked folder: its target is checked for being at or under a reference folder, not above.
      const arg = words.length === 2 ? words[1] : null
      if (arg !== null && !arg.startsWith('-') && !/[$%`()<>|&]/.test(arg)) {
        const target = resolveWord(s, arg, cwd)
        if (target) {
          const hit = touchOf(s, target, false)
          if (hit) return { folder: hit, how: 'names' }
          cwd = target
          continue
        }
      }
      cwd = undefined
    }
    for (const word of words) {
      if (++s.words > MAX_WORDS) return { folder: s.refs[0].ref, how: 'names' }
      if (depth < MAX_NEST && /\s/.test(word)) {
        const nested = scanCommand(s, word, cwd, depth + 1)
        if (nested) return nested
      }
      for (const part of partsOf(word)) {
        const hit = checkPart(s, part, cwd)
        if (hit) return { folder: hit, how: 'names' }
      }
    }
  }
  return null
}

/**
 * The reference folder a shell command touches and how: 'runs-in' when the effective working folder `cwd` is at or
 * under it, 'names' when a word of the command names a path at, under or above it (see the module comment for the
 * rules and limits). null when none, when `refs` has no usable absolute folder, or `command` is not a string.
 */
export function commandReferenceTouch(
  command: string,
  cwd: string | undefined,
  refs: readonly string[],
  opts: ReferenceCheckOptions = {}
): Touch | null {
  if (typeof command !== 'string' || !command.trim() || !Array.isArray(refs)) return null
  const platform = opts.platform ?? process.platform
  const p: PathModule = platform === 'win32' ? win32 : posix
  const entries: RefEntry[] = []
  for (const r of refs) {
    if (typeof r === 'string' && r !== '' && !r.includes('\0') && p.isAbsolute(r)) entries.push({ ref: r, abs: p.resolve(r) })
  }
  if (!entries.length) return null
  const s: CheckState = {
    p,
    platform,
    shell: opts.shell ?? 'bash',
    home: opts.home ?? homedir(),
    refs: entries,
    real: platform === process.platform,
    cache: new Map(),
    words: 0
  }
  const startCwd = typeof cwd === 'string' && cwd !== '' && p.isAbsolute(cwd) ? p.resolve(cwd) : undefined
  if (startCwd) {
    const hit = touchOf(s, startCwd, false)
    if (hit) return { folder: hit, how: 'runs-in' }
  }
  const texts = [command]
  const unwrapped = unwrapShellCommand(command)
  if (unwrapped && unwrapped !== command.trim()) texts.push(unwrapped)
  for (const text of texts) {
    const hit = scanCommand(s, text, startCwd, 0)
    if (hit) return hit
  }
  return null
}

/** The reference folder a shell command touches (commandReferenceTouch's folder, as given in `refs`), else null. */
export function commandTouchesReference(
  command: string,
  cwd: string | undefined,
  refs: readonly string[],
  opts: ReferenceCheckOptions = {}
): string | null {
  return commandReferenceTouch(command, cwd, refs, opts)?.folder ?? null
}

/** The refusal / ask text for a command: "<folder> is a reference folder...; this command names it" or "...runs inside it". */
export function referenceCommandMessage(folder: string, how: 'names' | 'runs-in'): string {
  return `${referenceFolderMessage(folder)}; this command ${how === 'names' ? 'names it' : 'runs inside it'}`
}

/**
 * The reference folder a tool call touches, else null (also null for other tools and without folders). Shell tools go
 * through commandTouchesReference; edit tools by their target path; Read by file_path; Glob by path (missing = cwd)
 * and an absolute pattern's static prefix; Grep by path (missing = cwd).
 */
export function referenceTouchOf(
  toolName: string,
  input: unknown,
  refs: readonly string[],
  cwd: string | undefined,
  opts: ReferenceCheckOptions = {}
): string | null {
  if (!refs?.length) return null
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (SHELL_TOOLS.has(toolName)) {
    return typeof i.command === 'string'
      ? commandTouchesReference(i.command, cwd, refs, { ...opts, shell: toolName === 'PowerShell' ? 'powershell' : opts.shell })
      : null
  }
  if (REFERENCE_EDIT_TOOLS.has(toolName)) return referenceFolderOf(editTargetOf(toolName, input), refs, cwd)
  if (toolName === 'Read') return referenceFolderOf(i.file_path, refs, cwd)
  if (toolName === 'Glob' || toolName === 'Grep') {
    const where = typeof i.path === 'string' && i.path ? i.path : cwd
    const hit = referenceFolderOf(where, refs, cwd)
    if (hit || toolName === 'Grep') return hit
    const pattern = i.pattern
    if (typeof pattern === 'string' && isAbsolute(pattern)) {
      const idx = pattern.search(GLOB_CHAR)
      const prefix = idx < 0 ? pattern : pattern.slice(0, idx)
      const sep = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'))
      return referenceFolderOf(idx < 0 ? pattern : sep >= 0 ? prefix.slice(0, sep + 1) : '', refs, cwd)
    }
  }
  return null
}

// Control, zero-width, bidi and other invisible characters (the set capabilities/sanitize.ts uses).
const HIDDEN_RUN = new RegExp(
  '[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0\u{e0000}-\u{e007f}]+',
  'gu'
)

/**
 * The one harness transcript row an adapter writes when it refuses a call under a reference folder:
 * `{ kind: 'system', text, detail }`. text names the file (last path segment, cleaned, at most 120 chars); detail is
 * the full cleaned target path (at most 1,024 chars) on one line, then referenceFolderMessage(folder). A missing or
 * non-string target gets the no-file text and the message alone.
 */
export function referenceRefusalEntry(target: unknown, folder: string): { text: string; detail: string } {
  const message = referenceFolderMessage(folder)
  const path = typeof target === 'string' ? target.replace(HIDDEN_RUN, '').replace(/\s+/g, ' ').trim() : ''
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? ''
  if (!name) return { text: 'Refused: an edit that names no file (reference folders are read only)', detail: message }
  const shown = name.length > 120 ? `${name.slice(0, 119)}…` : name
  return { text: `Refused: ${shown} is in a reference folder (read only)`, detail: `${path.slice(0, 1024)}\n${message}` }
}
