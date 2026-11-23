import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentInstance, AgentState, Project, RunRecord, RunSummary, WorktreeStatus } from '@shared/types'
import { MaintenanceService } from './maintenance'
import type { ProjectStore } from './store/projects'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0)

let root: string

function git(cwd: string, args: string, env: Record<string, string> = {}): string {
  return execSync(`git -c user.name=OrgAI-Test -c user.email=test@orgai.local ${args}`, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env }
  }).trim()
}

function put(dir: string, rel: string, content: string): void {
  const full = join(dir, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

/** A finished copy as Claude Code leaves it: worktree under .claude/worktrees on branch worktree-agent-<id>, one commit made `daysAgo` days before NOW. */
function addCopy(id: string, daysAgo: number): { path: string; branch: string } {
  const rel = `.claude/worktrees/agent-${id}`
  const branch = `worktree-agent-${id}`
  git(root, `worktree add -q -b ${branch} ${rel}`)
  const path = join(root, rel)
  put(path, `work-${id}.txt`, 'work\n')
  const when = new Date(NOW - daysAgo * DAY).toISOString()
  git(path, 'add -A')
  git(path, `commit -q -m work-${id}`, { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when })
  const t = new Date(NOW - daysAgo * DAY)
  utimesSync(path, t, t)
  return { path, branch }
}

function agent(id: string, state: AgentState, worktree: WorktreeStatus, wtPath: string, branch: string): AgentInstance {
  return { id, roleId: null, roleSlug: 'eng', name: id, parentId: 'root', spawnToolUseId: null, state, activity: '', inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: 0, worktree: { path: wtPath, branch, status: worktree } }
}

function run(id: string, status: RunSummary['status'], endedDaysAgo: number): RunSummary {
  return { id, projectId: 'p1', kind: 'work', prompt: 'x', status, startedAt: NOW - (endedDaysAgo + 1) * DAY, endedAt: status === 'finished' || status === 'error' ? NOW - endedDaysAgo * DAY : undefined, totalCostUsd: 0 } as RunSummary
}

function fixture(opts: { days?: number; runs: RunSummary[]; agents: Record<string, AgentInstance[]>; kind?: 'engagement'; live?: boolean }) {
  const project = { id: 'p1', name: 'Demo', path: root, roles: [], keepFailedBranchesDays: opts.days, ...(opts.kind ? { kind: opts.kind } : {}) } as unknown as Project
  const store = { get: () => project, list: () => [project], save: (p: Project) => p } as unknown as ProjectStore
  const logs: string[] = []
  const svc = new MaintenanceService(store, undefined, {
    runs: {
      list: () => opts.runs,
      getRecord: (runId) => ({ summary: opts.runs.find((r) => r.id === runId), agents: Object.fromEntries((opts.agents[runId] ?? []).map((a) => [a.id, a])), transcript: [], logs: [] }) as unknown as RunRecord
    },
    hasLiveRun: () => opts.live === true,
    now: () => NOW,
    log: (m) => logs.push(m)
  })
  return { svc, logs }
}

function branches(): string[] {
  return git(root, 'branch')
    .split(/\r?\n/)
    .map((l) => l.replace(/^[*+]?\s*/, '').trim())
    .filter(Boolean)
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-keep-')))
  git(root, 'init -q -b main')
  put(root, 'README.md', 'x\n')
  git(root, 'add -A')
  git(root, 'commit -q -m initial')
  put(root, '.git/info/exclude', '.claude/worktrees/\n')
})

afterEach(() => {
  try {
    git(root, 'worktree prune')
  } catch {
    /* ignore */
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

describe('keepFailedBranchesDays retention', () => {
  it('removes only old failed or discarded copies', async () => {
    const oldConflict = addCopy('oldc', 20)
    const oldRemoved = addCopy('oldr', 20)
    const oldError = addCopy('olde', 20)
    const young = addCopy('young', 2)
    const oldHeld = addCopy('oldh', 20)
    const oldMerging = addCopy('oldm', 20)
    const unowned = addCopy('nobody', 20)
    const { svc, logs } = fixture({
      days: 7,
      runs: [run('r1', 'finished', 15)],
      agents: {
        r1: [
          agent('oldc', 'done', 'conflict', oldConflict.path, oldConflict.branch),
          agent('oldr', 'done', 'removed', oldRemoved.path, oldRemoved.branch),
          agent('olde', 'error', 'active', oldError.path, oldError.branch),
          agent('young', 'done', 'conflict', young.path, young.branch),
          agent('oldh', 'done', 'held', oldHeld.path, oldHeld.branch),
          agent('oldm', 'done', 'merging', oldMerging.path, oldMerging.branch)
        ]
      }
    })
    const removed = await svc.sweepFinishedCopies()
    expect(removed.sort()).toEqual([oldConflict.branch, oldError.branch, oldRemoved.branch].sort())
    for (const gone of [oldConflict, oldRemoved, oldError]) expect(existsSync(gone.path)).toBe(false)
    for (const kept of [young, oldHeld, oldMerging, unowned]) {
      expect(existsSync(kept.path)).toBe(true)
      expect(branches()).toContain(kept.branch)
    }
    expect(logs).toHaveLength(3)
  })

  it('never removes anything while a run of the project is live', async () => {
    const copy = addCopy('live1', 30)
    const { svc } = fixture({
      days: 1,
      runs: [run('r1', 'finished', 25), run('r2', 'running', 0)],
      agents: { r1: [agent('live1', 'done', 'conflict', copy.path, copy.branch)] }
    })
    expect(await svc.sweepFinishedCopies()).toEqual([])
    expect(existsSync(copy.path)).toBe(true)
  })

  it('never removes anything while RunManager reports a live run, whatever the stored status says', async () => {
    const copy = addCopy('live2', 30)
    const { svc } = fixture({ days: 1, live: true, runs: [run('r1', 'finished', 25)], agents: { r1: [agent('live2', 'done', 'conflict', copy.path, copy.branch)] } })
    expect(await svc.sweepFinishedCopies()).toEqual([])
    expect(existsSync(copy.path)).toBe(true)
  })

  it('keeps a paused or idle run\'s copies too (the run can continue)', async () => {
    for (const status of ['paused', 'idle', 'stopping', 'starting'] as const) {
      const copy = addCopy(`p-${status}`, 30)
      const { svc } = fixture({ days: 1, runs: [run('r1', status, 25)], agents: { r1: [agent(`p-${status}`, 'done', 'conflict', copy.path, copy.branch)] } })
      expect(await svc.sweepFinishedCopies()).toEqual([])
      expect(existsSync(copy.path)).toBe(true)
    }
  })

  it('keeps a copy with uncommitted work', async () => {
    const copy = addCopy('dirty1', 30)
    put(copy.path, 'unsaved.txt', 'not committed\n')
    const { svc } = fixture({ days: 7, runs: [run('r1', 'finished', 25)], agents: { r1: [agent('dirty1', 'done', 'conflict', copy.path, copy.branch)] } })
    expect(await svc.sweepFinishedCopies()).toEqual([])
    expect(existsSync(join(copy.path, 'unsaved.txt'))).toBe(true)
  })

  it('keeps a copy whose run ended recently even when its last commit is old', async () => {
    const copy = addCopy('recent1', 30)
    const { svc } = fixture({ days: 7, runs: [run('r1', 'finished', 1)], agents: { r1: [agent('recent1', 'done', 'conflict', copy.path, copy.branch)] } })
    expect(await svc.sweepFinishedCopies()).toEqual([])
  })

  it('does nothing without a setting, with an out-of-range value, for an engagement, or without a run store', async () => {
    const copy = addCopy('off1', 30)
    const agents = { r1: [agent('off1', 'done', 'conflict', copy.path, copy.branch)] }
    for (const days of [undefined, 0, 400, 1.5]) {
      const { svc } = fixture({ days, runs: [run('r1', 'finished', 25)], agents })
      expect(await svc.sweepFinishedCopies()).toEqual([])
    }
    expect(await fixture({ days: 7, kind: 'engagement', runs: [run('r1', 'finished', 25)], agents }).svc.sweepFinishedCopies()).toEqual([])
    const project = { id: 'p1', name: 'Demo', path: root, roles: [], keepFailedBranchesDays: 7 } as unknown as Project
    const bare = new MaintenanceService({ get: () => project, list: () => [project] } as unknown as ProjectStore)
    expect(await bare.sweepFinishedCopies()).toEqual([])
    expect(existsSync(copy.path)).toBe(true)
  })

  it('keeps a copy over an unfinished git operation (the discard refuses)', async () => {
    const copy = addCopy('merge1', 30)
    const gitDir = git(copy.path, 'rev-parse --absolute-git-dir')
    writeFileSync(join(gitDir, 'MERGE_HEAD'), 'deadbeef\n')
    const { svc } = fixture({ days: 7, runs: [run('r1', 'finished', 25)], agents: { r1: [agent('merge1', 'done', 'conflict', copy.path, copy.branch)] } })
    expect(await svc.sweepFinishedCopies()).toEqual([])
    expect(existsSync(copy.path)).toBe(true)
  })
})

describe('integrating a leftover copy from maintenance', () => {
  function service(over: Partial<Project>): MaintenanceService {
    const project = { id: 'p1', name: 'Demo', path: root, roles: [], ...over } as unknown as Project
    return new MaintenanceService({ get: () => project, list: () => [project] } as unknown as ProjectStore)
  }

  it('runs the project\'s test command first: a failing command refuses the merge and keeps the copy', async () => {
    const copy = addCopy('gate-bad', 0)
    const res = await service({ requireTestsPass: true, testCommand: 'node -e "process.exit(2)"' }).integrateWorktree('p1', copy.branch)
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/Not merged: the project's tests failed/)
    expect(res.message).toContain('exit code 2')
    expect(existsSync(copy.path)).toBe(true)
    expect(branches()).toContain(copy.branch)
    expect(git(root, 'log -1 --format=%s')).toBe('initial')
  })

  it('merges when the command passes', async () => {
    const copy = addCopy('gate-ok', 0)
    const res = await service({ requireTestsPass: true, testCommand: 'node -e "process.exit(0)"' }).integrateWorktree('p1', copy.branch)
    expect(res.ok, res.message).toBe(true)
    expect(existsSync(copy.path)).toBe(false)
  })

  it('merges without running anything when the gate is off', async () => {
    const copy = addCopy('gate-off', 0)
    const res = await service({ requireTestsPass: false, testCommand: 'node -e "process.exit(2)"' }).integrateWorktree('p1', copy.branch)
    expect(res.ok, res.message).toBe(true)
  })

  it('honours Project.mainBranch', async () => {
    git(root, 'branch release')
    const copy = addCopy('mb-ok', 0)
    const res = await service({ mainBranch: 'release' }).integrateWorktree('p1', copy.branch)
    expect(res.ok, res.message).toBe(true)
    expect(git(root, 'branch --show-current')).toBe('release')
    expect(git(root, 'log -1 --format=%s main')).toBe('initial')
  })
})
