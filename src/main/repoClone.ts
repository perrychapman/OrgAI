import { execFile, execFileSync, spawn } from 'node:child_process'
import { lstatSync, mkdirSync, promises as fsp, readdirSync, realpathSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  REPO_CLONES_MAX,
  REPO_CLONE_CANCELLED_PREFIX,
  REPO_CONFIG_PATHS,
  REPO_DESTINATION_MAX_CHARS,
  REPO_SOURCE_MAX_CHARS,
  type RepoCloneFork,
  type RepoCloneInput,
  type RepoCloneProgress,
  type RepoCloneResult,
  type RepoSourceOk,
  type RepoSourceParse,
  type RepoTools
} from '@shared/types'
import { clampText, hiddenCharIn } from './capabilities/sanitize'
import { cleanProjectPath } from './store/projects'
import { canonicalDeep, isInsideEither, isNetworkPath, pathKey } from './quick/scratch'
import { allowedDirectoryRisk } from './runtime/allowedDirectories'
import { maskKeyLike } from './runtime/codexAppServer'

// ---- Constants ----

/** Nothing arrived from git for this long: the clone is stopped. No total timeout. */
export const CLONE_INACTIVITY_MS = 5 * 60_000
/** How long a fresh fork is given to become cloneable, counted from GitHub's answer. */
export const FORK_READY_TIMEOUT_MS = 60_000
const FORK_RETRY_START_MS = 2_000
const FORK_RETRY_MAX_MS = 8_000
const GH_FORK_TIMEOUT_MS = 60_000
const GH_STATUS_TIMEOUT_MS = 10_000
const SHORT_CALL_TIMEOUT_MS = 15_000
const PROGRESS_THROTTLE_MS = 250
const STDERR_TAIL_MAX = 16 * 1024
const PARTIAL_LINE_MAX = 8 * 1024
const KILL_WAIT_MS = 5_000
const CLOSE_GRACE_MS = 1_000
const FORK_RESPONSE_MAX = 1024 * 1024
const ALREADY_EXISTED_MS = 5 * 60_000
export const REPO_REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

const GH_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const GH_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/
const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/
const SEGMENT_RE = /^[A-Za-z0-9._~-]+$/
const SSH_USER_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/
const MAX_PATH_SEGMENTS = 8

// ---- Sentences (fixed; none quotes the input) ----

const P_EMPTY = 'Type or paste a repository address, such as https://github.com/owner/repo.'
const P_LONG = 'That address is too long.'
const P_HIDDEN = 'That address contains a hidden or control character. Remove it and try again.'
const P_DASH = 'That address cannot start with a dash.'
const P_HELPER = 'That kind of address is not supported. Use an https:// or ssh address.'
const P_SCHEME = 'Only https and ssh addresses can be cloned.'
const P_HTTP = 'Plain http is not allowed; use https.'
const P_LOCAL = 'That looks like a folder on this computer. Paste the repository\'s web address instead.'
const P_SPACE = 'An address cannot contain spaces.'
const P_MALFORMED = 'OrgAI could not read that address. Use a form such as https://github.com/owner/repo.'
const P_INSIDE = 'That link points inside a repository; use its main address such as https://github.com/owner/repo.'
const P_USERINFO = 'That address holds a sign-in name or token. Remove it; git will use your saved sign-in.'
const P_NEEDS_REPO = 'The address needs an owner and a repository, such as https://github.com/owner/repo.'
const P_GH_PORT = 'github.com addresses cannot include a port.'
const P_GH_OWNER = 'That is not a valid GitHub owner name.'
const P_GH_REPO = 'That is not a valid GitHub repository name.'
const P_GH_SSH_USER = 'GitHub ssh addresses use the user git, for example git@github.com:owner/repo.'
const P_SSH_USER = 'An ssh address needs a user name, for example ssh://git@host/group/repo.'
const P_HOST = 'That is not a valid host name.'
const P_PORT = 'That is not a valid port.'
const P_PATH = 'That repository path has a part OrgAI does not accept.'
const P_TOKEN = 'That address holds something that looks like a sign-in token. Remove it; git will use your saved sign-in.'
const P_SCHEME_HINT ='Start the address with https://, for example https://github.com/owner/repo.'

const MSG_NO_GIT = 'Git is not installed. Install it from git-scm.com, then try again.'
const MSG_FORK_NEEDS_GH = 'Forking needs the GitHub CLI: install gh from cli.github.com, then run gh auth login. A plain clone still works.'
const MSG_FORK_NEEDS_LOGIN = 'Forking needs you to sign in to the GitHub CLI: run gh auth login. A plain clone still works.'
const MSG_OWN_REPO = 'This is your own repository, so GitHub will not fork it. Clone it instead.'
const MSG_FORK_ONLY_GITHUB = 'Forking works for github.com repositories only. Clone it instead.'
const MSG_FORK_UNCHECKED = 'GitHub answered with something OrgAI could not check, so nothing was cloned.'
const MSG_INACTIVE = 'The download stopped: nothing arrived for 5 minutes. Check your connection and try again.'
const MSG_CLOSING = 'OrgAI is closing, so no new clone can start.'

// ---- Run/spawn injection ----

export interface RunOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
}
export interface RunResult {
  /** The exit code; null when the program did not run to an exit. */
  code: number | null
  stdout: string
  stderr: string
  /** Set when the program could not be started (ENOENT ...). */
  spawnError?: string
  timedOut?: boolean
  aborted?: boolean
  /** The program started but was stopped or overran its output limit (signal kill, maxBuffer); never "not installed". */
  failed?: boolean
}
/** One-shot process: no shell, never rejects. */
export type RunFn = (file: string, args: string[], opts: RunOptions) => Promise<RunResult>

export interface GitHandle {
  pid?: number
  onData(cb: (chunk: string) => void): void
  onExit(cb: (code: number | null) => void): void
  onClose(cb: (code: number | null) => void): void
  onError(cb: (err: Error & { code?: string }) => void): void
  kill(): void
}
export type SpawnGitFn = (file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => GitHandle

export interface RepoCloneOptions {
  dataDir: string
  /** The scripted mock: no gh, no network, no remote git. */
  mock?: boolean
  env?: NodeJS.ProcessEnv
  run?: RunFn
  spawnGit?: SpawnGitFn
  killTree?: (pid: number) => void
  killTreeSync?: (pid: number) => void
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  platform?: NodeJS.Platform
  /** The user's home folder for the destination rules (default os.homedir()); tests inject one. */
  home?: string
  /** Folders of existing projects (path, allowed and reference folders); a destination in one is refused. Throwing fails closed. */
  projectFolders?: () => string[]
  inactivityMs?: number
  closeGraceMs?: number
  killWaitMs?: number
}

// ---- Parse ----

export function parseRepoSource(input: unknown): RepoSourceParse {
  try {
    return parseInner(input)
  } catch {
    return refuse(P_MALFORMED)
  }
}

function refuse(problem: string): RepoSourceParse {
  return { ok: false, problem }
}

/** A name that looks like a credential (GitHub, GitLab token prefixes, x-access-token). Never quoted in a refusal. */
const TOKEN_SHAPE_RE = /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]|github_pat_|glpat-|x-access-token)/i
function tokenShaped(s: string): boolean {
  return TOKEN_SHAPE_RE.test(s)
}

function parseInner(input: unknown): RepoSourceParse {
  if (typeof input !== 'string') return refuse(P_EMPTY)
  const t = input.trim()
  if (!t) return refuse(P_EMPTY)
  if (t.length > REPO_SOURCE_MAX_CHARS) return refuse(P_LONG)
  if (hiddenCharIn(t)) return refuse(P_HIDDEN)
  if (t.startsWith('-')) return refuse(P_DASH)
  if (/^[A-Za-z]:/.test(t) || /^[\\/.~]/.test(t)) return refuse(P_LOCAL)
  if (/^[A-Za-z0-9+._-]+::/.test(t)) return refuse(P_HELPER)
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(t)
  if (scheme) {
    const s = scheme[1].toLowerCase()
    if (s === 'https') return parseHttps(t.slice(scheme[0].length))
    if (s === 'ssh') return parseSshUrl(t.slice(scheme[0].length))
    if (s === 'http') return refuse(P_HTTP)
    return refuse(P_SCHEME)
  }
  if (/\s/.test(t)) return refuse(P_SPACE)
  if (t.includes('\\')) return refuse(P_MALFORMED)
  const scp = /^([^@:/]+)@([^@:/]+):(.+)$/.exec(t)
  if (scp) return parseScp(scp[1], scp[2], scp[3])
  if (!t.includes('@') && !t.includes(':')) {
    const parts = t.split('/')
    if (parts.length === 2 && parts[0] && parts[1]) return parseShorthand(parts[0], parts[1])
    if (/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\//.test(t)) return refuse(P_SCHEME_HINT)
  }
  return refuse(P_MALFORMED)
}

function splitHostPort(authority: string): { host: string; port?: string } | { problem: string } {
  const i = authority.lastIndexOf(':')
  let host = authority
  let port: string | undefined
  if (i !== -1) {
    host = authority.slice(0, i)
    port = authority.slice(i + 1)
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return { problem: P_PORT }
  }
  host = host.toLowerCase()
  if (host === 'www.github.com') host = 'github.com'
  if (!HOST_RE.test(host) || host.includes('..')) return { problem: P_HOST }
  return { host, port }
}

function stripGit(name: string): string {
  return name.endsWith('.git') ? name.slice(0, -4) : name
}

function ghNames(ownerRaw: string, repoRaw: string): { owner: string; repo: string } | { problem: string } {
  if (!GH_OWNER_RE.test(ownerRaw)) return { problem: P_GH_OWNER }
  const repo = stripGit(repoRaw)
  if (!repo || repo === '.' || repo.includes('..') || repo.startsWith('-') || !GH_REPO_RE.test(repo)) return { problem: P_GH_REPO }
  return { owner: ownerRaw, repo }
}

function githubOk(owner: string, repo: string, ssh: 'scp' | 'url' | null): RepoSourceOk {
  const url = ssh === 'scp' ? `git@github.com:${owner}/${repo}.git` : ssh === 'url' ? `ssh://git@github.com/${owner}/${repo}.git` : `https://github.com/${owner}/${repo}.git`
  return { ok: true, url, host: 'github.com', owner, repo, display: `${owner}/${repo}`, suggestedFolder: suggestedFolderFor(repo), canFork: true }
}

/** Other hosts: path segments are checked, the URL keeps the typed form (`.git` as typed). */
function otherHostOk(prefix: string, hostField: string, segs: string[], form: 'url' | 'scp'): RepoSourceParse {
  if (segs.length < 1 || segs.length > MAX_PATH_SEGMENTS) return refuse(P_PATH)
  for (const s of segs) {
    if (!SEGMENT_RE.test(s) || s.includes('..') || s === '.' || s.startsWith('-')) return refuse(P_PATH)
  }
  const repo = stripGit(segs[segs.length - 1])
  if (!repo || repo === '.' || repo.startsWith('-')) return refuse(P_PATH)
  const clean = [...segs.slice(0, -1), repo]
  const owner = segs.length > 1 ? segs.slice(0, -1).join('/') : undefined
  const url = form === 'scp' ? `${prefix}:${segs.join('/')}` : `${prefix}/${segs.join('/')}`
  const out: RepoSourceOk = { ok: true, url, host: hostField, repo, display: `${hostField}/${clean.join('/')}`, suggestedFolder: suggestedFolderFor(repo), canFork: false }
  if (owner !== undefined) out.owner = owner
  return out
}

function pathSegments(tail: string): string[] | { problem: string } {
  // tail starts at the '/' after the authority.
  if (!tail.startsWith('/')) return { problem: P_NEEDS_REPO }
  let p = tail.slice(1)
  if (p.endsWith('/')) p = p.slice(0, -1)
  if (!p) return { problem: P_NEEDS_REPO }
  const segs = p.split('/')
  if (segs.some((s) => s === '')) return { problem: P_MALFORMED }
  if (segs.some(tokenShaped)) return { problem: P_TOKEN }
  return segs
}

function githubFromSegments(segs: string[], ssh: 'scp' | 'url' | null): RepoSourceParse {
  if (segs.length > 2) return refuse(P_INSIDE)
  if (segs.length < 2) return refuse(P_NEEDS_REPO)
  const names = ghNames(segs[0], segs[1])
  if ('problem' in names) return refuse(names.problem)
  return githubOk(names.owner, names.repo, ssh)
}

function parseHttps(afterColon: string): RepoSourceParse {
  if (!afterColon.startsWith('//')) return refuse(P_MALFORMED)
  const rest = afterColon.slice(2)
  if (rest.includes('\\') || /\s/.test(rest)) return refuse(P_MALFORMED)
  const cut = rest.search(/[/?#]/)
  const authority = cut === -1 ? rest : rest.slice(0, cut)
  const tail = cut === -1 ? '' : rest.slice(cut)
  if (authority.includes('@')) return refuse(P_USERINFO)
  if (/[?#]/.test(tail)) return refuse(P_INSIDE)
  const hp = splitHostPort(authority)
  if ('problem' in hp) return refuse(hp.problem)
  const segs = pathSegments(tail)
  if (!Array.isArray(segs)) return refuse(segs.problem)
  if (hp.host === 'github.com') {
    if (hp.port !== undefined) return refuse(P_GH_PORT)
    return githubFromSegments(segs, null)
  }
  const hostField = hp.port ? `${hp.host}:${hp.port}` : hp.host
  return otherHostOk(`https://${hostField}`, hostField, segs, 'url')
}

function parseSshUrl(afterColon: string): RepoSourceParse {
  if (!afterColon.startsWith('//')) return refuse(P_MALFORMED)
  const rest = afterColon.slice(2)
  if (rest.includes('\\') || /\s/.test(rest)) return refuse(P_MALFORMED)
  const cut = rest.search(/[/?#]/)
  const authority = cut === -1 ? rest : rest.slice(0, cut)
  const tail = cut === -1 ? '' : rest.slice(cut)
  if (/[?#]/.test(tail)) return refuse(P_INSIDE)
  const at = authority.indexOf('@')
  if (at === -1) return refuse(P_SSH_USER)
  const user = authority.slice(0, at)
  if (user.includes(':')) return refuse(P_USERINFO)
  if (tokenShaped(user)) return refuse(P_TOKEN)
  if (!SSH_USER_RE.test(user)) return refuse(P_SSH_USER)
  const hostPart = authority.slice(at + 1)
  if (hostPart.includes('@')) return refuse(P_MALFORMED)
  const hp = splitHostPort(hostPart)
  if ('problem' in hp) return refuse(hp.problem)
  const segs = pathSegments(tail)
  if (!Array.isArray(segs)) return refuse(segs.problem)
  if (hp.host === 'github.com') {
    if (user !== 'git') return refuse(P_GH_SSH_USER)
    if (hp.port !== undefined) return refuse(P_GH_PORT)
    return githubFromSegments(segs, 'url')
  }
  const hostField = hp.port ? `${hp.host}:${hp.port}` : hp.host
  return otherHostOk(`ssh://${user}@${hostField}`, hostField, segs, 'url')
}

function parseScp(user: string, hostRaw: string, path: string): RepoSourceParse {
  if (tokenShaped(user)) return refuse(P_TOKEN)
  if (!SSH_USER_RE.test(user)) return refuse(P_SSH_USER)
  const host = hostRaw.toLowerCase() === 'www.github.com' ? 'github.com' : hostRaw.toLowerCase()
  if (!HOST_RE.test(host) || host.includes('..')) return refuse(P_HOST)
  let p = path
  if (p.endsWith('/')) p = p.slice(0, -1)
  const segs = p.split('/')
  if (!p || segs.some((s) => s === '')) return refuse(P_MALFORMED)
  if (segs.some(tokenShaped)) return refuse(P_TOKEN)
  if (host === 'github.com') {
    if (user !== 'git') return refuse(P_GH_SSH_USER)
    return githubFromSegments(segs, 'scp')
  }
  return otherHostOk(`${user}@${host}`, host, segs, 'scp')
}

function parseShorthand(owner: string, repo: string): RepoSourceParse {
  const names = ghNames(owner, repo)
  if ('problem' in names) return refuse(names.problem)
  return githubOk(names.owner, names.repo, null)
}

const WINDOWS_RESERVED_RE = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])$/i

/** A folder name for the repository: no leading or trailing dots or spaces, never a Windows device name. */
export function suggestedFolderFor(repo: string): string {
  const name = repo.replace(/^[. ]+|[. ]+$/g, '')
  if (!name) return 'repo'
  const base = name.split('.')[0].trimEnd()
  return WINDOWS_RESERVED_RE.test(base) ? `${name}-repo` : name
}

// ---- Destination ----

const D_BAD = 'Choose a folder for the new project.'
const D_LONG = 'That folder path is too long.'
const D_HIDDEN = 'That folder path holds a hidden or control character.'
const D_NETWORK = 'Choose a folder on this computer, not a network or device path.'
const D_RELATIVE = 'Use the full path of the folder.'
const D_STREAM = 'That folder path has a colon in it, which Windows does not allow there.'
const D_NAME = 'A part of that folder path is not a valid folder name on Windows.'
const D_DOTS = 'That folder path has a "." or ".." part. Use the full path.'
const D_ROOT = 'Choose a folder inside a drive, not the drive itself.'
const D_DATA = "Choose a folder outside OrgAI's own data folder."
const D_UNCHECKED = 'OrgAI could not check that folder.'
const D_LINK = 'That folder is a link. Choose the real folder.'
const D_FILE = 'That path is a file, not a folder.'
const D_NOT_EMPTY = 'That folder is not empty. Choose an empty or new folder.'
const D_UNREADABLE = 'OrgAI could not read that folder.'
const D_ANCESTOR = 'Part of that path is a file, not a folder.'
const D_UNSAFE = 'That folder is one OrgAI will not clone into: files there can run or sign in later. Choose another folder.'
const D_PROJECT = 'That folder belongs to an existing project. Choose a new folder.'
const PROTECTED_SEGMENTS = new Set(['.git', '.claude', '.codex'])

function hasProtectedSegment(path: string): boolean {
  return path.split(/[\\/]+/).some((s) => PROTECTED_SEGMENTS.has(s.toLowerCase()))
}

/** Context for the destination rules; both parts are injectable for tests. */
export interface DestinationContext {
  home?: string
  projectFolders?: () => string[]
}

/** The path to use, or the one-line problem. Pure checks first; the file system only after they pass. */
export function checkDestination(raw: unknown, dataDir: string, platform: NodeJS.Platform = process.platform, ctx: DestinationContext = {}): { path: string } | { problem: string } {
  if (typeof raw !== 'string') return { problem: D_BAD }
  if (raw.length > REPO_DESTINATION_MAX_CHARS * 2) return { problem: D_LONG }
  const cleaned = cleanProjectPath(raw)
  if (!cleaned) return { problem: D_BAD }
  if (cleaned.length > REPO_DESTINATION_MAX_CHARS) return { problem: D_LONG }
  if (hiddenCharIn(cleaned)) return { problem: D_HIDDEN }
  if (/^[\\/]{2}/.test(cleaned) || isNetworkPath(cleaned)) return { problem: D_NETWORK }
  const win = platform === 'win32'
  if (win ? !/^[a-zA-Z]:[\\/]/.test(cleaned) : !cleaned.startsWith('/')) return { problem: D_RELATIVE }
  if (win && cleaned.slice(2).includes(':')) return { problem: D_STREAM }
  const segs = (win ? cleaned.slice(2).split(/[\\/]+/) : cleaned.split('/')).filter((s) => s !== '')
  for (const seg of segs) {
    if (seg === '.' || seg === '..') return { problem: D_DOTS }
    if (PROTECTED_SEGMENTS.has(seg.toLowerCase())) return { problem: D_UNSAFE }
    if (win) {
      if (/[. ]$/.test(seg)) return { problem: D_NAME }
      if (WINDOWS_RESERVED_RE.test(seg.split('.')[0].trimEnd())) return { problem: D_NAME }
    }
  }
  const dest = resolve(cleaned)
  if (dirname(dest) === dest) return { problem: D_ROOT }
  const fsProblem = destinationFsProblem(dest, dataDir, platform, ctx)
  return fsProblem ? { problem: fsProblem } : { path: dest }
}

/** The one-line problem with a destination, or null when it is usable. */
export function destinationProblem(raw: unknown, dataDir: string, platform: NodeJS.Platform = process.platform, ctx: DestinationContext = {}): string | null {
  const r = checkDestination(raw, dataDir, platform, ctx)
  return 'problem' in r ? r.problem : null
}

function destinationFsProblem(dest: string, dataDir: string, platform: NodeJS.Platform, ctx: DestinationContext): string | null {
  try {
    if (dataDir && (isInsideEither(dataDir, dest) || isInsideEither(dest, dataDir))) return D_DATA
    const real = canonicalDeep(dest)
    if (/^[\\/]{2}/.test(real) || isNetworkPath(real)) return D_NETWORK
    // Folders that run or sign in later: judged on the typed and the real spelling, against both spellings of home.
    const spellings = real === dest ? [dest] : [dest, real]
    if (hasProtectedSegment(real)) return D_UNSAFE
    const home = ctx.home ?? homedir()
    const homes = home ? [...new Set([home, canonicalDeep(home)])] : ['']
    for (const s of spellings) {
      for (const h of homes) {
        if (allowedDirectoryRisk(s, { home: h, platform }) === 'unsafe') return D_UNSAFE
      }
    }
  } catch {
    return D_UNCHECKED
  }
  if (ctx.projectFolders) {
    try {
      const list = ctx.projectFolders()
      if (!Array.isArray(list)) return D_UNCHECKED
      for (const f of list) {
        if (typeof f === 'string' && f && isAbsolute(f) && isInsideEither(f, dest)) return D_PROJECT
      }
    } catch {
      return D_UNCHECKED
    }
  }
  let st
  try {
    st = lstatSync(dest)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return D_UNCHECKED
    return ancestorProblem(dest)
  }
  if (st.isSymbolicLink()) return D_LINK
  if (!st.isDirectory()) return D_FILE
  try {
    if (readdirSync(dest).length > 0) return D_NOT_EMPTY
  } catch {
    return D_UNREADABLE
  }
  return null
}

function ancestorProblem(dest: string): string | null {
  let probe = dirname(dest)
  for (let i = 0; i < 256; i++) {
    try {
      const st = statSync(probe)
      return st.isDirectory() ? null : D_ANCESTOR
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') return code === 'ENOTDIR' ? D_ANCESTOR : D_UNCHECKED
    }
    const parent = dirname(probe)
    if (parent === probe) return null
    probe = parent
  }
  return D_UNCHECKED
}

/** What one clone call made on disk. Cleanup removes exactly this. */
export interface DestRecord {
  dest: string
  /** Directories this call created, outermost first (dest included when it did not exist). */
  createdDirs: string[]
  /** True when dest existed already (an empty directory). */
  preexisting: boolean
  /** The real path of dest when it was prepared; cleanup removes nothing when dest no longer resolves to it. */
  real?: string
}

const RM_OPTS = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 } as const

/**
 * Create the destination (and missing parents, one at a time, recording each) so it exists empty before git runs.
 * Throws a readable error and removes what it made when it cannot.
 */
export function prepareDestination(dest: string): DestRecord {
  const missing: string[] = []
  let probe = dest
  for (let i = 0; i < 256; i++) {
    try {
      lstatSync(probe)
      break
    } catch (e) {
      // Only "does not exist" means missing; any other error and the folder is not touched.
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw new Error(code === 'ENOTDIR' ? D_ANCESTOR : D_UNCHECKED)
      missing.unshift(probe)
      const parent = dirname(probe)
      if (parent === probe) break
      probe = parent
    }
  }
  const rec: DestRecord = { dest, createdDirs: [], preexisting: missing.length === 0 }
  const fail = (): never => {
    // Only directories this call made, innermost first, never recursive.
    for (const dir of [...rec.createdDirs].reverse()) {
      try {
        rmdirSync(dir)
      } catch {
        // not empty or already gone: not ours to force
      }
    }
    throw new Error(`OrgAI could not create the folder ${dest}. Check that you can write there.`)
  }
  for (const dir of missing) {
    try {
      mkdirSync(dir)
      rec.createdDirs.push(dir)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST' && dir === dest) rec.preexisting = true
      else if ((e as NodeJS.ErrnoException).code !== 'EEXIST') fail()
    }
  }
  if (rec.preexisting) {
    // The folder was there already: it must still be a real, empty directory. Nothing inside it is ours to remove.
    let unusable = false
    try {
      const st = lstatSync(dest)
      unusable = st.isSymbolicLink() || !st.isDirectory() || readdirSync(dest).length > 0
    } catch {
      unusable = true
    }
    if (unusable) {
      removeCreatedParents(rec)
      throw new Error(D_NOT_EMPTY)
    }
  }
  try {
    rec.real = realpathSync(dest)
  } catch {
    fail()
  }
  return rec
}

/** True when dest still resolves to the place it was prepared at (no link or swapped ancestor since). */
function sameReal(rec: DestRecord, real: string): boolean {
  return rec.real === undefined || pathKey(real) === pathKey(rec.real)
}

function removeCreatedParents(rec: DestRecord): void {
  for (const dir of [...rec.createdDirs].reverse()) {
    if (dir === rec.dest) continue
    try {
      rmdirSync(dir)
    } catch {
      break
    }
  }
}

function removeChildren(dir: string): boolean {
  let ok = true
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return false
  }
  for (const name of names) {
    try {
      rmSync(join(dir, name), RM_OPTS)
    } catch {
      ok = false
    }
  }
  return ok
}

/** True when dest is a real directory right now (not a link, not a file, not gone). */
function isRealDir(path: string): 'dir' | 'gone' | 'other' {
  try {
    const st = lstatSync(path)
    return !st.isSymbolicLink() && st.isDirectory() ? 'dir' : 'other'
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'other'
  }
}

function realMatches(rec: DestRecord): boolean {
  try {
    return sameReal(rec, realpathSync(rec.dest))
  } catch {
    return false
  }
}

async function realMatchesAsync(rec: DestRecord): Promise<boolean> {
  try {
    return sameReal(rec, await fsp.realpath(rec.dest))
  } catch {
    return false
  }
}

async function isRealDirAsync(path: string): Promise<'dir' | 'gone' | 'other'> {
  try {
    const st = await fsp.lstat(path)
    return !st.isSymbolicLink() && st.isDirectory() ? 'dir' : 'other'
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'other'
  }
}

async function removeChildrenAsync(dir: string): Promise<boolean> {
  let ok = true
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch {
    return false
  }
  for (const name of names) {
    try {
      await fsp.rm(join(dir, name), RM_OPTS)
    } catch {
      ok = false
    }
  }
  return ok
}

/** Empty dest between fork attempts (keeps the folder). False when something could not be removed. */
export function emptyDestination(rec: DestRecord): boolean {
  if (isRealDir(rec.dest) !== 'dir' || !realMatches(rec)) return false
  return removeChildren(rec.dest)
}

/** emptyDestination without blocking the main thread. */
export async function emptyDestinationAsync(rec: DestRecord): Promise<boolean> {
  if ((await isRealDirAsync(rec.dest)) !== 'dir' || !(await realMatchesAsync(rec))) return false
  return removeChildrenAsync(rec.dest)
}

/**
 * Remove what this call made. A pre-existing dest stays, emptied. A dest we created is removed with the parents we
 * created (innermost first, non-recursive, stopping at the first that is not empty). Nothing is removed when git said
 * the folder was not empty (someone else's content), when dest has become a link or file, or when it no longer
 * resolves to where it was prepared. Returns false when something remains that should not.
 */
export function cleanupDestination(rec: DestRecord, opts: { contentsAdded?: boolean } = {}): boolean {
  if (opts.contentsAdded) return true
  const state = isRealDir(rec.dest)
  if (state === 'other') return false
  let ok = true
  if (state === 'dir') {
    if (!realMatches(rec)) return false
    if (rec.preexisting) ok = removeChildren(rec.dest)
    else {
      try {
        rmSync(rec.dest, RM_OPTS)
      } catch {
        ok = false
      }
    }
  }
  if (!ok) return false
  removeCreatedParents(rec)
  return true
}

/** cleanupDestination without blocking the main thread (same rules, line for line). */
export async function cleanupDestinationAsync(rec: DestRecord, opts: { contentsAdded?: boolean } = {}): Promise<boolean> {
  if (opts.contentsAdded) return true
  const state = await isRealDirAsync(rec.dest)
  if (state === 'other') return false
  let ok = true
  if (state === 'dir') {
    if (!(await realMatchesAsync(rec))) return false
    if (rec.preexisting) ok = await removeChildrenAsync(rec.dest)
    else {
      try {
        await fsp.rm(rec.dest, RM_OPTS)
      } catch {
        ok = false
      }
    }
  }
  if (!ok) return false
  removeCreatedParents(rec)
  return true
}

// ---- Repo config scan ----

/** The REPO_CONFIG_PATHS present in `dest`, in table order. Only lstat; a link counts as present and is never followed. */
export function scanRepoConfig(dest: string): string[] {
  const out: string[] = []
  for (const { path } of REPO_CONFIG_PATHS) {
    const parts = path.split('/')
    let cur = dest
    let found = true
    for (let i = 0; i < parts.length; i++) {
      cur = join(cur, parts[i])
      try {
        const st = lstatSync(cur)
        // A link on the way: the rest would be read through it, so stop here and count the path as present.
        if (st.isSymbolicLink()) break
      } catch {
        found = false
        break
      }
    }
    if (found) out.push(path)
  }
  return out
}

// ---- Environment and arguments ----

/** The only GIT_* names that reach git: ssh and certificate settings. Every other GIT_* name is dropped. */
const GIT_ENV_ALLOW = new Set(['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH'])
const GH_ENV_DROP = ['GH_HOST', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_DEBUG', 'DEBUG', 'GH_REPO']

function buildEnv(base: NodeJS.ProcessEnv, drop: string[], set: Record<string, string>): NodeJS.ProcessEnv {
  const dropped = new Set([...drop, ...Object.keys(set)].map((k) => k.toUpperCase()))
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || dropped.has(k.toUpperCase())) continue
    out[k] = v
  }
  return Object.assign(out, set)
}

export function gitEnv(base: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const fold = platform === 'win32'
  const drop = Object.keys(base).filter((k) => {
    const name = fold ? k.toUpperCase() : k
    return name.startsWith('GIT_') && !GIT_ENV_ALLOW.has(name)
  })
  return buildEnv(base, drop, {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'https:ssh',
    SSH_ASKPASS_REQUIRE: 'never',
    LC_ALL: 'C',
    LANGUAGE: 'C'
  })
}

export function ghEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return buildEnv(base, GH_ENV_DROP, { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' })
}

/** The exact argument list of the clone (pinned by a test). */
export function cloneArgs(url: string, dest: string): string[] {
  return ['-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', 'clone', '--progress', '--no-recurse-submodules', '--', url, dest]
}

export function forkArgs(owner: string, repo: string): string[] {
  return ['api', '--method', 'POST', '--hostname', 'github.com', `repos/${owner}/${repo}/forks`]
}

export const GH_AUTH_ARGS: readonly string[] = ['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts']
export const GH_AUTH_ARGS_OLD: readonly string[] = ['auth', 'status', '--hostname', 'github.com']

// ---- Scrubbing and error mapping ----

/** Strip anything that could be a credential from text that came from git, gh or the remote. */
export function scrubStderr(text: string): string {
  return maskKeyLike(String(text ?? ''))
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s@]*@/g, '$1')
    .replace(/\bx-access-token:[^\s@]*/gi, '[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/\bglpat-[A-Za-z0-9_-]+/g, '[redacted]')
}

export type CloneErrorKind = 'spawn' | 'disk' | 'folder' | 'hostkey' | 'not-found' | 'signin' | 'network' | 'other'

export function cloneErrorKind(stderr: string): CloneErrorKind {
  const s = String(stderr ?? '')
  if (/no space left|disk quota/i.test(s)) return 'disk'
  if (/already exists and is not an empty directory|could not create work tree|unable to create file|filename too long|could not create leading directories/i.test(s)) return 'folder'
  if (/permission denied/i.test(s) && !/publickey/i.test(s)) return 'folder'
  if (/host key verification failed/i.test(s)) return 'hostkey'
  if (/repository\b[^\n]*not found|(?<!command )\bnot found\b|error: 404|does not appear to be a git repository/i.test(s)) return 'not-found'
  if (/authentication failed|could not read username|terminal prompts disabled|error: 40[13]|permission denied \(publickey|invalid username or (?:password|token)/i.test(s)) return 'signin'
  if (/could not resolve host|could not resolve hostname|failed to connect|connection timed out|connection refused|network is unreachable|connection reset|\bssl\b|unable to access|timed out/i.test(s)) return 'network'
  if (/could not read from remote repository/i.test(s)) return 'signin'
  return 'other'
}

/** True when git's own `fatal:` line says `dest` already exists and is not empty. Remote text never counts. */
export function gitSaysNotEmpty(tail: string, dest: string): boolean {
  for (const raw of String(tail ?? '').split(/[\r\n]+/)) {
    const m = /^fatal: destination path '([^']{1,2000})' already exists and is not an empty directory\.?$/.exec(raw.trim())
    if (!m) continue
    try {
      if (pathKey(m[1]) === pathKey(dest)) return true
    } catch {
      // unreadable path: not a match
    }
  }
  return false
}

export interface CloneErrorContext {
  /** `owner/repo` or `host/group/repo`. */
  display: string
  host: string
  /** The destination folder, named in folder problems. */
  dest?: string
  /** The program could not be started. */
  spawnError?: boolean
}

/** One readable line for a failed clone. Never empty, never holds a credential. */
export function cloneErrorMessage(stderr: string, ctx: CloneErrorContext): string {
  if (ctx.spawnError) return MSG_NO_GIT
  const scrubbed = scrubStderr(stderr)
  const display = clampText(ctx.display, 120)
  const host = clampText(ctx.host, 100)
  switch (cloneErrorKind(scrubbed)) {
    case 'disk':
      return 'There is not enough disk space for this repository.'
    case 'folder':
      return `Git could not write to the folder${ctx.dest ? ` ${clampText(ctx.dest, 200)}` : ''}. Check that it is empty and that you can create files there.`
    case 'hostkey':
      return `Git does not trust the ssh key of ${host} yet. Connect to it once with ssh from a terminal to accept its key, then try again.`
    case 'not-found':
      return `${display} was not found, or this account has no access to it.`
    case 'signin':
      return `Git could not sign in to ${host}. Sign in with your usual git credentials, then try again.`
    case 'network':
      return `Could not reach ${host}. Check your connection, or a proxy or firewall.`
    default: {
      const lines = scrubbed.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean)
      const last = clampText(lines[lines.length - 1] ?? '', 200).replace(/[.\s]+$/, '')
      return last ? `Git could not clone ${display}: ${last}.` : `Git could not clone ${display}.`
    }
  }
}

/** gh's failure text for the fork call. Wording is unverified, so the matching is generous. */
export function forkErrorMessage(stderr: string, display: string): string {
  const s = scrubStderr(stderr)
  const d = clampText(display, 120)
  if (/saml|single sign-on|\bsso\b/i.test(s)) return 'Your organisation requires you to authorise the GitHub CLI for it. Run gh auth refresh, then try again.'
  if (/http 401|bad credentials|requires authentication/i.test(s)) return MSG_FORK_NEEDS_LOGIN
  if (/forbids forking|cannot be forked|forking is disabled|forks? (?:are |is )?disabled|disabled/i.test(s)) return `${d} does not allow forking. Clone it instead.`
  if (/http 404|not found/i.test(s)) return `${d} was not found, or your GitHub account has no access to it.`
  const lines = s.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean)
  const first = clampText(lines[0] ?? '', 200).replace(/[.\s]+$/, '')
  return first ? `GitHub could not fork ${d}: ${first}.` : `GitHub could not fork ${d}.`
}

// ---- Fork response ----

export interface ForkOk {
  ok: true
  fullName: string
  owner: string
  repo: string
  htmlUrl: string
  cloneUrl: string
  alreadyExisted: boolean
}
export interface ForkRefused {
  ok: false
  problem: string
  /** The answer was the source repository itself (the user owns it). */
  own?: boolean
}

/** Check gh's answer to POST repos/<owner>/<repo>/forks. Nothing is trusted: URLs are rebuilt and compared exactly. */
export function validateForkResponse(stdout: unknown, source: { owner: string; repo: string }, now: number = Date.now()): ForkOk | ForkRefused {
  const bad: ForkRefused = { ok: false, problem: MSG_FORK_UNCHECKED }
  if (typeof stdout !== 'string' || stdout.length > FORK_RESPONSE_MAX) return bad
  let body: unknown
  try {
    body = JSON.parse(stdout)
  } catch {
    return bad
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad
  const b = body as Record<string, unknown>
  const fullName = b.full_name
  if (typeof fullName !== 'string' || fullName.length > 200) return bad
  const parts = fullName.split('/')
  if (parts.length !== 2) return bad
  const [owner, repoRaw] = parts
  const repo = repoRaw
  if (!GH_OWNER_RE.test(owner) || !GH_REPO_RE.test(repo) || repo === '.' || repo.includes('..') || repo.startsWith('-')) return bad
  if (b.clone_url !== `https://github.com/${fullName}.git` || b.html_url !== `https://github.com/${fullName}`) return bad
  if (fullName.toLowerCase() === `${source.owner}/${source.repo}`.toLowerCase()) return { ok: false, problem: MSG_OWN_REPO, own: true }
  if (b.fork !== true) return bad
  let alreadyExisted = false
  if (typeof b.created_at === 'string') {
    const t = Date.parse(b.created_at)
    if (Number.isFinite(t) && now - t > ALREADY_EXISTED_MS) alreadyExisted = true
  }
  return { ok: true, fullName, owner, repo, htmlUrl: `https://github.com/${fullName}`, cloneUrl: `https://github.com/${fullName}.git`, alreadyExisted }
}

// ---- gh auth status ----

export interface GhAuthReading {
  loggedIn: boolean
  login?: string
  detail?: string
}

const D_EXPIRED = 'Your GitHub CLI sign-in has expired. Run gh auth login.'
const D_UNREACHABLE = 'OrgAI could not reach GitHub to check your sign-in.'
const D_LOGGED_OUT = 'Run gh auth login to sign in to the GitHub CLI.'
const D_UNCHECKED_GH = 'OrgAI could not check your GitHub CLI sign-in.'
const D_NO_GH = 'Install the GitHub CLI from cli.github.com to fork a repository.'

/** Read `gh auth status --json hosts`. Null when the text is not that JSON. `detail` is always a fixed sentence. */
export function readGhAuthJson(stdout: string): GhAuthReading | null {
  let body: unknown
  try {
    body = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!body || typeof body !== 'object') return null
  const hosts = (body as { hosts?: unknown }).hosts
  if (!hosts || typeof hosts !== 'object' || Array.isArray(hosts)) return null
  const list = (hosts as Record<string, unknown>)['github.com']
  const entries = Array.isArray(list) ? list.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && !Array.isArray(e)) : []
  const active = entries.find((e) => e.active === true)
  if (!active) return { loggedIn: false, detail: D_LOGGED_OUT }
  const login = typeof active.login === 'string' && GH_OWNER_RE.test(active.login) ? active.login : undefined
  const state = active.state
  if (state === 'success') return { loggedIn: true, ...(login ? { login } : {}) }
  const err = typeof active.error === 'string' ? active.error : ''
  if (/invalid|expired|bad credentials|\b401\b/i.test(err)) return { loggedIn: false, ...(login ? { login } : {}), detail: D_EXPIRED }
  return { loggedIn: true, ...(login ? { login } : {}), detail: D_UNREACHABLE }
}

// ---- Output reading ----

export interface ParsedProgress {
  phase: 'receiving' | 'resolving' | 'updating' | 'other'
  text: string
  percent?: number
}

const PROGRESS_LINE_RE = /^(Receiving objects|Resolving deltas|Updating files|Checking out files|Counting objects|Compressing objects|Enumerating objects|Checking connectivity|Filtering content)\b/

/** One git progress line to a fixed label, or null. Remote lines never become text. */
export function parseProgressLine(line: string): ParsedProgress | null {
  const l = line.trim()
  const m = PROGRESS_LINE_RE.exec(l)
  if (!m) return null
  const pct = /(\d{1,3})%/.exec(l)
  const raw = pct ? Math.min(100, Number(pct[1])) : undefined
  switch (m[1]) {
    case 'Receiving objects':
      return { phase: 'receiving', text: 'Receiving files', percent: raw }
    case 'Resolving deltas':
      return { phase: 'resolving', text: 'Resolving changes', percent: raw }
    case 'Updating files':
    case 'Checking out files':
      return { phase: 'updating', text: 'Writing files', percent: raw }
    default:
      return { phase: 'other', text: 'Contacting the server' }
  }
}

/** Splits git's output on \r and \n, keeps a bounded tail of the non-progress lines, reports monotonic overall percent. */
export class CloneOutputReader {
  private partial = ''
  private lines: string[] = []
  private size = 0
  private last = 0
  constructor(private readonly onProgress: (p: { text: string; percent: number }) => void) {}

  feed(chunk: string): void {
    const parts = (this.partial + chunk).split(/[\r\n]/)
    this.partial = (parts.pop() ?? '').slice(-PARTIAL_LINE_MAX)
    for (const line of parts) this.line(line)
  }

  end(): void {
    const rest = this.partial
    this.partial = ''
    if (rest) this.line(rest)
  }

  get tail(): string {
    return this.lines.join('\n')
  }

  private line(raw: string): void {
    const line = raw.trim()
    if (!line) return
    // Text the remote sent never enters the tail: it must not steer a decision or a message.
    if (/^remote:/i.test(line)) return
    {
      const p = parseProgressLine(line)
      if (p) {
        let overall = this.last
        if (p.percent !== undefined) {
          if (p.phase === 'receiving') overall = p.percent * 0.8
          else if (p.phase === 'resolving') overall = 80 + p.percent * 0.15
          else if (p.phase === 'updating') overall = 95 + p.percent * 0.05
        }
        this.last = Math.max(this.last, Math.round(overall))
        this.onProgress({ text: p.text, percent: this.last })
        return
      }
    }
    this.lines.push(line.slice(0, 1000))
    this.size += line.length + 1
    while (this.size > STDERR_TAIL_MAX && this.lines.length > 1) this.size -= (this.lines.shift() as string).length + 1
  }
}

// ---- Mock ----

/** The mock's marker repositories (`owner/repo`, lowercase) and what each does; docs and a test read this table. */
export const MOCK_REPO_MARKERS: readonly { repo: string; behaviour: string }[] = [
  { repo: 'mock-org/with-agents', behaviour: 'A repository with .claude/agents/mock-reviewer.md, .claude/settings.json, .mcp.json, AGENTS.md and README.md.' },
  { repo: 'mock-org/slow', behaviour: 'The cloning phase takes about 20 seconds with a tick every 500 ms; for driving cancel.' },
  { repo: 'mock-org/missing', behaviour: 'Fails after a short delay with the not-found sentence (in fork mode at the fork step, so it never waits for the fork).' },
  { repo: 'mock-org/private', behaviour: 'Fails with the sign-in sentence.' },
  { repo: 'mock-org/unreachable', behaviour: 'Fails with the could-not-reach sentence.' },
  { repo: 'mock-org/no-fork', behaviour: 'Fork mode answers the does-not-allow-forking sentence; clone mode works.' },
  { repo: 'mock-org/fork-clone-fails', behaviour: 'The fork is made, the clone fails, and the message names the fork URL.' },
  { repo: 'mock-org/fork-exists', behaviour: 'The fork is made with alreadyExisted true.' },
  { repo: 'mock-org/fork-slow', behaviour: 'About 4 seconds in waiting-for-fork before cloning.' },
  { repo: 'mock-user/<anything>', behaviour: 'Fork mode answers the own-repository sentence; clone mode works.' }
]
const MOCK_USER = 'mock-user'

function mockFiles(key: string, repo: string): Record<string, string> {
  if (key === 'mock-org/with-agents') {
    return {
      '.claude/agents/mock-reviewer.md': '---\nname: mock-reviewer\ndescription: Reviews changes for mistakes and missing tests\ntools: Read, Grep, Glob\n---\nYou review code changes. Report problems; do not edit files.\n',
      '.claude/settings.json': '{"permissions":{"allow":["Bash(npm test:*)"]}}\n',
      '.mcp.json': '{"mcpServers":{}}\n',
      'AGENTS.md': '# Agents\n\nRun the tests before you finish.\n',
      'README.md': `# ${repo}\n\nA mock repository with agent definitions.\n`
    }
  }
  return { 'README.md': `# ${repo}\n` }
}

// ---- Service ----

interface Job {
  id: string
  controller: AbortController
  cancelled: boolean
  disposed: boolean
  forkInFlight: boolean
  fork?: { htmlUrl: string }
  record?: DestRecord
  contentsAdded: boolean
  pid?: number
  killProcess?: () => void
}

type AttemptFailure = { ok: false; kind: CloneErrorKind | 'empty' | 'inactive'; stderr: string }
type AttemptResult = { ok: true } | AttemptFailure
type Emit = (e: Omit<RepoCloneProgress, 'requestId'>) => void

interface ProcessOutcome {
  code: number | null
  tail: string
  spawnError?: string
  inactive?: boolean
}

export class RepoCloneService {
  private readonly jobs = new Map<string, Job>()
  private disposed = false
  private readonly dataDir: string
  private readonly mock: boolean
  private readonly envBase: NodeJS.ProcessEnv | undefined
  private readonly run: RunFn
  private readonly spawnGit: SpawnGitFn
  private readonly killTree: (pid: number) => void
  private readonly killTreeSync: (pid: number) => void
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly now: () => number
  private readonly platform: NodeJS.Platform
  private readonly destCtx: DestinationContext
  private readonly folderLocks = new Set<string>()
  private readonly inactivityMs: number
  private readonly closeGraceMs: number
  private readonly killWaitMs: number

  constructor(opts: RepoCloneOptions) {
    this.dataDir = opts.dataDir
    this.mock = opts.mock === true
    this.envBase = opts.env
    this.platform = opts.platform ?? process.platform
    this.destCtx = { ...(opts.home !== undefined ? { home: opts.home } : {}), ...(opts.projectFolders ? { projectFolders: opts.projectFolders } : {}) }
    this.run = opts.run ?? defaultRun
    this.spawnGit = opts.spawnGit ?? defaultSpawnGit(this.platform)
    this.killTree = opts.killTree ?? defaultKillTree(this.platform)
    this.killTreeSync = opts.killTreeSync ?? defaultKillTreeSync(this.platform)
    this.sleep = opts.sleep ?? defaultSleep
    this.now = opts.now ?? Date.now
    this.inactivityMs = opts.inactivityMs ?? CLONE_INACTIVITY_MS
    this.closeGraceMs = opts.closeGraceMs ?? CLOSE_GRACE_MS
    this.killWaitMs = opts.killWaitMs ?? KILL_WAIT_MS
  }

  private get env(): NodeJS.ProcessEnv {
    return this.envBase ?? process.env
  }

  parse(text: unknown): RepoSourceParse {
    return parseRepoSource(text)
  }

  // ---- Binaries ----

  /** Absolute path of git or gh from PATH, or null. Never a .cmd shim on Windows; never searches the cwd. */
  async resolveBinary(name: 'git' | 'gh', signal?: AbortSignal): Promise<string | null> {
    const win = this.platform === 'win32'
    const p = win ? nodePath.win32 : nodePath.posix
    const opts: RunOptions = { cwd: tmpdir(), env: this.env, timeoutMs: 8_000, signal }
    const res = win
      ? await this.run(p.join(this.env.SystemRoot ?? this.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'where.exe'), [`$PATH:${name}`], opts)
      : await this.run('which', ['-a', name], opts)
    if (res.spawnError || res.code !== 0) return null
    for (const raw of res.stdout.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || !p.isAbsolute(line) || hiddenCharIn(line)) continue
      if (win && !/\.exe$/i.test(line)) continue
      return line
    }
    return null
  }

  private systemTool(name: string): string {
    return nodePath.win32.join(this.env.SystemRoot ?? this.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', name)
  }

  // ---- tools() ----

  async tools(): Promise<RepoTools> {
    try {
      return await this.toolsInner()
    } catch {
      return { git: { available: false }, gh: { available: false, loggedIn: false, detail: D_UNCHECKED_GH } }
    }
  }

  private async toolsInner(): Promise<RepoTools> {
    if (this.mock) return this.mockTools()
    const git = await this.gitInfo()
    const gh = await this.ghAccount()
    if (!gh.available) return { git, gh: { available: false, loggedIn: false, detail: D_NO_GH } }
    return { git, gh: { available: true, loggedIn: gh.loggedIn, ...(gh.login ? { login: gh.login } : {}), ...(gh.detail ? { detail: gh.detail } : {}) } }
  }

  private mockTools(): RepoTools {
    const gitMissing = this.env.ORGAI_MOCK_GIT === 'missing'
    const gh = this.env.ORGAI_MOCK_GH
    const git = gitMissing ? { available: false } : { available: true, version: 'mock' }
    if (gh === 'missing') return { git, gh: { available: false, loggedIn: false, detail: D_NO_GH } }
    if (gh === 'logged-out') return { git, gh: { available: true, loggedIn: false, detail: D_LOGGED_OUT } }
    return { git, gh: { available: true, loggedIn: true, login: MOCK_USER } }
  }

  private async gitInfo(): Promise<{ available: boolean; version?: string }> {
    const bin = await this.resolveBinary('git')
    if (!bin) return { available: false }
    const res = await this.run(bin, ['--version'], { cwd: tmpdir(), env: gitEnv(this.env), timeoutMs: SHORT_CALL_TIMEOUT_MS })
    const m = /git version (\S+)/.exec(res.stdout)
    return m ? { available: true, version: clampText(m[1], 40) } : { available: true }
  }

  private async ghAccount(signal?: AbortSignal): Promise<{ available: false } | ({ available: true; bin: string; uncertain?: boolean } & GhAuthReading)> {
    const bin = await this.resolveBinary('gh', signal)
    if (!bin) return { available: false }
    const opts: RunOptions = { cwd: tmpdir(), env: ghEnv(this.env), timeoutMs: GH_STATUS_TIMEOUT_MS, signal }
    const res = await this.run(bin, [...GH_AUTH_ARGS], opts)
    if (res.spawnError || res.timedOut || res.aborted || res.failed) return { available: true, bin, loggedIn: false, detail: D_UNCHECKED_GH, uncertain: true }
    const parsed = readGhAuthJson(res.stdout)
    if (parsed) return { available: true, bin, ...parsed }
    if (/unknown flag|unknown shorthand/i.test(res.stderr)) {
      const old = await this.run(bin, [...GH_AUTH_ARGS_OLD], opts)
      if (old.spawnError || old.timedOut || old.aborted || old.failed) return { available: true, bin, loggedIn: false, detail: D_UNCHECKED_GH, uncertain: true }
      if (old.code === 0) {
        const m = /account (\S+)/.exec(`${old.stdout}\n${old.stderr}`)
        const login = m && GH_OWNER_RE.test(m[1]) ? m[1] : undefined
        return { available: true, bin, loggedIn: true, ...(login ? { login } : {}) }
      }
      return { available: true, bin, loggedIn: false, detail: D_LOGGED_OUT }
    }
    return { available: true, bin, loggedIn: false, detail: D_UNCHECKED_GH, uncertain: true }
  }

  // ---- clone() ----

  cancel(requestId: unknown): void {
    if (typeof requestId !== 'string') return
    const job = this.jobs.get(requestId)
    if (!job) return
    this.cancelJob(job)
  }

  private cancelJob(job: Job): void {
    job.cancelled = true
    job.controller.abort()
    try {
      job.killProcess?.()
    } catch {
      // already gone
    }
  }

  /** Stop every clone now and clean up what they made, synchronously. Idempotent; new clones are refused afterwards. */
  dispose(): void {
    this.disposed = true
    for (const job of [...this.jobs.values()]) {
      job.cancelled = true
      job.disposed = true
      job.controller.abort()
      if (job.pid !== undefined) {
        try {
          this.killTreeSync(job.pid)
        } catch {
          // best effort
        }
      }
      if (job.record) {
        try {
          cleanupDestination(job.record, { contentsAdded: job.contentsAdded })
        } catch {
          // best effort
        }
      }
    }
  }

  async clone(input: RepoCloneInput, onProgress: (event: RepoCloneProgress) => void): Promise<RepoCloneResult> {
    if (this.disposed) throw new Error(MSG_CLOSING)
    const i = (input ?? {}) as Partial<RepoCloneInput>
    if (typeof i.requestId !== 'string' || !REPO_REQUEST_ID_RE.test(i.requestId)) throw new Error('Invalid clone request.')
    if (this.jobs.has(i.requestId)) throw new Error('That clone is already running.')
    if (this.jobs.size >= REPO_CLONES_MAX) throw new Error('Too many clones are running. Wait for one to finish.')
    const source = parseRepoSource(i.source)
    if (!source.ok) throw new Error(source.problem)
    if (i.mode !== 'clone' && i.mode !== 'fork') throw new Error('Choose clone or fork.')
    if (i.mode === 'fork' && !source.canFork) throw new Error(MSG_FORK_ONLY_GITHUB)
    const dest = checkDestination(i.destination, this.dataDir, this.platform, this.destCtx)
    if ('problem' in dest) throw new Error(dest.problem)
    // One job per folder, taken before any await: both spellings, so a link or 8.3 name cannot get around it.
    let keys: string[]
    try {
      keys = [...new Set([pathKey(dest.path), pathKey(canonicalDeep(dest.path))])]
    } catch {
      throw new Error(D_UNCHECKED)
    }
    if (keys.some((k) => this.folderLocks.has(k))) throw new Error('A clone into that folder is already running.')
    for (const k of keys) this.folderLocks.add(k)
    const job: Job = { id: i.requestId, controller: new AbortController(), cancelled: false, disposed: false, forkInFlight: false, contentsAdded: false }
    this.jobs.set(job.id, job)
    try {
      return await this.execute(job, source, i.mode, dest.path, this.makeEmit(job.id, onProgress))
    } finally {
      this.jobs.delete(job.id)
      for (const k of keys) this.folderLocks.delete(k)
    }
  }

  private makeEmit(requestId: string, sink: (e: RepoCloneProgress) => void): Emit {
    let last: { phase: string; text?: string; at: number } | undefined
    return (e) => {
      const at = this.now()
      if (last && last.phase === e.phase && last.text === e.text && at - last.at < PROGRESS_THROTTLE_MS) return
      last = { phase: e.phase, text: e.text, at }
      try {
        sink({ requestId, ...e })
      } catch {
        // a destroyed window must not stop the clone
      }
    }
  }

  private cancelMessage(job: Job): string {
    if (job.fork) return `${REPO_CLONE_CANCELLED_PREFIX} The fork exists at ${job.fork.htmlUrl}.`
    if (job.forkInFlight) return `${REPO_CLONE_CANCELLED_PREFIX} The fork may still have been made on GitHub.`
    return REPO_CLONE_CANCELLED_PREFIX
  }

  private check(job: Job): void {
    if (job.cancelled) throw new Error(this.cancelMessage(job))
  }

  private async execute(job: Job, source: RepoSourceOk, mode: 'clone' | 'fork', path: string, emit: Emit): Promise<RepoCloneResult> {
    const gitBin = await this.resolveGit(job)
    this.check(job)
    if (!gitBin) throw new Error(MSG_NO_GIT)

    let record: DestRecord | undefined
    try {
      let cloneUrl = source.url
      let forkInfo: RepoCloneFork | undefined
      let displayForClone = source.display
      let deadline = 0
      if (mode === 'fork') {
        const fork = this.mock ? await this.mockFork(job, source, emit) : await this.forkRepo(job, source, emit)
        this.check(job)
        job.fork = { htmlUrl: fork.htmlUrl }
        cloneUrl = source.url.startsWith('https://') ? fork.cloneUrl : `git@github.com:${fork.fullName}.git`
        displayForClone = fork.fullName
        forkInfo = { fullName: fork.fullName, htmlUrl: fork.htmlUrl, upstreamUrl: source.url, upstreamAdded: false, ...(fork.alreadyExisted ? { alreadyExisted: true } : {}) }
        deadline = this.now() + FORK_READY_TIMEOUT_MS
      }

      record = prepareDestination(path)
      job.record = record

      let delay = FORK_RETRY_START_MS
      for (;;) {
        emit({ phase: 'cloning', percent: 0, text: 'Contacting the server' })
        const attempt = this.mock ? await this.mockAttempt(job, source, mode, cloneUrl, path, gitBin, emit) : await this.attempt(job, gitBin, cloneUrl, path, mode === 'fork', emit)
        this.check(job)
        if (attempt.ok) break
        const retryable = mode === 'fork' && (attempt.kind === 'not-found' || attempt.kind === 'empty') && this.now() < deadline
        if (!retryable) throw new Error(this.failureMessage(job, attempt, source, displayForClone, path))
        emit({ phase: 'waiting-for-fork' })
        if (!(await emptyDestinationAsync(record))) throw new Error(`OrgAI could not clear the folder ${path} for the next attempt.`)
        await this.sleep(delay, job.controller.signal)
        this.check(job)
        delay = Math.min(FORK_RETRY_MAX_MS, delay * 2)
      }

      emit({ phase: 'finishing' })
      const result: RepoCloneResult = { path, url: cloneUrl, repoConfig: [] }
      if (forkInfo) {
        const upstream = await this.run(gitBin, ['-C', path, 'remote', 'add', 'upstream', source.url], this.gitOpts())
        forkInfo.upstreamAdded = upstream.code === 0
        if (!forkInfo.upstreamAdded) console.warn('Could not add the upstream remote to the new clone.')
        result.fork = forkInfo
      }
      const br = await this.run(gitBin, ['-C', path, 'symbolic-ref', '--short', 'HEAD'], this.gitOpts())
      const branch = br.code === 0 ? br.stdout.trim() : ''
      if (branch && branch.length <= 200 && !hiddenCharIn(branch)) result.branch = branch
      result.repoConfig = scanRepoConfig(path)
      this.check(job)
      return result
    } catch (err) {
      let message = err instanceof Error ? err.message : String(err)
      // Every failure after the fork was made names it (the cancel message and failureMessage already do).
      if (job.fork && !message.includes(job.fork.htmlUrl)) message += ` The fork exists at ${job.fork.htmlUrl}.`
      if (record) {
        let ok = true
        try {
          ok = await cleanupDestinationAsync(record, { contentsAdded: job.contentsAdded })
        } catch {
          ok = false
        }
        if (!ok) message += ` A partial folder may remain at ${path}.`
      }
      console.warn(`Repository clone failed: ${scrubStderr(message)}`)
      throw new Error(message)
    }
  }

  private gitOpts(signal?: AbortSignal): RunOptions {
    return { cwd: tmpdir(), env: gitEnv(this.env), timeoutMs: SHORT_CALL_TIMEOUT_MS, signal }
  }

  private async resolveGit(job: Job): Promise<string | null> {
    if (this.mock && this.env.ORGAI_MOCK_GIT === 'missing') return null
    return this.resolveBinary('git', job.controller.signal)
  }

  private failureMessage(job: Job, f: AttemptFailure, source: RepoSourceOk, display: string, dest: string): string {
    let msg: string
    if (f.kind === 'inactive') msg = MSG_INACTIVE
    else if (f.kind === 'empty') msg = `GitHub has not finished preparing the fork of ${source.display} yet.`
    else msg = cloneErrorMessage(f.stderr, { display, host: source.host, dest, spawnError: f.kind === 'spawn' })
    if (job.fork) msg += ` The fork exists at ${job.fork.htmlUrl}.`
    return msg
  }

  // ---- Real clone ----

  private async attempt(job: Job, gitBin: string, url: string, dest: string, checkEmpty: boolean, emit: Emit): Promise<AttemptResult> {
    const out = await this.runCloneProcess(job, gitBin, cloneArgs(url, dest), emit)
    if (job.cancelled) return { ok: false, kind: 'other', stderr: '' }
    if (out.spawnError) return { ok: false, kind: 'spawn', stderr: '' }
    if (out.inactive) return { ok: false, kind: 'inactive', stderr: '' }
    if (out.code !== 0) {
      if (gitSaysNotEmpty(out.tail, dest)) job.contentsAdded = true
      return { ok: false, kind: cloneErrorKind(scrubStderr(out.tail)), stderr: out.tail }
    }
    if (checkEmpty) {
      const head = await this.run(gitBin, ['-C', dest, 'rev-parse', '--verify', '--quiet', 'HEAD'], this.gitOpts(job.controller.signal))
      if (head.code === 1) return { ok: false, kind: 'empty', stderr: '' }
    }
    return { ok: true }
  }

  private killHandle(handle: GitHandle): void {
    if (handle.pid !== undefined) this.killTree(handle.pid)
    else handle.kill()
  }

  private runCloneProcess(job: Job, gitBin: string, args: string[], emit: Emit): Promise<ProcessOutcome> {
    return new Promise((resolveOutcome) => {
      const reader = new CloneOutputReader((p) => emit({ phase: 'cloning', percent: p.percent, text: p.text }))
      if (job.cancelled) return resolveOutcome({ code: null, tail: '' })
      let handle: GitHandle
      try {
        handle = this.spawnGit(gitBin, args, { cwd: tmpdir(), env: gitEnv(this.env) })
      } catch (e) {
        return resolveOutcome({ code: null, tail: '', spawnError: (e as NodeJS.ErrnoException).code ?? 'ERR' })
      }
      job.pid = handle.pid
      let settled = false
      let killed = false
      let inactive = false
      let exitCode: number | null | undefined
      let inactivityTimer: NodeJS.Timeout | undefined
      let graceTimer: NodeJS.Timeout | undefined
      let capTimer: NodeJS.Timeout | undefined
      const settle = (extra: Partial<ProcessOutcome> = {}): void => {
        if (settled) return
        settled = true
        clearTimeout(inactivityTimer)
        clearTimeout(graceTimer)
        clearTimeout(capTimer)
        job.killProcess = undefined
        job.pid = undefined
        reader.end()
        resolveOutcome({ code: exitCode ?? null, tail: reader.tail, inactive, ...extra })
      }
      const kill = (): void => {
        if (killed || settled) return
        killed = true
        this.killHandle(handle)
        capTimer = setTimeout(() => settle(), this.killWaitMs)
      }
      job.killProcess = kill
      const arm = (): void => {
        clearTimeout(inactivityTimer)
        inactivityTimer = setTimeout(() => {
          inactive = true
          kill()
        }, this.inactivityMs)
      }
      arm()
      handle.onData((chunk) => {
        if (settled) return
        if (!killed) arm()
        reader.feed(chunk)
      })
      handle.onError((err) => settle({ spawnError: err.code ?? 'ERR' }))
      handle.onExit((code) => {
        exitCode = code
        if (killed) settle()
        else graceTimer = setTimeout(() => settle(), this.closeGraceMs)
      })
      handle.onClose((code) => {
        if (exitCode === undefined) exitCode = code
        settle()
      })
    })
  }

  // ---- Real fork ----

  private async forkRepo(job: Job, source: RepoSourceOk, emit: Emit): Promise<ForkOk> {
    emit({ phase: 'forking' })
    const owner = source.owner as string
    const acct = await this.ghAccount(job.controller.signal)
    this.check(job)
    if (!acct.available) throw new Error(MSG_FORK_NEEDS_GH)
    if (!acct.loggedIn && !acct.uncertain) throw new Error(MSG_FORK_NEEDS_LOGIN)
    if (acct.login && acct.login.toLowerCase() === owner.toLowerCase()) throw new Error(MSG_OWN_REPO)
    job.forkInFlight = true
    const res = await this.run(acct.bin, forkArgs(owner, source.repo), { cwd: tmpdir(), env: ghEnv(this.env), timeoutMs: GH_FORK_TIMEOUT_MS, signal: job.controller.signal })
    if (job.cancelled) throw new Error(this.cancelMessage(job))
    if (res.spawnError) {
      job.forkInFlight = false
      throw new Error(MSG_FORK_NEEDS_GH)
    }
    if (res.timedOut) throw new Error('GitHub did not answer in time. The fork may still have been made on GitHub.')
    // Stopped or over its output limit: not "gh is missing", and the fork request may have gone through.
    if (res.failed) throw new Error('The GitHub CLI stopped before it answered. The fork may still have been made on GitHub.')
    job.forkInFlight = false
    if (res.code !== 0) throw new Error(forkErrorMessage(res.stderr, source.display))
    const valid = validateForkResponse(res.stdout, { owner, repo: source.repo }, this.now())
    if (!valid.ok) throw new Error(valid.own ? valid.problem : `${valid.problem} A fork may exist on GitHub.`)
    job.fork = { htmlUrl: valid.htmlUrl }
    return valid
  }

  // ---- Mock ----

  private async mockFork(job: Job, source: RepoSourceOk, emit: Emit): Promise<ForkOk> {
    emit({ phase: 'forking' })
    const key = `${source.owner ?? ''}/${source.repo}`.toLowerCase()
    job.forkInFlight = true
    await this.sleep(400, job.controller.signal)
    this.check(job)
    if ((source.owner ?? '').toLowerCase() === MOCK_USER) throw new Error(MSG_OWN_REPO)
    if (key === 'mock-org/missing') throw new Error(`${source.display} was not found, or your GitHub account has no access to it.`)
    if (key === 'mock-org/no-fork') throw new Error(`${source.display} does not allow forking. Clone it instead.`)
    job.forkInFlight = false
    const fullName = `${MOCK_USER}/${source.repo}`
    job.fork = { htmlUrl: `https://github.com/${fullName}` }
    return {
      ok: true,
      fullName,
      owner: MOCK_USER,
      repo: source.repo,
      htmlUrl: `https://github.com/${fullName}`,
      cloneUrl: `https://github.com/${fullName}.git`,
      alreadyExisted: key === 'mock-org/fork-exists'
    }
  }

  private async mockAttempt(job: Job, source: RepoSourceOk, mode: 'clone' | 'fork', url: string, dest: string, gitBin: string, emit: Emit): Promise<AttemptResult> {
    const key = `${source.owner ?? ''}/${source.repo}`.toLowerCase()
    const signal = job.controller.signal
    if (mode === 'fork' && key === 'mock-org/fork-slow') {
      for (let i = 0; i < 8; i++) {
        emit({ phase: 'waiting-for-fork' })
        await this.sleep(500, signal)
        if (job.cancelled) return { ok: false, kind: 'other', stderr: '' }
      }
    }
    const fails: Record<string, string> = {
      'mock-org/missing': 'remote: Repository not found.',
      'mock-org/private': 'fatal: could not read Username for host: terminal prompts disabled',
      'mock-org/unreachable': 'fatal: unable to access: Could not resolve host',
      'mock-org/fork-clone-fails': 'fatal: unable to access: Could not resolve host'
    }
    const failing = key === 'mock-org/fork-clone-fails' ? mode === 'fork' : key in fails
    const slow = key === 'mock-org/slow'
    const ticks = slow ? 40 : failing ? 1 : 4
    const tickMs = slow ? 500 : failing ? 300 : 260
    for (let i = 1; i <= ticks; i++) {
      await this.sleep(tickMs, signal)
      if (job.cancelled) return { ok: false, kind: 'other', stderr: '' }
      if (!failing) emit({ phase: 'cloning', percent: Math.round((i / ticks) * 80), text: 'Receiving files' })
    }
    if (failing) return { ok: false, kind: cloneErrorKind(fails[key]), stderr: fails[key] }
    // A small real repository, made with the local git only.
    const opts = this.gitOpts(signal)
    const steps: string[][] = [['init', '-b', 'main']]
    try {
      for (const [rel, text] of Object.entries(mockFiles(key, source.repo))) {
        const file = join(dest, ...rel.split('/'))
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, text)
      }
    } catch {
      return { ok: false, kind: 'folder', stderr: 'unable to create file' }
    }
    steps.push(['add', '-A'], ['-c', 'user.name=OrgAI', '-c', 'user.email=mock@orgai.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial commit'], ['remote', 'add', 'origin', url])
    emit({ phase: 'cloning', percent: 90, text: 'Resolving changes' })
    for (const step of steps) {
      const r = await this.run(gitBin, ['-C', dest, ...step], opts)
      if (r.spawnError) return { ok: false, kind: 'spawn', stderr: '' }
      if (r.code !== 0) return { ok: false, kind: 'other', stderr: r.stderr }
    }
    emit({ phase: 'cloning', percent: 100, text: 'Writing files' })
    return { ok: true }
  }
}

// ---- Real process helpers ----

/** The real one-shot runner (execFile, no shell). Exported so a test can wrap it. */
export const defaultRun: RunFn = (file, args, opts) =>
  new Promise((resolveRun) => {
    try {
      execFile(
        file,
        args,
        { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, signal: opts.signal, windowsHide: true, maxBuffer: FORK_RESPONSE_MAX, encoding: 'utf8' },
        (err, stdout, stderr) => {
          const out = String(stdout ?? '')
          const errText = String(stderr ?? '')
          if (!err) return resolveRun({ code: 0, stdout: out, stderr: errText })
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }
          if (typeof e.code === 'number') return resolveRun({ code: e.code, stdout: out, stderr: errText })
          if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return resolveRun({ code: null, stdout: out, stderr: errText, aborted: true })
          // The program ran but was stopped from outside or produced too much: never "not installed".
          if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolveRun({ code: null, stdout: out, stderr: errText, failed: true })
          if (e.killed) return resolveRun({ code: null, stdout: out, stderr: errText, timedOut: true })
          if (e.signal) return resolveRun({ code: null, stdout: out, stderr: errText, failed: true })
          // Only a program that could not start (ENOENT, EACCES ...) is a spawn error.
          if (typeof e.code === 'string' && /^spawn/.test(String((e as { syscall?: string }).syscall ?? 'spawn'))) return resolveRun({ code: null, stdout: out, stderr: errText, spawnError: e.code })
          resolveRun({ code: null, stdout: out, stderr: errText, failed: true })
        }
      )
    } catch (e) {
      resolveRun({ code: null, stdout: '', stderr: '', spawnError: (e as NodeJS.ErrnoException).code ?? 'ERR' })
    }
  })

function defaultSpawnGit(platform: NodeJS.Platform): SpawnGitFn {
  return (file, args, opts) => {
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: platform !== 'win32' })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    return {
      pid: child.pid,
      onData: (cb) => {
        child.stdout?.on('data', (d: string) => cb(d))
        child.stderr?.on('data', (d: string) => cb(d))
      },
      onExit: (cb) => child.on('exit', (code) => cb(code)),
      onClose: (cb) => child.on('close', (code) => cb(code)),
      onError: (cb) => child.on('error', (e) => cb(e as Error & { code?: string })),
      kill: () => {
        try {
          child.kill()
        } catch {
          // gone
        }
      }
    }
  }
}

function taskkillPath(): string {
  return nodePath.win32.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'taskkill.exe')
}

function defaultKillTree(platform: NodeJS.Platform): (pid: number) => void {
  return (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return
    if (platform === 'win32') {
      execFile(taskkillPath(), ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
      return
    }
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        return
      }
    }
    const t = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }, 2_000)
    t.unref()
  }
}

function defaultKillTreeSync(platform: NodeJS.Platform): (pid: number) => void {
  return (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return
    if (platform === 'win32') {
      execFileSync(taskkillPath(), ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 3_000, stdio: 'ignore' })
      return
    }
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res) => {
    if (signal?.aborted) return res()
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      res()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}
