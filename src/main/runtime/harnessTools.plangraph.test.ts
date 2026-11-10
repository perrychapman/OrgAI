import { describe, expect, it } from 'vitest'
import { PLAN_TOOLS } from './continuation'
import { workTools, type HarnessTool } from './harnessTools'
import { fakeCtx, project } from './testHelpers'

const byName = (tools: HarnessTool[], name: string): HarnessTool => {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}

// The test project's concurrency limit is 3 (testHelpers.project); the root is the lead.
function setup(live = 0, maxConcurrentSubagents = 8) {
  const ctx = fakeCtx({ project: project({ maxConcurrentSubagents }), liveReports: () => live })
  const tools = workTools(ctx)
  return { ctx, set: (args: unknown) => byName(tools, PLAN_TOOLS.set).call(args), update: (args: unknown) => byName(tools, PLAN_TOOLS.update).call(args), tools }
}

const impl = { role: 'engineer' }

describe('plan graph tools', () => {
  it('set_plan round-trips after, paths and staff, cleaned, and shows them in the step line', async () => {
    const { ctx, set } = setup()
    const text = await set({
      goal: 'G',
      steps: [
        { title: 'Spec' },
        { title: 'Write tests', after: ['p1'], paths: [' test/ ', 'test'], staff: { role: ' ENGINEER ', tier: 'everyday', effort: 'medium' } },
        { title: 'Build', after: ['p1'], staff: { role: 'engineer' } }
      ]
    })
    expect(text).toContain('p2 Write tests (after p1; engineer, everyday / medium)')
    expect(text).toContain('p3 Build (after p1; engineer)')
    expect(ctx.getPlan()!.steps).toEqual([
      { id: 'p1', title: 'Spec', status: 'pending' },
      { id: 'p2', title: 'Write tests', status: 'pending', after: ['p1'], paths: ['test/', 'test'], staff: { role: 'engineer', tier: 'everyday', effort: 'medium' } },
      { id: 'p3', title: 'Build', status: 'pending', after: ['p1'], staff: { role: 'engineer' } }
    ])
  })

  it('stores the slug for a role written by name or in another case; an unknown role drops staff and lists the roles', async () => {
    const { ctx, set } = setup()
    const text = await set({ goal: 'G', steps: [{ title: 'A', staff: { role: 'Reviewer' } }, { title: 'B', staff: { role: ' ENGINEER ', tier: 'deep' } }, { title: 'C', staff: { role: 'coder' } }] })
    expect(ctx.getPlan()!.steps.map((s) => s.staff)).toEqual([{ role: 'reviewer' }, { role: 'engineer', tier: 'deep' }, undefined])
    expect(text).toContain('p3 staff role "coder" matches no role (roles: lead, engineer, reviewer); staff dropped.')
    expect(text).toContain('Ready now: p1 (reviewer), p2 (engineer).')
  })

  it('a bad tier or effort is refused by validation, naming the field and the allowed values', async () => {
    const { set } = setup()
    const err = await set({ goal: 'G', steps: [{ title: 'A', staff: { role: 'engineer', tier: 'huge' } }] }).catch((e: Error) => e.message)
    expect(err).toContain('"staff"')
    expect(err).toContain('"tier"')
    for (const v of ['fast', 'everyday', 'deep', 'top']) expect(err).toContain(v)
    const err2 = await set({ goal: 'G', steps: [{ title: 'A', staff: { role: 'engineer', effort: 'extreme' } }] }).catch((e: Error) => e.message)
    expect(err2).toContain('"effort"')
    expect(err2).toContain('xhigh')
  })

  it('reports an after entry past the 16 cap as more than 16', async () => {
    const { set } = setup()
    const steps = Array.from({ length: 20 }, (_, i) => ({ title: `s${i}` }))
    steps.push({ title: 'join', after: Array.from({ length: 20 }, (_, i) => `p${i + 1}`) } as never)
    const text = await set({ goal: 'G', steps })
    expect(text).toContain('p21 after p17 (more than 16), p21 after p18 (more than 16), p21 after p19 (more than 16), p21 after p20 (more than 16)')
  })

  it('reports dropped after entries (unknown id, itself, cycle) and stores the cleaned plan', async () => {
    const { ctx, set } = setup()
    const text = await set({ goal: 'G', steps: [{ title: 'A', after: ['p2'] }, { title: 'B', after: ['p1', 'p9'] }, { title: 'C', after: ['p3'] }] })
    expect(text).toContain('Dropped: p1 after p2 (cycle), p2 after p9 (no such step), p3 after p3 (itself).')
    expect(ctx.getPlan()!.steps.map((s) => s.after)).toEqual([undefined, ['p1'], undefined])
  })

  it('update_plan add takes the fields, ids continue, and a step update sets, replaces and clears them', async () => {
    const { ctx, set, update } = setup()
    await set({ goal: 'G', steps: [{ title: 'A' }, { title: 'B' }] })
    const text = await update({
      steps: [{ id: 'p2', after: ['p1'], paths: ['src'], staff: { role: 'reviewer', effort: 'high' } }],
      add: [{ title: 'C', after: ['p2', 'p7'], staff: impl }]
    })
    expect(text).toContain('Updated: p2 updated, p3 added.')
    expect(text).toContain('Dropped: p3 after p7 (no such step).')
    expect(ctx.getPlan()!.steps[1]).toEqual({ id: 'p2', title: 'B', status: 'pending', after: ['p1'], paths: ['src'], staff: { role: 'reviewer', effort: 'high' } })
    expect(ctx.getPlan()!.steps[2]).toMatchObject({ id: 'p3', after: ['p2'], staff: impl })
    await update({ steps: [{ id: 'p2', status: 'done', after: [], paths: [] }] })
    expect(ctx.getPlan()!.steps[1]).toEqual({ id: 'p2', title: 'B', status: 'done', staff: { role: 'reviewer', effort: 'high' } })
  })

  it('mark_blocked and complete_plan keep the new step fields', async () => {
    const { ctx, set, tools } = setup()
    await set({ goal: 'G', steps: [{ title: 'A' }, { title: 'B', after: ['p1'], paths: ['x'], staff: impl }] })
    await byName(tools, PLAN_TOOLS.blocked).call({ reason: 'why' })
    expect(ctx.getPlan()!.steps[1]).toMatchObject({ after: ['p1'], paths: ['x'], staff: impl })
    await byName(tools, PLAN_TOOLS.complete).call({ summary: 'done' })
    expect(ctx.getPlan()!.steps[1]).toMatchObject({ after: ['p1'], paths: ['x'], staff: impl })
  })

  describe('ready lines', () => {
    it('no line when nothing staffed is ready', async () => {
      const { set } = setup()
      const text = await set({ goal: 'G', steps: [{ title: 'A' }, { title: 'B', after: ['p1'], staff: impl }] })
      expect(text).not.toContain('Ready now')
    })

    it('one step: just its name', async () => {
      const { set } = setup()
      const text = await set({ goal: 'G', steps: [{ title: 'A', staff: impl }, { title: 'B', after: ['p1'], staff: impl }] })
      expect(text.endsWith(' Ready now: p1 (engineer).')).toBe(true)
    })

    it('several steps ready at once', async () => {
      const { set, update } = setup(2)
      await set({ goal: 'G', steps: [{ title: 'A' }, { title: 'B', after: ['p1'], staff: impl }, { title: 'C', after: ['p1'], staff: impl }, { title: 'D', after: ['p1'], staff: { role: 'reviewer' } }] })
      const text = await update({ steps: [{ id: 'p1', status: 'done' }] })
      expect(text.endsWith(' Ready now: p2 (engineer), p3 (engineer), p4 (reviewer). 6 of 8 agent slots are free. Start them in one message: calls in one message run together.')).toBe(true)
    })

    it('more ready than free slots: how many fit now', async () => {
      const { set } = setup(6)
      const text = await set({ goal: 'G', steps: [{ title: 'A', staff: impl }, { title: 'B', staff: impl }, { title: 'C', staff: impl }] })
      expect(text.endsWith(' Ready now: p1 (engineer), p2 (engineer), p3 (engineer). 2 of 8 agent slots are free, so only 2 fit now. Start those in one message: calls in one message run together.')).toBe(true)
    })

    it('steps without staff and steps naming the caller own role are not listed', async () => {
      const { set } = setup()
      const text = await set({ goal: 'G', steps: [{ title: 'own work' }, { title: 'lead work', staff: { role: 'lead' } }, { title: 'Lead again', staff: { role: 'Lead' } }, { title: 'review', staff: { role: 'reviewer' } }] })
      expect(text.endsWith(' Ready now: p4 (reviewer).')).toBe(true)
    })

    it('an overlap is warned about and the later step is not ready', async () => {
      const { set } = setup()
      const text = await set({ goal: 'G', steps: [{ title: 'A', paths: ['src/api'], staff: impl }, { title: 'B', paths: ['src/api/x.ts'], staff: impl }] })
      expect(text).toContain('p1 and p2 both change src/api; p2 waits for p1. Give them separate paths to run them together. Ready now: p1 (engineer).')
    })

    it('a missing liveReports counts as none running', async () => {
      const ctx = fakeCtx({ project: project({ maxConcurrentSubagents: 8 }) })
      const text = await byName(workTools(ctx), PLAN_TOOLS.set).call({ goal: 'G', steps: [{ title: 'A', staff: impl }, { title: 'B', staff: impl }] })
      expect(text).toContain('8 of 8 agent slots are free.')
    })
  })

  describe('a step with a report bound to it', () => {
    const bind = (ctx: ReturnType<typeof setup>['ctx'], ...stepIds: string[]) => ctx.updateStaffing({ goal: 'balanced', assignments: stepIds.map((stepId) => ({ roleId: 'r', model: 'sonnet', source: 'role' as const, at: 1, stepId })) })
    const statuses = (ctx: ReturnType<typeof setup>['ctx']) => ctx.getPlan()!.steps.map((s) => s.status)

    it('update_plan pending keeps a bound in_progress step; done, blocked and skipped win; an unbound one goes back to pending', async () => {
      const { ctx, set, update } = setup()
      await set({ goal: 'G', steps: [{ title: 'A', staff: impl }, { title: 'B', staff: impl }, { title: 'C', staff: impl }] })
      await update({ steps: [{ id: 'p1', status: 'in_progress' }, { id: 'p2', status: 'in_progress' }, { id: 'p3', status: 'in_progress' }] })
      expect(statuses(ctx)).toEqual(['in_progress', 'in_progress', 'in_progress'])
      await bind(ctx, 'p1', 'p2')
      const text = await update({ steps: [{ id: 'p1', status: 'pending' }, { id: 'p3', status: 'pending' }] })
      expect(statuses(ctx)).toEqual(['in_progress', 'in_progress', 'pending'])
      expect(text).toContain('p1 kept in_progress')
      expect(text).toContain('Ready now: p3')
      expect(text).not.toMatch(/Ready now:[^.]*p1/)
      await update({ steps: [{ id: 'p1', status: 'done' }, { id: 'p2', status: 'blocked' }] })
      expect(statuses(ctx)).toEqual(['done', 'blocked', 'pending'])
    })

    it('set_plan keeps a bound in_progress step with the same id and title, not a changed one', async () => {
      const { ctx, set, update } = setup()
      await set({ goal: 'G', steps: [{ title: 'A', staff: impl }, { title: 'B', staff: impl }] })
      await update({ steps: [{ id: 'p1', status: 'in_progress' }, { id: 'p2', status: 'in_progress' }] })
      await bind(ctx, 'p1', 'p2')
      const text = await set({ goal: 'G2', steps: [{ title: 'A', staff: impl }, { title: 'Other', staff: impl }] })
      expect(statuses(ctx)).toEqual(['in_progress', 'pending'])
      expect(text).toContain('Ready now: p2')
      expect(text).not.toMatch(/Ready now:[^.]*p1/)
    })
  })
})
