import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  commitLeftovers,
  discardWorktree,
  findWorktree,
  inspectPending,
  integrateWorktree,
  isGitRepo,
  pathKey,
  pendingWorktrees,
  prepareRepo,
  removeExcludeLine,
  withRepoLock
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

  it('commits and merges with OrgAI identity when git has none (fresh CI runner)', async () => {
    await prepareRepo(root)
    const wt = addWorktree('noid1')
    put(wt.path, 'src/noid.js', 'export const n = 1\n')
    // No repo, global or system identity, no env identity, and no hostname guessing.
    git(root, 'config --unset user.name')
    git(root, 'config --unset user.email')
    git(root, 'config user.useConfigOnly true')
    const keys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
    for (const k of keys) delete process.env[k]
    process.env.GIT_CONFIG_GLOBAL = join(root, 'no-global-gitconfig')
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    try {
      const res = await integrateWorktree(root, { ...wt, status: 'merging' }, 'Implementer: no identity')
      expect(res.info.status, res.message).toBe('merged')
      expect(execSync('git log -1 --format=%an%x20%P', { cwd: root, encoding: 'utf8' }).trim().split(' ')).toHaveLength(3)
      expect(execSync('git log -1 --format=%an', { cwd: root, encoding: 'utf8' }).trim()).toBe('OrgAI')
      expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(false)
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
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

describe('nested worktrees', () => {
  /** Mimic Claude Code spawning from inside a parent's worktree: cwd = the parent worktree. */
  function addNested(parentPath: string, id: string): { path: string; branch: string } {
    const rel = `.claude/worktrees/agent-${id}`
    const branch = `worktree-agent-${id}`
    git(parentPath, `worktree add -q -b ${branch} ${rel}`)
    return { path: join(parentPath, rel), branch }
  }

  it('merges a child into its parent worktree, then the parent into main with both changes', async () => {
    await prepareRepo(root)
    const parent = addWorktree('lead1')
    put(parent.path, 'src/lead.js', 'export const lead = 1\n')
    // The parent finished first: its own work is committed before its reports merge.
    expect(await commitLeftovers(parent.path, 'Lead: own work')).toEqual({ committed: true })

    const kid = addNested(parent.path, 'kid1')
    // The child lives inside the parent's checkout, on a branch cut from the parent's branch.
    expect(norm(kid.path)).toBe(norm(join(root, '.claude/worktrees/agent-lead1/.claude/worktrees/agent-kid1')))
    expect(git(kid.path, 'rev-parse HEAD')).toBe(git(parent.path, 'rev-parse HEAD'))
    expect(existsSync(join(kid.path, 'src/lead.js'))).toBe(true)
    // The shared exclude line keeps the nested worktree out of the parent's status.
    expect(git(parent.path, 'status --porcelain')).toBe('')
    // Worktrees are repository-wide: the main checkout finds the nested one by agent id.
    expect(norm((await findWorktree(root, 'kid1'))!.path)).toBe(norm(kid.path))

    put(kid.path, 'src/kid.js', 'export const kid = 2\n')
    const child = await integrateWorktree(parent.path, { ...kid, status: 'merging' }, 'Dev: add kid')
    expect(child.info.status).toBe('merged')
    expect(child.message).toMatch(/Merged worktree-agent-kid1 into branch worktree-agent-lead1 \(1 file: src\/kid\.js\)/)
    expect(existsSync(kid.path)).toBe(false)
    expect(branches()).not.toContain(kid.branch)
    expect(git(parent.path, 'log -1 --format=%s')).toBe('Merge worktree-agent-kid1: Dev: add kid')
    // Nothing reached main yet.
    expect(existsSync(join(root, 'src/kid.js'))).toBe(false)

    const lead = await integrateWorktree(root, { ...parent, status: 'merging' }, 'Lead: feature')
    expect(lead.info.status).toBe('merged')
    expect(lead.info.changedFiles).toEqual(['src/kid.js', 'src/lead.js'])
    expect(lead.message).toMatch(/into the main checkout/)
    expect(existsSync(parent.path)).toBe(false)
    expect(branches()).toEqual(['main'])
    expect(readFileSync(join(root, 'src/kid.js'), 'utf8')).toContain('kid = 2')
    expect(readFileSync(join(root, 'src/lead.js'), 'utf8')).toContain('lead = 1')
    const subjects = git(root, 'log --format=%s main').split(/\r?\n/)
    expect(subjects).toEqual(expect.arrayContaining(['Merge worktree-agent-lead1: Lead: feature', 'Merge worktree-agent-kid1: Dev: add kid', 'Lead: own work', 'Dev: add kid']))
  })

  it('keeps a child that conflicted with its parent pending when the parent leaves', async () => {
    await prepareRepo(root)
    const parent = addWorktree('lead2')
    const kid = addNested(parent.path, 'kid2')
    put(kid.path, 'src/app.js', 'export const a = "from kid"\n')
    put(parent.path, 'src/app.js', 'export const a = "from lead"\n')
    await commitLeftovers(parent.path, 'Lead: change a')

    const child = await integrateWorktree(parent.path, { ...kid, status: 'merging' }, 'Dev: change a')
    expect(child.info.status).toBe('conflict')
    expect(git(parent.path, 'status --porcelain')).toBe('')

    const lead = await integrateWorktree(root, { ...parent, status: 'merging' }, 'Lead: feature')
    expect(lead.info.status).toBe('merged')
    expect(existsSync(parent.path)).toBe(false)
    // The child's worktree was moved out of the parent's directory before it was removed.
    const moved = join(root, '.claude/worktrees/agent-kid2')
    expect(existsSync(moved)).toBe(true)
    const pending = await pendingWorktrees(root)
    expect(pending.map((p) => [p.branch, norm(p.path)])).toEqual([[kid.branch, norm(moved)]])
    expect(git(root, `log -1 --format=%s ${kid.branch}`)).toBe('Dev: change a')
    expect(readFileSync(join(moved, 'src/app.js'), 'utf8')).toContain('from kid')
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

describe('pathKey', () => {
  it('normalises separators and trailing slashes', () => {
    expect(pathKey('C:\\Repo\\Sub\\', 'win32')).toBe('c:/repo/sub')
  })
  it('folds case on win32 and darwin but not on linux', () => {
    // A root that exists nowhere, so no ancestor resolves (on Windows "/Users" would resolve to C:\Users).
    expect(pathKey('/OrgAI-No-Such-Root/Me/Proj', 'darwin')).toBe('/orgai-no-such-root/me/proj')
    expect(pathKey('/OrgAI-No-Such-Root/Me/Proj', 'linux')).toBe('/OrgAI-No-Such-Root/Me/Proj')
  })
  it('resolves existing directories to their real path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgai-pk-'))
    try {
      expect(pathKey(dir, 'linux')).toBe(realpathSync.native(dir).replace(/\\/g, '/'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** A directory link to `target` (a junction on Windows, which needs no privileges). Undefined if links are refused. */
function linkTo(target: string): string | undefined {
  const link = join(mkdtempSync(join(tmpdir(), 'orgai-link-')), 'linked')
  try {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    return link
  } catch {
    rmSync(dirname(link), { recursive: true, force: true })
    return undefined
  }
}

// macOS: /tmp and /var are symlinks into /private, so git reports /private/... for a project picked as /tmp/...
describe('symlinked project roots', () => {
  it('pathKey treats a link and its target as the same checkout', (ctx) => {
    const link = linkTo(root)
    if (!link) return ctx.skip()
    try {
      expect(pathKey(link)).toBe(pathKey(root))
      expect(pathKey(join(link, '.claude', 'worktrees'))).toBe(pathKey(join(root, '.claude', 'worktrees')))
    } finally {
      rmSync(dirname(link), { recursive: true, force: true })
    }
  })

  it('finds and inspects an agent worktree through the link', async (ctx) => {
    const link = linkTo(root)
    if (!link) return ctx.skip()
    try {
      await prepareRepo(link)
      const wt = addWorktree('viaLink')
      const found = await findWorktree(link, 'viaLink')
      expect(found?.branch).toBe(wt.branch)
      expect(pathKey(found!.path)).toBe(pathKey(wt.path))
      expect(pathKey(found!.path).startsWith(`${pathKey(link)}/`)).toBe(true)
      expect((await inspectPending(link)).map((p) => p.branch)).toEqual([wt.branch])
    } finally {
      rmSync(dirname(link), { recursive: true, force: true })
    }
  })

  it('serialises the repo lock across a link and its target', async (ctx) => {
    const link = linkTo(root)
    if (!link) return ctx.skip()
    try {
      const order: string[] = []
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const first = withRepoLock(root, async () => {
        order.push('a-start')
        await gate
        order.push('a-end')
      })
      const second = withRepoLock(link, async () => {
        order.push('b')
      })
      await new Promise((r) => setTimeout(r, 20))
      release()
      await Promise.all([first, second])
      expect(order).toEqual(['a-start', 'a-end', 'b'])
    } finally {
      rmSync(dirname(link), { recursive: true, force: true })
    }
  })
})

describe('withRepoLock', () => {
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((r) => (resolve = r))
    return { promise, resolve }
  }
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it('serializes calls on one checkout in arrival order', async () => {
    const order: string[] = []
    const gate = deferred()
    const a = withRepoLock(root, async () => {
      order.push('a:start')
      await gate.promise
      order.push('a:end')
    })
    // The same checkout spelled differently (separators, trailing slash) shares the lock.
    const b = withRepoLock(`${root.replace(/\\/g, '/')}/`, async () => {
      order.push('b')
    })
    await tick()
    await tick()
    expect(order).toEqual(['a:start'])
    gate.resolve()
    await Promise.all([a, b])
    expect(order).toEqual(['a:start', 'a:end', 'b'])
  })

  it('lets different checkouts interleave', async () => {
    const other = join(root, '.claude', 'worktrees', 'agent-x')
    mkdirSync(other, { recursive: true })
    const order: string[] = []
    const gate = deferred()
    const a = withRepoLock(root, async () => {
      order.push('main:start')
      await gate.promise
      order.push('main:end')
    })
    await withRepoLock(other, async () => {
      order.push('worktree')
    })
    expect(order).toEqual(['main:start', 'worktree'])
    gate.resolve()
    await a
    expect(order).toEqual(['main:start', 'worktree', 'main:end'])
  })

  it('releases on rejection and is re-entrant within one call chain', async () => {
    await expect(withRepoLock(root, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(await withRepoLock(root, () => withRepoLock(root, async () => 42))).toBe(42)
  })

  it('merges two reports into one checkout concurrently', async () => {
    await prepareRepo(root)
    const one = addWorktree('par1')
    const two = addWorktree('par2')
    put(one.path, 'src/one.js', 'export const one = 1\n')
    put(two.path, 'src/two.js', 'export const two = 2\n')
    const [r1, r2] = await Promise.all([
      integrateWorktree(root, { ...one, status: 'merging' }, 'one'),
      integrateWorktree(root, { ...two, status: 'merging' }, 'two')
    ])
    expect([r1.info.status, r2.info.status]).toEqual(['merged', 'merged'])
    expect(branches()).toEqual(['main'])
    expect(existsSync(join(root, 'src/one.js')) && existsSync(join(root, 'src/two.js'))).toBe(true)
  })

  it('does not hold the checkout while the user reviews a merge', async () => {
    await prepareRepo(root)
    const held = addWorktree('rev1')
    const other = addWorktree('rev2')
    put(held.path, 'src/r.js', 'export const r = 1\n')
    const review = deferred()
    let reviewing = false
    const pending = integrateWorktree(root, { ...held, status: 'merging' }, 'reviewed', async () => {
      reviewing = true
      await review.promise
      return { behavior: 'merge' }
    })
    while (!reviewing) await tick()
    // The maintenance panel can discard another worktree while the review card is open.
    await discardWorktree(root, other)
    expect(branches()).not.toContain(other.branch)
    review.resolve()
    expect((await pending).info.status).toBe('merged')
  })

  it('reports a worktree discarded during the review as removed, not as a conflict', async () => {
    await prepareRepo(root)
    const wt = addWorktree('rev3')
    put(wt.path, 'src/r3.js', 'export const r3 = 1\n')
    const review = deferred()
    let reviewing = false
    const pending = integrateWorktree(root, { ...wt, status: 'merging' }, 'reviewed', async () => {
      reviewing = true
      await review.promise
      return { behavior: 'merge' }
    })
    while (!reviewing) await tick()
    await discardWorktree(root, wt)
    review.resolve()
    const res = await pending
    expect(res.info.status).toBe('removed')
    expect(res.message).toMatch(/removed during the review/)
  })
})
