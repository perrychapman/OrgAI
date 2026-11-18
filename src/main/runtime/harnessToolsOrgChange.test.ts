import { describe, expect, it, vi } from 'vitest'
import type { ProposalOutcome, Role, RunRosterChange } from '@shared/types'
import { PROPOSAL_TOOLS } from '@shared/setup'
import { workTools, type ConfigChange, type ConfigChangeResult, type HarnessToolHooks } from './harnessTools'
import { fakeCtx, orgChart, role } from './testHelpers'

vi.mock('./worktrees', () => ({ pendingWorktrees: vi.fn(async () => []) }))

/** propose_org_change after approval: the text says exactly what this run can use (2026-11-18). */

const draft = (name: string, reportsTo: string | null, extra: Record<string, unknown> = {}) => ({
  name,
  description: `${name} does things`,
  responsibilities: ['x'],
  prompt: `You are ${name}.`,
  tools: ['Read'],
  model: 'sonnet',
  canSpawn: false,
  spawnable: [],
  reportsTo,
  ...extra
})

/**
 * A work-run ctx whose approval behaves like RunManager: ctx.roles changes in place (QA added, reviewer removed) and the
 * outcome carries the roster.
 */
function rig(roster: RunRosterChange | undefined, hooks: HarnessToolHooks = {}) {
  const roles: Role[] = orgChart()
  const retired: Role[] = []
  const ctx = fakeCtx({
    roles,
    retiredRoles: () => retired,
    requestProposal: vi.fn(async (): Promise<ProposalOutcome> => {
      if (roster) {
        roles.push(role({ id: 'r-qa', slug: 'qa', name: 'QA', reportsTo: 'r-lead' }))
        retired.push(...roles.splice(2, 1))
        roles[0].prompt = 'new'
      }
      return { behavior: 'approve', ...(roster ? { roster } : {}) }
    })
  })
  const tool = workTools(ctx, hooks).find((t) => t.name === PROPOSAL_TOOLS.orgChange)!
  const call = (): Promise<string> =>
    tool.call({ title: 'T', rationale: 'r', roles: [draft('Lead', null, { slug: 'lead', canSpawn: true, spawnable: ['Engineer', 'QA'] }), draft('Engineer', 'Lead', { slug: 'engineer' }), draft('QA', 'Lead')] })
  return { ctx, call }
}

const applied: RunRosterChange = { added: ['r-qa'], changed: ['r-lead'], removed: ['r-rev'], deferred: [{ id: 'r-far', name: 'Far', reason: 'It would run on OpenAI; it applies from the next run.' }] }

describe('propose_org_change result texts', () => {
  it('available now: names the roles to delegate to, what changed, the deferred ones; the hook gets the ids', async () => {
    const configChanged = vi.fn(async (_c: ConfigChange): Promise<ConfigChangeResult> => ({ availability: 'now' }))
    const text = await rig(applied, { configChanged }).call()
    expect(configChanged).toHaveBeenCalledTimes(1)
    expect(configChanged.mock.calls[0][0]).toEqual({ roles: { added: ['r-qa'], changed: ['r-lead'], removed: ['r-rev'] } })
    expect(text).toMatch(/^APPROVED\. The org chart was saved\. In this run: added QA; changed Lead; removed Reviewer \(no new agents of these; running ones finish as they started\)\./)
    // The root is not a role to delegate to.
    expect(text).toContain('Available now: you can delegate to QA in this run.')
    expect(text).toContain('Not in this run (from the next run): Far: It would run on OpenAI; it applies from the next run.')
    expect(text).toContain('an org change never grants')
  })

  it('after idle: says it takes effect once the agents are idle and the session restarts', async () => {
    const configChanged = vi.fn(async (): Promise<ConfigChangeResult> => ({ availability: 'after-idle' }))
    const text = await rig(applied, { configChanged }).call()
    expect(text).toContain('It takes effect once the agents are idle and the session restarts; the harness will message you.')
    expect(text).not.toContain('Available now')
  })

  it('no hook or a rejection: applies from the next run', async () => {
    expect(await rig(applied).call()).toContain('This session was not updated; the change applies from the next run.')
    const configChanged = vi.fn(async (): Promise<ConfigChangeResult> => {
      throw new Error('cannot')
    })
    expect(await rig(applied, { configChanged }).call()).toContain('Bringing this session in line failed (cannot); the change applies from the next run.')
  })

  it('no roster (the session does not take roster changes): saved for the next run, the hook is not called', async () => {
    const configChanged = vi.fn(async (): Promise<ConfigChangeResult> => ({ availability: 'now' }))
    const text = await rig(undefined, { configChanged }).call()
    expect(text).toMatch(/^APPROVED\. The org chart was saved\. It applies from the next run; this session keeps its current roles\./)
    expect(configChanged).not.toHaveBeenCalled()
  })

  it('an empty roster: nothing changed in this run, the hook is not called', async () => {
    const configChanged = vi.fn(async (): Promise<ConfigChangeResult> => ({ availability: 'now' }))
    const text = await rig({ added: [], changed: [], removed: [], deferred: [] }, { configChanged }).call()
    expect(text).toContain("Nothing in this run's roles changed.")
    expect(configChanged).not.toHaveBeenCalled()
  })
})
