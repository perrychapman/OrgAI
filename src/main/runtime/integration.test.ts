import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentInstance, MergeDecision, WorktreeInfo, WorktreeStatus } from '@shared/types'
import { WorktreeIntegrator } from './integration'
import { fakeCtx, project } from './testHelpers'
import { commitLeftovers, diffWorktree, findWorktree, inspectPending, integrateWorktree, prepareRepo } from './worktrees'

vi.mock('./worktrees', () => ({
  prepareRepo: vi.fn(async () => {}),
  findWorktree: vi.fn(async () => null),
  integrateWorktree: vi.fn(),
  diffWorktree: vi.fn(async () => ({ stat: ' a.ts | 2 +-', patch: 'diff --git a/a.ts b/a.ts', changedFiles: ['a.ts'] })),
  inspectPending: vi.fn(async () => []),
  commitLeftovers: vi.fn(async () => ({ committed: true })),
  pendingWorktrees: vi.fn(async () => [])
}))

const WT: WorktreeInfo = { path: '/repo/.claude/worktrees/agent-a1', branch: 'worktree-agent-a1', status: 'active' }

function agent(id: string, name: string): AgentInstance {
  return {
    id,
    roleId: null,
    roleSlug: name.toLowerCase(),
    name,
    parentId: 'root',
    spawnToolUseId: null,
    state: 'done',
    activity: 'Reported back',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    startedAt: 0
  }
}

/** integrateWorktree stand-in: optionally runs the review gate, then lands in `status`. */
function integrateTo(status: WorktreeStatus, message = `${status} message`, changedFiles = ['a.ts']) {
  vi.mocked(integrateWorktree).mockImplementation(async (_root, info, _msg, review) => {
    let final = status
    if (review) {
      const d: MergeDecision = await review(changedFiles)
      final = d.behavior === 'discard' ? 'removed' : d.behavior === 'hold' ? 'held' : status
    }
    return { info: { ...info, status: final, changedFiles }, message }
  })
}

function setup(reviewMerges = false, decision: MergeDecision = { behavior: 'merge' }) {
  const ctx = fakeCtx({
    project: project({ reviewMerges }),
    requestMergeReview: vi.fn(async () => decision)
  })
  const agents = new Map<string, AgentInstance>([['a1', agent('a1', 'Engineer')]])
  const transitions: { id: string; status: WorktreeStatus; path: string }[] = []
  const notes: string[] = []
  const integrator = new WorktreeIntegrator(ctx, {
    agent: (id) => agents.get(id),
    setWorktree: (id, info) => {
      transitions.push({ id, status: info.status, path: info.path })
      const a = agents.get(id)
      if (a) a.worktree = info
    },
    notify: (text) => notes.push(text)
  })
  const logs = () => ctx.events.flatMap((e) => (e.type === 'log' ? [`${e.level}: ${e.message}`] : []))
  return { ctx, agents, transitions, notes, integrator, logs }
}

beforeEach(() => {
  vi.mocked(integrateWorktree).mockReset()
  vi.mocked(findWorktree).mockClear()
  vi.mocked(diffWorktree).mockClear()
  vi.mocked(commitLeftovers).mockClear()
  vi.mocked(inspectPending).mockReset()
  vi.mocked(inspectPending).mockResolvedValue([])
})

describe('WorktreeIntegrator', () => {
  it('merges a finished report once and tells the orchestrator', async () => {
    integrateTo('merged', 'Merged worktree-agent-a1 into the main checkout (1 file: a.ts).')
    const { integrator, transitions, notes, logs } = setup()
    integrator.noteBrief('a1', 'Add the login form')
    expect(integrator.track('a1', WT)).toBe(WT)
    await integrator.onSubagentFinished('a1')
    await integrator.onSubagentFinished('a1')

    expect(integrateWorktree).toHaveBeenCalledOnce()
    expect(vi.mocked(integrateWorktree).mock.calls[0][2]).toBe('Engineer: Add the login form')
    expect(vi.mocked(integrateWorktree).mock.calls[0][3]).toBeUndefined()
    expect(transitions.map((t) => t.status)).toEqual(['merging', 'merged'])
    expect(integrator.worktreeOf('a1')?.status).toBe('merged')
    expect(notes).toEqual([
      "Harness: Engineer's report was merged into the main checkout. Merged worktree-agent-a1 into the main checkout (1 file: a.ts). Verify the merged result before relying on it."
    ])
    expect(logs()).toEqual(['info: Engineer: Merged worktree-agent-a1 into the main checkout (1 file: a.ts).'])
  })

  it('uses the located worktree path when git knows a different one', async () => {
    integrateTo('merged')
    vi.mocked(findWorktree).mockResolvedValueOnce({ path: '/elsewhere/agent-a1', branch: 'worktree-agent-a1' })
    const { integrator } = setup()
    integrator.track('a1', WT)
    await integrator.onSubagentFinished('a1')
    expect(vi.mocked(integrateWorktree).mock.calls[0][1].path).toBe('/elsewhere/agent-a1')
  })

  it('hands a conflict to the orchestrator with instructions and a warning', async () => {
    integrateTo('conflict', 'Branch worktree-agent-a1 could not be merged automatically (conflicts in a.ts).')
    const { integrator, notes, logs } = setup()
    integrator.track('a1', WT)
    await integrator.onSubagentFinished('a1')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain("Harness: Engineer's report could not be merged automatically.")
    expect(notes[0]).toContain('git worktree remove --force "/repo/.claude/worktrees/agent-a1"')
    expect(notes[0]).toContain('call integrate_worktrees')
    expect(logs()[0]).toMatch(/^warn: Engineer: Branch worktree-agent-a1/)
  })

  it('says nothing to the orchestrator when the report changed nothing', async () => {
    integrateTo('empty', 'The report made no changes; worktree removed.', [])
    const { integrator, notes } = setup()
    integrator.track('a1', WT)
    await integrator.onSubagentFinished('a1')
    expect(notes).toEqual([])
    expect(integrator.worktreeOf('a1')?.status).toBe('empty')
  })

  it('ignores agents that are not isolated or not active', async () => {
    const { integrator } = setup()
    await integrator.onSubagentFinished('nobody')
    integrator.track('a1', { ...WT, status: 'merged' })
    await integrator.onSubagentFinished('a1')
    expect(integrateWorktree).not.toHaveBeenCalled()
  })

  describe('review gate', () => {
    it('shows the diff and merges on approval', async () => {
      integrateTo('merged')
      const { integrator, ctx, transitions, notes } = setup(true, { behavior: 'merge' })
      integrator.track('a1', WT)
      await integrator.onSubagentFinished('a1')
      expect(transitions.map((t) => t.status)).toEqual(['merging', 'review', 'merging', 'merged'])
      expect(diffWorktree).toHaveBeenCalledWith('/repo', 'worktree-agent-a1')
      expect(ctx.requestMergeReview).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'a1', agentName: 'Engineer', branch: 'worktree-agent-a1', changedFiles: ['a.ts'], stat: ' a.ts | 2 +-' })
      )
      expect(notes[0]).toMatch(/was merged into the main checkout/)
    })

    it('holds the branch and tells the orchestrator not to build on it', async () => {
      integrateTo('merged')
      const { integrator, transitions, notes } = setup(true, { behavior: 'hold' })
      integrator.track('a1', WT)
      await integrator.onSubagentFinished('a1')
      expect(transitions.map((t) => t.status)).toEqual(['merging', 'review', 'held'])
      expect(notes).toHaveLength(1)
      expect(notes[0]).toContain('chose to hold it for later instead of merging')
      expect(notes[0]).toContain('they stay on branch worktree-agent-a1')
    })

    it('discards the branch and tells the orchestrator to redo the work', async () => {
      integrateTo('merged')
      const { integrator, transitions, notes } = setup(true, { behavior: 'discard' })
      integrator.track('a1', WT)
      await integrator.onSubagentFinished('a1')
      expect(transitions.map((t) => t.status)).toEqual(['merging', 'review', 'removed'])
      expect(notes).toEqual([
        "Harness: the user reviewed Engineer's report and discarded it. None of its changes were merged and its branch was deleted. Redo or reassign that work if it is still needed."
      ])
    })

    it('is skipped when reviewMerges is off', () => {
      const { integrator } = setup(false)
      expect(integrator.reviewGate('a1', WT)).toBeUndefined()
    })
  })

  describe('integratePending', () => {
    it('retries a conflicted branch for its owner', async () => {
      integrateTo('merged', 'Merged it.')
      const { integrator, transitions } = setup()
      integrator.noteBrief('a1', 'Fix the bug')
      integrator.track('a1', { ...WT, status: 'conflict', changedFiles: ['a.ts'] })
      const line = await integrator.integratePending({ path: WT.path, branch: WT.branch })
      expect(line).toBe('worktree-agent-a1: Merged it.')
      expect(vi.mocked(integrateWorktree).mock.calls[0][2]).toBe('Engineer: Fix the bug')
      expect(vi.mocked(integrateWorktree).mock.calls[0][1]).toEqual({ path: WT.path, branch: WT.branch, status: 'merging', changedFiles: ['a.ts'] })
      expect(transitions.map((t) => t.status)).toEqual(['merging', 'merged'])
    })

    it('integrates a branch nobody in this run owns', async () => {
      integrateTo('conflict', 'Still conflicts.')
      const { integrator, transitions, logs } = setup()
      const line = await integrator.integratePending({ path: '/repo/.claude/worktrees/agent-old', branch: 'worktree-agent-old' })
      expect(line).toBe('worktree-agent-old: Still conflicts.')
      expect(vi.mocked(integrateWorktree).mock.calls[0][2]).toBe('report: worktree-agent-old')
      expect(transitions).toEqual([])
      expect(logs()).toEqual(['warn: worktree-agent-old: Still conflicts.'])
    })
  })

  it('updates the worktree path from the agent\'s real cwd while active', () => {
    const { integrator, transitions } = setup()
    integrator.track('a1', WT)
    integrator.reportCwd('a1', '/repo')
    integrator.reportCwd('a1', WT.path)
    integrator.reportCwd('a1', undefined)
    expect(transitions).toEqual([])
    integrator.reportCwd('a1', '/real/agent-a1')
    expect(transitions).toEqual([{ id: 'a1', status: 'active', path: '/real/agent-a1' }])
  })

  it('prepares the repository and reconciles leftovers on start', async () => {
    vi.mocked(inspectPending).mockResolvedValue([
      {
        path: '/repo/.claude/worktrees/agent-x',
        branch: 'worktree-agent-x',
        agentId: 'x',
        exists: true,
        uncommittedFiles: 2,
        commitsAhead: 1,
        changedFiles: ['a.ts', 'b.ts'],
        lastSubject: 'wip'
      },
      { path: '/gone', branch: 'worktree-agent-y', agentId: 'y', exists: false, uncommittedFiles: 0, commitsAhead: 3, changedFiles: [] }
    ])
    const { integrator, logs } = setup()
    const text = await integrator.start()
    expect(prepareRepo).toHaveBeenCalledWith('/repo')
    expect(commitLeftovers).toHaveBeenCalledOnce()
    expect(text).toContain('Harness: 2 report branches from earlier runs are still waiting in this repository:')
    expect(text).toContain('- worktree-agent-x: 1 commit(s) ahead, touches a.ts, b.ts, last: "wip" (uncommitted work was just committed to keep it safe)')
    expect(text).toContain('- worktree-agent-y: 3 commit(s) ahead\n')
    expect(text).toContain('call integrate_worktrees to merge the ones worth keeping')
    expect(logs()[0]).toMatch(/^info: Writing reports run in isolated git worktrees/)
    expect(logs().filter((l) => l.startsWith('warn: Leftover report branch'))).toHaveLength(2)
  })

  it('returns null when no leftovers are waiting', async () => {
    const { integrator } = setup()
    expect(await integrator.reconcileLeftovers()).toBeNull()
  })
})
