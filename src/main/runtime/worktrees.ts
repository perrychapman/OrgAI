import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
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
 * The exclude line lives in .git/info/exclude, which belongs to the common git dir and so
 * applies to every worktree. The pattern ".claude/worktrees/" has a slash in the middle, so it
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
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: String(stdout).trim(), err: String(stderr ?? error?.message ?? '').trim() })
    })
  })
}

/** Tail of each checkout's lock queue, by pathKey. Removed when the last holder releases. */
const repoLocks = new Map<string, Promise<void>>()
/** Keys the current async call chain already holds, so nested calls (integrate -> discard) do not wait on themselves. */
const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>()

/**
 * Run `fn` while holding the lock of one checkout (the main checkout or a worktree), keyed by pathKey(root).
 * Two runs of one project, or a run and the maintenance panel, then never merge, commit or remove worktrees in
 * the same checkout at the same time. Different checkouts do not block each other. Re-entrant within one call
 * chain. Callers queue in arrival order; a rejected fn releases the lock.
 */
export async function withRepoLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const key = pathKey(root)
  const held = heldLocks.getStore()
  if (held?.has(key)) return fn()
  const prev = repoLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>((r) => (release = r))
  const tail = prev.then(() => mine)
  repoLocks.set(key, tail)
  await prev
  try {
    return await heldLocks.run(new Set([...(held ?? []), key]), fn)
  } finally {
    release()
    if (repoLocks.get(key) === tail) repoLocks.delete(key)
  }
}

/** Keep agent worktrees out of `git status` and prune leftovers from crashed runs. */
export async function prepareRepo(root: string): Promise<void> {
  if (!isGitRepo(root)) return
  await withRepoLock(root, () => prepareRepoUnlocked(root))
}

async function prepareRepoUnlocked(root: string): Promise<void> {
  const infoDir = join(root, '.git', 'info')
  try {
    mkdirSync(infoDir, { recursive: true })
    const excludeFile = join(infoDir, 'exclude')
    const existing = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : ''
    if (!existing.split(/\r?\n/).includes(EXCLUDE_LINE)) appendFileSync(excludeFile, `${existing.endsWith('\n') || !existing ? '' : '\n'}${EXCLUDE_LINE}\n`)
  } catch {
    /* best effort */
  }
  await git(root, ['worktree', 'prune'])
}

/** Undo what prepareRepo added to .git/info/exclude. */
export function removeExcludeLine(root: string): boolean {
  const excludeFile = join(root, '.git', 'info', 'exclude')
  if (!existsSync(excludeFile)) return false
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

/**
 * Path comparison key: forward slashes, no trailing slash. Case-folded on Windows and macOS, whose default
 * file systems are case-insensitive, but not on Linux. Symlinks are resolved when the path exists: git prints
 * real paths (/private/var/... for /var/...) while a project folder may have been picked through a symlink.
 */
export function pathKey(p: string, platform: string = process.platform): string {
  let real = p
  try {
    real = realpathSync.native(p)
  } catch {
    /* the path does not exist (yet): compare as given */
  }
  const key = real.replace(/\\/g, '/').replace(/\/+$/, '')
  return platform === 'win32' || platform === 'darwin' ? key.toLowerCase() : key
}

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

/** Stage and commit whatever a report left behind. Returns true when a commit was made. */
export async function commitLeftovers(wt: string, message: string): Promise<{ committed: boolean; error?: string }> {
  return withRepoLock(wt, () => commitLeftoversUnlocked(wt, message))
}

async function commitLeftoversUnlocked(wt: string, message: string): Promise<{ committed: boolean; error?: string }> {
  const status = await git(wt, ['status', '--porcelain'])
  if (!status.ok || !status.out) return { committed: false }
  await git(wt, ['add', '-A', ...ADD_PATHSPEC])
  const nothingStaged = (await git(wt, ['diff', '--cached', '--quiet'])).ok
  if (nothingStaged) {
    await git(wt, ['reset', '-q'])
    return { committed: false }
  }
  let commit = await git(wt, ['commit', '-q', '-m', message])
  if (!commit.ok && /user\.name|user\.email|identity/i.test(commit.err)) {
    commit = await git(wt, ['-c', 'user.name=OrgAI', '-c', 'user.email=orgai@localhost', 'commit', '-q', '-m', message])
  }
  return commit.ok ? { committed: true } : { committed: false, error: commit.err.slice(0, 300) }
}

/** Remove a worktree and its branch, discarding any work on it. */
export async function discardWorktree(root: string, wt: { path: string; branch: string }): Promise<void> {
  await withRepoLock(root, async () => {
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
      await discardWorktree(root, info)
      return { info: { ...info, status: 'removed', changedFiles }, message: `The user discarded ${info.branch}; its changes were deleted.` }
    }
    if (decision.behavior === 'hold') {
      return {
        info: { ...info, status: 'held', changedFiles },
        message: `The user is holding ${info.branch} for later review; it was not merged and is kept at ${wt}.`
      }
    }
  }

  return withRepoLock(root, () => mergeInto(root, info, commitMessage, changedFiles))
}

/** integrateWorktree's merge step; the caller holds the target's lock. */
async function mergeInto(root: string, info: WorktreeInfo, commitMessage: string, changedFiles: string[]): Promise<IntegrateResult> {
  const wt = info.path
  const merge = await git(root, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${info.branch}: ${commitMessage}`, info.branch])
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
