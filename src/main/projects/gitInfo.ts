import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { GIT_RECENT_COMMITS_MAX } from '../../shared/types'
import type { GitCommitInfo, GitSummary } from '../../shared/types'
import { gitExecutable } from '../host/systemBinaries'
import { trackChildProcess } from '../host/shutdown'
import { HOSTILE_CONFIG_OVERRIDES, hasPlainGitDir, readOnlyGitEnv } from '../runtime/worktrees'

/**
 * UI overhaul (gitInfo.summary / branches): read-only git facts of a stored code project.
 *
 * Every call is one `execFile` of the git binary (no shell, fixed argument arrays), with a 5 s timeout and an output cap.
 * The environment is the read-only one of worktrees.ts (readOnlyGitEnv: GIT_DIR pinned to `<root>/.git`, no transport,
 * no lazy fetch, no prompts, no optional locks) and every command carries the hostile-config overrides of that module
 * plus `core.untrackedCache=false` and `--no-optional-locks`, so an untrusted repository's config can neither run a
 * program through core.fsmonitor, hooks, pager or ssh nor write a lock or cache. One program path is NOT closed by those
 * overrides: `git status` runs a `filter.<name>.clean` / `.process` driver (named by the repository's config, selected by
 * its .gitattributes) to hash a changed file, and no `-c` switch turns that off. So before `status` the local config is
 * asked for `filter.*` keys in every scope but the user's global and system ones, a worktree-config file is looked for
 * (`extensions.worktreeConfig`, `config.worktree`), and when the repository defines any (or the question fails) status is
 * not run and `dirtyFiles` is reported as 0: dirty counting is skipped for repositories with their own filter drivers. The other
 * commands here (rev-parse, symbolic-ref, for-each-ref, log with --no-textconv --no-ext-diff, rev-list) run no filter.
 * Nothing here fetches, merges or writes.
 * `root` must hold a real `.git` directory (hasPlainGitDir): a `.git` file, a symlink or a linked worktree is "not a
 * repository" here, the same rule as projects:commitActivity.
 *
 * Branch names come from the repository. They are only ever passed as full ref names (`refs/heads/<name>`, which cannot be
 * read as an option) and a Project.mainBranch that starts with '-' is never used.
 */

export const GIT_INFO_TIMEOUT_MS = 5000
export const GIT_INFO_MAX_OUTPUT = 4 * 1024 * 1024
export const GIT_INFO_MAX_BRANCHES = 200
/** Local branches read from the repository at most (the list is sorted by name; the rest is ignored). */
const BRANCH_SCAN_MAX = 2000
const SUBJECT_MAX = 200

const GLOBAL_ARGS = ['--no-pager', '--no-optional-locks', ...HOSTILE_CONFIG_OVERRIDES, '-c', 'core.untrackedCache=false']

interface GitResult {
  ok: boolean
  out: string
  /** The output hit the cap (out holds what was read before git was stopped). */
  truncated: boolean
  /** The process exit code when git exited non-zero (`git config --get-regexp` exits 1 when nothing matches). */
  exitCode?: number
}

function run(bin: string, root: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    try {
      const env = { ...readOnlyGitEnv(root), LC_ALL: 'C', LANG: 'C' }
      const child = execFile(
        bin,
        [...GLOBAL_ARGS, ...args],
        { cwd: root, env, windowsHide: true, timeout: GIT_INFO_TIMEOUT_MS, maxBuffer: GIT_INFO_MAX_OUTPUT, encoding: 'utf8' },
        (error, stdout) => {
          const truncated = !!error && (error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          const code = (error as NodeJS.ErrnoException | null)?.code
          resolve({ ok: !error, out: typeof stdout === 'string' ? stdout : String(stdout ?? ''), truncated, ...(typeof code === 'number' ? { exitCode: code } : {}) })
        }
      )
      trackChildProcess(child, 'git')
    } catch {
      resolve({ ok: false, out: '', truncated: false })
    }
  })
}

interface LocalBranch {
  name: string
  /** Full upstream ref (refs/remotes/...), when one is configured. */
  upstream?: string
}

/** Local branches (sorted by name by git) with their configured upstream refs. */
async function listBranches(bin: string, root: string): Promise<LocalBranch[]> {
  const r = await run(bin, root, ['for-each-ref', '--format=%(refname)%09%(upstream)', 'refs/heads/'])
  if (!r.ok && !r.truncated) return []
  const out: LocalBranch[] = []
  for (const line of r.out.split('\n')) {
    const [ref, upstream] = line.replace(/\r$/, '').split('\t')
    if (!ref || !ref.startsWith('refs/heads/')) continue
    const name = ref.slice('refs/heads/'.length)
    if (!name || name.startsWith('-')) continue
    out.push(upstream && upstream.startsWith('refs/') ? { name, upstream } : { name })
    if (out.length >= BRANCH_SCAN_MAX) break
  }
  return out
}

async function currentBranch(bin: string, root: string): Promise<string | null> {
  const r = await run(bin, root, ['symbolic-ref', '-q', '--short', 'HEAD'])
  const name = r.ok ? r.out.trim() : ''
  return name || null
}

/** Project.mainBranch when it names a local branch, else origin/HEAD's target, else main or master, else the current branch. */
async function detectDefault(bin: string, root: string, local: LocalBranch[], current: string | null, mainBranch?: string): Promise<string | null> {
  const names = new Set(local.map((b) => b.name))
  if (typeof mainBranch === 'string' && mainBranch && !mainBranch.startsWith('-') && names.has(mainBranch)) return mainBranch
  const head = await run(bin, root, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'])
  const prefix = 'refs/remotes/origin/'
  if (head.ok && head.out.trim().startsWith(prefix)) {
    const target = head.out.trim().slice(prefix.length)
    if (names.has(target)) return target
  }
  for (const c of ['main', 'master']) if (names.has(c)) return c
  return current
}

/**
 * True unless the repository is known to hand `git status` no filter driver of its own. `git status` runs a
 * `filter.<name>.clean` / `.process` program, named by the repository's config and selected by its .gitattributes, to hash
 * a file whose stat data changed, and no `-c` override switches that off. Every way the repository can name one is closed:
 * - `extensions.worktreeConfig` set, or a `config.worktree` file in the git directory (git reads it for this work tree
 *   when the extension is on, and `config --local` does not show it): status is skipped without reading it. The git
 *   directory is `<root>/.git`, the one readOnlyGitEnv pins (hasPlainGitDir has already refused a `.git` file or a
 *   `commondir`, so a linked worktree never gets here);
 * - any `filter.*` key in a scope other than the user's `system` and `global` ones: the local config, anything it
 *   includes, and (belt and braces) a worktree or command scope. Asked with `--show-scope` over every config git reads, so
 *   a scope this code does not know counts as the repository's.
 * A failure to ask (including a git too old for --show-scope) counts as "has one" (fail closed).
 */
export async function hasRepoFilterDriver(bin: string, root: string): Promise<boolean> {
  try {
    if (existsSync(join(root, '.git', 'config.worktree'))) return true
  } catch {
    return true
  }
  const ext = await run(bin, root, ['config', '--local', '--type=bool', '--get', 'extensions.worktreeConfig'])
  if (ext.ok) {
    if (ext.out.trim() !== 'false') return true
  } else if (ext.exitCode !== 1) return true // exit 1 is "not set"; anything else (unreadable, not a boolean) fails closed
  const r = await run(bin, root, ['config', '--show-scope', '--includes', '--name-only', '--get-regexp', '^filter\\.'])
  if (!r.ok) return r.exitCode !== 1
  for (const line of r.out.split('\n')) {
    if (!line.trim()) continue
    const scope = line.includes('\t') ? line.slice(0, line.indexOf('\t')).trim() : ''
    if (scope !== 'system' && scope !== 'global') return true
  }
  return false
}

/** Count of `status --porcelain=v1 -z` entries: a rename or copy entry carries a second path token that is not an entry. */
export function countPorcelainEntries(out: string): number {
  const tokens = out.split('\0')
  // The last token is empty after a complete listing; after a truncated one it may be cut mid-path: dropped either way.
  tokens.pop()
  let n = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.length < 3) continue
    n++
    if (t[0] === 'R' || t[0] === 'C' || t[1] === 'R' || t[1] === 'C') i++
  }
  return n
}

function parseCount(text: string, re: RegExp): number | undefined {
  const m = re.exec(text)
  if (!m) return undefined
  const n = Number(m[1])
  return Number.isSafeInteger(n) ? n : undefined
}

/** Parse the `log --shortstat` output produced by recentCommits. Exported for tests. */
export function parseRecentCommits(out: string): GitCommitInfo[] {
  const commits: GitCommitInfo[] = []
  for (const rec of out.split('\x1e').slice(1)) {
    const nl = rec.indexOf('\n')
    const header = nl === -1 ? rec : rec.slice(0, nl)
    const stat = nl === -1 ? '' : rec.slice(nl + 1)
    const [sha, at, ...subjectParts] = header.split('\x1f')
    const when = Number(at)
    if (!sha || !/^[0-9a-f]{4,64}$/i.test(sha) || !Number.isFinite(when)) continue
    // eslint-disable-next-line no-control-regex
    const subject = subjectParts.join('\x1f').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, SUBJECT_MAX)
    const info: GitCommitInfo = { sha, subject, at: when * 1000 }
    if (/files? changed/.test(stat)) {
      // Either side is left out of the line when it is zero.
      info.additions = parseCount(stat, /(\d+) insertions?\(\+\)/) ?? 0
      info.deletions = parseCount(stat, /(\d+) deletions?\(-\)/) ?? 0
    }
    commits.push(info)
    if (commits.length >= GIT_RECENT_COMMITS_MAX) break
  }
  return commits
}

async function recentCommits(bin: string, root: string, branch: string): Promise<GitCommitInfo[]> {
  const r = await run(bin, root, [
    'log',
    `--max-count=${GIT_RECENT_COMMITS_MAX}`,
    '--no-color',
    '--no-show-signature',
    '--no-ext-diff',
    '--no-textconv',
    '--shortstat',
    '--abbrev=7',
    '--format=%x1e%h%x1f%at%x1f%s',
    `refs/heads/${branch}`,
    '--'
  ])
  return r.ok || r.truncated ? parseRecentCommits(r.out) : []
}

async function unmerged(bin: string, root: string, branch: string, now: number): Promise<GitSummary['unmergedBranches']> {
  const r = await run(bin, root, [
    'for-each-ref',
    '--format=%(refname)%09%(committerdate:unix)',
    `--no-merged=refs/heads/${branch}`,
    'refs/heads/'
  ])
  if (!r.ok && !r.truncated) return { count: 0 }
  let count = 0
  let oldest: number | undefined
  for (const line of r.out.split('\n')) {
    const [ref, time] = line.replace(/\r$/, '').split('\t')
    if (!ref || !ref.startsWith('refs/heads/') || ref === `refs/heads/${branch}`) continue
    count++
    const t = Number(time)
    if (Number.isFinite(t) && t > 0 && (oldest === undefined || t < oldest)) oldest = t
  }
  return oldest === undefined ? { count } : { count, oldestAgeMs: Math.max(0, now - oldest * 1000) }
}

async function aheadBehind(bin: string, root: string, branch: string, upstream: string | undefined): Promise<{ ahead: number; behind: number } | undefined> {
  if (!upstream || !upstream.startsWith('refs/')) return undefined
  const r = await run(bin, root, ['rev-list', '--left-right', '--count', `refs/heads/${branch}...${upstream}`, '--'])
  if (!r.ok) return undefined
  const m = /^(\d+)\s+(\d+)\s*$/.exec(r.out)
  return m ? { ahead: Number(m[1]), behind: Number(m[2]) } : undefined
}

/** The git binary when `path` is a plain git work tree, else null. */
async function open(path: string): Promise<string | null> {
  if (typeof path !== 'string' || !path.trim()) return null
  const bin = gitExecutable()
  if (!bin || !hasPlainGitDir(path)) return null
  const inside = await run(bin, path, ['rev-parse', '--is-inside-work-tree'])
  return inside.ok && inside.out.trim() === 'true' ? bin : null
}

/** Null when `path` is not a git work tree or git is missing. Never throws. */
export async function gitSummary(path: string, mainBranch?: string): Promise<GitSummary | null> {
  try {
    const bin = await open(path)
    if (!bin) return null
    const now = Date.now()
    const [local, branch] = await Promise.all([listBranches(bin, path), currentBranch(bin, path)])
    const defaultBranch = await detectDefault(bin, path, local, branch, mainBranch)
    const exists = defaultBranch !== null && local.some((b) => b.name === defaultBranch)
    // Dirty counting is skipped (0) for a repository with its own filter drivers: status could run one of its programs.
    const skipStatus = await hasRepoFilterDriver(bin, path)
    const [status, commits, unmergedBranches, upstream] = await Promise.all([
      skipStatus ? Promise.resolve({ ok: false, out: '', truncated: false } as GitResult) : run(bin, path, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
      exists ? recentCommits(bin, path, defaultBranch) : Promise.resolve([] as GitCommitInfo[]),
      exists ? unmerged(bin, path, defaultBranch, now) : Promise.resolve({ count: 0 } as GitSummary['unmergedBranches']),
      exists ? aheadBehind(bin, path, defaultBranch, local.find((b) => b.name === defaultBranch)?.upstream) : Promise.resolve(undefined)
    ])
    const summary: GitSummary = {
      branch,
      defaultBranch,
      dirtyFiles: status.ok || status.truncated ? countPorcelainEntries(status.out) : 0,
      recentCommits: commits,
      unmergedBranches,
      generatedAt: now
    }
    if (upstream) summary.upstream = upstream
    return summary
  } catch (err) {
    console.warn('[gitInfo] summary failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

/** Local branch names, the default branch first, at most 200; [] when not a git work tree. Never throws. */
export async function gitBranches(path: string, mainBranch?: string): Promise<string[]> {
  try {
    const bin = await open(path)
    if (!bin) return []
    const [local, branch] = await Promise.all([listBranches(bin, path), currentBranch(bin, path)])
    const defaultBranch = await detectDefault(bin, path, local, branch, mainBranch)
    const names = local.map((b) => b.name)
    const ordered = defaultBranch && names.includes(defaultBranch) ? [defaultBranch, ...names.filter((n) => n !== defaultBranch)] : names
    return ordered.slice(0, GIT_INFO_MAX_BRANCHES)
  } catch (err) {
    console.warn('[gitInfo] branches failed:', err instanceof Error ? err.message : String(err))
    return []
  }
}
