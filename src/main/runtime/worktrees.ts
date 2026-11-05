import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { gitPath, gitPathSync, pathKey, repoLockRecovery, withRepoLock as repoLock } from './repoLock'
import { gitExecutable } from '../host/systemBinaries'
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
const BRANCH_PREFIX = 'worktree-agent-'

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
    execFile(bin, args, { cwd: root, windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: String(stdout).trim(), err: String(stderr ?? error?.message ?? '').trim() })
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
    if ((await git(main, ['worktree', 'move', wt.path, dest])).ok) moved.push(dest)
  }
  return moved
}

/** Remove one worktree directory (keeping nested agent worktrees) and prune its record. */
async function removeWorktree(root: string, path: string): Promise<void> {
  if (existsSync(path)) {
    await evacuateNested(root, path)
    await git(root, ['worktree', 'remove', '--force', path])
  }
  await git(root, ['worktree', 'prune'])
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
}

/** How a merge target is named in messages: the main checkout, or the parent report's branch. */
async function targetName(root: string): Promise<string> {
  const head = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
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
  review?: (changedFiles: string[]) => Promise<MergeDecision>
): Promise<IntegrateResult> {
  const wt = info.path
  // The target's lock is held for the git work but not while the user reviews the merge, which can take as
  // long as the user likes; another run's merge into the same checkout then waits only for git.
  const prepared = await withRepoLock(root, async (): Promise<IntegrateResult | { changedFiles: string[]; merged?: IntegrateResult }> => {
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

    // Anything to merge at all?
    const head = await git(root, ['rev-parse', 'HEAD'])
    const ahead = await git(root, ['rev-list', '--count', `HEAD..${info.branch}`])
    if (!ahead.ok || ahead.out === '0') {
      await discardWorktree(root, info)
      return { info: { ...info, status: 'empty', changedFiles: [] }, message: 'The report made no changes; worktree removed.' }
    }

    const changed = await git(root, ['diff', '--name-only', `${head.out}...${info.branch}`])
    const changedFiles = changed.ok ? changed.out.split(/\r?\n/).filter(Boolean) : []
    // Without a review gate the merge follows under the same lock.
    return review ? { changedFiles } : { changedFiles, merged: await mergeInto(root, info, commitMessage, changedFiles) }
  })
  if ('info' in prepared) return prepared
  if (prepared.merged) return prepared.merged
  const { changedFiles } = prepared

  if (review) {
    const decision = await review(changedFiles)
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
    const refusal = await unfinishedGitStateRefusal([root, wt], `branch ${info.branch} is kept at ${wt}`)
    if (refusal) return { info: { ...info, status: 'conflict', changedFiles }, message: refusal.message }
    return mergeInto(root, info, commitMessage, changedFiles)
  })
}

/** integrateWorktree's merge step; the caller holds the target's lock. */
async function mergeInto(root: string, info: WorktreeInfo, commitMessage: string, changedFiles: string[]): Promise<IntegrateResult> {
  const wt = info.path
  const mergeArgs = ['merge', '--no-ff', '--no-edit', '-m', `Merge ${info.branch}: ${commitMessage}`, info.branch]
  let merge = await git(root, mergeArgs)
  if (!merge.ok && IDENTITY_ERROR.test(merge.err)) {
    // No git identity (fresh CI runner, new machine): undo any half-made merge and retry with OrgAI's, as commits do.
    await git(root, ['merge', '--abort'])
    merge = await git(root, [...FALLBACK_IDENTITY, ...mergeArgs])
  }
  if (!merge.ok) {
    const conflicts = await git(root, ['diff', '--name-only', '--diff-filter=U'])
    const conflictFiles = conflicts.ok ? conflicts.out.split(/\r?\n/).filter(Boolean) : []
    await git(root, ['merge', '--abort'])
    const reason = conflictFiles.length ? `conflicts in ${conflictFiles.join(', ')}` : merge.err.slice(0, 300)
    return {
      info: { ...info, status: 'conflict', changedFiles },
      message: `Branch ${info.branch} could not be merged automatically (${reason}). It is kept at ${wt}.`
    }
  }

  const into = await targetName(root)
  await removeWorktree(root, wt)
  await git(root, ['branch', '-d', info.branch])
  return {
    info: { ...info, status: 'merged', changedFiles },
    message: `Merged ${info.branch} into ${into} (${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'}: ${changedFiles.slice(0, 12).join(', ')}${changedFiles.length > 12 ? ', …' : ''}).`
  }
}

/** Largest patch sent to the renderer; bigger diffs are cut with a note. */
const MAX_PATCH_BYTES = 200 * 1024

/** A branch's changes since it forked from HEAD of `root` (the main checkout, or a parent's worktree). */
export async function diffWorktree(root: string, branch: string): Promise<WorktreeDiff & { changedFiles: string[] }> {
  const range = `HEAD...${branch}`
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
