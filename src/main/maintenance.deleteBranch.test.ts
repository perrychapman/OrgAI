import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentInstance, Project, RunRecord, RunSummary } from '@shared/types'
import { MaintenanceService, type MaintenanceDeps } from './maintenance'
import type { ProjectStore } from './store/projects'

let root: string
let remote: string | null = null

function git(cwd: string, args: string): string {
  return execSync(`git -c user.name=OrgAI-Test -c user.email=test@orgai.local ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function put(dir: string, rel: string, content: string): void {
  const full = join(dir, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

function localBranches(): string[] {
  return git(root, "for-each-ref --format=%(refname:short) refs/heads")
    .split(/\r?\n/)
    .filter(Boolean)
    .sort()
}

/** A finished copy as the SDK leaves it: worktree under .claude/worktrees on branch worktree-agent-<id> with one commit. */
function addCopy(id: string): { path: string; branch: string } {
  const rel = `.claude/worktrees/agent-${id}`
  const branch = `worktree-agent-${id}`
  git(root, `worktree add -q -b ${branch} ${rel}`)
  const path = join(root, rel)
  put(path, `work-${id}.txt`, 'work\n')
  git(path, 'add -A')
  git(path, `commit -q -m work-${id}`)
  return { path, branch }
}

/** A branch with no copy: at the current HEAD (merged) or with one extra commit (unmerged). */
function addBareBranch(name: string, unmerged: boolean): void {
  if (!unmerged) {
    git(root, `branch ${name}`)
    return
  }
  const rel = `.claude/tmp-${name.replace(/[^a-z0-9]/gi, '')}`
  git(root, `worktree add -q -b ${name} ${rel}`)
  put(join(root, rel), 'extra.txt', 'x\n')
  git(join(root, rel), 'add -A')
  git(join(root, rel), 'commit -q -m extra')
  git(root, `worktree remove --force ${rel}`)
}

function service(extra: Record<string, unknown> = {}, deps: MaintenanceDeps = {}): MaintenanceService {
  const project = { id: 'p1', name: 'Demo', path: root, roles: [], ...extra } as unknown as Project
  const logs: string[] = []
  return new MaintenanceService({ get: () => project, list: () => [project] } as unknown as ProjectStore, undefined, { log: (m) => logs.push(m), ...deps })
}

function agent(id: string, branch: string): AgentInstance {
  return { id, roleId: null, roleSlug: 'eng', name: id, parentId: 'root', spawnToolUseId: null, state: 'thinking', activity: '', inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: 0, worktree: { path: join(root, '.claude', 'worktrees', `agent-${id}`), branch, status: 'active' } } as AgentInstance
}

function runsDeps(runs: { summary: Partial<RunSummary> & { id: string }; agents: AgentInstance[] }[], hasLive?: boolean): MaintenanceDeps {
  const summaries = runs.map((r) => ({ projectId: 'p1', kind: 'work', prompt: 'x', startedAt: 1, totalCostUsd: 0, status: 'finished', ...r.summary }) as RunSummary)
  return {
    runs: {
      list: () => summaries,
      getRecord: (runId) => {
        const r = runs.find((x) => x.summary.id === runId)
        return r ? ({ summary: summaries.find((s) => s.id === runId), agents: Object.fromEntries(r.agents.map((a) => [a.id, a])), transcript: [], logs: [] } as unknown as RunRecord) : null
      }
    },
    ...(hasLive === undefined ? {} : { hasLiveRun: () => hasLive })
  }
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-delbranch-')))
  git(root, 'init -q -b main')
  put(root, 'README.md', 'x\n')
  git(root, 'add -A')
  git(root, 'commit -q -m init')
  git(root, 'config core.autocrlf false')
  put(root, '.git/info/exclude', '.claude/\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  if (remote) rmSync(remote, { recursive: true, force: true })
  remote = null
})

describe('deleteBranch: refusals change nothing', () => {
  it('refuses the branch the checkout is on', async () => {
    addBareBranch('worktree-agent-cur', false)
    git(root, 'checkout -q worktree-agent-cur')
    const res = await service().deleteBranch('p1', 'worktree-agent-cur')
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/branch this checkout is on/)
    expect(localBranches()).toContain('worktree-agent-cur')
  })

  it('refuses the default branch and Project.mainBranch', async () => {
    git(root, 'branch develop')
    git(root, 'checkout -q -b side')
    const main = await service().deleteBranch('p1', 'main')
    expect(main.ok).toBe(false)
    expect(main.message).toMatch(/default or main branch/)
    const dev = await service({ mainBranch: 'develop' }).deleteBranch('p1', 'develop')
    expect(dev.ok).toBe(false)
    expect(dev.message).toMatch(/default or main branch/)
    // The default named by origin/HEAD counts too.
    git(root, 'branch trunk')
    git(root, 'update-ref refs/remotes/origin/trunk HEAD')
    git(root, 'symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/trunk')
    const trunk = await service().deleteBranch('p1', 'trunk')
    expect(trunk.ok).toBe(false)
    expect(trunk.message).toMatch(/default or main branch/)
    expect(localBranches()).toEqual(['develop', 'main', 'side', 'trunk'])
  })

  it('refuses a branch a live run uses, and everything while a live run cannot be read', async () => {
    const copy = addCopy('live1')
    const live = runsDeps([{ summary: { id: 'r1', status: 'running' }, agents: [agent('live1', copy.branch)] }], true)
    const res = await service({}, live).deleteBranch('p1', copy.branch)
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/still active/)
    expect(existsSync(copy.path)).toBe(true)
    expect(localBranches()).toContain(copy.branch)
    // A branch of the same project that the live run does not use is not blocked by it.
    addBareBranch('worktree-agent-other', false)
    expect((await service({}, live).deleteBranch('p1', 'worktree-agent-other')).ok).toBe(true)
    // RunManager says a run is live but no stored run shows it: nothing can be judged unused.
    addBareBranch('worktree-agent-blind', false)
    const blind = await service({}, { hasLiveRun: () => true }).deleteBranch('p1', 'worktree-agent-blind')
    expect(blind.ok).toBe(false)
    expect(blind.message).toMatch(/cannot tell which branches it uses/)
    expect(localBranches()).toContain('worktree-agent-blind')
  })

  it('refuses a branch the live run names by agent id even when the record has no worktree yet', async () => {
    addBareBranch('worktree-agent-early', false)
    const live = runsDeps([{ summary: { id: 'r1', status: 'running' }, agents: [{ ...agent('early', ''), worktree: undefined } as AgentInstance] }], true)
    const res = await service({}, live).deleteBranch('p1', 'worktree-agent-early')
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/still active/)
  })

  it('refuses a branch that is not an OrgAI report branch', async () => {
    git(root, 'branch feature/mine')
    git(root, 'branch worktree-agent-')
    for (const name of ['feature/mine', 'worktree-agent-']) {
      const res = await service().deleteBranch('p1', name)
      expect(res.ok, name).toBe(false)
      expect(res.message).toMatch(/not a report branch/)
    }
    expect(localBranches()).toEqual(expect.arrayContaining(['feature/mine', 'worktree-agent-']))
  })

  it('refuses a name that is invalid or does not exist, without running a delete', async () => {
    for (const name of ['', '-D', '--all', 'a b', 'a..b', 'a:b', '../main', 'worktree-agent-x\n-D main']) {
      const res = await service().deleteBranch('p1', name)
      expect(res.ok, name).toBe(false)
      expect(res.message).toMatch(/not a branch name OrgAI will delete/)
    }
    const missing = await service().deleteBranch('p1', 'worktree-agent-nothere')
    expect(missing).toEqual({ ok: false, message: 'There is no local branch named worktree-agent-nothere.' })
    expect(localBranches()).toEqual(['main'])
  })

  it('refuses, keeping copy and branch, over an unfinished merge in the finished copy', async () => {
    const copy = addCopy('merge1')
    const gitDir = git(copy.path, 'rev-parse --absolute-git-dir')
    writeFileSync(join(gitDir, 'MERGE_HEAD'), 'deadbeef\n')
    const res = await service().deleteBranch('p1', copy.branch)
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/unfinished operation/)
    expect(existsSync(copy.path)).toBe(true)
    expect(localBranches()).toContain(copy.branch)
  })

  it('refuses over an unfinished merge in the main checkout', async () => {
    addBareBranch('worktree-agent-m2', false)
    writeFileSync(join(root, '.git', 'MERGE_HEAD'), 'deadbeef\n')
    const res = await service().deleteBranch('p1', 'worktree-agent-m2')
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/unfinished operation/)
    expect(localBranches()).toContain('worktree-agent-m2')
  })

  it('refuses a branch without a copy that has work not merged into the current branch', async () => {
    addBareBranch('worktree-agent-unmerged', true)
    const res = await service().deleteBranch('p1', 'worktree-agent-unmerged')
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/not merged/)
    expect(localBranches()).toContain('worktree-agent-unmerged')
  })

  it('refuses a folder that is not a git repository', async () => {
    const plain = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-delbranch-plain-')))
    try {
      const project = { id: 'p2', name: 'Plain', path: plain, roles: [] } as unknown as Project
      const svc = new MaintenanceService({ get: () => project, list: () => [project] } as unknown as ProjectStore)
      expect((await svc.deleteBranch('p2', 'worktree-agent-x')).ok).toBe(false)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})

describe('deleteBranch: deletes', () => {
  it('discards an unmerged finished copy and force-deletes its branch', async () => {
    const copy = addCopy('gone1')
    addBareBranch('worktree-agent-keep', false)
    const res = await service().deleteBranch('p1', copy.branch)
    expect(res).toEqual({ ok: true, message: `Deleted ${copy.branch} and its finished copy.` })
    expect(existsSync(copy.path)).toBe(false)
    expect(localBranches()).toEqual(['main', 'worktree-agent-keep'])
    expect(git(root, 'worktree list --porcelain')).not.toContain('agent-gone1')
  })

  it('deletes a merged branch that has no copy', async () => {
    addBareBranch('worktree-agent-merged1', false)
    const res = await service().deleteBranch('p1', 'worktree-agent-merged1')
    expect(res).toEqual({ ok: true, message: 'Deleted worktree-agent-merged1.' })
    expect(localBranches()).toEqual(['main'])
  })

  it('deletes a merged branch named by branchNamePattern, not one that only looks like it', async () => {
    addBareBranch('orgai/fix-login-ab12', false)
    git(root, 'branch other/fix-login-ab12')
    git(root, 'branch orgai-fix')
    const svc = service({ branchNamePattern: 'orgai/{task}' })
    expect((await svc.deleteBranch('p1', 'orgai/fix-login-ab12')).ok).toBe(true)
    for (const name of ['other/fix-login-ab12', 'orgai-fix']) expect((await svc.deleteBranch('p1', name)).ok, name).toBe(false)
    expect(localBranches()).toEqual(['main', 'orgai-fix', 'other/fix-login-ab12'])
  })

  it('does not treat a placeholder-first pattern as ownership of every branch', async () => {
    git(root, 'branch mine-and-more')
    const res = await service({ branchNamePattern: '{task}' }).deleteBranch('p1', 'mine-and-more')
    expect(res.ok).toBe(false)
    expect(localBranches()).toContain('mine-and-more')
  })

  it('deletes a branch an ended run recorded as an agent worktree branch', async () => {
    git(root, 'branch custom-report-1')
    const ended = runsDeps([{ summary: { id: 'r0', status: 'finished' }, agents: [agent('c1', 'custom-report-1')] }], false)
    expect((await service({}, ended).deleteBranch('p1', 'custom-report-1')).ok).toBe(true)
    expect(localBranches()).toEqual(['main'])
  })

  it('never touches a remote', async () => {
    remote = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-delbranch-remote-')))
    git(remote, 'init -q --bare -b main')
    git(root, `remote add origin "${remote.replace(/\\/g, '/')}"`)
    addBareBranch('worktree-agent-pushed', false)
    git(root, 'push -q origin main worktree-agent-pushed')
    const res = await service().deleteBranch('p1', 'worktree-agent-pushed')
    expect(res.ok).toBe(true)
    expect(localBranches()).toEqual(['main'])
    expect(git(remote, 'for-each-ref --format=%(refname:short) refs/heads').split(/\r?\n/).sort()).toEqual(['main', 'worktree-agent-pushed'])
    expect(git(root, 'for-each-ref --format=%(refname:short) refs/remotes')).toContain('origin/worktree-agent-pushed')
  })
})
