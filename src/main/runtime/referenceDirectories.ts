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
 * writes: every touching command asks. A UNC or device word (\\host\share, //host/s, \\?\...) counts as touching with no
 * file-system access (resolving it would open a network connection). After a cd whose target cannot be tracked (`cd -`,
 * popd, a bare cd, a variable) a segment with a relative path word or no absolute path word asks. Commands over 32 KB
 * or with over 2,000 words or parts ask without any file-system access. Honest limits: a command that reaches a folder
 * through a variable ($VAR, %VAR%), a link created at run time, a program's own config or script files (a script that
 * deletes files, a makefile), or a provider deciding by itself for calls OrgAI never sees is not detected.
 *
 * ruleMatch.ts calls this module (shellRulesFor) and this module calls ruleMatch.ts (splitting): each side uses the
 * other only inside function bodies, never at module load.
 */

/** True for a path that starts with two separators (UNC, device and extended-length paths): never touched on disk. */
function isUncLike(p: string): boolean {
  return /^[\\/]{2}/.test(p)
}

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
  // A UNC or device path (\\host\share, //host/s, \\?\..., \\.\...) is never handed to the file system: resolving it
  // would open a network connection. On Windows it counts as inside the first reference folder (edit tools are denied).
  if (isUncLike(abs) || isUncLike(target)) {
    if (process.platform === 'win32') return usable[0]
  }
  let real = abs
  if (!isUncLike(abs)) {
    try {
      real = canonicalDeep(abs)
    } catch {
      // Unresolvable: the lexical check alone.
    }
  }
  for (const ref of usable) {
    let refReal = ref
    if (!isUncLike(ref)) {
      try {
        refReal = canonicalDeep(ref)
      } catch {
        // Keep the given spelling.
      }
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
  /**
   * 'reference' (default): the reference-folder rules above (a word naming a parent counts, limits and untrackable
   * cds fail closed). 'self-control' (selfControlGate.ts): only definite hits count. A word must name a path AT or
   * UNDER a folder (a parent such as the home folder or the data dir never counts), and the fail-closed answers
   * (an untrackable cd, UNC / device words, provider-qualified words) give null so the normal permission flow decides.
   * A scan limit (command over 32 KB, too many words or parts, a quoted word nested deeper than three levels) also
   * gives null here, but commandControlScan reports it as 'limit' and the gate denies the command. cd tracking stays on; after an untrackable cd relative words are
   * not resolved, absolute ones still are.
   */
  mode?: 'reference' | 'self-control'
}

/** Words checked per command; past this the check fails closed (asks). */
const MAX_WORDS = 2000
/** Nested command texts (a word that itself holds a command) are scanned this deep. */
const MAX_NEST = 3
/** Parts (pieces of words) checked per command; past this the check fails closed. */
const MAX_PARTS = 2000
/** Longest command text checked; past this the check fails closed with no file-system access. */
const MAX_COMMAND_CHARS = 32 * 1024
const CD_NAMES: ReadonlySet<string> = new Set(['cd', 'pushd', 'push-location', 'set-location', 'sl', 'chdir'])
/** These make the working folder unknown (the previous folder is not tracked). */
const POP_NAMES: ReadonlySet<string> = new Set(['popd', 'pop-location'])
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
  parts: number
  /** mode 'self-control': only definite AT-or-UNDER hits, never a fail-closed answer. */
  definite: boolean
  /** Set (definite mode) when a fail-closed answer was reached: scanning stops and the command answers null. */
  stopped: boolean
  /**
   * Set (definite mode) when a scan limit was hit (command over 32 KB, too many words or parts, a quoted word nested
   * deeper than MAX_NEST): the scanner did not read the whole command, so selfControlGate.ts denies it.
   */
  limited: boolean
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
  if (!isUncLike(abs)) {
    try {
      real = canonicalDeep(abs)
    } catch {
      // Unresolvable: the lexical spelling alone.
    }
  }
  s.cache.set(abs, real)
  return real
}

/** The reference folder `abs` is at or under (or, with `ancestor`, above), lexically and through real paths. */
function touchOf(s: CheckState, abs: string, ancestorWanted: boolean): string | null {
  const ancestor = ancestorWanted && !s.definite
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

function trimDotsSpaces(part: string): string {
  let end = part.length
  while (end > 0 && (part.charCodeAt(end - 1) === 46 || part.charCodeAt(end - 1) === 32)) end--
  return end === part.length ? part : part.slice(0, end)
}

/**
 * Definite mode (self-control): a leading home variable read as the home folder: `$HOME`, `${HOME}`, PowerShell
 * `$env:HOME` / `$env:USERPROFILE` / `$HOME`, cmd `%USERPROFILE%` / `%HOME%`. These expand to a known
 * value, and `$HOME/...` is the ordinary way to spell OrgAI's default data folder. Reference mode keeps its documented
 * limit (variables are not followed).
 */
const HOME_VARIABLE = /^(?:\$\{HOME\}|\$HOME|\$env:(?:HOME|USERPROFILE)|%USERPROFILE%|%HOME%)(?=$|[\\/])/i

/** One word as an absolute path against `cwd`, or null when it names no resolvable path. */
function resolveWord(s: CheckState, raw: string, cwd: string | undefined): string | null {
  let w = raw
  if (!w || w.includes('\0')) return null
  if (s.definite) {
    const v = HOME_VARIABLE.exec(w)
    if (v) {
      if (!s.home || !s.p.isAbsolute(s.home)) return null
      w = s.p.join(s.home, w.slice(v[0].length))
    }
  }
  if (w === '~' || /^~[\\/]/.test(w)) {
    if (!s.home || !s.p.isAbsolute(s.home)) return null
    w = s.p.join(s.home, w.slice(1))
  }
  if (s.platform === 'win32') {
    if (s.shell !== 'powershell') {
      const msys = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(w)
      if (msys) w = `${msys[1].toUpperCase()}:\\${(msys[2] ?? '').replace(/\//g, '\\')}`
    }
    // Other ':' (providers are screened in variantsOf): only a drive prefix is a path.
    if (w.replace(/^[a-zA-Z]:/, '').includes(':')) return null
    // win32 drops trailing dots and spaces from a name (`Acme.` opens `Acme`). A linear trim, never a backtracking regex.
    w = w
      .split(/[\\/]/)
      .map((part) => (part === '.' || part === '..' ? part : trimDotsSpaces(part) || part))
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

/** PowerShell providers that are not the file system: a path in one touches no folder. */
const NON_FS_PROVIDERS: ReadonlySet<string> = new Set([
  'hkcu', 'hklm', 'hkcr', 'hku', 'hkcc', 'env', 'alias', 'function', 'variable', 'cert', 'wsman', 'registry'
])

/**
 * The spellings of a word to check: the word itself, a leading PowerShell `-Name:` parameter prefix removed, a
 * `(Microsoft.PowerShell.Core\)FileSystem::` prefix removed, and (bash) the word with `\x` unescaped to `x`. 'touch'
 * for a provider-qualified word that may be the file system; an empty list for a known non-file-system provider.
 */
function variantsOf(s: CheckState, raw: string): string[] | 'touch' {
  let w = raw
  const param = /^-[A-Za-z][A-Za-z0-9]*:(?=.)/.exec(w)
  if (param) w = w.slice(param[0].length)
  // A URL is never a file path (and its `https:/` would read as a provider). `//host/s` is not one.
  if (w.includes('://')) return []
  const fsPrefix = /^(?:microsoft\.powershell\.core\\)?filesystem::/i.exec(w)
  if (fsPrefix) w = w.slice(fsPrefix[0].length)
  else if (s.platform === 'win32' && s.shell === 'powershell') {
    // `Foo::bar` / `std::fs` are not paths (FileSystem:: is handled above); a PSDrive-looking `Name:\` word may be one.
    const named = /^([A-Za-z][\w.-]+):[\\/]/.exec(w)
    if (named) {
      const name = (named[1].split('\\').pop() ?? '').toLowerCase()
      return NON_FS_PROVIDERS.has(name) ? [] : 'touch'
    }
  }
  const out = [w]
  if (s.shell !== 'powershell' && w.includes('\\')) {
    const unescaped = w.replace(/\\(.)/g, '$1')
    if (unescaped !== w) out.push(unescaped)
  }
  return out
}

function checkPart(s: CheckState, raw: string, cwd: string | undefined): string | null {
  if (!raw) return null
  const variants = variantsOf(s, raw)
  if (variants === 'touch') return s.definite ? null : s.refs[0].ref
  for (const v of variants) {
    if (v.includes('://')) continue
    // A UNC or device word is never resolved (that would touch the network): it counts as naming a reference folder.
    if (s.platform === 'win32' && isUncLike(v)) {
      if (s.definite) continue
      return s.refs[0].ref
    }
    const hit = checkWord(s, v, cwd)
    if (hit) return hit
  }
  return null
}

/** One glob component as an anchored RegExp source (`*`, `?`, `[...]` / `[!...]`; everything else literal). */
function globComponentSource(c: string): string {
  let out = ''
  for (let i = 0; i < c.length; i++) {
    const ch = c[i]
    if (ch === '*') out += '[^\\\\/]*'
    else if (ch === '?') out += '[^\\\\/]'
    else if (ch === '[') {
      const close = c.indexOf(']', i + 2)
      if (close < 0) {
        out += '\\['
        continue
      }
      let body = c.slice(i + 1, close)
      const negate = body.startsWith('!') || body.startsWith('^')
      if (negate) body = body.slice(1)
      out += `[${negate ? '^' : ''}${body.replace(/[\\\]^]/g, (m) => `\\${m}`)}]`
      i = close
    } else out += ch.replace(/[.*+?^${}()|[\]\\/]/g, (m) => `\\${m}`)
  }
  return out
}

/**
 * Definite mode: the protected folder a glob word can reach, else null. The glob's components are matched one by one
 * against each folder's: a glob as deep as the folder (or deeper) whose leading components all match names a path AT
 * or UNDER it (`<data>/r?n/daemon.secret`, `<data>/r*`); a `**` component reaches anything below. A shallower glob
 * only names a parent, which never counts.
 */
function globReaches(s: CheckState, full: string): string | null {
  const parts = (v: string): string[] => fold(s, v).split(/[\\/]+/).filter((x, i) => x !== '' || i === 0)
  const g = parts(full)
  for (const r of s.refs) {
    for (const spelling of r.real && r.real !== r.abs ? [r.abs, r.real] : [r.abs]) {
      const rc = parts(spelling)
      let ok = true
      let k = 0
      for (; k < rc.length; k++) {
        const gc = g[k]
        if (gc === undefined) {
          ok = false
          break
        }
        if (gc === '**') break
        if (!GLOB_CHAR.test(gc) ? gc !== rc[k] : !new RegExp(`^${globComponentSource(gc)}$`).test(rc[k])) {
          ok = false
          break
        }
      }
      if (ok) return r.ref
    }
  }
  return null
}

function checkWord(s: CheckState, part: string, cwd: string | undefined): string | null {
  if (!part) return null
  const full = resolveWord(s, part, cwd)
  if (GLOB_CHAR.test(part)) {
    if (full) {
      const hit = touchOf(s, full, false) ?? (s.definite ? globReaches(s, full) : null)
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

/** The cd target among a cd segment's words after the command: the last non-flag word, `-Name:value` accepted. */
function cdTargetWord(words: readonly string[]): string | null {
  let target: string | null = null
  for (let i = 1; i < words.length; i++) {
    const w = words[i]
    const attached = /^-[A-Za-z][A-Za-z0-9]*:(?=.)/.exec(w)
    if (attached) target = w.slice(attached[0].length)
    else if (w === '-') target = '-'
    else if (w.startsWith('-')) continue
    else if (/^\/d$/i.test(w) && i < words.length - 1) continue
    else target = w
  }
  return target
}

/** The folder a cd segment moves to when it can be tracked (a plain path, not `-`, a variable or a glob), else null. */
function trackedTarget(s: CheckState, words: readonly string[], cwd: string | undefined): string | null {
  const arg = cdTargetWord(words)
  if (arg === null || arg === '-' || /[$%`()<>|&]/.test(arg) || GLOB_CHAR.test(arg)) return null
  const target = resolveWord(s, arg, cwd)
  return target && !(s.platform === 'win32' && isUncLike(target)) ? target : null
}

/** A fail-closed answer: as given, or (definite mode) null with scanning stopped. */
function stopOr(s: CheckState, touch: Touch): Touch | null {
  if (!s.definite) return touch
  s.stopped = true
  return null
}

/** A scan limit: as stopOr, and (definite mode) `limited` set so the self-control gate denies the command. */
function limitHit(s: CheckState, touch: Touch): Touch | null {
  if (s.definite) s.limited = true
  return stopOr(s, touch)
}

function scanCommand(s: CheckState, text: string, startCwd: string | undefined, depth: number, startUnknown = false): Touch | null {
  let cwd = startCwd
  let unknown = startUnknown
  const first = s.refs[0].ref
  for (const segment of splitCommand(text)) {
    const words = segmentWords(segment)
    if (!words.length) continue
    const head = (words[0].split(/[\\/]/).pop() ?? words[0]).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '')
    const isCd = CD_NAMES.has(head) || POP_NAMES.has(head)
    const scanned = isCd ? words.slice(1) : words
    // Once the working folder is unknown (an untracked cd), every later segment fails closed until a tracked cd.
    // Definite mode goes on with no working folder: relative words resolve to nothing, absolute ones are checked.
    if (unknown && !s.definite && !(isCd && !POP_NAMES.has(head) && trackedTarget(s, words, cwd))) return { folder: first, how: 'runs-in' }
    for (const word of scanned) {
      if (++s.words > MAX_WORDS) return limitHit(s, { folder: first, how: 'names' })
      if (/\s/.test(word)) {
        if (depth < MAX_NEST) {
          const nested = scanCommand(s, word, cwd, depth + 1, unknown)
          if (nested || s.stopped) return nested
        } else if (s.definite) {
          // A quoted word deeper than MAX_NEST is not split again, so a path inside it would go unread.
          return limitHit(s, { folder: first, how: 'names' })
        }
      }
      // `${HOME}` would be split at its braces (PUNCTUATION); definite mode reads it as `$HOME` (HOME_VARIABLE).
      for (const part of partsOf(s.definite ? word.replace(/\$\{HOME\}/gi, () => '$HOME') : word)) {
        if (++s.parts > MAX_PARTS) return limitHit(s, { folder: first, how: 'names' })
        const hit = checkPart(s, part, cwd)
        if (hit) return { folder: hit, how: 'names' }
      }
    }
    if (isCd) {
      // Words were scanned with the folder from before the cd (an ancestor of a reference folder counts as touching).
      const target = POP_NAMES.has(head) ? null : trackedTarget(s, words, cwd)
      if (target) {
        cwd = target
        unknown = false
      } else {
        cwd = undefined
        unknown = true
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
  return scanReferenceTouch(command, cwd, refs, opts).touch
}

/**
 * The self-control gate's shell check (mode 'self-control'): 'touch' when the command definitely names (or runs
 * inside) a protected path, 'limit' when the scanner hit a limit before reading all of it (over 32 KB, over 2,000 words
 * or parts, a quoted word nested deeper than three levels), else null.
 */
export function commandControlScan(
  command: string,
  cwd: string | undefined,
  refs: readonly string[],
  opts: Omit<ReferenceCheckOptions, 'mode'> = {}
): 'touch' | 'limit' | null {
  const r = scanReferenceTouch(command, cwd, refs, { ...opts, mode: 'self-control' })
  return r.touch ? 'touch' : r.limited ? 'limit' : null
}

function scanReferenceTouch(
  command: string,
  cwd: string | undefined,
  refs: readonly string[],
  opts: ReferenceCheckOptions
): { touch: Touch | null; limited: boolean } {
  if (typeof command !== 'string' || !command.trim() || !Array.isArray(refs)) return { touch: null, limited: false }
  const platform = opts.platform ?? process.platform
  const p: PathModule = platform === 'win32' ? win32 : posix
  const entries: RefEntry[] = []
  for (const r of refs) {
    if (typeof r === 'string' && r !== '' && !r.includes('\0') && p.isAbsolute(r)) entries.push({ ref: r, abs: p.resolve(r) })
  }
  if (!entries.length) return { touch: null, limited: false }
  const s: CheckState = {
    p,
    platform,
    shell: opts.shell ?? 'bash',
    home: opts.home ?? homedir(),
    refs: entries,
    real: platform === process.platform,
    cache: new Map(),
    words: 0,
    parts: 0,
    definite: opts.mode === 'self-control',
    stopped: false,
    limited: false
  }
  const done = (touch: Touch | null): { touch: Touch | null; limited: boolean } => ({ touch, limited: s.limited })
  if (command.length > MAX_COMMAND_CHARS) return done(limitHit(s, { folder: entries[0].ref, how: 'names' }))
  const startCwd = typeof cwd === 'string' && cwd !== '' && p.isAbsolute(cwd) ? p.resolve(cwd) : undefined
  if (startCwd && platform === 'win32' && isUncLike(startCwd)) return done(stopOr(s, { folder: entries[0].ref, how: 'runs-in' }))
  if (startCwd) {
    const hit = touchOf(s, startCwd, false)
    if (hit) return done({ folder: hit, how: 'runs-in' })
  }
  const texts = [command]
  const unwrapped = unwrapShellCommand(command)
  if (unwrapped && unwrapped !== command.trim()) texts.push(unwrapped)
  for (const text of texts) {
    const hit = scanCommand(s, text, startCwd, 0)
    if (hit || s.stopped) return done(hit)
  }
  return done(null)
}

/** A definite-mode CheckState over `refs` (absolute ones only), or null when none is usable. */
function definiteState(refs: readonly string[], opts: Pick<ReferenceCheckOptions, 'platform' | 'home'>): CheckState | null {
  if (!Array.isArray(refs)) return null
  const platform = opts.platform ?? process.platform
  const p: PathModule = platform === 'win32' ? win32 : posix
  const entries: RefEntry[] = []
  for (const r of refs) {
    if (typeof r === 'string' && r !== '' && !r.includes('\0') && p.isAbsolute(r)) entries.push({ ref: r, abs: p.resolve(r) })
  }
  if (!entries.length) return null
  return {
    p,
    platform,
    shell: 'bash',
    home: opts.home ?? homedir(),
    refs: entries,
    real: platform === process.platform,
    cache: new Map(),
    words: 0,
    parts: 0,
    definite: true,
    stopped: false,
    limited: false
  }
}

/** `target` as an absolute path (`~` expanded, relative against cwd), or null (none, UNC / device, NUL). */
function definiteAbs(s: CheckState, target: unknown, cwd: string | undefined): string | null {
  if (typeof target !== 'string' || !target || target.includes('\0') || isUncLike(target)) return null
  const p = s.p
  let w = target
  if (w === '~' || /^~[\\/]/.test(w)) {
    if (!s.home || !p.isAbsolute(s.home)) return null
    w = p.join(s.home, w.slice(1))
  }
  const base = typeof cwd === 'string' && cwd !== '' && p.isAbsolute(cwd) ? p.resolve(cwd) : undefined
  const abs = p.isAbsolute(w) ? p.resolve(w) : base ? p.resolve(base, w) : null
  return !abs || isUncLike(abs) ? null : abs
}

/** The folder of `refs` that is at or under `abs`, or inside its tree (`abs` an ancestor), lexically and through real paths. */
function reachesBelow(s: CheckState, abs: string): string | null {
  const hit = touchOf(s, abs, false)
  if (hit) return hit
  for (const r of s.refs) if (within(s, abs, r.abs)) return r.ref
  if (!s.real) return null
  const ra = realOf(s, abs)
  for (const r of s.refs) {
    r.real ??= realOf(s, r.abs)
    if (within(s, ra, r.abs) || within(s, abs, r.real) || within(s, ra, r.real)) return r.ref
  }
  return null
}

/**
 * The folder of `refs` that `target` is AT or UNDER (never above), else null: the definite check selfControlGate.ts
 * uses for file tools. `~` expands to opts.home, a relative target resolves against `cwd` (none: null), and the
 * comparison is lexical and through real paths, case folded on win32 and darwin. A UNC or device target, a NUL
 * character or a non-string gives null (never touched on disk).
 */
export function pathAtOrUnder(
  target: unknown,
  refs: readonly string[],
  cwd: string | undefined,
  opts: Pick<ReferenceCheckOptions, 'platform' | 'home'> = {}
): string | null {
  const s = definiteState(refs, opts)
  if (!s) return null
  const abs = definiteAbs(s, target, cwd)
  return abs ? touchOf(s, abs, false) : null
}

/**
 * The folder of `refs` a file search can reach (selfControlGate.ts, Grep and Glob), else null. `root` is the search
 * folder (`~` expanded, relative against cwd). `pattern` undefined = a recursive search (Grep): it reaches every folder
 * at, under or BELOW the root, so a root that is the data dir or any ancestor of a protected path reaches it. A Glob
 * `pattern` (relative to the root, or absolute) reaches a folder when its components match the folder's (`*`, `?`,
 * `[...]`), or anything below its static folder once a `**` component appears; a glob shallower than the folder only
 * lists a parent and never counts.
 */
export function searchReaches(
  root: unknown,
  pattern: string | undefined,
  refs: readonly string[],
  cwd: string | undefined,
  opts: Pick<ReferenceCheckOptions, 'platform' | 'home'> = {}
): string | null {
  const s = definiteState(refs, opts)
  if (!s) return null
  const base = definiteAbs(s, root, cwd)
  if (pattern === undefined) return base ? reachesBelow(s, base) : null
  const full = definiteAbs(s, pattern, base ?? undefined)
  if (!full) return null
  if (!GLOB_CHAR.test(pattern) && !/[{}]/.test(pattern)) return touchOf(s, full, false)
  const parts = full.split(/[\\/]+/)
  const deep = parts.findIndex((c) => c.includes('**') || /[{}]/.test(c))
  if (deep >= 0) {
    // Everything below the static folder before the first `**` (or brace set, not expanded here) may be reached.
    const staticDir = s.p.resolve(parts.slice(0, deep).join(s.p.sep) || s.p.sep)
    const head = parts.slice(0, deep).some((c) => GLOB_CHAR.test(c))
    return head ? (globReaches(s, full) ?? reachesBelow(s, s.p.resolve(globDir(s, full)))) : reachesBelow(s, staticDir)
  }
  return touchOf(s, full, false) ?? globReaches(s, full)
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
  '[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]+',
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
