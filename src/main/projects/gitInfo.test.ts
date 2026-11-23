import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GIT_RECENT_COMMITS_MAX } from '../../shared/types'
import { countPorcelainEntries, gitBranches, gitSummary, parseRecentCommits } from './gitInfo'

const created: string[] = []

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', ['-c', 'user.name=OrgAI-Test', '-c', 'user.email=test@orgai.local', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function tmp(prefix: string): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  created.push(d)
  return d
}

function newRepo(): string {
  const root = tmp('orgai-gitinfo-')
  git(root, ['init', '-q', '-b', 'main'])
  return root
}

function commit(root: string, file: string, content: string, message: string, date?: string): void {
  writeFileSync(join(root, file), content, 'utf8')
  git(root, ['add', '--', file])
  git(root, ['commit', '-q', '-m', message], date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {})
}

let root: string

beforeEach(() => {
  root = newRepo()
})

afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('gitSummary', () => {
  it('returns null for a folder that is not a git repository', async () => {
    const plain = tmp('orgai-gitinfo-plain-')
    expect(await gitSummary(plain)).toBeNull()
    expect(await gitBranches(plain)).toEqual([])
  })

  it('returns null for a missing path and an empty path without throwing', async () => {
    expect(await gitSummary(join(tmpdir(), 'orgai-gitinfo-does-not-exist-xyz'))).toBeNull()
    expect(await gitSummary('')).toBeNull()
  })

  it('reports a clean repository', async () => {
    commit(root, 'a.txt', 'one\n', 'first commit')
    const s = await gitSummary(root)
    expect(s).not.toBeNull()
    expect(s!.branch).toBe('main')
    expect(s!.defaultBranch).toBe('main')
    expect(s!.dirtyFiles).toBe(0)
    expect(s!.unmergedBranches).toEqual({ count: 0 })
    expect(s!.upstream).toBeUndefined()
    expect(s!.recentCommits).toHaveLength(1)
    expect(s!.recentCommits[0].subject).toBe('first commit')
    expect(typeof s!.generatedAt).toBe('number')
  })

  it('reports an empty repository (no commits) without commits or a throw', async () => {
    const s = await gitSummary(root)
    expect(s).not.toBeNull()
    expect(s!.branch).toBe('main')
    expect(s!.recentCommits).toEqual([])
    expect(s!.unmergedBranches).toEqual({ count: 0 })
  })

  it('counts modified, staged and untracked files as dirty', async () => {
    commit(root, 'a.txt', 'one\n', 'first')
    writeFileSync(join(root, 'a.txt'), 'changed\n', 'utf8')
    writeFileSync(join(root, 'new1.txt'), 'x\n', 'utf8')
    writeFileSync(join(root, 'new2.txt'), 'y\n', 'utf8')
    writeFileSync(join(root, 'staged.txt'), 'z\n', 'utf8')
    git(root, ['add', '--', 'staged.txt'])
    expect((await gitSummary(root))!.dirtyFiles).toBe(4)
  })

  it('counts a rename as one entry', async () => {
    commit(root, 'a.txt', 'some content that is long enough to detect\n', 'first')
    git(root, ['mv', 'a.txt', 'b.txt'])
    expect((await gitSummary(root))!.dirtyFiles).toBe(1)
  })

  it('lists recent commits newest first with additions and deletions', async () => {
    commit(root, 'a.txt', 'l1\nl2\nl3\n', 'add three lines')
    commit(root, 'a.txt', 'l1\nl2 changed\nl3\nl4\n', 'edit and add')
    const s = await gitSummary(root)
    expect(s!.recentCommits.map((c) => c.subject)).toEqual(['edit and add', 'add three lines'])
    expect(s!.recentCommits[0]).toMatchObject({ additions: 2, deletions: 1 })
    expect(s!.recentCommits[1]).toMatchObject({ additions: 3, deletions: 0 })
    expect(s!.recentCommits[0].sha).toMatch(/^[0-9a-f]{7,}$/)
    expect(Math.abs(s!.recentCommits[0].at - Date.now())).toBeLessThan(60_000)
  })

  it('caps recent commits and cuts a long subject to 200 characters', async () => {
    for (let i = 0; i < GIT_RECENT_COMMITS_MAX + 3; i++) commit(root, 'a.txt', `v${i}\n`, i === GIT_RECENT_COMMITS_MAX + 2 ? 'x'.repeat(500) : `c${i}`)
    const s = await gitSummary(root)
    expect(s!.recentCommits).toHaveLength(GIT_RECENT_COMMITS_MAX)
    expect(s!.recentCommits[0].subject).toHaveLength(200)
  })

  it('counts local branches not merged into the default branch and the age of the oldest tip', async () => {
    commit(root, 'a.txt', 'one\n', 'base')
    const old = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString()
    git(root, ['checkout', '-q', '-b', 'feature-old'])
    commit(root, 'b.txt', 'b\n', 'old work', old)
    git(root, ['checkout', '-q', 'main'])
    git(root, ['checkout', '-q', '-b', 'feature-new'])
    commit(root, 'c.txt', 'c\n', 'new work')
    git(root, ['checkout', '-q', 'main'])
    git(root, ['branch', 'merged-already'])
    const s = await gitSummary(root)
    expect(s!.unmergedBranches.count).toBe(2)
    expect(s!.unmergedBranches.oldestAgeMs).toBeGreaterThan(9 * 24 * 3600 * 1000)
    expect(s!.unmergedBranches.oldestAgeMs).toBeLessThan(11 * 24 * 3600 * 1000)
  })

  it('honours mainBranch when it names a local branch', async () => {
    commit(root, 'a.txt', 'one\n', 'base')
    git(root, ['checkout', '-q', '-b', 'develop'])
    commit(root, 'd.txt', 'd\n', 'develop work')
    git(root, ['checkout', '-q', 'main'])
    const s = await gitSummary(root, 'develop')
    expect(s!.defaultBranch).toBe('develop')
    expect(s!.branch).toBe('main')
    expect(s!.recentCommits[0].subject).toBe('develop work')
    // main is now the unmerged side? No: develop contains main, so main is merged into develop.
    expect(s!.unmergedBranches.count).toBe(0)
  })

  it('falls back to the detected default for a mainBranch that does not exist or looks like an option', async () => {
    commit(root, 'a.txt', 'one\n', 'base')
    for (const bad of ['nope', '--output=/tmp/x', '-h', 'refs/heads/main', '']) {
      const s = await gitSummary(root, bad)
      expect(s!.defaultBranch, bad).toBe('main')
    }
  })

  it('detects master, then the current branch, when there is no main', async () => {
    git(root, ['checkout', '-q', '-b', 'master'])
    commit(root, 'a.txt', 'one\n', 'base')
    expect((await gitSummary(root))!.defaultBranch).toBe('master')
    git(root, ['checkout', '-q', '-b', 'topic'])
    git(root, ['branch', '-q', '-m', 'master', 'old-master'])
    expect((await gitSummary(root))!.defaultBranch).toBe('topic')
  })

  it('reports a detached HEAD with a null branch', async () => {
    commit(root, 'a.txt', 'one\n', 'base')
    commit(root, 'a.txt', 'two\n', 'second')
    git(root, ['checkout', '-q', '--detach', 'HEAD~1'])
    const s = await gitSummary(root)
    expect(s!.branch).toBeNull()
    expect(s!.defaultBranch).toBe('main')
    expect(s!.recentCommits).toHaveLength(2)
  })

  it('reports ahead and behind of the upstream and uses origin/HEAD for the default', async () => {
    const origin = newRepo()
    commit(origin, 'a.txt', 'one\n', 'base')
    const clone = tmp('orgai-gitinfo-clone-')
    rmSync(clone, { recursive: true, force: true })
    git(tmpdir(), ['clone', '-q', origin, clone])
    commit(clone, 'local.txt', 'l\n', 'local only')
    commit(origin, 'b.txt', 'b\n', 'remote one')
    commit(origin, 'c.txt', 'c\n', 'remote two')
    git(clone, ['fetch', '-q', 'origin'])
    const s = await gitSummary(clone)
    expect(s!.defaultBranch).toBe('main')
    expect(s!.upstream).toEqual({ ahead: 1, behind: 2 })
  })

  it('does not run a core.fsmonitor program from the repository config', async () => {
    commit(root, 'a.txt', 'one\n', 'base')
    const marker = join(root, '..', `fsmonitor-marker-${Date.now()}.txt`).replace(/\\/g, '/')
    created.push(marker)
    const hook = join(root, '..', `fsmonitor-hook-${Date.now()}.sh`)
    created.push(hook)
    writeFileSync(hook, `#!/bin/sh\necho ran > "${marker}"\nprintf '\\0'\n`, { mode: 0o755 })
    git(root, ['config', 'core.fsmonitor', hook.replace(/\\/g, '/')])
    git(root, ['config', 'core.untrackedCache', 'true'])
    writeFileSync(join(root, 'dirty.txt'), 'x\n', 'utf8')
    // Control: plain git status runs the program on the author's machine (git for Windows 2.x), so the absent marker
    // below is meaningful there. Not asserted: whether a given git version runs the hook is not what this test checks.
    git(root, ['status', '--porcelain'])
    rmSync(marker, { force: true })
    const s = await gitSummary(root)
    expect(s!.dirtyFiles).toBe(1)
    expect(existsSync(marker)).toBe(false)
  })

  it('does not run a filter driver from the repository config, and skips dirty counting for such a repository (M4)', async () => {
    commit(root, 'a.txt', 'one\n', 'base')
    const marker = join(root, '..', `filter-marker-${Date.now()}.txt`).replace(/\\/g, '/')
    created.push(marker)
    const script = join(root, '..', `filter-clean-${Date.now()}.sh`)
    created.push(script)
    writeFileSync(script, `#!/bin/sh\necho ran > "${marker}"\ncat\n`, { mode: 0o755 })
    git(root, ['config', 'filter.evil.clean', `sh "${script.replace(/\\/g, '/')}"`])
    writeFileSync(join(root, '.gitattributes'), 'a.txt filter=evil\n', 'utf8')
    // A rewrite with the same size and an older mtime still looks stat-dirty to git, which then hashes it through the filter.
    writeFileSync(join(root, 'a.txt'), 'two\n', 'utf8')
    // Control: plain git status runs the clean filter here (so the absent marker below means something).
    git(root, ['status', '--porcelain'])
    expect(existsSync(marker)).toBe(true)
    rmSync(marker, { force: true })
    const s = await gitSummary(root)
    expect(s).not.toBeNull()
    expect(existsSync(marker)).toBe(false)
    expect(s!.dirtyFiles).toBe(0)
    // The rest of the summary still works.
    expect(s!.defaultBranch).toBe('main')
    expect(s!.recentCommits).toHaveLength(1)
  })

  it('also skips status when the filter comes from an included config file (M4)', async () => {
    commit(root, 'a.txt', 'one\n', 'base')
    const inc = join(root, '..', `filter-include-${Date.now()}.cfg`)
    created.push(inc)
    writeFileSync(inc, '[filter "evil"]\n\tclean = false\n', 'utf8')
    git(root, ['config', 'include.path', inc.replace(/\\/g, '/')])
    writeFileSync(join(root, 'dirty.txt'), 'x\n', 'utf8')
    expect((await gitSummary(root))!.dirtyFiles).toBe(0)
  })

  it('still counts dirty files when the repository has no filter.* keys', async () => {
    commit(root, 'a.txt', 'one\n', 'base')
    git(root, ['config', 'core.whitespace', 'trailing-space'])
    writeFileSync(join(root, 'dirty.txt'), 'x\n', 'utf8')
    expect((await gitSummary(root))!.dirtyFiles).toBe(1)
  })

  it('does not write an index lock or refresh the index (optional locks off)', async () => {
    commit(root, 'a.txt', 'one\n', 'base')
    writeFileSync(join(root, 'a.txt'), 'changed\n', 'utf8')
    const lock = join(root, '.git', 'index.lock')
    const before = await gitSummary(root)
    expect(before!.dirtyFiles).toBe(1)
    expect(existsSync(lock)).toBe(false)
  })

  it('returns null for a .git file (linked worktree) instead of following it', async () => {
    commit(root, 'a.txt', 'one\n', 'base')
    const wt = tmp('orgai-gitinfo-wt-')
    rmSync(wt, { recursive: true, force: true })
    git(root, ['worktree', 'add', '-q', '-b', 'wt-branch', wt])
    expect(existsSync(join(wt, '.git'))).toBe(true)
    expect(await gitSummary(wt)).toBeNull()
  })
})

describe('gitBranches', () => {
  it('lists local branches with the default first', async () => {
    commit(root, 'a.txt', 'one\n', 'base')
    git(root, ['branch', 'alpha'])
    git(root, ['branch', 'zeta'])
    expect(await gitBranches(root)).toEqual(['main', 'alpha', 'zeta'])
    expect(await gitBranches(root, 'zeta')).toEqual(['zeta', 'alpha', 'main'])
    expect(await gitBranches(root, '--bad')).toEqual(['main', 'alpha', 'zeta'])
  })

  it('caps the list at 200', async () => {
    commit(root, 'a.txt', 'one\n', 'base')
    mkdirSync(join(root, '.git', 'refs', 'heads', 'many'), { recursive: true })
    const sha = git(root, ['rev-parse', 'HEAD'])
    for (let i = 0; i < 230; i++) writeFileSync(join(root, '.git', 'refs', 'heads', 'many', `b${String(i).padStart(3, '0')}`), `${sha}\n`)
    const list = await gitBranches(root)
    expect(list).toHaveLength(200)
    expect(list[0]).toBe('main')
  })
})

describe('parsers', () => {
  it('counts porcelain -z entries, skipping the origin path of a rename', () => {
    expect(countPorcelainEntries(' M a.txt\0?? b.txt\0R  new.txt\0old.txt\0')).toBe(3)
    expect(countPorcelainEntries('')).toBe(0)
    // A truncated listing drops the cut last token.
    expect(countPorcelainEntries(' M a.txt\0 M b.t')).toBe(1)
  })

  it('parses shortstat lines with a missing insertion or deletion side and omits counts without a stat line', () => {
    const out =
      '\x1eabc1234\x1f1700000000\x1fonly deletions\n\n 1 file changed, 4 deletions(-)\n' +
      '\x1edef5678\x1f1700000100\x1fonly insertions\n\n 2 files changed, 7 insertions(+)\n' +
      '\x1e0123456\x1f1700000200\x1fempty commit\n' +
      '\x1ebad\x1fnot-a-number\x1fbroken\n'
    const c = parseRecentCommits(out)
    expect(c).toEqual([
      { sha: 'abc1234', subject: 'only deletions', at: 1700000000_000, additions: 0, deletions: 4 },
      { sha: 'def5678', subject: 'only insertions', at: 1700000100_000, additions: 7, deletions: 0 },
      { sha: '0123456', subject: 'empty commit', at: 1700000200_000 }
    ])
  })
})
