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
      const d: MergeDecision = await review({ changedFiles, sourceOid: 'source-oid', targetOid: 'target-oid' })
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
      expect(diffWorktree).toHaveBeenCalledWith('/repo', 'source-oid', 'target-oid')
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

describe('nested isolation', () => {
  const P = '/repo/.claude/worktrees/agent-p1'
  const PARENT: WorktreeInfo = { path: P, branch: 'worktree-agent-p1', status: 'active', mergeTarget: 'main' }
  const child = (id: string): WorktreeInfo => ({
    path: `${P}/.claude/worktrees/agent-${id}`,
    branch: `worktree-agent-${id}`,
    status: 'active',
    mergeTarget: 'parent',
    parentAgentId: 'p1',
    parentBranch: 'worktree-agent-p1'
  })

  /** integrateWorktree stand-in that lands each branch in its own status (default merged). */
  function integrateBy(statuses: Record<string, WorktreeStatus>) {
    vi.mocked(integrateWorktree).mockImplementation(async (_root, info, _msg, review) => {
      let final = statuses[info.branch] ?? 'merged'
      if (review) {
        const d = await review({ changedFiles: ['a.ts'], sourceOid: 'source-oid', targetOid: 'target-oid' })
        final = d.behavior === 'discard' ? 'removed' : d.behavior === 'hold' ? 'held' : final
      }
      return { info: { ...info, status: final, changedFiles: ['a.ts'] }, message: `${info.branch} ${final}` }
    })
  }

  function nested(reviewMerges = false, decision: MergeDecision = { behavior: 'merge' }) {
    const s = setup(reviewMerges, decision)
    s.agents.set('p1', agent('p1', 'Lead'))
    s.agents.set('c1', { ...agent('c1', 'Dev1'), parentId: 'p1' })
    s.agents.set('c2', { ...agent('c2', 'Dev2'), parentId: 'p1' })
    s.integrator.track('p1', PARENT)
    s.integrator.track('c1', child('c1'))
    s.integrator.track('c2', child('c2'))
    const roots = () => vi.mocked(integrateWorktree).mock.calls.map((c) => `${c[1].branch} -> ${c[0]}`)
    const statusesOf = (id: string) => s.transitions.filter((t) => t.id === id).map((t) => t.status)
    return { ...s, roots, statusesOf }
  }

  beforeEach(() => {
    vi.mocked(findWorktree).mockReset()
    vi.mocked(findWorktree).mockResolvedValue(null)
  })

  it('merges a depth-2 report into its parent worktree, quietly', async () => {
    integrateBy({})
    const { integrator, notes, logs, roots } = nested()
    await integrator.onSubagentFinished('c1')
    expect(roots()).toEqual([`worktree-agent-c1 -> ${P}`])
    expect(integrator.worktreeOf('c1')?.status).toBe('merged')
    // A clean nested merge is logged only; the lead verifies and its branch carries it on.
    expect(notes).toEqual([])
    expect(logs()).toContain('info: Dev1: worktree-agent-c1 merged')
  })

  it('makes a parent that finishes first wait for its children, then merges it into main', async () => {
    integrateBy({})
    const { integrator, notes, roots, statusesOf } = nested()
    await integrator.onSubagentFinished('p1')
    expect(integrator.worktreeOf('p1')?.status).toBe('waiting-children')
    expect(commitLeftovers).toHaveBeenCalledWith(P, expect.stringMatching(/^Lead: /))
    expect(integrateWorktree).not.toHaveBeenCalled()

    await integrator.onSubagentFinished('c1')
    expect(integrator.worktreeOf('p1')?.status).toBe('waiting-children')
    await integrator.onSubagentFinished('c2')
    expect(roots()).toEqual([`worktree-agent-c1 -> ${P}`, `worktree-agent-c2 -> ${P}`, 'worktree-agent-p1 -> /repo'])
    expect(statusesOf('p1')).toEqual(['waiting-children', 'merging', 'merged'])
    expect(notes).toEqual([
      "Harness: Lead's report was merged into the main checkout. worktree-agent-p1 merged Verify the merged result before relying on it."
    ])
    // Finishing again (SubagentStop and task_notification both fire) changes nothing.
    await integrator.onSubagentFinished('p1')
    expect(integrateWorktree).toHaveBeenCalledTimes(3)
  })

  it('merges a parent with no unsettled children right away', async () => {
    integrateBy({})
    const { integrator, roots } = nested()
    await integrator.onSubagentFinished('c1')
    await integrator.onSubagentFinished('c2')
    await integrator.onSubagentFinished('p1')
    expect(roots()).toEqual([`worktree-agent-c1 -> ${P}`, `worktree-agent-c2 -> ${P}`, 'worktree-agent-p1 -> /repo'])
    expect(commitLeftovers).not.toHaveBeenCalled()
  })

  it('holds a child that conflicts with its parent, names both branches, and still merges the parent', async () => {
    integrateBy({ 'worktree-agent-c1': 'conflict' })
    // After the parent leaves, git reports the child's worktree at its moved location.
    vi.mocked(findWorktree).mockImplementation(async (_root, id) =>
      id === 'c1' && vi.mocked(integrateWorktree).mock.calls.length >= 3
        ? { path: '/repo/.claude/worktrees/agent-c1', branch: 'worktree-agent-c1' }
        : null
    )
    const { integrator, notes, roots, logs } = nested()
    await integrator.onSubagentFinished('p1')
    await integrator.onSubagentFinished('c1')
    expect(integrator.worktreeOf('c1')?.status).toBe('conflict')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain("Harness: Dev1's report (spawned by Lead) could not be merged into Lead's worktree automatically.")
    expect(notes[0]).toContain('Child branch: worktree-agent-c1')
    expect(notes[0]).toContain('Parent branch: worktree-agent-p1')
    expect(notes[0]).toContain('call integrate_worktrees')
    expect(logs()).toContain('warn: Dev1: worktree-agent-c1 conflict')
    // The conflicted child counts as settled; the parent still waits for c2.
    expect(integrator.worktreeOf('p1')?.status).toBe('waiting-children')
    await integrator.onSubagentFinished('c2')
    expect(roots()).toEqual([`worktree-agent-c1 -> ${P}`, `worktree-agent-c2 -> ${P}`, 'worktree-agent-p1 -> /repo'])
    expect(integrator.worktreeOf('p1')?.status).toBe('merged')
    // The pending child now targets the main checkout at its moved worktree.
    expect(integrator.worktreeOf('c1')).toMatchObject({ status: 'conflict', mergeTarget: 'main', path: '/repo/.claude/worktrees/agent-c1' })

    integrateBy({})
    await integrator.integratePending({ path: '/repo/.claude/worktrees/agent-c1', branch: 'worktree-agent-c1' })
    expect(vi.mocked(integrateWorktree).mock.calls.at(-1)![0]).toBe('/repo')
  })

  it('retries a conflicted child into its parent while the parent is still running', async () => {
    integrateBy({ 'worktree-agent-c1': 'conflict' })
    const { integrator } = nested()
    await integrator.onSubagentFinished('c1')
    integrateBy({})
    const line = await integrator.integratePending({ path: child('c1').path, branch: 'worktree-agent-c1' })
    expect(line).toBe('worktree-agent-c1: worktree-agent-c1 merged')
    expect(vi.mocked(integrateWorktree).mock.calls.at(-1)![0]).toBe(P)
  })

  it('refuses to integrate a branch whose report is still running', async () => {
    const { integrator } = nested()
    const line = await integrator.integratePending({ path: P, branch: 'worktree-agent-p1' })
    expect(line).toBe('worktree-agent-p1: still in progress (active); the harness merges it when its report finishes.')
    expect(integrateWorktree).not.toHaveBeenCalled()
  })

  it('reviews a child against its parent branch before merging into the parent', async () => {
    integrateBy({})
    const { integrator, ctx, statusesOf, logs } = nested(true, { behavior: 'merge' })
    await integrator.onSubagentFinished('c1')
    expect(diffWorktree).toHaveBeenCalledWith(P, 'source-oid', 'target-oid')
    expect(ctx.requestMergeReview).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'c1', agentName: 'Dev1', branch: 'worktree-agent-c1' }))
    expect(statusesOf('c1')).toEqual(['merging', 'review', 'merging', 'merged'])
    expect(logs()).toContain('info: Dev1: waiting for the user to review worktree-agent-c1 before merging into worktree-agent-p1.')
  })

  it('tells the orchestrator when the user holds a child, and the parent still merges', async () => {
    integrateBy({})
    const { integrator, notes, roots } = nested(true, { behavior: 'hold' })
    await integrator.onSubagentFinished('p1')
    await integrator.onSubagentFinished('c1')
    await integrator.onSubagentFinished('c2')
    expect(notes[0]).toContain("chose to hold it instead of merging it into Lead's branch worktree-agent-p1")
    expect(roots()).toEqual([`worktree-agent-c1 -> ${P}`, `worktree-agent-c2 -> ${P}`, 'worktree-agent-p1 -> /repo'])
    // The (reviewed) parent is held too in this fixture, since every review answers "hold".
    expect(integrator.worktreeOf('p1')?.status).toBe('held')
  })

  it('serializes merges into the same worktree', async () => {
    let inFlight = 0
    let maxInFlight = 0
    vi.mocked(integrateWorktree).mockImplementation(async (_root, info) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return { info: { ...info, status: 'merged' }, message: 'ok' }
    })
    const { integrator } = nested()
    await Promise.all([integrator.onSubagentFinished('c1'), integrator.onSubagentFinished('c2')])
    expect(maxInFlight).toBe(1)
    expect(integrateWorktree).toHaveBeenCalledTimes(2)
  })
})
