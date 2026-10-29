import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Proposal } from '@shared/types'
import { PROPOSAL_TOOLS } from '@shared/setup'
import { INTEGRATE_TOOL, answerText, isBlockingHarnessTool, setupTools, workTools, type HarnessTool } from './harnessTools'
import { PLAN_TOOLS } from './continuation'
import { fakeCtx, project } from './testHelpers'
import { pendingWorktrees } from './worktrees'

vi.mock('./worktrees', () => ({ pendingWorktrees: vi.fn(async () => []) }))

const byName = (tools: HarnessTool[], name: string): HarnessTool => {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}

const archArgs = {
  title: 'Arch',
  summary: 'S',
  stack: ['TS'],
  modules: [{ name: 'core', purpose: 'p', paths: ['src'] }],
  conventions: [],
  commands: [{ name: 'test', command: 'npm test' }],
  risks: []
}

const draftRole = (name: string, reportsTo: string | null, spawnable: string[] = []) => ({
  name,
  description: `${name} does things`,
  responsibilities: ['x'],
  prompt: `You are ${name}.`,
  tools: ['Read', 'Edit', 'NotATool'],
  model: 'sonnet',
  canSpawn: spawnable.length > 0,
  spawnable,
  reportsTo
})

describe('setupTools', () => {
  it('lists the proposal tools by bare name', () => {
    const names = setupTools(fakeCtx()).map((t) => t.name)
    // propose_org_change belongs to work runs, not setup.
    const setupNames = Object.values(PROPOSAL_TOOLS).filter((n) => n !== PROPOSAL_TOOLS.orgChange)
    expect(names.sort()).toEqual(setupNames.sort())
    expect(names).not.toContain(INTEGRATE_TOOL)
    expect(names).not.toContain(PROPOSAL_TOOLS.orgChange)
  })

  it('propose_architecture returns APPROVED and sends the payload without the title', async () => {
    const ctx = fakeCtx()
    const onDecided = vi.fn()
    const text = await byName(setupTools(ctx, { onDecided }), PROPOSAL_TOOLS.architecture).call(archArgs)
    expect(text).toMatch(/^APPROVED\. The architecture was saved/)
    expect(onDecided).toHaveBeenCalledOnce()
    const req = vi.mocked(ctx.requestProposal).mock.calls[0][0] as Omit<Extract<Proposal, { kind: 'architecture' }>, 'id' | 'runId' | 'createdAt'>
    expect(req.kind).toBe('architecture')
    expect(req.agentId).toBe('root')
    expect(req.title).toBe('Arch')
    expect(req.payload).not.toHaveProperty('title')
    expect(req.payload.stack).toEqual(['TS'])
  })

  it('returns REVISE with the user feedback', async () => {
    const ctx = fakeCtx({ requestProposal: vi.fn(async () => ({ behavior: 'revise' as const, feedback: 'Use Rust' })) })
    const text = await byName(setupTools(ctx), PROPOSAL_TOOLS.settings).call({ title: 'S', rationale: 'r', brief: 'b' })
    expect(text).toBe('REVISE. The user asked for changes:\nUse Rust')
  })

  it('rejects arguments that do not match the schema', async () => {
    const ctx = fakeCtx()
    await expect(byName(setupTools(ctx), PROPOSAL_TOOLS.architecture).call({ title: 'x' })).rejects.toThrow()
    await expect(byName(setupTools(ctx), PROPOSAL_TOOLS.settings).call({ title: 'S', rationale: 'r', brief: 'b', maxSubagentDepth: 9 })).rejects.toThrow()
    expect(ctx.requestProposal).not.toHaveBeenCalled()
  })

  it('propose_settings accepts every permission mode, the new limits and allow rules', async () => {
    const ctx = fakeCtx()
    const tool = byName(setupTools(ctx), PROPOSAL_TOOLS.settings)
    for (const permissionMode of ['auto', 'acceptEdits', 'default', 'dontAsk', 'plan', 'bypassPermissions']) {
      await tool.call({ title: 'S', rationale: 'r', brief: 'b', permissionMode })
    }
    await expect(tool.call({ title: 'S', rationale: 'r', brief: 'b', permissionMode: 'yolo' })).rejects.toThrow()
    await expect(tool.call({ title: 'S', rationale: 'r', brief: 'b', maxConcurrentSubagents: 33 })).rejects.toThrow()
    await tool.call({ title: 'S', rationale: 'r', brief: 'b', maxConcurrentSubagents: 32, maxSubagentDepth: 5, allowRules: ['Bash(npm:*)'] })
    const calls = vi.mocked(ctx.requestProposal).mock.calls
    const last = calls[calls.length - 1][0] as Omit<Extract<Proposal, { kind: 'settings' }>, 'id' | 'runId' | 'createdAt'>
    expect(last.payload).toMatchObject({ maxConcurrentSubagents: 32, maxSubagentDepth: 5, allowRules: ['Bash(npm:*)'] })
    expect(calls).toHaveLength(7)
  })

  it('propose_org_chart converts drafts to roles before proposing', async () => {
    const ctx = fakeCtx()
    const text = await byName(setupTools(ctx), PROPOSAL_TOOLS.orgChart).call({
      title: 'Chart',
      rationale: 'Because',
      roles: [draftRole('Lead', null, ['Dev']), draftRole('Dev', 'Lead')]
    })
    expect(text).toMatch(/^APPROVED\. The org chart was applied/)
    const req = vi.mocked(ctx.requestProposal).mock.calls[0][0] as Omit<Extract<Proposal, { kind: 'orgChart' }>, 'id' | 'runId' | 'createdAt'>
    expect(req.kind).toBe('orgChart')
    expect(req.payload.rationale).toBe('Because')
    const [lead, dev] = req.payload.roles
    expect(lead.slug).toBe('lead')
    expect(lead.reportsTo).toBeNull()
    expect(lead.spawnable).toEqual([dev.id])
    expect(dev.reportsTo).toBe(lead.id)
    expect(dev.tools).toEqual(['Read', 'Edit'])
  })

  it('propose_org_chart answers REVISE without asking the user when the chart is invalid', async () => {
    const ctx = fakeCtx()
    const text = await byName(setupTools(ctx), PROPOSAL_TOOLS.orgChart).call({ title: 'Chart', rationale: 'r', roles: [] })
    expect(text).toMatch(/^REVISE\. The org chart could not be validated: /)
    expect(ctx.requestProposal).not.toHaveBeenCalled()
  })

  it('ask_user forwards defaults and formats the answer', async () => {
    const ctx = fakeCtx({ requestQuestion: vi.fn(async () => ({ selected: ['B'], text: ' keep it small ' })) })
    const text = await byName(setupTools(ctx), PROPOSAL_TOOLS.question).call({ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] })
    expect(text).toBe('B\nNote from the user: keep it small')
    expect(ctx.requestQuestion).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'root', allowMultiple: false, allowFreeText: true }))
  })

  it('answerText covers empty and text-only answers', () => {
    expect(answerText({ selected: [] })).toMatch(/did not answer/)
    expect(answerText({ selected: [], text: 'other' })).toBe('other')
    expect(answerText({ selected: ['A', 'B'] })).toBe('A, B')
  })

  it('complete_setup marks setup complete and mentions scaffolding for new projects', async () => {
    const fresh = fakeCtx({ project: project({ setup: { kind: 'new', state: 'in_progress' } }) })
    const t1 = await byName(setupTools(fresh), PROPOSAL_TOOLS.complete).call({ summary: 'Done' })
    expect(fresh.completeSetup).toHaveBeenCalledWith('Done')
    expect(t1).toContain('Scaffold the project')

    const existing = fakeCtx({ project: project({ setup: { kind: 'existing', state: 'in_progress' } }) })
    const t2 = await byName(setupTools(existing), PROPOSAL_TOOLS.complete).call({ summary: 'Done' })
    expect(t2).toBe('Setup is marked complete. Give the user a brief closing message.')
  })
})

describe('workTools', () => {
  beforeEach(() => vi.mocked(pendingWorktrees).mockReset())

  it('integrate_worktrees reports when nothing is waiting', async () => {
    vi.mocked(pendingWorktrees).mockResolvedValue([])
    const integratePending = vi.fn()
    const text = await byName(workTools(fakeCtx(), { integratePending }), INTEGRATE_TOOL).call({})
    expect(text).toBe('No report branches are waiting.')
    expect(integratePending).not.toHaveBeenCalled()
  })

  it('integrate_worktrees merges each waiting branch through the hook', async () => {
    vi.mocked(pendingWorktrees).mockResolvedValue([
      { path: '/repo/.claude/worktrees/agent-a', branch: 'worktree-agent-a' },
      { path: '/repo/.claude/worktrees/agent-b', branch: 'worktree-agent-b' }
    ])
    const integratePending = vi.fn(async (wt: { branch: string }) => `${wt.branch}: merged`)
    const ctx = fakeCtx()
    const text = await byName(workTools(ctx, { integratePending }), INTEGRATE_TOOL).call(undefined)
    expect(pendingWorktrees).toHaveBeenCalledWith('/repo')
    expect(text).toBe('worktree-agent-a: merged\nworktree-agent-b: merged')
  })
})

describe('plan tools', () => {
  it('work runs get the plan tools and ask_user; only the plan and merge tools are non-blocking', () => {
    const names = workTools(fakeCtx()).map((t) => t.name)
    expect(names).toEqual(['set_plan', 'update_plan', 'complete_plan', 'mark_blocked', 'ask_user', 'integrate_worktrees', 'propose_org_change'])
    expect(names.filter((n) => !isBlockingHarnessTool(n))).toEqual(['set_plan', 'update_plan', 'complete_plan', 'mark_blocked', 'integrate_worktrees'])
    expect(setupTools(fakeCtx()).map((t) => t.name)).not.toContain('set_plan')
  })

  it('set_plan numbers the steps, keeps the continue count and lists the ids', async () => {
    const ctx = fakeCtx()
    const onPlanUpdated = vi.fn()
    const tools = workTools(ctx, { onPlanUpdated })
    const text = await byName(tools, PLAN_TOOLS.set).call({ goal: ' Add search ', steps: [{ title: 'Read' }, { title: 'Build', owner: 'engineer' }, { title: 'Verify' }] })
    expect(text).toContain('Plan saved with 3 steps: p1 Read; p2 Build [engineer]; p3 Verify.')
    expect(text).toContain('Start on p1 now.')
    const plan = ctx.getPlan()!
    expect(plan).toMatchObject({ goal: 'Add search', status: 'active', autoContinues: 0 })
    expect(plan.steps).toEqual([
      { id: 'p1', title: 'Read', status: 'pending' },
      { id: 'p2', title: 'Build', status: 'pending', owner: 'engineer' },
      { id: 'p3', title: 'Verify', status: 'pending' }
    ])
    expect(onPlanUpdated).toHaveBeenCalledWith(plan)
    await ctx.updatePlan({ ...plan, autoContinues: 5 })
    await byName(tools, PLAN_TOOLS.set).call({ goal: 'Again', steps: [{ title: 'Only' }] })
    expect(ctx.getPlan()).toMatchObject({ goal: 'Again', autoContinues: 5 })
    await expect(byName(tools, PLAN_TOOLS.set).call({ goal: 'x', steps: [] })).rejects.toThrow()
  })

  it('update_plan patches statuses and notes, appends steps and flags unknown ids', async () => {
    const ctx = fakeCtx()
    const tools = workTools(ctx)
    expect(await byName(tools, PLAN_TOOLS.update).call({ steps: [{ id: 'p1', status: 'done' }] })).toContain('There is no plan yet')
    await byName(tools, PLAN_TOOLS.set).call({ goal: 'G', steps: [{ title: 'A' }, { title: 'B' }] })
    const text = await byName(tools, PLAN_TOOLS.update).call({
      steps: [
        { id: 'p1', status: 'done', note: 'did it' },
        { id: 'p2', status: 'in_progress' },
        { id: 'p9', status: 'done' }
      ],
      add: [{ title: 'C' }]
    })
    expect(text).toContain('Updated: p1 done, p2 in_progress, p3 added.')
    expect(text).toContain('Unknown step ids: p9. The plan has p1, p2.')
    expect(text).toContain('Progress: 1 of 3 done. Remaining: p2 B (in_progress); p3 C (pending).')
    expect(ctx.getPlan()!.steps).toEqual([
      { id: 'p1', title: 'A', status: 'done', note: 'did it' },
      { id: 'p2', title: 'B', status: 'in_progress' },
      { id: 'p3', title: 'C', status: 'pending' }
    ])
  })

  it('mark_blocked stops the plan and update_plan reactivates it; complete_plan finishes it', async () => {
    const ctx = fakeCtx()
    const tools = workTools(ctx)
    await byName(tools, PLAN_TOOLS.set).call({ goal: 'G', steps: [{ title: 'A' }, { title: 'B' }] })
    expect(await byName(tools, PLAN_TOOLS.blocked).call({ reason: 'Which database?' })).toContain('call update_plan to resume the plan')
    expect(ctx.getPlan()).toMatchObject({ status: 'blocked', blockedReason: 'Which database?' })
    const resumed = await byName(tools, PLAN_TOOLS.update).call({ steps: [{ id: 'p1', status: 'done' }] })
    expect(resumed).toContain('The plan is active again.')
    expect(ctx.getPlan()?.status).toBe('active')
    expect(ctx.getPlan()?.blockedReason).toBeUndefined()
    const done = await byName(tools, PLAN_TOOLS.complete).call({ summary: 'All done' })
    expect(done).toContain('Plan marked complete. Give the user your final report now.')
    expect(done).toContain('Note: p2 was not marked done')
    expect(ctx.getPlan()).toMatchObject({ status: 'done', summary: 'All done' })
  })

  it('mark_blocked without a plan still records the reason', async () => {
    const ctx = fakeCtx()
    await byName(workTools(ctx), PLAN_TOOLS.blocked).call({ reason: 'Need credentials' })
    expect(ctx.getPlan()).toMatchObject({ goal: 'Do it', steps: [], status: 'blocked', blockedReason: 'Need credentials' })
    expect(await byName(workTools(fakeCtx()), PLAN_TOOLS.complete).call({ summary: 's' })).toContain('There is no plan to complete')
  })
})
