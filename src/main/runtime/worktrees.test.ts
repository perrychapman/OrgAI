import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  commitLeftovers,
  discardWorktree,
  findWorktree,
  inspectPending,
  integrateWorktree,
  isGitRepo,
  pendingWorktrees,
  prepareRepo,
  removeExcludeLine
} from './worktrees'

const ID = '-c user.name=OrgAI-Test -c user.email=test@orgai.local'
let root: string

function git(cwd: string, args: string): string {
  return execSync(`git ${ID} ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function put(dir: string, rel: string, content: string): void {
  const full = join(dir, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()

/** Mimic Claude Code: worktree under .claude/worktrees/agent-<id> on branch worktree-agent-<id>. */
function addWorktree(id: string): { path: string; branch: string } {
  const rel = `.claude/worktrees/agent-${id}`
  const branch = `worktree-agent-${id}`
  git(root, `worktree add -q -b ${branch} ${rel}`)
  return { path: join(root, rel), branch }
}

function branches(): string[] {
  return git(root, 'branch --format=%(refname:short)').split(/\r?\n/).filter(Boolean)
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-wt-')))
  git(root, 'init -q -b main')
  // integrateWorktree runs plain git (no -c); give the repo its own identity.
  git(root, 'config user.name OrgAI-Test')
  git(root, 'config user.email test@orgai.local')
  git(root, 'config core.autocrlf false')
  put(root, 'package.json', '{"name":"fixture"}\n')
  put(root, 'src/app.js', 'export const a = 1\n')
  git(root, 'add -A')
  git(root, 'commit -q -m initial')
})

afterEach(() => {
  try {
    git(root, 'worktree prune')
  } catch {
    /* ignore */
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

describe('prepareRepo / removeExcludeLine', () => {
  it('adds the worktrees exclude line once and removes it again', async () => {
    const exclude = join(root, '.git', 'info', 'exclude')
    await prepareRepo(root)
    await prepareRepo(root)
    const lines = readFileSync(exclude, 'utf8').split(/\r?\n/)
    expect(lines.filter((l) => l === '.claude/worktrees/')).toHaveLength(1)
    expect(removeExcludeLine(root)).toBe(true)
    expect(readFileSync(exclude, 'utf8')).not.toContain('.claude/worktrees/')
    expect(removeExcludeLine(root)).toBe(false)
  })

  it('appends on a new line when the exclude file lacks a trailing newline', async () => {
    const exclude = join(root, '.git', 'info', 'exclude')
    writeFileSync(exclude, '*.local', 'utf8')
    await prepareRepo(root)
    expect(readFileSync(exclude, 'utf8')).toBe('*.local\n.claude/worktrees/\n')
    expect(removeExcludeLine(root)).toBe(true)
    expect(readFileSync(exclude, 'utf8')).toContain('*.local')
  })

  it('keeps agent worktrees out of git status', async () => {
    await prepareRepo(root)
    addWorktree('quiet')
    expect(git(root, 'status --porcelain')).toBe('')
  })

  it('does nothing outside a git repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'orgai-plain-'))
    try {
      expect(isGitRepo(plain)).toBe(false)
      await prepareRepo(plain)
      expect(existsSync(join(plain, '.git'))).toBe(false)
      expect(removeExcludeLine(plain)).toBe(false)
      expect(await inspectPending(plain)).toEqual([])
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})

describe('findWorktree / pendingWorktrees', () => {
  it('finds a worktree by agent id and ignores unrelated worktrees', async () => {
    await prepareRepo(root)
    const wt = addWorktree('abc123')
    git(root, 'worktree add -q -b feature other-tree')
    const found = await findWorktree(root, 'abc123')
    expect(found?.branch).toBe(wt.branch)
    expect(norm(found!.path)).toBe(norm(wt.path))
    expect(await findWorktree(root, 'nope')).toBeNull()
    const pending = await pendingWorktrees(root)
    expect(pending.map((p) => p.branch)).toEqual([wt.branch])
  })
})

describe('commitLeftovers', () => {
  it('commits uncommitted work and reports nothing to do when clean', async () => {
    await prepareRepo(root)
    const wt = addWorktree('left')
    expect(await commitLeftovers(wt.path, 'nothing')).toEqual({ committed: false })
    put(wt.path, 'src/new.js', 'export const n = 2\n')
    expect(await commitLeftovers(wt.path, 'Leftover work')).toEqual({ committed: true })
    expect(git(wt.path, 'log -1 --format=%s')).toBe('Leftover work')
    expect(git(wt.path, 'status --porcelain')).toBe('')
  })

  it('never commits dependency directories, and does not commit when only they changed', async () => {
    await prepareRepo(root)
    const wt = addWorktree('deps')
    put(wt.path, 'node_modules/dep/index.js', 'module.exports = 1\n')
    put(wt.path, 'packages/x/node_modules/y/index.js', '1\n')
    expect(await commitLeftovers(wt.path, 'deps only')).toEqual({ committed: false })
    // Nothing should remain staged after the no-op.
    expect(git(wt.path, 'diff --cached --name-only')).toBe('')
    put(wt.path, 'src/real.js', 'export {}\n')
    expect(await commitLeftovers(wt.path, 'real work')).toEqual({ committed: true })
    const files = git(wt.path, 'show --name-only --format= HEAD').split(/\r?\n/).filter(Boolean)
    expect(files).toEqual(['src/real.js'])
  })
})

describe('integrateWorktree', () => {
  it('merges a clean report with a merge commit and removes worktree and branch', async () => {
    await prepareRepo(root)
    const wt = addWorktree('clean1')
    put(wt.path, 'src/feature.js', 'export const f = true\n')
    put(wt.path, 'node_modules/lib/index.js', 'junk\n')
    const res = await integrateWorktree(root, { ...wt, status: 'merging' }, 'Implementer: add feature')
    expect(res.info.status).toBe('merged')
    expect(res.info.changedFiles).toEqual(['src/feature.js'])
    expect(res.message).toMatch(/Merged worktree-agent-clean1 into the main checkout \(1 file: src\/feature\.js\)/)
    expect(existsSync(wt.path)).toBe(false)
    expect(branches()).toEqual(['main'])
    expect(git(root, 'log -1 --format=%s')).toBe('Merge worktree-agent-clean1: Implementer: add feature')
    expect(git(root, 'log -1 --format=%P').split(' ')).toHaveLength(2)
    expect(git(root, 'ls-files')).not.toContain('node_modules')
    expect(readFileSync(join(root, 'src/feature.js'), 'utf8')).toContain('f = true')
  })

  it('keeps the branch and aborts the merge on a conflict', async () => {
    await prepareRepo(root)
    const wt = addWorktree('conf1')
    put(wt.path, 'src/app.js', 'export const a = "from report"\n')
    put(root, 'src/app.js', 'export const a = "from main"\n')
    git(root, 'commit -q -am "main edit"')
    const res = await integrateWorktree(root, { ...wt, status: 'merging' }, 'Implementer: change a')
    expect(res.info.status).toBe('conflict')
    expect(res.message).toMatch(/conflicts in src\/app\.js/)
    expect(res.info.changedFiles).toEqual(['src/app.js'])
    expect(existsSync(wt.path)).toBe(true)
    expect(branches()).toContain(wt.branch)
    expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(git(root, 'status --porcelain')).toBe('')
    expect(readFileSync(join(root, 'src/app.js'), 'utf8')).toContain('from main')
    // The report's work was committed on its branch.
    expect(git(root, `log -1 --format=%s ${wt.branch}`)).toBe('Implementer: change a')
  })

  it('reports an empty report and removes it', async () => {
    await prepareRepo(root)
    const wt = addWorktree('empty1')
    const res = await integrateWorktree(root, { ...wt, status: 'merging' }, 'nothing')
    expect(res.info.status).toBe('empty')
    expect(res.info.changedFiles).toEqual([])
    expect(existsSync(wt.path)).toBe(false)
    expect(branches()).toEqual(['main'])
  })

  it('reports a worktree that is already gone as removed', async () => {
    const res = await integrateWorktree(root, { path: join(root, '.claude/worktrees/agent-ghost'), branch: 'worktree-agent-ghost', status: 'merging' }, 'x')
    expect(res.info.status).toBe('removed')
  })
})

describe('inspectPending', () => {
  it('describes each leftover branch', async () => {
    await prepareRepo(root)
    const a = addWorktree('inspA')
    put(a.path, 'src/one.js', '1\n')
    put(a.path, 'src/two.js', '2\n')
    git(a.path, 'add src/one.js')
    git(a.path, 'commit -q -m "Report one"')
    const b = addWorktree('inspB')
    put(b.path, 'README.md', 'dirty\n')

    const list = await inspectPending(root)
    expect(list).toHaveLength(2)
    const pa = list.find((w) => w.branch === a.branch)!
    expect(pa.agentId).toBe('inspA')
    expect(pa.exists).toBe(true)
    expect(pa.commitsAhead).toBe(1)
    expect(pa.uncommittedFiles).toBe(1)
    expect(pa.changedFiles).toEqual(['src/one.js'])
    expect(pa.lastSubject).toBe('Report one')
    expect(pa.lastCommitAt).toBeGreaterThan(Date.now() - 10 * 60_000)
    const pb = list.find((w) => w.branch === b.branch)!
    expect(pb.commitsAhead).toBe(0)
    expect(pb.uncommittedFiles).toBe(1)
    expect(pb.changedFiles).toEqual([])
    expect(pb.lastSubject).toBe('initial')
  })
})

describe('discardWorktree', () => {
  it('removes the worktree and deletes the branch, even with unmerged work', async () => {
    await prepareRepo(root)
    const wt = addWorktree('drop1')
    put(wt.path, 'src/x.js', 'x\n')
    git(wt.path, 'add -A')
    git(wt.path, 'commit -q -m "unmerged"')
    put(wt.path, 'src/y.js', 'y\n')
    await discardWorktree(root, wt)
    expect(existsSync(wt.path)).toBe(false)
    expect(branches()).toEqual(['main'])
    expect(await inspectPending(root)).toEqual([])
  })
})
