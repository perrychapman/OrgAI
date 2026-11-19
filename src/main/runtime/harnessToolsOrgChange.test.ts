import { describe, expect, it, vi } from 'vitest'
import type { ProposalOutcome, Role, RunRosterChange } from '@shared/types'
import { PROPOSAL_TOOLS } from '@shared/setup'
import { workTools, type ConfigChange, type ConfigChangeResult, type HarnessToolHooks } from './harnessTools'
import { fakeCtx, orgChart, project, role } from './testHelpers'

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

/** A four-role project whose roles carry grants; the card payload of one call is what the user would approve. */
function grantedProject() {
  const roles: Role[] = [
    role({ id: 'r-lead', slug: 'lead', name: 'Lead', canSpawn: true, spawnable: ['r-eng', 'r-rev', 'r-doc'], mcpServers: ['mcp-1'], skills: ['sk-1'], position: { x: 5, y: 6 } }),
    role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', tools: ['Read', 'Edit'], reportsTo: 'r-lead', mcpServers: ['mcp-1'], skills: ['sk-1'] }),
    role({ id: 'r-rev', slug: 'reviewer', name: 'Reviewer', reportsTo: 'r-lead', skills: ['sk-1'] }),
    role({ id: 'r-doc', slug: 'writer', name: 'Writer', reportsTo: 'r-lead', mcpServers: ['mcp-1'] })
  ]
  return project({ roles, mcpServers: [{ id: 'mcp-1', name: 'github' } as never], skills: [{ id: 'sk-1', name: 'triage' } as never] })
}

describe('propose_org_change lists only what changes', () => {
  async function propose(args: Record<string, unknown>) {
    const p = grantedProject()
    const before = structuredClone(p.roles)
    const ctx = fakeCtx({ project: p })
    const tool = workTools(ctx).find((t) => t.name === PROPOSAL_TOOLS.orgChange)!
    const text = await tool.call({ title: 'T', rationale: 'r', ...args })
    const req = vi.mocked(ctx.requestProposal).mock.calls[0]?.[0]
    const roles = req ? (req.payload as { roles: Role[] }).roles : undefined
    return { text, roles, before, ctx }
  }

  it('one new role: every existing role is unchanged and the new one is under the root', async () => {
    const { roles, before } = await propose({ roles: [draft('QA', 'Lead')] })
    expect(roles).toHaveLength(5)
    for (const b of before) {
      const now = roles!.find((r) => r.id === b.id)!
      // The root gains the new role as a spawn target; everything else is exactly as it was.
      expect(b.id === 'r-lead' ? { ...now, spawnable: b.spawnable } : now).toEqual(b)
    }
    const qa = roles!.find((r) => r.name === 'QA')!
    expect(qa.reportsTo).toBe('r-lead')
    expect(qa.mcpServers).toBeUndefined()
    expect(qa.skills).toBeUndefined()
    expect(roles!.filter((r) => r.reportsTo === null).map((r) => r.id)).toEqual(['r-lead'])
  })

  it('a new role with reportsTo null goes under the kept root', async () => {
    const { roles } = await propose({ roles: [draft('QA', null)] })
    expect(roles!.find((r) => r.name === 'QA')!.reportsTo).toBe('r-lead')
    expect(roles!.filter((r) => r.reportsTo === null)).toHaveLength(1)
  })

  it('one existing role by slug with a new prompt changes that role only', async () => {
    const { roles, before } = await propose({ roles: [draft('Engineer', 'Lead', { slug: 'engineer', prompt: 'New prompt' })] })
    expect(roles).toHaveLength(4)
    expect(roles!.find((r) => r.id === 'r-eng')).toMatchObject({ prompt: 'New prompt', mcpServers: ['mcp-1'], skills: ['sk-1'] })
    for (const id of ['r-lead', 'r-rev', 'r-doc']) expect(roles!.find((r) => r.id === id)).toMatchObject({ prompt: before.find((b) => b.id === id)!.prompt, slug: before.find((b) => b.id === id)!.slug })
  })

  it('remove drops exactly that role', async () => {
    const { roles } = await propose({ roles: [draft('QA', 'Lead')], remove: ['writer'] })
    expect(roles!.find((r) => r.name === 'QA')).toBeDefined()
    roles!.splice(roles!.findIndex((r) => r.name === 'QA'), 1)
    expect(roles!.map((r) => r.id).sort()).toEqual(['r-eng', 'r-lead', 'r-rev'])
    expect(roles!.find((r) => r.id === 'r-lead')!.spawnable).not.toContain('r-doc')
  })

  it('an unknown remove slug, or a slug both listed and removed, is REVISE and shows no card', async () => {
    const a = await propose({ roles: [], remove: ['ghost'] })
    expect(a.text).toMatch(/^REVISE\./)
    expect(a.ctx.requestProposal).not.toHaveBeenCalled()
    const b = await propose({ roles: [draft('Engineer', 'Lead', { slug: 'engineer' })], remove: ['engineer'] })
    expect(b.text).toMatch(/^REVISE\..*both in remove and in roles/)
    expect(b.ctx.requestProposal).not.toHaveBeenCalled()
  })

  it('the complete chart still gives the same chart with nothing dropped', async () => {
    const { roles, before } = await propose({
      roles: [
        draft('Lead', null, { slug: 'lead', canSpawn: true, spawnable: ['Engineer', 'Reviewer', 'Writer'], prompt: before0('r-lead') }),
        draft('Engineer', 'Lead', { slug: 'engineer', prompt: before0('r-eng') }),
        draft('Reviewer', 'Lead', { slug: 'reviewer', prompt: before0('r-rev') }),
        draft('Writer', 'Lead', { slug: 'writer', prompt: before0('r-doc') })
      ]
    })
    expect(roles!.map((r) => r.id)).toEqual(['r-lead', 'r-eng', 'r-rev', 'r-doc'])
    expect(roles!.find((r) => r.id === 'r-eng')).toMatchObject({ mcpServers: ['mcp-1'], skills: ['sk-1'] })
    expect(before).toHaveLength(4)
  })
})

function before0(id: string): string {
  return grantedProject().roles.find((r) => r.id === id)!.prompt
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
