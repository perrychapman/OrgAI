import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MergeDecision, PendingWorktree, WorktreeDiff, WorktreeInfo } from '@shared/types'

/**
 * Git plumbing for isolated subagents. Vendor-neutral: any adapter whose subagents work
 * in git worktrees can use it. Claude Code creates the worktree itself (under
 * <repo>/.claude/worktrees/agent-<id> on branch worktree-agent-<id>) and leaves it behind
 * with uncommitted changes; this module commits those changes and merges them back.
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

/** Keep agent worktrees out of `git status` and prune leftovers from crashed runs. */
export async function prepareRepo(root: string): Promise<void> {
  if (!isGitRepo(root)) return
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

async function listAgentWorktrees(root: string): Promise<{ path: string; branch: string }[]> {
  const res = await git(root, ['worktree', 'list', '--porcelain'])
  if (!res.ok) return []
  const out: { path: string; branch: string }[] = []
  let cur: { path?: string; branch?: string } = {}
  for (const line of [...res.out.split(/\r?\n/), '']) {
    if (line.startsWith('worktree ')) cur = { path: line.slice(9).trim() }
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '')
    else if (line === '') {
      if (cur.path && cur.branch?.startsWith(BRANCH_PREFIX)) out.push({ path: cur.path, branch: cur.branch })
      cur = {}
    }
  }
  return out
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
  if (existsSync(wt.path)) await git(root, ['worktree', 'remove', '--force', wt.path])
  await git(root, ['worktree', 'prune'])
  await git(root, ['branch', '-D', wt.branch])
}

export interface IntegrateResult {
  info: WorktreeInfo
  /** Human summary for the log and the orchestrator. */
  message: string
}

/**
 * Commit whatever the subagent left in its worktree and merge it into the main checkout.
 * Clean merges remove the worktree and branch. Conflicts and refusals leave the branch for
 * the orchestrator or the user to integrate by hand.
 */
export async function integrateWorktree(
  root: string,
  info: WorktreeInfo,
  commitMessage: string,
  /** Optional gate before merging (review-before-merge). Not called when there is nothing to merge. */
  review?: (changedFiles: string[]) => Promise<MergeDecision>
): Promise<IntegrateResult> {
  const wt = info.path
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

  await git(root, ['worktree', 'remove', '--force', wt])
  await git(root, ['branch', '-d', info.branch])
  return {
    info: { ...info, status: 'merged', changedFiles },
    message: `Merged ${info.branch} into the main checkout (${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'}: ${changedFiles.slice(0, 12).join(', ')}${changedFiles.length > 12 ? ', …' : ''}).`
  }
}

/** Largest patch sent to the renderer; bigger diffs are cut with a note. */
const MAX_PATCH_BYTES = 200 * 1024

/** A branch's changes since it forked from the main checkout's HEAD. */
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
