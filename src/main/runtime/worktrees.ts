import { execFile, spawn } from 'node:child_process'
import { scrubControlEnv } from './childEnv'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { gitPath, gitPathSync, pathKey, repoLockRecovery, withRepoLock as repoLock } from './repoLock'
import { gitExecutable, neutralCwd, system32Path } from '../host/systemBinaries'
import { trackChildProcess } from '../host/shutdown'
import { REPORT_BRANCH_PREFIX } from './branchNames'
import { recordOrgAiMove, type HeadState } from './orgaiMoves'
import type { MergeDecision, PendingWorktree, WorktreeDiff, WorktreeInfo } from '@shared/types'

/**
 * Git plumbing for isolated subagents. Vendor-neutral: any adapter whose subagents work
 * in git worktrees can use it. Claude Code creates the worktree itself (under
 * <repo>/.claude/worktrees/agent-<id> on branch worktree-agent-<id>) and leaves it behind
 * with uncommitted changes; this module commits those changes and merges them back.
 *
 * Nested isolation. A report spawned by an isolated report runs from its parent's worktree, so
 * Claude Code's `git worktree add` runs with cwd = <parent worktree>. A linked worktree shares
 * the repository (one object store, one ref namespace, one worktree list in the common git
 * dir), so the child becomes another linked worktree of the same repository:
 *   - its directory is resolved against the toplevel of the cwd, i.e.
 *     <parent worktree>/.claude/worktrees/agent-<child id>, nested inside the parent's checkout;
 *   - its branch worktree-agent-<child id> is cut from HEAD of the cwd, which is the parent's
 *     branch, so the child starts from the parent's committed work;
 *   - `git worktree list --porcelain` from any worktree, including the main checkout, lists it,
 *     so findWorktree(<main root>, id) still locates it without knowing where it was created.
 * This is reasoned from git semantics, not observed through the SDK: if Claude Code instead
 * anchors agent worktrees at the main repository root, findWorktree still finds them, and a
 * child cut from the main HEAD still merges into its parent's branch (only with an older base).
 *
 * The exclude line lives in the common git dir's info/exclude (resolved with `git rev-parse --git-path
 * info/exclude`, so a linked worktree or a `.git`-file checkout writes the same file) and so applies to every
 * worktree. The pattern ".claude/worktrees/" has a slash in the middle, so it
 * is anchored at each worktree's toplevel (not at any depth); nested agent worktrees always
 * sit at <some worktree>/.claude/worktrees/, which it matches. commitLeftovers additionally
 * never stages .claude/worktrees at any depth.
 *
 * A child merges into its parent with cwd = the parent's worktree (`integrateWorktree(parentPath,
 * ...)`); worktree removal and branch deletion work from any worktree of the repository. Before a
 * worktree is removed, agent worktrees nested inside it (a child held or conflicted) are moved
 * to the main checkout's .claude/worktrees so their branch and files survive.
 */

const EXCLUDE_LINE = '.claude/worktrees/'
const BRANCH_PREFIX = REPORT_BRANCH_PREFIX

/**
 * Dependency and cache directories a report may create while building or testing. They are
 * never committed on its behalf, even when the repository has no .gitignore for them.
 */
const NEVER_COMMIT = ['node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.cache', '.turbo', '.claude/worktrees']
const ADD_PATHSPEC = ['--', '.', ...NEVER_COMMIT.flatMap((d) => [`:(exclude)${d}/`, `:(exclude,glob)**/${d}/**`])]

export function isGitRepo(root: string): boolean {
  return existsSync(join(root, '.git'))
}

function git(root: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  // By absolute path (review H1): on Windows a bare 'git' is searched in the cwd (the checkout, maybe an untrusted
  // clone) before PATH. Missing on Windows = git is not installed.
  const bin = gitExecutable()
  if (!bin) return Promise.resolve({ ok: false, out: '', err: 'git was not found on PATH.' })
  return new Promise((resolve) => {
    const child = execFile(bin, args, { cwd: root, env: scrubControlEnv(process.env), windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: String(stdout).trim(), err: String(stderr ?? error?.message ?? '').trim() })
    })
    // Git under the repo lock is ended with the host at the shutdown's hard limit (cli-standalone.md 4.3).
    trackChildProcess(child, 'git')
  })
}

/**
 * `-c` overrides every read-only history query passes. These cover the config keys that name a program for the commands
 * `git log` runs itself (pager, fsmonitor, hooks, ssh, askpass, signature check, auto gc). They are defence in depth:
 * `git log` with a piped stdout reaches none of fsmonitor, pager or ssh, so no test shows them being stopped. What
 * actually stops a program that a repository's config names for a lazy fetch (remote.<n>.uploadpack, core.gitProxy,
 * a credential helper) is the environment of readOnlyGitEnv (GIT_NO_LAZY_FETCH, GIT_ALLOW_PROTOCOL), which a `-c`
 * override cannot replace: a remote's own uploadpack key has no global switch.
 */
export const HOSTILE_CONFIG_OVERRIDES = [
  '-c', 'core.fsmonitor=false',
  '-c', `core.hooksPath=${devNull}`,
  '-c', 'core.pager=cat',
  '-c', 'core.sshCommand=false',
  '-c', 'core.askPass=',
  '-c', 'log.showSignature=false',
  '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false'
]

/**
 * The environment of a read-only history query: control variables scrubbed and every inherited GIT_* dropped (GIT_DIR,
 * GIT_CONFIG_*, GIT_SSH...), then:
 * - GIT_DIR / GIT_WORK_TREE pinned to `root`, so git never searches upward (an empty or invalid `.git` directory would
 *   otherwise make it count a parent repository) and never follows `.git` anywhere else. Explicit GIT_DIR skips git's
 *   safe.directory ownership check, so the defence is this environment plus the strict `.git` check (hasPlainGitDir).
 * - GIT_NO_LAZY_FETCH=1 (git 2.44+): a missing object in a partial clone is not fetched.
 * - GIT_ALLOW_PROTOCOL=orgai-none: a name no transport has, so no protocol is allowed at all, whatever the repository's
 *   own protocol.*.allow says (the environment variable wins). This is what stops a promisor fetch on git older than
 *   2.44 and any other transport use (remote.<n>.uploadpack, core.gitProxy, https and its credential helper).
 * - no prompts, no optional locks, no pager, replace objects ignored.
 * The system git config is deliberately left on: an administrator's hardening there only helps.
 */
export function readOnlyGitEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(scrubControlEnv(process.env))) if (!k.toUpperCase().startsWith('GIT_')) env[k] = v
  return {
    ...env,
    GIT_DIR: join(root, '.git'),
    GIT_WORK_TREE: root,
    GIT_NO_LAZY_FETCH: '1',
    GIT_ALLOW_PROTOCOL: 'orgai-none',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_NO_REPLACE_OBJECTS: '1'
  }
}

/**
 * The environment of a guarded git call: a plain `.git` checkout gets the pinned read-only environment (readOnlyGitEnv). Any
 * other checkout (a linked worktree, whose `.git` is a file) cannot have GIT_DIR pinned here, but gets the rest of it: every
 * inherited GIT_* variable dropped (GIT_DIR, GIT_INDEX_FILE, GIT_AUTHOR_*, GIT_COMMITTER_*, GIT_CONFIG_*), no prompt, and
 * replace objects ignored (`refs/replace` can make a commit read as other content), as on a plain checkout.
 */
export function guardedGitEnv(root: string): NodeJS.ProcessEnv {
  if (hasPlainGitDir(root)) return readOnlyGitEnv(root)
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(scrubControlEnv(process.env))) if (!k.toUpperCase().startsWith('GIT_')) env[k] = v
  return { ...env, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' }
}

/**
 * The null file for git config and attributes paths. Not `os.devNull`: on Windows that is `\\.\nul`, which git cannot open as
 * a config file ("unable to access"); `NUL` and `/dev/null` are mapped by git itself.
 */
export const GIT_NULL_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null'

/**
 * The merge's isolation from the user's own git setup: a test command runs as the user and can edit the global config, point
 * core.attributesFile at a file of its own or define a merge driver there; none of it may change the merged content. System
 * and global config and attributes are ignored for the merge (the identity is read separately, mergeIdentityArgs), and a path
 * with no merge attribute uses git's text merge whatever `merge.default` says. A merge driver the repository's own config or
 * attributes select is refused beforehand (mergeAttributeRefusal), and the repository config is pinned by rootPin.ts.
 * Needs git 2.32 for GIT_CONFIG_GLOBAL; an older git still reads the global config (unverified).
 */
const NEUTRAL_ENV: Record<string, string> = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: GIT_NULL_FILE, GIT_ATTR_NOSYSTEM: '1' }
const NEUTRAL_OVERRIDES = ['-c', `core.attributesFile=${GIT_NULL_FILE}`, '-c', 'merge.default=text']

/**
 * git's safe values for the two settings that stop a tree from writing through a name that aliases `.git` (".git ", "git~1",
 * ".git::$INDEX_ALLOCATION", HFS-ignorable characters), forced on every guarded call on every platform. A `-c` on the command
 * line wins over every config file, so neither the repository's config nor the user's (which a test command, repository code
 * run as the user, can edit) can switch them off for a merge, a branch switch or a worktree removal. They are never carried
 * from config (mergeCarriedConfigArgs).
 */
const WRITE_SAFETY_OVERRIDES = ['-c', 'core.protectNTFS=true', '-c', 'core.protectHFS=true']

/** True when `<root>/.git` is a real directory: not a file (`gitdir:` redirect), not a symlink or junction. */
export function hasPlainGitDir(root: string): boolean {
  try {
    const st = lstatSync(join(root, '.git'))
    if (!st.isDirectory() || st.isSymbolicLink()) return false
    // `commondir` points git at another repository's object store and refs; any alternate (not only a UNC one) does the same.
    if (existsSync(join(root, '.git', 'commondir'))) return false
    const alt = join(root, '.git', 'objects', 'info', 'alternates')
    if (existsSync(alt)) {
      if (statSync(alt).size > 64 * 1024) return false
      if (readFileSync(alt, 'utf8').split(/\r?\n/).some((l) => l.trim() !== '')) return false
    }
    return true
  } catch {
    return false
  }
}

interface KillableChild {
  readonly pid?: number
  readonly exitCode?: number | null
  readonly signalCode?: NodeJS.Signals | null
  kill(signal?: NodeJS.Signals | number): boolean
}

export interface TreeKillDeps {
  platform?: NodeJS.Platform
  spawn?: typeof spawn
  /** POSIX: signal a whole process group (default process.kill(-pid, signal)). */
  killGroup?: (pid: number, signal: NodeJS.Signals | number) => void
}

/**
 * Kill `child` and everything it started. win32: `%SystemRoot%\System32\taskkill.exe /PID <pid> /T /F` (absolute path, an
 * argument array, no shell). POSIX: the process group, which needs the child to have been spawned `detached` so it leads
 * its own group. Falls back to killing only the direct child when the tree kill cannot be started. Never throws.
 */
export function killProcessTree(child: KillableChild, signal: NodeJS.Signals | number = 'SIGKILL', deps: TreeKillDeps = {}): boolean {
  const pid = child.pid
  const direct = (): boolean => {
    try {
      return child.kill(signal)
    } catch {
      return false
    }
  }
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return direct()
  // Already exited: its pid may have been reused, so never aim a tree kill at it.
  if ((child.exitCode !== undefined && child.exitCode !== null) || (child.signalCode !== undefined && child.signalCode !== null)) return false
  if ((deps.platform ?? process.platform) === 'win32') {
    try {
      const killer = (deps.spawn ?? spawn)(system32Path('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { cwd: neutralCwd(), windowsHide: true, shell: false, stdio: 'ignore' })
      killer.on('error', () => void direct())
      killer.on('exit', (code: number | null) => {
        if (code !== 0) void direct()
      })
      killer.unref?.()
      return true
    } catch {
      return direct()
    }
  }
  try {
    ;(deps.killGroup ?? ((p, s) => process.kill(-p, s)))(pid, signal)
    return true
  } catch {
    return direct()
  }
}

export interface CommitTimesOptions {
  /** Kill git after this long (default 5 s). */
  timeoutMs?: number
  /** Stop reading after this many commits (default 5000). */
  maxCommits?: number
}

/** The argument list of the commit-time query (exported for tests). */
export function commitTimesArgs(sinceMs: number, maxCommits: number): string[] {
  return [
    '--no-pager',
    ...HOSTILE_CONFIG_OVERRIDES,
    'log', '--no-merges', '--no-show-signature', `--since=${new Date(sinceMs).toISOString()}`, `--max-count=${maxCommits}`, '--format=%ct',
    // `--` ends the options and the revision list, so a working-tree file named HEAD is not ambiguous.
    'HEAD', '--'
  ]
}

/**
 * Committer timestamps (unix seconds) of the commits reachable from HEAD at or after `sinceMs`, merge commits left out.
 * Asks git for `%ct` and nothing else, so no message, author, file name or path is ever read. Spawns git directly (no
 * shell, argument array, no pager, no prompts, hostile-config overrides, a pinned GIT_DIR and an environment that allows
 * no transport and no lazy fetch, a timeout), reads at most `maxCommits` lines and then kills git and its process tree.
 * `root` must itself hold a real `.git` directory (hasPlainGitDir: a `.git` file, a symlink, a linked worktree or a
 * folder inside another repository is `{ ok: false }`). Never throws: any failure is `{ ok: false }`.
 */
export function gitCommitTimes(root: string, sinceMs: number, opts: CommitTimesOptions = {}): Promise<{ ok: boolean; times: number[] }> {
  const bin = gitExecutable()
  const failed = { ok: false, times: [] as number[] }
  if (!bin || !hasPlainGitDir(root)) return Promise.resolve(failed)
  const maxCommits = opts.maxCommits ?? 5000
  const args = commitTimesArgs(sinceMs, maxCommits)
  return new Promise((resolve) => {
    let settled = false
    let buf = ''
    const times: number[] = []
    const finish = (r: { ok: boolean; times: number[] }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    let child: ReturnType<typeof spawn>
    try {
      // POSIX: detached makes git lead its own process group so killProcessTree can end the whole group. win32 uses
      // taskkill /T instead (detached there would open a console window).
      child = spawn(bin, args, { cwd: root, env: readOnlyGitEnv(root), windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve(failed)
      return
    }
    const spawned = child
    // The shutdown registry kills the whole tree too (its kill signal goes through killProcessTree).
    trackChildProcess(
      { get pid() { return spawned.pid }, kill: (signal) => killProcessTree(spawned, signal), once: (event, listener) => spawned.once(event, listener) },
      'git'
    )
    let killed = false
    const stop = (): void => {
      if (killed) return
      killed = true
      killProcessTree(child)
    }
    const timer = setTimeout(() => {
      stop()
      finish(failed)
    }, opts.timeoutMs ?? 5000)
    const take = (line: string): void => {
      const n = Number(line.trim())
      if (line.trim() !== '' && Number.isInteger(n) && n > 0) times.push(n)
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk
      const parts = buf.split('\n')
      buf = parts.pop() ?? ''
      for (const p of parts) take(p)
      if (times.length >= maxCommits || buf.length > 1024) stop()
    })
    child.on('error', () => finish(failed))
    child.on('close', (code) => {
      if (buf) take(buf)
      const capped = times.length >= maxCommits
      finish(code === 0 || capped ? { ok: true, times: times.slice(0, maxCommits) } : failed)
    })
  })
}

/**
 * Run `fn` while holding the repository lock of `root` (the main checkout or any linked worktree). Delegates to
 * repoLock.ts: the lock is keyed by the repository's common git dir, so it serializes ALL git operations per
 * repository, across processes (`<commonDir>/orgai-repo.lock`, so the app and a CLI host never run git on one
 * repository at the same time), reentrant within one async call chain (integrateWorktree(root) ->
 * commitLeftovers(wt) / discardWorktree(root) reuse the outer lease), and never held across a merge review.
 * A worktree and the main checkout of one repository therefore queue behind each other; different repositories do
 * not. Callers queue in arrival order; a rejected fn releases the lock.
 *
 * Lock hierarchy: `WorktreeIntegrator.exclusive(dir)` (integration.ts, a per-directory in-process queue) is always
 * taken first, outside this lock, and nothing in this file calls back into integration.ts while holding it, so the
 * order exclusive -> repo lock is the only one. integrateWorktree releases the repo lock before awaiting `review`
 * (the user's merge card) and takes it again for the merge.
 */
export function withRepoLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  return repoLock(root, fn)
}

/**
 * The exclude file `git rev-parse --git-path info/exclude` names, made absolute: the common dir's info/exclude, also
 * from a linked worktree or a checkout whose `.git` is a file. Falls back to <root>/.git/info/exclude only when
 * .git is a real directory.
 */
async function excludeFileOf(root: string): Promise<string | null> {
  return (await gitPath(root, 'info/exclude')) ?? fallbackExclude(root)
}

function excludeFileOfSync(root: string): string | null {
  return gitPathSync(root, 'info/exclude') ?? fallbackExclude(root)
}

function fallbackExclude(root: string): string | null {
  try {
    return statSync(join(root, '.git')).isDirectory() ? join(root, '.git', 'info', 'exclude') : null
  } catch {
    return null
  }
}

/** Keep agent worktrees out of `git status` and prune leftovers from crashed runs. */
export async function prepareRepo(root: string): Promise<void> {
  if (!isGitRepo(root)) return
  await withRepoLock(root, () => prepareRepoUnlocked(root))
}

async function prepareRepoUnlocked(root: string): Promise<void> {
  const excludeFile = await excludeFileOf(root)
  try {
    if (!excludeFile) throw new Error('no exclude file')
    mkdirSync(dirname(excludeFile), { recursive: true })
    const existing = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : ''
    if (!existing.split(/\r?\n/).includes(EXCLUDE_LINE)) appendFileSync(excludeFile, `${existing.endsWith('\n') || !existing ? '' : '\n'}${EXCLUDE_LINE}\n`)
  } catch {
    /* best effort */
  }
  await git(root, ['worktree', 'prune'])
}

/** Undo what prepareRepo added to the repository's info/exclude (synchronous: maintenance.ts calls it inline). */
export function removeExcludeLine(root: string): boolean {
  const excludeFile = excludeFileOfSync(root)
  if (!excludeFile || !existsSync(excludeFile)) return false
  const lines = readFileSync(excludeFile, 'utf8').split(/\r?\n/)
  if (!lines.includes(EXCLUDE_LINE)) return false
  writeFileSync(excludeFile, lines.filter((l) => l !== EXCLUDE_LINE).join('\n'), 'utf8')
  return true
}

/** Every worktree of the repository; the first entry is the main checkout. */
async function listAllWorktrees(root: string): Promise<{ path: string; branch?: string }[]> {
  const res = await git(root, ['worktree', 'list', '--porcelain'])
  if (!res.ok) return []
  const out: { path: string; branch?: string }[] = []
  let cur: { path?: string; branch?: string } = {}
  for (const line of [...res.out.split(/\r?\n/), '']) {
    if (line.startsWith('worktree ')) cur = { path: line.slice(9).trim() }
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '')
    else if (line === '') {
      if (cur.path) out.push({ path: cur.path, ...(cur.branch ? { branch: cur.branch } : {}) })
      cur = {}
    }
  }
  return out
}

async function listAgentWorktrees(root: string): Promise<{ path: string; branch: string }[]> {
  return (await listAllWorktrees(root)).flatMap((e) => (e.branch?.startsWith(BRANCH_PREFIX) ? [{ path: e.path, branch: e.branch }] : []))
}

export { pathKey }

/**
 * Move agent worktrees nested inside `parentPath` to the main checkout's .claude/worktrees, so
 * removing the parent's worktree does not delete them. Returns the moved worktrees' new paths.
 */
async function evacuateNested(root: string, parentPath: string): Promise<string[]> {
  const all = await listAllWorktrees(root)
  const main = all[0]?.path
  if (!main) return []
  const prefix = `${pathKey(parentPath)}/`
  const moved: string[] = []
  for (const wt of all.slice(1)) {
    if (!wt.branch?.startsWith(BRANCH_PREFIX) || !pathKey(wt.path).startsWith(prefix) || !existsSync(wt.path)) continue
    const dir = join(main, '.claude', 'worktrees')
    const dest = join(dir, basename(wt.path))
    if (existsSync(dest)) continue
    mkdirSync(dir, { recursive: true })
    if ((await gitGuarded(main, ['worktree', 'move', wt.path, dest])).ok) moved.push(dest)
  }
  return moved
}

/**
 * Remove one worktree directory (keeping nested agent worktrees) and prune its record. Through the guarded runner (hooks,
 * fsmonitor and the other program-naming keys off): it runs after a merge, when a test command may have changed the
 * repository's config.
 */
async function removeWorktree(root: string, path: string): Promise<void> {
  if (existsSync(path)) {
    await evacuateNested(root, path)
    await gitGuarded(root, ['worktree', 'remove', '--force', path])
  }
  await gitGuarded(root, ['worktree', 'prune'])
}

/** Locate the worktree Claude Code created for a subagent, if any. */
export async function findWorktree(root: string, agentId: string): Promise<{ path: string; branch: string } | null> {
  const needle = `agent-${agentId}`
  const all = await listAgentWorktrees(root)
  return all.find((e) => e.path.replace(/\\/g, '/').endsWith(`/${needle}`) || e.branch.endsWith(needle)) ?? null
}

/** Branches left by earlier conflicts or crashes, so an orchestrator or the user can deal with them. */
export async function pendingWorktrees(root: string): Promise<{ path: string; branch: string }[]> {
  return listAgentWorktrees(root)
}

/** Everything the maintenance panel shows about a leftover worktree. */
export async function inspectPending(root: string): Promise<PendingWorktree[]> {
  if (!isGitRepo(root)) return []
  const out: PendingWorktree[] = []
  for (const wt of await listAgentWorktrees(root)) {
    const exists = existsSync(wt.path)
    const status = exists ? await git(wt.path, ['status', '--porcelain']) : { ok: false, out: '', err: '' }
    const uncommitted = status.ok ? status.out.split(/\r?\n/).filter(Boolean).length : 0
    const ahead = await git(root, ['rev-list', '--count', `HEAD..${wt.branch}`])
    const changed = await git(root, ['diff', '--name-only', `HEAD...${wt.branch}`])
    const last = await git(root, ['log', '-1', '--format=%ct%x00%s', wt.branch])
    const [ts, subject] = last.ok ? last.out.split('\0') : []
    out.push({
      path: wt.path,
      branch: wt.branch,
      agentId: wt.branch.slice(BRANCH_PREFIX.length),
      exists,
      uncommittedFiles: uncommitted,
      commitsAhead: ahead.ok ? Number(ahead.out) || 0 : 0,
      changedFiles: changed.ok ? changed.out.split(/\r?\n/).filter(Boolean) : [],
      lastCommitAt: ts ? Number(ts) * 1000 : undefined,
      lastSubject: subject || undefined
    })
  }
  return out
}

/**
 * Files in a checkout's git dir that mean a git operation is unfinished there: a merge, cherry-pick, revert or rebase
 * in progress, or an index.lock (a git process running now, such as the user's editor or terminal, or one that stopped
 * without cleaning up). With the repository lock held none of them is OrgAI's own work in progress.
 */
const UNFINISHED_GIT_STATE = ['index.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']

/**
 * How long to wait (ms, one entry per re-check) when the only unfinished state is an index.lock (review M5): the
 * user's own git (an editor's status poll, a commit in a terminal) holds it for a moment, so it is re-checked a few
 * times before a refusal. About 2 s in all, spent holding the repository lock.
 */
export const INDEX_LOCK_RETRY_DELAYS_MS: readonly number[] = [100, 250, 500, 1000]
let indexLockRetryDelays: readonly number[] = INDEX_LOCK_RETRY_DELAYS_MS

/** Tests: the index.lock re-check delays (undefined restores INDEX_LOCK_RETRY_DELAYS_MS). */
export function setIndexLockRetryDelays(delays?: readonly number[]): void {
  indexLockRetryDelays = delays ?? INDEX_LOCK_RETRY_DELAYS_MS
}

const isIndexLock = (p: string): boolean => basename(p).toLowerCase() === 'index.lock'

/** Thrown by a git step that refused to run over an unfinished git operation (spec 3.2 (5) 4). */
export class UnfinishedGitStateError extends Error {
  readonly files: string[]
  constructor(message: string, files: string[]) {
    super(message)
    this.name = 'UnfinishedGitStateError'
    this.files = files
  }
}

/** The unfinished-operation files of each existing checkout, deduplicated. Read-only; one git call per checkout. */
async function unfinishedGitState(checkouts: string[]): Promise<string[]> {
  const found: string[] = []
  const seen = new Set<string>()
  for (const checkout of checkouts) {
    if (!existsSync(checkout)) continue
    const res = await git(checkout, ['rev-parse', ...UNFINISHED_GIT_STATE.flatMap((rel) => ['--git-path', rel])])
    if (!res.ok) continue
    for (const line of res.out.split(/\r?\n/)) {
      if (!line.trim()) continue
      const p = resolve(checkout, line.trim())
      const k = pathKey(p)
      if (seen.has(k)) continue
      seen.add(k)
      if (existsSync(p)) found.push(p)
    }
  }
  return found
}

/**
 * Null when git may run destructive steps (merge --abort, worktree remove --force, branch -D, reset) in `checkouts`;
 * else the sentence telling the user what was found and that nothing was changed. Call it holding the repository lock.
 * An index.lock alone is usually a git process running right now (the user's editor or terminal), so it is re-checked
 * after each of indexLockRetryDelays before a refusal; MERGE_HEAD and the other operation files refuse at once.
 */
async function unfinishedGitStateRefusal(checkouts: string[], kept: string): Promise<{ message: string; files: string[] } | null> {
  let files = await unfinishedGitState(checkouts)
  let waited = false
  for (const delay of indexLockRetryDelays) {
    if (!files.length || !files.every(isIndexLock)) break
    waited = true
    await new Promise((r) => setTimeout(r, delay))
    files = await unfinishedGitState(checkouts)
  }
  if (!files.length) return null
  const reclaimed = repoLockRecovery()
    .map((n) => (n.previousOwner ? ` OrgAI took over the repository lock from process ${n.previousOwner.pid}, which is gone.` : ' OrgAI took over a stale repository lock.'))
    .slice(0, 1)
    .join('')
  const lock = files.some(isIndexLock)
  return {
    files,
    message:
      `Git is busy or has an unfinished operation in this repository (${files.join(', ')}).${reclaimed} ` +
      `OrgAI ${waited ? 'waited a moment, ' : ''}ran no destructive git command and changed nothing; ${kept}. ` +
      (lock ? 'If git is running elsewhere (an editor, a terminal or another tool), let it finish and integrate again. ' : '') +
      'If an operation was left half done, finish or abort it yourself (for example git merge --abort, or delete index.lock once no git process is running), then integrate again.'
  }
}

/** Stage and commit whatever a report left behind. Returns true when a commit was made. */
export async function commitLeftovers(wt: string, message: string): Promise<{ committed: boolean; error?: string }> {
  return withRepoLock(wt, () => commitLeftoversUnlocked(wt, message))
}

/** git's complaint when no user.name / user.email is configured ("Please tell me who you are", "Author identity unknown"). */
const IDENTITY_ERROR = /user\.name|user\.email|identity|tell me who you are/i
const FALLBACK_IDENTITY = ['-c', 'user.name=OrgAI', '-c', 'user.email=orgai@localhost']

async function commitLeftoversUnlocked(wt: string, message: string): Promise<{ committed: boolean; error?: string }> {
  // `git add` / `reset` / `commit` over a half-finished merge in the worktree would conclude or unstage it.
  const refusal = await unfinishedGitStateRefusal([wt], `its files stay as they are in ${wt}`)
  if (refusal) return { committed: false, error: refusal.message }
  const status = await git(wt, ['status', '--porcelain'])
  if (!status.ok || !status.out) return { committed: false }
  await git(wt, ['add', '-A', ...ADD_PATHSPEC])
  const nothingStaged = (await git(wt, ['diff', '--cached', '--quiet'])).ok
  if (nothingStaged) {
    await git(wt, ['reset', '-q'])
    return { committed: false }
  }
  let commit = await git(wt, ['commit', '-q', '-m', message])
  if (!commit.ok && IDENTITY_ERROR.test(commit.err)) {
    commit = await git(wt, [...FALLBACK_IDENTITY, 'commit', '-q', '-m', message])
  }
  return commit.ok ? { committed: true } : { committed: false, error: commit.err.slice(0, 300) }
}

/** git output exactly as printed (the trimming `git()` does would eat the leading space of a porcelain line). */
function gitRaw(root: string, args: string[]): Promise<{ ok: boolean; out: string; err: string; overflow?: boolean }> {
  const bin = gitExecutable()
  if (!bin) return Promise.resolve({ ok: false, out: '', err: 'git was not found on PATH.' })
  return new Promise((resolve) => {
    execFile(bin, args, { cwd: root, env: scrubControlEnv(process.env), windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const overflow = (error as { code?: unknown } | null)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      resolve({ ok: !error, out: String(stdout ?? ''), err: String(stderr ?? error?.message ?? '').trim(), ...(overflow ? { overflow: true } : {}) })
    })
  })
}

/** The paths team files live at, relative to the project folder. */
const TEAM_PATHSPEC = ['.orgai/team.json', '.orgai/mcp.json', '.orgai/agents', '.orgai/skills']

/**
 * What git has not committed under the team files: every changed or untracked file (folders listed file by file;
 * a rename gives both names), folder-relative with '/'. `ok` false when `root` is not a git work tree git can read.
 */
export async function teamFilesStatusGit(root: string): Promise<{ ok: boolean; files: string[]; error?: string }> {
  if (!isGitRepo(root)) return { ok: false, files: [] }
  // The repository's own config is untrusted: no file-system monitor (it is a program the repository names), literal paths.
  const res = await gitRaw(root, ['-c', 'core.fsmonitor=false', '--literal-pathspecs', 'status', '--porcelain', '-z', '--untracked-files=all', '--', ...TEAM_PATHSPEC])
  // Output past the buffer is a git that works and a huge change list, not "not a repository": keep what was read.
  if (!res.ok && !res.overflow) return { ok: false, files: [], error: res.err }
  const parts = res.out.split('\0')
  if (res.overflow) parts.pop() // the last entry may be cut
  const files: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    files.push(entry.slice(3))
    // With -z a rename or copy is "XY new" followed by a separate "old" entry.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const old = parts[++i]
      if (old) files.push(old)
    }
  }
  return { ok: true, files: [...new Set(files)].sort() }
}

/**
 * Commit exactly `paths` (relative to `root`) and nothing else: `git add -A -- <paths>` then `git commit --only --no-verify
 * -- <paths>`, so another file the user already staged stays staged and out of the commit. Hooks are switched off with
 * core.hooksPath (a repository's hooks are code from the repository; OrgAI does not run them on its own initiative, and
 * --no-verify alone leaves post-commit and prepare-commit-msg hooks running). Never pushes. The message is fixed text by
 * the caller (it never starts with a dash). Uses the same identity fallback as every other OrgAI commit.
 */
export async function commitPaths(root: string, paths: string[], message: string): Promise<{ committed: boolean; error?: string }> {
  if (!paths.length) return { committed: false }
  return withRepoLock(root, async () => {
    // Paths come from a repository's status: literal, never a pathspec magic word or glob.
    const noHooks = ['-c', `core.hooksPath=${devNull}`, '--literal-pathspecs']
    const add = await git(root, [...noHooks, 'add', '-A', '--', ...paths])
    if (!add.ok) {
      // A path that only HEAD knows (the old name of a staged rename, a staged deletion) cannot be added; the commit below
      // still sees it through HEAD. Anything else that fails to add is reported by the commit.
      for (const p of paths) await git(root, [...noHooks, 'add', '-A', '--', p])
    }
    const args = ['commit', '--only', '--no-verify', '-q', '-m', message, '--', ...paths]
    let commit = await git(root, [...noHooks, ...args])
    if (!commit.ok && IDENTITY_ERROR.test(commit.err)) commit = await git(root, [...noHooks, ...FALLBACK_IDENTITY, ...args])
    return commit.ok ? { committed: true } : { committed: false, error: commit.err }
  })
}

/**
 * Remove a worktree and its branch, discarding any work on it. Throws UnfinishedGitStateError, changing nothing, when
 * the worktree's git dir holds an unfinished operation (an index.lock that does not go away, or MERGE_HEAD).
 */
export async function discardWorktree(root: string, wt: { path: string; branch: string }): Promise<void> {
  await withRepoLock(root, async () => {
    const refusal = await unfinishedGitStateRefusal([wt.path], `branch ${wt.branch} is kept at ${wt.path}`)
    if (refusal) throw new UnfinishedGitStateError(refusal.message, refusal.files)
    await removeWorktree(root, wt.path)
    await git(root, ['branch', '-D', wt.branch])
  })
}

export interface IntegrateResult {
  info: WorktreeInfo
  /** Human summary for the log and the orchestrator. */
  message: string
  /** Set when the merge was refused by the test gate (status 'conflict', the copy is kept as it is). */
  refused?: 'tests'
}

/**
 * What the pre-merge gate of integrateWorktree answers: the user's review decision, or a refusal (the test gate failed):
 * nothing is merged or deleted, the copy stays pending on its branch and `message` says why.
 */
export type GateDecision =
  | Exclude<MergeDecision, { behavior: 'merge' }>
  | {
      behavior: 'merge'
      sha?: string
      /**
       * Run under the repository lock right before the merge: a sentence (nothing is merged, the copy is kept) when the checkout
       * the merge lands in changed while repository code ran (rootPin.ts), else undefined.
       */
      verify?: () => Promise<string | undefined>
      /**
       * The git settings the merge carries from the user's own config (mergeCarriedConfigArgs), read BEFORE the test command
       * ran, with the root pin, under the repository lock. The command is repository code run as the user and can rewrite the
       * global config, so nothing is read from config at merge time. Absent: the snapshot taken when integrateWorktree started.
       */
      carried?: readonly string[]
    }
  | { behavior: 'refuse'; reason: 'tests'; message: string }

/**
 * The commit a local branch points at now, or null (no such branch, or git failed). The merge gate records it before the
 * user reviews or the tests run and merges that commit, never the branch name: whatever the test command (repository
 * code) commits to the branch meanwhile cannot land unreviewed.
 */
export async function branchTip(root: string, branch: string): Promise<string | null> {
  const r = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
  return r.ok && /^[0-9a-f]{40,64}$/.test(r.out) ? r.out : null
}

export interface IntegrateOptions {
  /**
   * Project.mainBranch: the local branch a merge into the main checkout lands on. Ignored when unset or when no such
   * local branch exists (then the checkout's current branch is used, as before). Pass it only for the main checkout,
   * never for a merge into a parent report's worktree. Never creates a branch.
   */
  mainBranch?: string
}

/**
 * Make `root` sit on `mainBranch` before a merge. Null when it already does, when no mainBranch is set, or when it
 * names no local branch (today's behaviour: merge into whatever the checkout has). The branch is switched only when the
 * checkout has no uncommitted change to tracked files; otherwise, or when git refuses (the branch is checked out in
 * another worktree), the sentence says nothing was merged. Call it holding the repository lock.
 */
export async function ensureMainBranch(root: string, mainBranch: string | undefined): Promise<string | null> {
  const name = mainBranch?.trim()
  if (!name || name.startsWith('-') || /[\0\r\n]/.test(name)) return null
  // Guarded: a checkout runs post-checkout hooks and a status runs fsmonitor, and this runs after a test command may have
  // changed the repository's config or hooks.
  const exists = await gitGuarded(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
  if (!exists.ok) return null
  const targetCommit = exists.out
  const head = await gitGuarded(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (head.ok && head.out === name) return null
  const current = head.ok ? head.out : 'another branch'
  const dirty = await gitGuarded(root, ['status', '--porcelain', '--untracked-files=no'])
  if (!dirty.ok || dirty.out) {
    return `The project's main branch is ${name} but the main checkout is on ${current} with uncommitted changes, so nothing was merged. Commit or stash them, or switch to ${name}, then integrate again.`
  }
  // The state the switch starts from is read right before it, and only the exact move it made is recorded in the ledger.
  const before = await readHeadState(root)
  const sw = await gitGuarded(root, ['checkout', '--quiet', name, '--'])
  if (!sw.ok) return `The project's main branch is ${name} but the main checkout could not switch to it from ${current} (${sw.err.slice(0, 200)}), so nothing was merged.`
  const after = await readHeadState(root)
  if (after.head === targetCommit && after.branch === `refs/heads/${name}`) recordOrgAiMove(root, before, after)
  return null
}

/** How a merge target is named in messages: the main checkout, or the parent report's branch. */
async function targetName(root: string): Promise<string> {
  const head = await gitGuarded(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return head.ok && head.out.startsWith(BRANCH_PREFIX) ? `branch ${head.out}` : 'the main checkout'
}

/**
 * Commit whatever the subagent left in its worktree and merge it into `root`: the main checkout,
 * or (nested isolation) the parent report's worktree, in which case the merge commit lands on
 * the parent's branch. Clean merges remove the worktree and branch. Conflicts and refusals leave
 * the branch for the orchestrator or the user to integrate by hand.
 */
export async function integrateWorktree(
  /** The merge target's working directory: the main checkout or the parent's worktree. */
  root: string,
  info: WorktreeInfo,
  commitMessage: string,
  /** Optional gate before merging (review-before-merge). Not called when there is nothing to merge. */
  review?: (changedFiles: string[], tip: string) => Promise<GateDecision>,
  opts: IntegrateOptions = {}
): Promise<IntegrateResult> {
  const wt = info.path
  // The target's lock is held for the git work but not while the user reviews the merge, which can take as
  // long as the user likes; another run's merge into the same checkout then waits only for git.
  // `tip` is the branch's commit recorded before the gate (review card, test command) runs; that commit is what merges.
  const prepared = await withRepoLock(root, async (): Promise<IntegrateResult | { changedFiles: string[]; tip: string; carried: readonly string[]; merged?: IntegrateResult }> => {
    if (!existsSync(wt)) {
      return { info: { ...info, status: 'removed' }, message: 'Worktree was already removed; nothing to integrate.' }
    }
    // The user's git (or one that stopped half way) holds a merge or an index.lock: never commit, merge, abort or remove over it.
    const refusal = await unfinishedGitStateRefusal([root, wt], `branch ${info.branch} is kept at ${wt}`)
    if (refusal) return { info: { ...info, status: 'conflict' }, message: refusal.message }

    const commit = await commitLeftovers(wt, commitMessage)
    if (commit.error) {
      return { info: { ...info, status: 'conflict' }, message: `Could not commit the worktree changes: ${commit.error}` }
    }

    // Project.mainBranch: the merge lands there (the checkout is switched to it only when that loses nothing).
    const branchRefusal = await ensureMainBranch(root, opts.mainBranch)
    if (branchRefusal) return { info: { ...info, status: 'conflict' }, message: branchRefusal }

    // Anything to merge at all?
    const head = await git(root, ['rev-parse', 'HEAD'])
    const ahead = await git(root, ['rev-list', '--count', `HEAD..${info.branch}`])
    if (!ahead.ok || ahead.out === '0') {
      await discardWorktree(root, info)
      return { info: { ...info, status: 'empty', changedFiles: [] }, message: 'The report made no changes; worktree removed.' }
    }

    const changed = await git(root, ['diff', '--name-only', `${head.out}...${info.branch}`])
    const changedFiles = changed.ok ? changed.out.split(/\r?\n/).filter(Boolean) : []
    const tip = await branchTip(root, info.branch)
    if (!tip) return { info: { ...info, status: 'conflict' }, message: `Could not read branch ${info.branch}; it is kept at ${wt}.` }
    // The settings the merge carries are read here, before any repository code (the test command) can run; a gate hands back
    // its own earlier snapshot (GateDecision.carried), this one serves a merge with no gate and a gate that gave none.
    const carried = await mergeCarriedConfigArgs(root)
    // Without a review gate the merge follows under the same lock.
    return review ? { changedFiles, tip, carried } : { changedFiles, tip, carried, merged: await mergeInto(root, info, commitMessage, changedFiles, tip, carried) }
  })
  if ('info' in prepared) return prepared
  if (prepared.merged) return prepared.merged
  const { changedFiles } = prepared
  let approvedTip = prepared.tip
  let carried: readonly string[] = prepared.carried
  let verifyRoot: (() => Promise<string | undefined>) | undefined

  if (review) {
    const decision = await review(changedFiles, prepared.tip)
    if (decision.behavior === 'merge' && decision.sha) approvedTip = decision.sha
    if (decision.behavior === 'merge') {
      verifyRoot = decision.verify
      if (decision.carried) carried = decision.carried
    }
    if (decision.behavior === 'refuse') {
      return { info: { ...info, status: 'conflict', changedFiles }, message: decision.message, refused: decision.reason }
    }
    if (decision.behavior === 'discard') {
      try {
        await discardWorktree(root, info)
      } catch (e) {
        if (e instanceof UnfinishedGitStateError) return { info: { ...info, status: 'conflict', changedFiles }, message: e.message }
        throw e
      }
      return { info: { ...info, status: 'removed', changedFiles }, message: `The user discarded ${info.branch}; its changes were deleted.` }
    }
    if (decision.behavior === 'hold') {
      return {
        info: { ...info, status: 'held', changedFiles },
        message: `The user is holding ${info.branch} for later review; it was not merged and is kept at ${wt}.`
      }
    }
  }

  return withRepoLock(root, async () => {
    // The lock was released during the review: maintenance or another run may have removed the worktree meanwhile.
    if (!existsSync(wt)) {
      return { info: { ...info, status: 'removed', changedFiles }, message: `${info.branch} was removed during the review; nothing was merged.` }
    }
    // Repository code (the test command) ran as the user since the checkout was last looked at: the merge lands only if that
    // checkout is as the gate left it (HEAD, index, config and hooks did not move afterwards). Before anything of OrgAI's own
    // touches the checkout (the switch to mainBranch below moves HEAD on purpose).
    const drift = await verifyRoot?.()
    if (drift) return { info: { ...info, status: 'conflict', changedFiles }, message: `${drift} Branch ${info.branch} is kept at ${wt}.` }
    const refusal = await unfinishedGitStateRefusal([root, wt], `branch ${info.branch} is kept at ${wt}`)
    if (refusal) return { info: { ...info, status: 'conflict', changedFiles }, message: refusal.message }
    const branchRefusal = await ensureMainBranch(root, opts.mainBranch)
    if (branchRefusal) return { info: { ...info, status: 'conflict', changedFiles }, message: branchRefusal }
    // Only the commit the user approved (or the one recorded before the test command ran) may land. The gate (the review
    // card, the tests) can run repository code that commits to the branch: a moved tip is refused, never merged unseen.
    const now = await branchTip(root, info.branch)
    if (now !== approvedTip) {
      return {
        info: { ...info, status: 'conflict', changedFiles },
        message: `Not merged: branch ${info.branch} changed after it was reviewed or before the tests finished, so the new commits were not approved. It is kept at ${wt}; integrate it again to review it as it is now.`
      }
    }
    return mergeInto(root, info, commitMessage, changedFiles, approvedTip, carried)
  })
}

/** A merge prints a diffstat of every file it touches. */
const MERGE_OUTPUT = { maxBuffer: 8 * 1024 * 1024 }

/**
 * integrateWorktree's merge step; the caller holds the target's lock. Merges the commit `sha`, never the branch name.
 * Every git call here, and the removal and branch deletion after it, goes through the guarded runner (gitGuarded): no hooks
 * (core.hooksPath off), no fsmonitor, no pager or ssh program. A test command (repository code, run as the user) may have
 * changed the shared git dir's config or hooks before this runs; the overrides on the command line win over the file.
 * Not closed by them: a merge driver (merge.<name>.driver) the config already named, a clean filter, a program the user's
 * own system or global config names. The caller checks the repository's config and hooks did not change while the tests
 * ran (rootPin.ts); what was there before is the user's own.
 */
async function mergeInto(root: string, info: WorktreeInfo, commitMessage: string, changedFiles: string[], sha: string, carried: readonly string[]): Promise<IntegrateResult> {
  const wt = info.path
  // A merge driver or the built-in `union` selected by an attribute would make the merged content differ from the reviewed
  // commit: refused, not merged (the config's own drivers are pinned by rootPin.ts, the user's global ones are ignored below).
  // So is a filter (git-lfs and the like): the merge runs no filter program and would write the stored form of the file.
  const attrRefusal = await mergeAttributeRefusal(root, sha, changedFiles)
  if (attrRefusal) return { info: { ...info, status: 'conflict', changedFiles }, message: `Not merged: ${attrRefusal} Branch ${info.branch} is kept at ${wt}.` }
  // `carried` is the snapshot taken before the test command ran: nothing is read from the user's config here.
  const mergeArgs = [...carried, 'merge', '--no-ff', '--no-edit', '-m', `Merge ${info.branch}: ${commitMessage}`, sha]
  // HEAD is read immediately before each attempt: the ledger records a move only when this merge made it (mergeMadeMove).
  const attempt = async (args: string[]): Promise<{ res: Awaited<ReturnType<typeof gitGuarded>>; before: HeadState }> => {
    const before = await readHeadState(root)
    return { res: await gitGuarded(root, args, { ...MERGE_OUTPUT, neutral: true }), before }
  }
  let { res: merge, before } = await attempt(mergeArgs)
  if (!merge.ok && IDENTITY_ERROR.test(merge.err)) {
    // No git identity (fresh CI runner, new machine): undo any half-made merge and retry with OrgAI's, as commits do.
    await gitGuarded(root, ['merge', '--abort'])
    const retry = await attempt([...FALLBACK_IDENTITY, ...mergeArgs])
    merge = retry.res
    before = retry.before
  }
  if (merge.ok) {
    const after = await readHeadState(root)
    if (await mergeMadeMove(root, before, after, sha)) recordOrgAiMove(root, before, after)
  }
  if (!merge.ok) {
    const conflicts = await gitGuarded(root, ['diff', '--no-ext-diff', '--name-only', '--diff-filter=U'])
    const conflictFiles = conflicts.ok ? conflicts.out.split(/\r?\n/).filter(Boolean) : []
    await gitGuarded(root, ['merge', '--abort'])
    const reason = conflictFiles.length ? `conflicts in ${conflictFiles.join(', ')}` : merge.err.slice(0, 300)
    // Team files changed in the main checkout and not committed: git refuses a merge that would overwrite them.
    const teamBlock = !conflictFiles.length && /\.orgai\//.test(merge.err) ? ' Uncommitted team files in .orgai block this merge; commit them and integrate again.' : ''
    return {
      info: { ...info, status: 'conflict', changedFiles },
      message: `Branch ${info.branch} could not be merged automatically (${reason}). It is kept at ${wt}.${teamBlock}`
    }
  }

  const into = await targetName(root)
  await removeWorktree(root, wt)
  await gitGuarded(root, ['branch', '-d', info.branch])
  return {
    info: { ...info, status: 'merged', changedFiles },
    message: `Merged ${info.branch} into ${into} (${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'}: ${changedFiles.slice(0, 12).join(', ')}${changedFiles.length > 12 ? ', …' : ''}).`
  }
}

/** git's boolean spellings, as `git config --type=bool` reads them; null for anything else. */
function parseGitBool(v: string): 'true' | 'false' | null {
  const t = v.trim().toLowerCase()
  if (t === 'true' || t === 'yes' || t === 'on' || t === '1') return 'true'
  if (t === 'false' || t === 'no' || t === 'off' || t === '0') return 'false'
  return null
}

/** Each carried key and what its value may be: a value outside it is dropped, never passed on. */
const CARRIED_VALUES: Record<string, (v: string) => string | null> = {
  'core.autocrlf': (v) => (v.trim().toLowerCase() === 'input' ? 'input' : parseGitBool(v)),
  'core.eol': (v) => (['lf', 'crlf', 'native'].includes(v.trim().toLowerCase()) ? v.trim().toLowerCase() : null),
  'core.safecrlf': (v) => (v.trim().toLowerCase() === 'warn' ? 'warn' : parseGitBool(v)),
  'core.filemode': parseGitBool,
  'core.symlinks': parseGitBool,
  'user.name': (v) => (v.length > 0 && v.length <= 200 && !/[\0\r\n<>]/.test(v) ? v : null),
  'user.email': (v) => (v.length > 0 && v.length <= 200 && !/[\0\r\n<>\s]/.test(v) ? v : null)
}

/** Two paths name the same folder: slashes and a trailing one ignored, case ignored where the file system is case-insensitive. */
function samePathText(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
    return process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s
  }
  return norm(a) === norm(b)
}

/**
 * The settings the merge needs from the user's own (system and global) git config, which the merge itself ignores (NEUTRAL_*),
 * as git reads them for a commit here: the identity (`user.name`, `user.email`) and how files on disk compare with the index
 * (`core.autocrlf` is on in a stock Git for Windows install, and a merge that ignored it would see every CRLF file as edited
 * and refuse to touch it): `core.autocrlf`, `core.eol`, `core.safecrlf`, `core.filemode`, `core.symlinks`. Exactly these keys,
 * each validated against its allowed values (CARRIED_VALUES); none names a program or a path. `core.protectNTFS` and
 * `core.protectHFS` are never carried: they are forced to git's safe values on every guarded call (WRITE_SAFETY_OVERRIDES).
 * `core.ignorecase` is not carried either: a checkout's own setting lives in the repository config, which the merge reads.
 *
 * `safe.directory` is never carried as a value from config. When the user's config already trusts `root` (the exact path, or `*`)
 * a linked worktree, which has no pinned GIT_DIR, still has to be opened by the neutral merge, so the path OrgAI itself
 * computed (`root`) is passed, never the string read from config.
 *
 * Read ONCE, before the project's test command runs (the command is repository code run as the user and can rewrite the global
 * config): the caller keeps the result with the root pin and hands it to mergeInto. Nothing reads config at merge time. The
 * identity is carried only when both name and email exist (the OrgAI fallback identity applies when git then complains).
 */
export async function mergeCarriedConfigArgs(root: string): Promise<string[]> {
  const res = await gitGuarded(root, ['config', '-z', '--get-regexp', '^(core\\.(autocrlf|eol|safecrlf|filemode|symlinks)|user\\.(name|email)|safe\\.directory)$'], { maxBuffer: 1024 * 1024 })
  if (!res.ok) return []
  const single = new Map<string, string>()
  let trustsRoot = false
  // `git config -z` prints "key\nvalue\0" (a key with no value: "key\0"); later scopes and later lines win.
  for (const entry of res.out.split('\0')) {
    if (!entry) continue
    const nl = entry.indexOf('\n')
    const key = (nl < 0 ? entry : entry.slice(0, nl)).toLowerCase()
    const value = nl < 0 ? '' : entry.slice(nl + 1)
    if (key === 'safe.directory') {
      if (value === '*' || samePathText(value, root)) trustsRoot = true
      continue
    }
    const check = CARRIED_VALUES[key]
    if (!check) continue
    // A boolean written with no value at all (`[core] filemode`) means true.
    const clean = check(nl < 0 && key !== 'user.name' && key !== 'user.email' ? 'true' : value)
    if (clean === null) single.delete(key)
    else single.set(key, clean)
  }
  const args: string[] = []
  for (const [k, v] of single) if (k !== 'user.name' && k !== 'user.email') args.push('-c', `${k}=${v}`)
  const name = single.get('user.name')
  const email = single.get('user.email')
  if (name && email) args.push('-c', `user.name=${name}`, '-c', `user.email=${email}`)
  if (trustsRoot) args.push('-c', `safe.directory=${root}`)
  return args
}

/** `merge` attribute values that cannot change merged content: git's own text merge, or a conflict where both sides changed. */
const PLAIN_MERGE_ATTRS = new Set(['unspecified', 'set', 'unset', 'text', 'binary'])

/** A `filter` attribute set to nothing (or unset) names no program. */
const NO_FILTER_ATTRS = new Set(['unspecified', 'unset'])

/**
 * The scratch index of the attribute check lives under one OrgAI temp folder, so a crash between its creation and removal
 * leaves a file the next start can find and remove (sweepMergeScratch), not a stray file among the OS temp files.
 */
const SCRATCH_DIR_NAME = 'orgai-merge-scratch'
const SCRATCH_STALE_MS = 10 * 60_000
let scratchSwept = false

export function mergeScratchDir(): string {
  return join(tmpdir(), SCRATCH_DIR_NAME)
}

/** Remove scratch indexes (and their lock files) older than ten minutes: a live check takes seconds. Never throws. */
export function sweepMergeScratch(now: number = Date.now()): number {
  let removed = 0
  try {
    const dir = mergeScratchDir()
    for (const name of readdirSync(dir)) {
      if (!/\.index(\.lock)?$/.test(name)) continue
      try {
        const full = join(dir, name)
        if (now - statSync(full).mtimeMs < SCRATCH_STALE_MS) continue
        unlinkSync(full)
        removed++
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* no folder yet */
  }
  return removed
}

/** A fresh scratch index path; the first use in this process sweeps what an earlier crash left. */
function newMergeScratchPath(): string {
  const dir = mergeScratchDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return join(tmpdir(), `orgai-attr-${randomUUID()}.index`)
  }
  if (!scratchSwept) {
    scratchSwept = true
    sweepMergeScratch()
  }
  return join(dir, `${randomUUID()}.index`)
}

/**
 * Every path the merge of `sha` into HEAD can treat as a file, with a rename's old name as well as its new one (an attribute
 * may sit on either): the changes of the merged side since the fork, and the renames of the checkout's own side. null when git
 * could not say.
 */
async function mergePaths(root: string, sha: string, files: readonly string[]): Promise<string[] | null> {
  const all = new Set<string>(files)
  const read = async (range: string, onlyRenames: boolean): Promise<boolean> => {
    const res = await gitGuarded(root, ['diff', '--no-ext-diff', '--name-status', '-M', '-z', ...(onlyRenames ? ['--diff-filter=RC'] : []), range], { maxBuffer: 8 * 1024 * 1024 })
    if (!res.ok) return false
    const parts = res.out.split('\0')
    for (let i = 0; i < parts.length; i++) {
      const status = parts[i] ?? ''
      if (!status) continue
      const two = status[0] === 'R' || status[0] === 'C'
      const first = parts[++i]
      if (first) all.add(first)
      if (two) {
        const second = parts[++i]
        if (second) all.add(second)
      }
    }
    return true
  }
  if (!(await read(`HEAD...${sha}`, false))) return null
  if (!(await read(`${sha}...HEAD`, true))) return null
  return [...all]
}

/** Paths per check-attr call (a Windows command line holds about 32 000 characters). */
const ATTR_CHUNK_CHARS = 12_000

/**
 * A sentence when the merge of `sha` into `root` would run an attribute-selected merge (a driver of any name, or the built-in
 * `union`, which concatenates both sides) on one of the files it changes, else undefined. Read where git reads them for the
 * merge: the root's working tree (tracked, untracked and ignored `.gitattributes`, `info/attributes`, with the user's global
 * and system attributes off) and the attributes the merged commit carries (its own `.gitattributes`, read from a scratch index
 * holding that commit). A failed read refuses, it never passes.
 */
export async function mergeAttributeRefusal(root: string, sha: string, files: readonly string[]): Promise<string | undefined> {
  if (!files.length) return undefined
  // A renamed file is looked up under both names (the old one is where an attribute of the checkout's side may sit).
  const paths = await mergePaths(root, sha, files)
  if (!paths) return 'git could not read the changes of the commit to merge, so the merge attributes were not checked.'
  const chunks: string[][] = []
  let chunk: string[] = []
  let size = 0
  for (const f of paths) {
    if (size + f.length + 1 > ATTR_CHUNK_CHARS && chunk.length) {
      chunks.push(chunk)
      chunk = []
      size = 0
    }
    chunk.push(f)
    size += f.length + 1
  }
  if (chunk.length) chunks.push(chunk)
  const scratch = newMergeScratchPath()
  interface Found {
    merge: { path: string; value: string }[]
    filter: { path: string; value: string }[]
  }
  const find = async (cached: boolean): Promise<Found | string> => {
    const found: Found = { merge: [], filter: [] }
    for (const group of chunks) {
      // `merge` and `filter` are read together; no filter program is run (check-attr only reads attribute files).
      const res = await gitGuarded(root, ['check-attr', '-z', ...(cached ? ['--cached'] : []), 'merge', 'filter', '--', ...group], { neutral: true, maxBuffer: 8 * 1024 * 1024, ...(cached ? { env: { GIT_INDEX_FILE: scratch } } : {}) })
      if (!res.ok) return `git could not read the merge attributes (${res.err.slice(0, 120)}).`
      const parts = res.out.split('\0')
      for (let i = 0; i + 2 < parts.length; i += 3) {
        const attr = parts[i + 1]
        const value = parts[i + 2] ?? ''
        if (attr === 'merge' && !PLAIN_MERGE_ATTRS.has(value)) found.merge.push({ path: parts[i] ?? '', value })
        if (attr === 'filter' && !NO_FILTER_ATTRS.has(value)) found.filter.push({ path: parts[i] ?? '', value })
      }
    }
    return found
  }
  try {
    const here = await find(false)
    if (typeof here === 'string') return here
    const read = await gitGuarded(root, ['read-tree', sha], { env: { GIT_INDEX_FILE: scratch } })
    if (!read.ok) return `git could not read the attributes of the commit to merge (${read.err.slice(0, 120)}).`
    const there = await find(true)
    if (typeof there === 'string') return there
    const filters = [...here.filter, ...there.filter]
    if (filters.length) {
      const named = [...new Set(filters.map((b) => `${b.path} (filter=${b.value})`))].slice(0, 3).join(', ')
      return (
        `a filter is set for ${named}${filters.length > 3 ? ', ...' : ''} (git-lfs, or another clean/smudge filter). OrgAI's merge runs no filter program, so it would write the stored form of those files ` +
        `(for git-lfs, pointer files instead of the content) and the folder would show them as modified. Merge it by hand with git in the project folder (git merge ${sha.slice(0, 12)}), where your filters run; the branch is kept.`
      )
    }
    const bad = [...here.merge, ...there.merge]
    if (!bad.length) return undefined
    const named = [...new Set(bad.map((b) => `${b.path} (merge=${b.value})`))].slice(0, 3).join(', ')
    return `a merge attribute selects a custom merge for ${named}${bad.length > 3 ? ', ...' : ''}, which could make the merged content differ from the reviewed commit. Only git's own text merge is used here: remove the merge attribute (in .gitattributes or .git/info/attributes), then integrate again.`
  } finally {
    try {
      unlinkSync(scratch)
    } catch {
      /* ignore */
    }
  }
}

/** HEAD's commit and the branch it is on, as rootPin.ts reads them. */
export async function readHeadState(root: string): Promise<HeadState> {
  const head = await gitGuarded(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  const branch = await gitGuarded(root, ['symbolic-ref', '--quiet', 'HEAD'])
  return { head: head.ok ? head.out : 'none', branch: branch.ok ? branch.out : 'detached' }
}

/**
 * True when HEAD went from `before` to `after` BECAUSE OF the merge of `sha` OrgAI just ran: `before` was read immediately
 * before `git merge`, and the new HEAD is a merge commit whose first parent is exactly `before` and whose second parent is
 * `sha`, or (a fast-forward) is `sha` itself with `before` an ancestor of it. A ref somebody else moved inside OrgAI's window
 * (a plumbing `update-ref` from another report's test command, between an earlier read and the merge) matches neither, so it is
 * not recorded in OrgAI's ledger (orgaiMoves.ts) and the merge gate reports it as someone else's change. Never a snapshot from
 * function entry.
 */
export async function mergeMadeMove(root: string, before: HeadState, after: HeadState, sha: string): Promise<boolean> {
  if (before.head === 'none' || after.head === 'none' || before.head === after.head || before.branch !== after.branch) return false
  const line = await gitGuarded(root, ['rev-list', '--parents', '-n', '1', after.head])
  if (!line.ok) return false
  const parents = line.out.split(/\s+/).slice(1)
  if (parents.length === 2 && parents[0] === before.head && parents[1] === sha) return true
  if (after.head === sha) return (await gitGuarded(root, ['merge-base', '--is-ancestor', before.head, sha])).ok
  return false
}

/** Largest patch sent to the renderer; bigger diffs are cut with a note. */
const MAX_PATCH_BYTES = 200 * 1024

/** A branch's changes since it forked from HEAD of `root` (the main checkout, or a parent's worktree). */
export async function diffWorktree(root: string, branch: string, ref: string = branch): Promise<WorktreeDiff & { changedFiles: string[] }> {
  // `ref` is the commit the merge gate recorded (so the card shows exactly what will merge); a branch name otherwise.
  const range = `HEAD...${ref}`
  const [stat, patch, names] = await Promise.all([
    git(root, ['diff', '--stat', range]),
    git(root, ['diff', range]),
    git(root, ['diff', '--name-only', range])
  ])
  let text = patch.ok ? patch.out : `Could not compute the diff: ${patch.err}`
  if (Buffer.byteLength(text, 'utf8') > MAX_PATCH_BYTES) {
    const cut = Buffer.from(text, 'utf8').subarray(0, MAX_PATCH_BYTES).toString('utf8')
    text = `${cut.slice(0, cut.lastIndexOf('\n') + 1)}\n… diff truncated at ${MAX_PATCH_BYTES / 1024} KB; run git diff ${range} for the rest.`
  }
  return {
    stat: stat.ok ? stat.out : stat.err,
    patch: text,
    changedFiles: names.ok ? names.out.split(/\r?\n/).filter(Boolean) : []
  }
}

// ---- Branch deletion (maintenance.deleteBranch) ----

/**
 * One git call for the branch checks and deletions below: no pager and the hostile-config overrides in front of the
 * subcommand, and (when `root` has a plain `.git` directory) the pinned read-only environment of readOnlyGitEnv, which
 * allows no transport and no lazy fetch. Branch deletion talks to no remote and runs no hook; this is defence in depth.
 */
export function gitGuarded(
  root: string,
  args: string[],
  opts: { maxBuffer?: number; /** The merge's isolation from the user's own git config and attributes (see NEUTRAL_*). */ neutral?: boolean; env?: Record<string, string> } = {}
): Promise<{ ok: boolean; out: string; err: string }> {
  const bin = gitExecutable()
  if (!bin) return Promise.resolve({ ok: false, out: '', err: 'git was not found on PATH.' })
  const env: NodeJS.ProcessEnv = { ...guardedGitEnv(root), ...(opts.neutral ? NEUTRAL_ENV : {}), ...(opts.env ?? {}) }
  return new Promise((resolve) => {
    const child = execFile(bin, ['--no-pager', ...HOSTILE_CONFIG_OVERRIDES, ...WRITE_SAFETY_OVERRIDES, ...(opts.neutral ? NEUTRAL_OVERRIDES : []), ...args], { cwd: root, env, windowsHide: true, timeout: 60_000, maxBuffer: opts.maxBuffer ?? 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: String(stdout).trim(), err: String(stderr ?? error?.message ?? '').trim() })
    })
    trackChildProcess(child, 'git')
  })
}

/**
 * Whether two branch names are the same branch to the file system holding the repository: refs are files, so on Windows
 * and macOS (case-insensitive by default) `Main` and `main` are one branch, and a protection of one covers the other.
 * Elsewhere names are compared exactly. `platform` is for tests.
 */
export function sameBranchName(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** The branch the checkout at `root` is on, or null on a detached HEAD (or when git cannot say). */
export async function currentBranchName(root: string): Promise<string | null> {
  const res = await gitGuarded(root, ['symbolic-ref', '--short', '-q', 'HEAD'])
  return res.ok && res.out ? res.out : null
}

/** True when `refs/heads/<name>` exists. `name` must already pass isValidBranchName. */
export async function localBranchExists(root: string, name: string): Promise<boolean> {
  return (await gitGuarded(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])).ok
}

/**
 * Names that count as the repository's default branch: what origin/HEAD points at (when a remote is configured),
 * `init.defaultBranch`, and the two usual names. Local read only.
 */
export async function defaultBranchNames(root: string): Promise<string[]> {
  const names = new Set<string>(['main', 'master'])
  const remote = await gitGuarded(root, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])
  if (remote.ok && remote.out.startsWith('origin/')) names.add(remote.out.slice('origin/'.length))
  const configured = await gitGuarded(root, ['config', '--get', 'init.defaultBranch'])
  if (configured.ok && configured.out) names.add(configured.out)
  return [...names]
}

export type DeleteBranchOutcome = { ok: true; removedCopy: boolean } | { ok: false; message: string }

/**
 * Delete the local branch `branch` (only ever refs/heads, never a remote; nothing is pushed or fetched).
 * - With `copyPath` (the branch's finished copy): the copy is removed like a discard (nested copies are moved out first)
 *   and the branch is force-deleted: `git branch -D -- <branch>`. Unmerged work goes with it.
 * - Without: `git branch -d -- <branch>`, which git itself refuses unless the branch is merged into HEAD.
 * Under the repository lock. Throws UnfinishedGitStateError, changing nothing, when the repository or the copy holds an
 * unfinished operation (a merge in progress, an index.lock that stays). Re-checks under the lock that the branch is not
 * the checkout's current one. The caller has already decided the branch may go (maintenance.ts deleteBranch).
 */
export async function deleteReportBranch(
  root: string,
  branch: string,
  opts: {
    copyPath?: string
    /**
     * Asked first, under the repository lock: the caller's refusal (a live run now uses the branch, it is now the default or
     * main branch, ...) or nothing. The conditions were true when the caller looked and may not be now (security review L8).
     */
    recheck?: () => Promise<string | undefined> | string | undefined
  } = {}
): Promise<DeleteBranchOutcome> {
  return withRepoLock(root, async (): Promise<DeleteBranchOutcome> => {
    const again = await opts.recheck?.()
    if (again) return { ok: false, message: again }
    const refusal = await unfinishedGitStateRefusal(opts.copyPath ? [root, opts.copyPath] : [root], `branch ${branch} is kept`)
    if (refusal) throw new UnfinishedGitStateError(refusal.message, refusal.files)
    const onBranch = await currentBranchName(root)
    if (onBranch !== null && sameBranchName(onBranch, branch)) return { ok: false, message: `${branch} is the branch this checkout is on, so it was not deleted.` }
    if (opts.copyPath) await removeWorktree(root, opts.copyPath)
    const res = await gitGuarded(root, ['branch', opts.copyPath ? '-D' : '-d', '--', branch])
    if (res.ok) return { ok: true, removedCopy: Boolean(opts.copyPath) }
    const why = /not fully merged/i.test(res.err) ? 'it has commits that are not merged into the current branch' : res.err.split(/\r?\n/)[0]?.slice(0, 200) || 'git refused'
    return { ok: false, message: `${branch} was not deleted: ${why}.${opts.copyPath ? ' Its finished copy was already removed.' : ''}` }
  })
}
