import { describe, expect, it, vi } from 'vitest'
import type { Proposal, Role } from '@shared/types'
import { PROPOSAL_TOOLS } from '@shared/setup'
import { setupTools, workTools, type HarnessTool } from './harnessTools'
import { fakeCtx, mcpSpec, project, role } from './testHelpers'
import { mergeOrgChart } from '../setup/orgMerge'

const byName = (tools: HarnessTool[], name: string): HarnessTool => {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}

const draft = (name: string, reportsTo: string | null, over: Record<string, unknown> = {}) => ({
  name,
  description: `${name} does things`,
  responsibilities: ['x'],
  prompt: `You are ${name}.`,
  tools: ['Read'],
  canSpawn: false,
  spawnable: [] as string[],
  reportsTo,
  ...over
})

/** Lead (root) -> Engineer, Reviewer -> QA. Every role has a pinned model and tier, positions and grants. */
function chart(): Role[] {
  return [
    role({ id: 'r-lead', slug: 'lead', name: 'Lead', model: 'gw/big', tier: 'deep', canSpawn: true, spawnable: ['r-eng', 'r-rev'], position: { x: 0, y: 0 } }),
    role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', model: 'gw/mid', tier: 'everyday', reportsTo: 'r-lead', mcpServers: ['mcp-1'], position: { x: -300, y: 210 } }),
    role({ id: 'r-rev', slug: 'reviewer', name: 'Reviewer', model: 'gw/mid', tier: 'everyday', reportsTo: 'r-lead', canSpawn: true, spawnable: ['r-qa'], position: { x: 300, y: 210 } }),
    role({ id: 'r-qa', slug: 'qa', name: 'QA', model: 'gw/small', tier: 'fast', reportsTo: 'r-rev', position: { x: 300, y: 420 } })
  ]
}

const revisionProject = (state: 'complete' | 'in_progress' = 'complete') =>
  project({
    roles: chart(),
    setup: { kind: 'existing', state } as never,
    mcpServers: [mcpSpec({ id: 'mcp-1', name: 'github', roles: ['engineer', 'reviewer', 'qa'] })]
  })

async function propose(p: ReturnType<typeof revisionProject>, args: Record<string, unknown>, connection?: unknown) {
  const ctx = fakeCtx({ project: p, ...(connection ? { connection: connection as never } : {}) })
  const text = await byName(setupTools(ctx), PROPOSAL_TOOLS.orgChart).call({ title: 'T', rationale: 'r', ...args })
  const calls = vi.mocked(ctx.requestProposal).mock.calls
  const roles = calls.length ? ((calls[0][0] as { payload: { roles: Role[] } }).payload.roles) : undefined
  return { ctx, text, roles }
}

const proxyConn = { connection: 'litellm', tierModels: {}, models: ['gw/big', 'gw/mid', 'gw/small'] }

describe('propose_org_chart in a revision (setup complete)', () => {
  it('keeps roles it does not mention, with ids, grants, positions and models', async () => {
    const p = revisionProject()
    const { roles, text } = await propose(p, { roles: [draft('Engineer', 'Lead', { slug: 'engineer', prompt: 'Sharper prompt.' })] }, proxyConn)
    expect(text).toMatch(/^APPROVED/)
    expect(roles!.map((r) => r.slug).sort()).toEqual(['engineer', 'lead', 'qa', 'reviewer'])
    const by = (slug: string) => roles!.find((r) => r.slug === slug)!
    expect(by('engineer').prompt).toBe('Sharper prompt.')
    expect(by('engineer')).toMatchObject({ id: 'r-eng', model: 'gw/mid', tier: 'everyday', mcpServers: ['mcp-1'], position: { x: -300, y: 210 } })
    expect(by('lead')).toMatchObject({ id: 'r-lead', model: 'gw/big', tier: 'deep', reportsTo: null })
    expect(by('reviewer')).toMatchObject({ id: 'r-rev', reportsTo: 'r-lead', spawnable: ['r-qa'], position: { x: 300, y: 210 } })
    expect(by('qa')).toMatchObject({ id: 'r-qa', reportsTo: 'r-rev', model: 'gw/small', tier: 'fast' })
    expect(roles!.filter((r) => r.reportsTo === null)).toHaveLength(1)
  })

  it('applying the payload against the project (the applyProposal path) gives the same chart', async () => {
    const p = revisionProject()
    const { roles } = await propose(p, { roles: [draft('Engineer', 'Lead', { slug: 'engineer' }), draft('Security', 'Reviewer')] }, proxyConn)
    const again = mergeOrgChart(p, roles!)
    expect(again.roles).toEqual(roles)
    expect(again.removed).toEqual([])
    expect(again.roles.map((r) => r.id)).toEqual(expect.arrayContaining(['r-lead', 'r-eng', 'r-rev', 'r-qa']))
  })

  it('remove drops the role and its slug leaves the server role lists', async () => {
    const p = revisionProject()
    const { roles } = await propose(p, { roles: [draft('Engineer', 'Lead', { slug: 'engineer' })], remove: ['qa', 'qa'] }, proxyConn)
    expect(roles!.map((r) => r.slug).sort()).toEqual(['engineer', 'lead', 'reviewer'])
    const merged = mergeOrgChart(p, roles!)
    expect(merged.removed).toEqual(['QA'])
    expect(merged.mcpServers![0].roles).toEqual(['engineer', 'reviewer'])
    // The reviewer no longer lists the removed role.
    expect(roles!.find((r) => r.slug === 'reviewer')!.spawnable).toEqual([])
  })

  it('a kept role that reported to a removed role is re-pointed to the root', async () => {
    const p = revisionProject()
    const { roles } = await propose(p, { roles: [draft('Engineer', 'Lead', { slug: 'engineer' })], remove: ['reviewer'] }, proxyConn)
    const by = (slug: string) => roles!.find((r) => r.slug === slug)!
    expect(roles!.some((r) => r.slug === 'reviewer')).toBe(false)
    expect(by('qa').reportsTo).toBe('r-lead')
    expect(by('lead').spawnable).not.toContain('r-rev')
    expect(by('lead').spawnable).toEqual(expect.arrayContaining(['r-eng', 'r-qa']))
  })

  it.each([
    ['an unknown slug', { roles: [draft('Engineer', 'Lead', { slug: 'engineer' })], remove: ['ghost'] }, /not the slug of an existing role/],
    ['a slug a draft also names', { roles: [draft('Engineer', 'Lead', { slug: 'engineer' })], remove: ['engineer'] }, /both in remove and in roles/],
    ['a slug a draft matches by name', { roles: [draft('QA', 'Reviewer')], remove: ['qa'] }, /both in remove and in roles/],
    ['the root, with no new root', { roles: [draft('Engineer', 'Lead', { slug: 'engineer' })], remove: ['lead'] }, /exactly one root/]
  ])('REVISE for %s, and the user is not asked', async (_l, args, re) => {
    const { text, ctx } = await propose(revisionProject(), args, proxyConn)
    expect(text).toMatch(/^REVISE\. The org chart was not shown to the user/)
    expect(text).toMatch(re)
    expect(ctx.requestProposal).not.toHaveBeenCalled()
  })

  it('a new draft may report to an unmentioned kept role by name, and that role may spawn it', async () => {
    const p = revisionProject()
    const { roles } = await propose(p, { roles: [draft('Security', 'reviewer')] }, proxyConn)
    const sec = roles!.find((r) => r.name === 'Security')!
    expect(sec.reportsTo).toBe('r-rev')
    expect(roles!.find((r) => r.slug === 'reviewer')!.spawnable).toEqual(expect.arrayContaining(['r-qa', sec.id]))
    expect(roles!.filter((r) => r.reportsTo === null).map((r) => r.id)).toEqual(['r-lead'])
    expect(roles).toHaveLength(5)
    // The model of a new role on a proxy with no tier mapping falls back to the listed model of the nearest tier,
    // else the chart root's model: never inherit.
    expect(sec.model).not.toBe('inherit')
  })

  it('a draft root with an unmentioned old root: the old root reports to the new one', async () => {
    const p = revisionProject()
    const { roles } = await propose(p, { roles: [draft('Director', null, { spawnable: ['Lead'] })] }, proxyConn)
    const dir = roles!.find((r) => r.name === 'Director')!
    expect(dir.reportsTo).toBeNull()
    expect(roles!.find((r) => r.slug === 'lead')!.reportsTo).toBe(dir.id)
    expect(dir.spawnable).toContain('r-lead')
    expect(roles!.filter((r) => r.reportsTo === null)).toHaveLength(1)
    expect(roles).toHaveLength(5)
  })

  it('omitted model keeps, a different tier changes, inherit keeps', async () => {
    const p = revisionProject()
    const { roles } = await propose(
      p,
      {
        roles: [
          draft('Engineer', 'Lead', { slug: 'engineer', model: 'deep' }),
          draft('Reviewer', 'Lead', { slug: 'reviewer', model: 'inherit' }),
          draft('QA', 'Reviewer', { slug: 'qa' })
        ]
      },
      { connection: 'litellm', tierModels: { deep: 'gw/big', everyday: 'gw/mid' }, models: ['gw/big', 'gw/mid', 'gw/small'] }
    )
    const by = (slug: string) => roles!.find((r) => r.slug === slug)!
    expect(by('engineer')).toMatchObject({ model: 'gw/big', tier: 'deep' })
    expect(by('reviewer')).toMatchObject({ model: 'gw/mid', tier: 'everyday' })
    expect(by('qa')).toMatchObject({ model: 'gw/small', tier: 'fast' })
  })

  it('first-time setup still replaces the chart and ignores remove', async () => {
    const p = revisionProject('in_progress')
    const { roles } = await propose(p, { roles: [draft('Boss', null)], remove: ['ghost'] }, proxyConn)
    expect(roles!.map((r) => r.name)).toEqual(['Boss'])
    const merged = mergeOrgChart(p, roles!)
    expect(merged.removed.sort()).toEqual(['Engineer', 'QA', 'Reviewer'].concat(merged.kept.length ? [] : ['Lead']).sort())
  })

  it('fromTemplate on a revision stays a full replacement', async () => {
    const p = revisionProject()
    const tpl = [role({ id: 't1', slug: 'solo', name: 'Solo', model: 'gw/mid' })]
    const ctx = fakeCtx({ project: p, connection: proxyConn as never, orgTemplate: () => ({ name: 'T', roles: tpl }) } as never)
    await byName(setupTools(ctx), PROPOSAL_TOOLS.orgChart).call({ title: 'T', rationale: 'r', fromTemplate: 'tpl' })
    const roles = ((vi.mocked(ctx.requestProposal).mock.calls[0][0] as unknown) as Extract<Proposal, { kind: 'orgChart' }>).payload.roles
    expect(roles.map((r) => r.name)).toEqual(['Solo'])
  })
})

describe('propose_org_change model keeping (full chart)', () => {
  it('a matched role with no model keeps its model; a new role falls back to the root model on an empty proxy', async () => {
    const p = revisionProject()
    const ctx = fakeCtx({ project: p, connection: { connection: 'litellm', tierModels: {}, models: [] } as never })
    await byName(workTools(ctx), 'propose_org_change').call({
      title: 'T',
      rationale: 'r',
      roles: [draft('Lead', null, { slug: 'lead', model: 'inherit' }), draft('Newcomer', 'Lead', { model: 'everyday' })]
    })
    const roles = (vi.mocked(ctx.requestProposal).mock.calls[0][0] as { payload: { roles: Role[] } }).payload.roles
    expect(roles.find((r) => r.slug === 'lead')).toMatchObject({ id: 'r-lead', model: 'gw/big', tier: 'deep' })
    expect(roles.find((r) => r.name === 'Newcomer')).toMatchObject({ model: 'gw/big', tier: 'deep' })
    // Full-chart semantics: the roles the draft left out are removed.
    expect(roles).toHaveLength(2)
  })
})
