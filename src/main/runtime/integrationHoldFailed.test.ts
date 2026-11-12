import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentInstance, WorktreeInfo, WorktreeStatus } from '@shared/types'
import { WorktreeIntegrator } from './integration'
import { fakeCtx } from './testHelpers'
import { commitLeftovers, integrateWorktree } from './worktrees'

vi.mock('./worktrees', () => ({
  prepareRepo: vi.fn(async () => {}),
  findWorktree: vi.fn(async () => null),
  integrateWorktree: vi.fn(),
  diffWorktree: vi.fn(async () => ({ stat: '', patch: '', changedFiles: [] })),
  inspectPending: vi.fn(async () => []),
  commitLeftovers: vi.fn(async () => ({ committed: true })),
  pendingWorktrees: vi.fn(async () => [])
}))

const WT: WorktreeInfo = { path: '/repo/.claude/worktrees/agent-m1', branch: 'worktree-agent-m1', status: 'active' }

function agent(id: string, name: string): AgentInstance {
  return { id, roleId: null, roleSlug: name.toLowerCase(), name, parentId: 'root', spawnToolUseId: null, state: 'done', activity: '', inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: 0 }
}

function setup() {
  const ctx = fakeCtx({})
  const agents = new Map<string, AgentInstance>([['m1', agent('m1', 'Manager')]])
  const statuses: { id: string; status: WorktreeStatus; heldBy?: string }[] = []
  const notes: string[] = []
  const integrator = new WorktreeIntegrator(ctx, {
    agent: (id) => agents.get(id),
    setWorktree: (id, info) => statuses.push({ id, status: info.status, heldBy: info.heldBy }),
    notify: (text) => notes.push(text)
  })
  return { integrator, statuses, notes }
}

beforeEach(() => {
  vi.mocked(integrateWorktree).mockReset()
  vi.mocked(commitLeftovers).mockClear()
})

describe('WorktreeIntegrator.holdFailed (delegation enforcement 5.7)', () => {
  it('holds the branch at once, commits leftovers, merges nothing and tells the orchestrator', async () => {
    const { integrator, statuses, notes } = setup()
    integrator.track('m1', { ...WT })
    const done = integrator.holdFailed('m1', 'evidence never spawned')
    // Set synchronously, before any await.
    expect(integrator.worktreeOf('m1')).toMatchObject({ status: 'held', heldBy: 'delegation' })
    await done
    expect(commitLeftovers).toHaveBeenCalledTimes(1)
    expect(integrateWorktree).not.toHaveBeenCalled()
    expect(statuses[0]).toEqual({ id: 'm1', status: 'held', heldBy: 'delegation' })
    expect(notes.join('\n')).toMatch(/held, not merged: it failed its required delegation \(evidence never spawned\)/)
  })

  it('a later finish does not merge a delegation-held branch', async () => {
    const { integrator } = setup()
    integrator.track('m1', { ...WT })
    await integrator.holdFailed('m1', 'x')
    await integrator.onSubagentFinished('m1')
    expect(integrateWorktree).not.toHaveBeenCalled()
  })

  it('the integrate tool refuses a delegation-held branch', async () => {
    const { integrator } = setup()
    integrator.track('m1', { ...WT })
    await integrator.holdFailed('m1', 'x')
    const out = await integrator.integratePending({ path: WT.path, branch: WT.branch })
    expect(out).toMatch(/held by the harness because Manager failed its required delegation/)
    expect(integrateWorktree).not.toHaveBeenCalled()
  })

  it('unhold makes the branch active again, so the next finish merges it', async () => {
    const { integrator } = setup()
    vi.mocked(integrateWorktree).mockImplementation(async (_root, info) => ({ info: { ...info, status: 'merged' }, message: 'merged' }))
    integrator.track('m1', { ...WT })
    await integrator.holdFailed('m1', 'x')
    integrator.unhold('m1')
    expect(integrator.worktreeOf('m1')?.status).toBe('active')
    expect(integrator.worktreeOf('m1')?.heldBy).toBeUndefined()
    await integrator.onSubagentFinished('m1')
    expect(integrateWorktree).toHaveBeenCalledTimes(1)
  })

  it('does nothing for an untracked agent or a user-held branch', async () => {
    const { integrator } = setup()
    await integrator.holdFailed('nobody', 'x')
    integrator.track('m1', { ...WT, status: 'held' })
    await integrator.holdFailed('m1', 'x')
    integrator.unhold('m1')
    expect(integrator.worktreeOf('m1')).toMatchObject({ status: 'held' })
    expect(integrator.worktreeOf('m1')?.heldBy).toBeUndefined()
  })
})
