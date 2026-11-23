import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentInstance, WorktreeInfo } from '@shared/types'
import { WorktreeIntegrator } from './integration'
import { integrateWorktree, prepareRepo } from './worktrees'
import { pinDrift, pinRoot, rootDrift } from './rootPin'
import { fakeCtx, project } from './testHelpers'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

// Security review M4: the test command is repository code run as the user, in the finished copy, but the copy shares its git
// directory with the checkout the merge lands in. Real git, the real test gate, no mocks: a command that commits on the root,
// stages a change, edits a tracked file, installs a hook or sets core.hooksPath is refused, and the merge itself runs with
// hooks off.

let root: string
let scripts: string

const norm = (p: string): string => p.replace(/\\/g, '/')
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Pin', '-c', 'user.email=pin@orgai.local', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function put(dir: string, rel: string, content: string): void {
  const full = join(dir, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

/** A node script the test command runs: repository code, written outside the repository. */
function script(name: string, body: string): string {
  const path = join(scripts, name)
  writeFileSync(path, `const { execFileSync } = require('node:child_process'); const fs = require('node:fs'); const path = require('node:path'); const root = process.argv[2];\nconst git = (...a) => execFileSync('git', ['-c', 'user.name=Evil', '-c', 'user.email=evil@x.local', '-C', root, ...a], { stdio: 'ignore' });\n${body}\n`)
  return path
}
const command = (file: string): string => `node "${file}" "${root}"`

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-pin-')))
  scripts = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-pin-scripts-')))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'Pin')
  git(root, 'config', 'user.email', 'pin@orgai.local')
  git(root, 'config', 'core.autocrlf', 'false')
  put(root, 'package.json', '{"name":"fixture"}\n')
  put(root, 'src/app.js', 'export const a = 1\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'initial')
})

afterEach(() => {
  try {
    git(root, 'worktree', 'prune')
  } catch {
    /* ignore */
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  rmSync(scripts, { recursive: true, force: true })
})

function addWorktree(id: string): WorktreeInfo {
  const rel = `.claude/worktrees/agent-${id}`
  const branch = `worktree-agent-${id}`
  git(root, 'worktree', 'add', '-q', '-b', branch, rel)
  put(join(root, rel), `src/${id}.js`, `export const ${id} = 1\n`)
  return { path: join(root, rel), branch, status: 'active' }
}

function integrator(testCommand: string) {
  const ctx = fakeCtx({ project: project({ path: root, requireTestsPass: true, testCommand }) })
  const agents = new Map<string, AgentInstance>()
  const i = new WorktreeIntegrator(ctx, { agent: (id) => agents.get(id), setWorktree: () => {}, notify: () => {} })
  const logs = (): string[] => ctx.events.flatMap((e) => (e.type === 'log' ? [`${e.level}: ${e.message}`] : []))
  return { i, logs }
}

const marker = (): string => join(scripts, 'hook-ran.txt')
const hookBody = (): string => `#!/bin/sh\necho ran > "${norm(marker())}"\n`

describe('the merge gate pins the checkout the merge lands in around the test command (security review M4)', () => {
  it('control: a command that touches nothing lets the merge through', async () => {
    await prepareRepo(root)
    const wt = addWorktree('ok1')
    const { i } = integrator(command(script('noop.js', '')))
    const out = await i.integratePending(wt)
    expect(out).toMatch(/Merged worktree-agent-ok1/)
    expect(existsSync(join(root, 'src/ok1.js'))).toBe(true)
  })

  it('refuses when the command commits on the main checkout, keeping the copy and the branch', async () => {
    await prepareRepo(root)
    const wt = addWorktree('c1')
    const before = git(root, 'rev-parse', 'HEAD')
    const { i, logs } = integrator(command(script('commit.js', "git('commit', '--allow-empty', '-q', '-m', 'planted')")))
    const out = await i.integratePending(wt)
    expect(out).toMatch(/Not merged: while the project's tests ran, its HEAD commit of .* changed/)
    expect(out).toContain('worktree-agent-c1')
    expect(existsSync(join(root, 'src/c1.js'))).toBe(false)
    expect(existsSync(wt.path)).toBe(true)
    expect(git(root, 'branch', '--list', wt.branch)).toContain(wt.branch)
    expect(git(root, 'rev-parse', 'HEAD')).not.toBe(before)
    expect(logs().some((l) => l.startsWith('warn:') && l.includes('HEAD commit'))).toBe(true)
  })

  it('refuses when the command stages a change in the main checkout\'s index', async () => {
    await prepareRepo(root)
    const wt = addWorktree('i1')
    const { i } = integrator(command(script('stage.js', "fs.writeFileSync(path.join(root, 'staged.txt'), 'x'); git('add', 'staged.txt')")))
    const out = await i.integratePending(wt)
    expect(out).toMatch(/Not merged: .*its index \(staged changes\)/)
    expect(existsSync(join(root, 'src/i1.js'))).toBe(false)
    expect(existsSync(wt.path)).toBe(true)
  })

  it('refuses when the command edits a tracked file of the main checkout', async () => {
    await prepareRepo(root)
    const wt = addWorktree('w1')
    const { i } = integrator(command(script('edit.js', "fs.appendFileSync(path.join(root, 'package.json'), '\\n')")))
    const out = await i.integratePending(wt)
    expect(out).toMatch(/Not merged: .*its tracked files/)
    expect(existsSync(join(root, 'src/w1.js'))).toBe(false)
  })

  it('refuses when the command installs a hook, and the hook never runs', async () => {
    await prepareRepo(root)
    const wt = addWorktree('h1')
    const body = hookBody().replace(/\n/g, '\\n').replace(/"/g, '\\"')
    const { i } = integrator(command(script('hook.js', `const dir = path.join(root, '.git', 'hooks'); fs.mkdirSync(dir, { recursive: true }); for (const n of ['post-merge', 'pre-merge-commit', 'post-commit', 'post-checkout']) fs.writeFileSync(path.join(dir, n), "${body}", { mode: 0o755 })`)))
    const out = await i.integratePending(wt)
    expect(out).toMatch(/Not merged: .*the git hooks/)
    expect(existsSync(join(root, 'src/h1.js'))).toBe(false)
    expect(existsSync(marker())).toBe(false)
  })

  it('refuses when the command sets core.hooksPath in the repository config, and that hook never runs', async () => {
    await prepareRepo(root)
    const wt = addWorktree('p1')
    const hooks = join(scripts, 'evil-hooks')
    mkdirSync(hooks)
    for (const n of ['post-merge', 'pre-merge-commit', 'post-commit', 'post-checkout']) writeFileSync(join(hooks, n), hookBody(), { mode: 0o755 })
    const { i } = integrator(command(script('hookspath.js', `git('config', 'core.hooksPath', ${JSON.stringify(norm(hooks))})`)))
    const out = await i.integratePending(wt)
    expect(out).toMatch(/Not merged: .*the repository config/)
    expect(existsSync(join(root, 'src/p1.js'))).toBe(false)
    expect(existsSync(marker())).toBe(false)
  })

  it('refuses when the command defines a merge driver in the repository config', async () => {
    await prepareRepo(root)
    const wt = addWorktree('d1')
    const { i } = integrator(command(script('driver.js', "git('config', 'merge.evil.driver', 'echo owned')")))
    const out = await i.integratePending(wt)
    expect(out).toMatch(/Not merged: .*the repository config/)
  })

  it('names every part that moved, and a failing test is still reported as the drift when it also moved the checkout', async () => {
    await prepareRepo(root)
    const wt = addWorktree('m1')
    const { i } = integrator(command(script('both.js', "git('commit', '--allow-empty', '-q', '-m', 'x'); fs.writeFileSync(path.join(root, 's.txt'), 's'); git('add', 's.txt'); process.exit(1)")))
    const out = await i.integratePending(wt)
    expect(out).toMatch(/its HEAD commit, its index \(staged changes\)/)
  })

  it('a pin read twice with nothing moved is equal, and says which part moved when one does', async () => {
    const a = await pinRoot(root)
    expect(pinDrift(a, await pinRoot(root))).toEqual([])
    expect(await rootDrift(root, a)).toBeUndefined()
    git(root, 'config', 'alias.zz', 'status')
    expect(pinDrift(a, await pinRoot(root))).toEqual(['the repository config'])
    expect(await rootDrift(root, a)).toContain('the repository config')
  })

  it('a repository with its own filter driver leaves the working tree unpinned (git diff-files would run the filter)', async () => {
    git(root, 'config', 'filter.lfsish.clean', 'cat')
    const a = await pinRoot(root)
    expect(a.worktree).toBe('not pinned')
    fs_append(join(root, 'package.json'))
    // The index and HEAD are still pinned, the working tree is not looked at.
    expect(pinDrift(a, await pinRoot(root))).toEqual([])
  })
})

function fs_append(path: string): void {
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n`)
}

describe('the merge step reads the checkout once more under the repository lock (GateDecision.verify)', () => {
  it('a drift found after the gate returned refuses the merge and keeps the copy; no drift merges', async () => {
    await prepareRepo(root)
    const wt = addWorktree('v1')
    const refused = await integrateWorktree(root, { ...wt, status: 'merging' }, 'Implementer: v1', async () => ({ behavior: 'merge', verify: async () => 'Not merged: the main checkout moved.' }))
    expect(refused.info.status).toBe('conflict')
    expect(refused.message).toContain('Not merged: the main checkout moved.')
    expect(refused.message).toContain(wt.branch)
    expect(existsSync(wt.path)).toBe(true)
    expect(existsSync(join(root, 'src/v1.js'))).toBe(false)
    const verify = vi.fn(async () => undefined)
    const merged = await integrateWorktree(root, { ...wt, status: 'merging' }, 'Implementer: v1', async () => ({ behavior: 'merge', verify }))
    expect(merged.info.status, merged.message).toBe('merged')
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('a change after the test command ended (a process it left behind) is caught by the same check', async () => {
    await prepareRepo(root)
    const wt = addWorktree('v2')
    const pin = await pinRoot(root)
    const res = await integrateWorktree(root, { ...wt, status: 'merging' }, 'Implementer: v2', async () => {
      // The gate has read the checkout after the tests; a straggler commits afterwards, before the merge step.
      git(root, 'commit', '--allow-empty', '-q', '-m', 'late')
      return { behavior: 'merge', verify: () => rootDrift(root, pin) }
    })
    expect(res.info.status).toBe('conflict')
    expect(res.message).toMatch(/its HEAD commit/)
    expect(existsSync(join(root, 'src/v2.js'))).toBe(false)
  })
})

describe('the merge and what follows run with hooks off (security review M4)', () => {
  it('a hook already in the repository (or one a later step could install) does not run on OrgAI\'s merge', async () => {
    await prepareRepo(root)
    const wt = addWorktree('g1')
    const hooks = join(root, '.git', 'hooks')
    mkdirSync(hooks, { recursive: true })
    for (const n of ['post-merge', 'pre-merge-commit', 'post-checkout', 'commit-msg']) writeFileSync(join(hooks, n), hookBody(), { mode: 0o755 })
    // The branch commit itself (commitLeftovers) is the user's own commit path and still runs hooks as before; the merge does not.
    rmSync(marker(), { force: true })
    git(wt.path, '-c', 'core.hooksPath=' + norm(join(scripts, 'none')), 'add', '-A')
    git(wt.path, '-c', 'core.hooksPath=' + norm(join(scripts, 'none')), 'commit', '-q', '-m', 'work')
    const res = await integrateWorktree(root, { ...wt, status: 'merging' }, 'Implementer: g1')
    expect(res.info.status, res.message).toBe('merged')
    expect(existsSync(join(root, 'src/g1.js'))).toBe(true)
    expect(existsSync(marker())).toBe(false)
  })

  it('core.hooksPath already in the repository config is overridden on the merge', async () => {
    await prepareRepo(root)
    const wt = addWorktree('g2')
    const hooks = join(scripts, 'cfg-hooks')
    mkdirSync(hooks)
    for (const n of ['post-merge', 'pre-merge-commit', 'post-checkout']) writeFileSync(join(hooks, n), hookBody(), { mode: 0o755 })
    git(wt.path, 'add', '-A')
    git(wt.path, 'commit', '-q', '-m', 'work')
    git(root, 'config', 'core.hooksPath', norm(hooks))
    const res = await integrateWorktree(root, { ...wt, status: 'merging' }, 'Implementer: g2')
    expect(res.info.status, res.message).toBe('merged')
    expect(existsSync(marker())).toBe(false)
  })
})
