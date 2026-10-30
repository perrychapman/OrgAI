import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
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

/**
 * Every harness-owned Git invocation disables hooks and filesystem monitors. Both are executable repository
 * configuration and must not run merely because OrgAI inspected, committed or integrated a worktree. A private,
 * empty directory is portable across Git for Windows, macOS and Linux (unlike /dev/null).
 */
const EMPTY_HOOKS_DIR = mkdtempSync(join(tmpdir(), 'orgai-no-git-hooks-'))
const SAFE_GIT_CONFIG = [
  '-c',
  `core.hooksPath=${EMPTY_HOOKS_DIR.replace(/\\/g, '/')}`,
  '-c',
  'core.fsmonitor=false',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'merge.gpgSign=false'
]

/** Args shared with the Codex worktree creator, which lives in a separate module. */
export function secureGitArgs(args: string[]): string[] {
  // Repository diff drivers and textconv filters are executable too. Git's explicit switches override both config
  // and attributes without changing ordinary diff output.
  const command = args[0] === 'diff' ? ['diff', '--no-ext-diff', '--no-textconv', ...args.slice(1)] : args
  return [...SAFE_GIT_CONFIG, ...command]
}

export function isGitRepo(root: string): boolean {
  return existsSync(join(root, '.git'))
}

function git(root: string, args: string[], input?: string, rawOutput = false): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      secureGitArgs(args),
      { cwd: root, windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ ok: !error, out: rawOutput ? String(stdout) : String(stdout).trim(), err: String(stderr ?? error?.message ?? '').trim() })
    )
    if (input !== undefined) {
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
    }
  })
}

const EXECUTABLE_GIT_CONFIG = '^(filter\\..*\\.(clean|smudge|process)|merge\\..*\\.driver|diff\\..*\\.(command|textconv))$'

/**
 * Filter and merge-driver commands selected by repository attributes are invoked by checkout, add or merge. There
 * is no portable, lossless no-op replacement for an arbitrary driver, so automation fails closed and leaves the
 * worktree for manual handling. Values are intentionally never returned or logged.
 */
export async function gitAutomationRisk(root: string, source?: string, additionalPathSource?: string): Promise<string | undefined> {
  // Query every scope: a tracked .gitattributes can select a driver from global or system config. We reject only
  // drivers Git says are active for a repository path, so an unused global Git LFS installation does not block work.
  const configured = await git(root, ['config', '--includes', '--name-only', '--get-regexp', EXECUTABLE_GIT_CONFIG])
  if (!configured.out) {
    // git config exits 1 with no stderr when nothing matched. Any actual config error fails closed.
    return configured.err ? 'Git automation is disabled because executable Git configuration could not be inspected safely.' : undefined
  }
  const drivers = new Map<string, string[]>()
  for (const key of [...new Set(configured.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))]) {
    const m = /^(filter|merge|diff)\.(.+)\.(?:clean|smudge|process|driver|command|textconv)$/i.exec(key)
    if (!m) continue
    drivers.set(`${m[1].toLowerCase()}\0${m[2]}`, [...(drivers.get(`${m[1].toLowerCase()}\0${m[2]}`) ?? []), key])
  }
  if (!drivers.size) return undefined

  const listed = source
    ? await Promise.all(
        [source, ...(additionalPathSource ? [additionalPathSource] : [])].map((tree) =>
          git(root, ['ls-tree', '-r', '--name-only', '-z', tree], undefined, true)
        )
      )
    : await Promise.all([
        git(root, ['ls-files', '-co', '--exclude-standard', '-z'], undefined, true),
        ...(additionalPathSource ? [git(root, ['ls-tree', '-r', '--name-only', '-z', additionalPathSource], undefined, true)] : [])
      ])
  if (listed.some((result) => !result.ok)) return 'Git automation is disabled because repository attributes could not be inspected safely.'
  // During a merge, target attributes also apply to paths introduced only by the source tree. Evaluate the target's
  // exact attributes against the union of both trees, preserving filenames byte-for-byte from NUL output.
  const paths = [...new Set(listed.flatMap((result) => result.out.split('\0').filter(Boolean)))]
  const active = new Set<string>()
  // Keep each check bounded: --all emits only attributes that are actually set, not three unspecified records per path.
  for (let i = 0; i < paths.length; i += 4096) {
    const batch = paths.slice(i, i + 4096)
    const attrs = await git(
      root,
      ['check-attr', '-z', ...(source ? ['--source', source] : []), '--stdin', '--all'],
      `${batch.join('\0')}\0`,
      true
    )
    if (!attrs.ok) return 'Git automation is disabled because repository attributes could not be inspected safely.'
    const fields = attrs.out.split('\0')
    for (let n = 0; n + 2 < fields.length; n += 3) {
      const attr = fields[n + 1]
      const value = fields[n + 2]
      for (const key of drivers.get(`${attr.toLowerCase()}\0${value}`) ?? []) active.add(key)
    }
  }
  if (!active.size) return undefined
  return `Git automation is disabled because repository attributes select executable filters or merge drivers (${[...active].sort().join(', ')}). Remove or manually review that configuration first.`
}

/** Exact, unambiguous worktree state for review snapshots; NUL output preserves every legal filename byte. */
function gitStatus(root: string): Promise<{ ok: boolean; out: string; err: string }> {
  return git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], undefined, true)
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
 * Real path of `p`, or for a path that does not exist (yet) the real path of its nearest existing ancestor plus
 * the rest, so /tmp/proj/.claude/worktrees/new keys like /private/tmp/proj/.claude/worktrees/new.
 */
function realpathOfNearest(p: string): string {
  if (!isAbsolute(p)) return p
  const rest: string[] = []
  let cur = p
  // Stop below the filesystem root: resolving "/" alone would turn a foreign path into C:\... on Windows.
  for (let parent = dirname(cur); parent !== cur; cur = parent, parent = dirname(cur)) {
    try {
      const real = realpathSync.native(cur)
      return rest.length ? join(real, ...rest.reverse()) : real
    } catch {
      rest.push(basename(cur))
    }
  }
  return p
}

/**
 * Path comparison key:forward slashes, no trailing slash. Case-folded on Windows and macOS, whose default
 * file systems are case-insensitive, but not on Linux. Symlinks are resolved when the path exists: git prints
 * real paths (/private/var/... for /var/...) while a project folder may have been picked through a symlink.
 */
export function pathKey(p: string, platform: string = process.platform): string {
  const key = realpathOfNearest(p).replace(/\\/g, '/').replace(/\/+$/, '')
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
    // Status may invoke a clean filter to compare working-tree content with the index. Inspect attributes first and
    // never run it when an executable driver is active; report one conservative pending change to keep cleanup gated.
    const risk = exists ? await gitAutomationRisk(wt.path) : undefined
    const status = exists && !risk ? await gitStatus(wt.path) : { ok: false, out: '', err: '' }
    const uncommitted = risk ? 1 : status.ok ? status.out.split('\0').filter(Boolean).length : 0
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

/** git's complaint when no user.name / user.email is configured ("Please tell me who you are", "Author identity unknown"). */
const IDENTITY_ERROR = /user\.name|user\.email|identity|tell me who you are/i
const FALLBACK_IDENTITY = ['-c', 'user.name=OrgAI', '-c', 'user.email=orgai@localhost']

async function commitLeftoversUnlocked(wt: string, message: string): Promise<{ committed: boolean; error?: string }> {
  const risk = await gitAutomationRisk(wt)
  if (risk) return { committed: false, error: risk }
  const status = await gitStatus(wt)
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

/** Immutable commits and file list represented by a merge-review artifact. */
export interface MergeSnapshot {
  changedFiles: string[]
  sourceOid: string
  targetOid: string
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
  review?: (snapshot: MergeSnapshot) => Promise<MergeDecision>
): Promise<IntegrateResult> {
  const wt = info.path
  // The target's lock is held for the git work but not while the user reviews the merge, which can take as
  // long as the user likes; another run's merge into the same checkout then waits only for git.
  const prepared = await withRepoLock(
    root,
    async (): Promise<IntegrateResult | { changedFiles: string[]; sourceOid: string; targetOid: string; sourceStatus: string; merged?: IntegrateResult }> => {
      if (!existsSync(wt)) {
        return { info: { ...info, status: 'removed' }, message: 'Worktree was already removed; nothing to integrate.' }
      }

      const commit = await commitLeftovers(wt, commitMessage)
      if (commit.error) {
        return { info: { ...info, status: 'conflict' }, message: `Could not commit the worktree changes: ${commit.error}` }
      }

      // Resolve both ends once. A reviewed merge later verifies these exact object ids before merging the reviewed source.
      const head = await git(root, ['rev-parse', '--verify', 'HEAD'])
      const source = await git(root, ['rev-parse', '--verify', info.branch])
      const sourceRisk = await gitAutomationRisk(wt)
      if (sourceRisk) {
        return { info: { ...info, status: 'conflict' }, message: `${sourceRisk} Branch ${info.branch} was kept.` }
      }
      const sourceTreeRisk = source.ok ? await gitAutomationRisk(wt, source.out) : undefined
      if (sourceTreeRisk) {
        return { info: { ...info, status: 'conflict' }, message: `${sourceTreeRisk} Branch ${info.branch} was kept.` }
      }
      const sourceStatus = await gitStatus(wt)
      if (!head.ok || !source.ok || !sourceStatus.ok) {
        return { info: { ...info, status: 'conflict' }, message: `Could not resolve the commits for ${info.branch}; it was not merged.` }
      }
      const ahead = await git(root, ['rev-list', '--count', `${head.out}..${source.out}`])
      if (!ahead.ok || ahead.out === '0') {
        await discardWorktree(root, info)
        return { info: { ...info, status: 'empty', changedFiles: [] }, message: 'The report made no changes; worktree removed.' }
      }

      const changed = await git(root, ['diff', '--name-only', `${head.out}...${source.out}`])
      const changedFiles = changed.ok ? changed.out.split(/\r?\n/).filter(Boolean) : []
      // Without a review gate the merge follows under the same lock.
      return review
        ? { changedFiles, sourceOid: source.out, targetOid: head.out, sourceStatus: sourceStatus.out }
        : {
            changedFiles,
            sourceOid: source.out,
            targetOid: head.out,
            sourceStatus: sourceStatus.out,
            merged: await mergeInto(root, info, commitMessage, changedFiles, source.out, head.out, sourceStatus.out)
          }
    }
  )
  if ('info' in prepared) return prepared
  if (prepared.merged) return prepared.merged
  const { changedFiles, sourceOid, targetOid, sourceStatus } = prepared

  if (!review) throw new Error('A prepared reviewed merge has no review callback')
  const decision = await review({ changedFiles, sourceOid, targetOid })

  return withRepoLock(root, async () => {
    // The lock was released during the review: maintenance or another run may have removed the worktree meanwhile.
    if (!existsSync(wt)) {
      return { info: { ...info, status: 'removed', changedFiles }, message: `${info.branch} was removed during the review; nothing was merged.` }
    }
    const currentRisk = await gitAutomationRisk(wt)
    if (currentRisk) {
      return { info: { ...info, status: 'conflict', changedFiles }, message: `${currentRisk} Branch ${info.branch} was kept.` }
    }
    const [currentSource, currentTarget, currentStatus] = await Promise.all([
      git(root, ['rev-parse', '--verify', info.branch]),
      git(root, ['rev-parse', '--verify', 'HEAD']),
      gitStatus(wt)
    ])
    if (
      !currentSource.ok ||
      !currentTarget.ok ||
      !currentStatus.ok ||
      currentSource.out !== sourceOid ||
      currentTarget.out !== targetOid ||
      currentStatus.out !== sourceStatus
    ) {
      return {
        info: { ...info, status: 'conflict', changedFiles },
        message: `Branch ${info.branch}, its worktree, or its merge target changed during review. Nothing was merged; review the current diff before trying again.`
      }
    }
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
    return mergeInto(root, info, commitMessage, changedFiles, sourceOid, targetOid, sourceStatus)
  })
}

/** integrateWorktree's merge step; the caller holds the target's lock. */
async function mergeInto(
  root: string,
  info: WorktreeInfo,
  commitMessage: string,
  changedFiles: string[],
  sourceOid: string,
  targetOid: string,
  expectedSourceStatus: string
): Promise<IntegrateResult> {
  const wt = info.path
  const [targetRisk, targetTreeRisk, targetConfigSourceTreeRisk, sourceRisk, sourceTreeRisk] = await Promise.all([
    gitAutomationRisk(root, undefined, sourceOid),
    gitAutomationRisk(root, targetOid, sourceOid),
    gitAutomationRisk(root, sourceOid, targetOid),
    gitAutomationRisk(wt),
    gitAutomationRisk(wt, sourceOid, targetOid)
  ])
  const risk = targetRisk ?? targetTreeRisk ?? targetConfigSourceTreeRisk ?? sourceRisk ?? sourceTreeRisk
  if (risk) return { info: { ...info, status: 'conflict', changedFiles }, message: `${risk} Branch ${info.branch} was kept.` }
  const [currentSource, currentTarget, currentStatus] = await Promise.all([
    git(root, ['rev-parse', '--verify', info.branch]),
    git(root, ['rev-parse', '--verify', 'HEAD']),
    gitStatus(wt)
  ])
  if (
    !currentSource.ok ||
    !currentTarget.ok ||
    !currentStatus.ok ||
    currentSource.out !== sourceOid ||
    currentTarget.out !== targetOid ||
    currentStatus.out !== expectedSourceStatus
  ) {
    return {
      info: { ...info, status: 'conflict', changedFiles },
      message: `Branch ${info.branch}, its worktree, or its merge target changed before merge. Nothing was merged; review the current diff before trying again.`
    }
  }
  const mergeArgs = ['merge', '--no-ff', '--no-edit', '-m', `Merge ${info.branch}: ${commitMessage}`, sourceOid]
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

/** Changes between exact commits, or HEAD and a branch for maintenance callers that omit `target`. */
export async function diffWorktree(root: string, source: string, target = 'HEAD'): Promise<WorktreeDiff & { changedFiles: string[] }> {
  const range = `${target}...${source}`
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
