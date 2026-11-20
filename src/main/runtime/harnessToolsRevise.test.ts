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
    ['the root, with no new root', { roles: [draft('Engineer', 'QA', { slug: 'engineer' })], remove: ['lead'] }, /exactly one root/],
    ['a reference to a removed role', { roles: [draft('Engineer', 'Lead', { slug: 'engineer' })], remove: ['lead'] }, /removed roles do not count\): Engineer reportsTo "Lead"/],
    ['a manager that matches no role', { roles: [draft('Security', 'Ghost Team')] }, /Security reportsTo "Ghost Team"/],
    ['a new role missing fields', { roles: [{ name: 'Security', tools: ['Read'], reportsTo: 'Lead' }] }, /role "Security" is missing description, responsibilities, prompt, canSpawn, spawnable/],
    ['an unknown slug that is not the slug of its name', { roles: [draft('Security', 'Lead', { slug: 'sec-old' })] }, /no existing role with slug "sec-old"/]
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

  it('a new draft with no manager while the old root is unmentioned goes under the old root (never takes over)', async () => {
    const p = revisionProject()
    const { roles } = await propose(p, { roles: [draft('Director', null)] }, proxyConn)
    const dir = roles!.find((r) => r.name === 'Director')!
    expect(dir.reportsTo).toBe('r-lead')
    expect(roles!.find((r) => r.slug === 'lead')!.reportsTo).toBeNull()
    expect(roles!.find((r) => r.slug === 'lead')!.spawnable).toContain(dir.id)
    expect(roles!.filter((r) => r.reportsTo === null).map((r) => r.id)).toEqual(['r-lead'])
    expect(roles).toHaveLength(5)
  })

  it('moving the root: the old root is listed under the new draft root', async () => {
    const p = revisionProject()
    const { roles } = await propose(p, { roles: [draft('Director', null, { spawnable: ['Lead'] }), draft('Lead', 'Director', { slug: 'lead' })] }, proxyConn)
    const dir = roles!.find((r) => r.name === 'Director')!
    expect(dir.reportsTo).toBeNull()
    expect(roles!.find((r) => r.slug === 'lead')!).toMatchObject({ id: 'r-lead', reportsTo: dir.id })
    expect(dir.spawnable).toContain('r-lead')
    expect(roles!.filter((r) => r.reportsTo === null)).toHaveLength(1)
    expect(roles).toHaveLength(5)
  })

  it('REVISE when a listed role is placed under one of its own kept descendants (review M1)', async () => {
    const { text, ctx } = await propose(revisionProject(), { roles: [draft('Boss', null), draft('Lead', 'QA', { slug: 'lead' })] }, proxyConn)
    expect(text).toMatch(/^REVISE\. The org chart was not shown to the user: the reporting lines of .*form a loop/)
    expect(ctx.requestProposal).not.toHaveBeenCalled()
  })

  it('a new draft asking canSpawn false keeps it false under a kept manager (review M2)', async () => {
    const { roles } = await propose(revisionProject(), { roles: [draft('Alpha', 'Lead'), draft('Beta', 'Lead')] }, proxyConn)
    expect(roles!.find((r) => r.name === 'Alpha')).toMatchObject({ canSpawn: false, spawnable: [], reportsTo: 'r-lead' })
    expect(roles!.find((r) => r.name === 'Beta')).toMatchObject({ canSpawn: false, spawnable: [], reportsTo: 'r-lead' })
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
    // The roles the draft left out are kept (only `remove` drops a role).
    expect(roles).toHaveLength(p.roles.length + 1)
  })
})

describe('revision patches (a listed existing slug changes only the fields given)', () => {
  const rich = () => {
    const p = revisionProject()
    const eng = p.roles.find((r) => r.slug === 'engineer')!
    Object.assign(eng, { description: 'Builds features.', responsibilities: ['Write code', 'Report files'], prompt: 'You are the Engineer. Long prompt.', tools: ['Read', 'Edit'] })
    return p
  }

  it('a patch changing only tools keeps prompt, description, responsibilities, model, id, grants and position', async () => {
    const p = rich()
    const { roles, text } = await propose(p, { roles: [{ slug: 'engineer', tools: ['Read', 'Edit', 'Bash'] }] }, proxyConn)
    expect(text).toMatch(/^APPROVED/)
    const eng = roles!.find((r) => r.slug === 'engineer')!
    expect(eng).toMatchObject({
      id: 'r-eng',
      name: 'Engineer',
      tools: ['Read', 'Edit', 'Bash'],
      prompt: 'You are the Engineer. Long prompt.',
      description: 'Builds features.',
      responsibilities: ['Write code', 'Report files'],
      model: 'gw/mid',
      tier: 'everyday',
      reportsTo: 'r-lead',
      mcpServers: ['mcp-1'],
      position: { x: -300, y: 210 }
    })
    // The card payload is the full merged chart: every other role unchanged.
    expect(roles!.find((r) => r.slug === 'reviewer')).toMatchObject({ id: 'r-rev', spawnable: ['r-qa'], reportsTo: 'r-lead' })
    expect(roles).toHaveLength(4)
  })

  it('a patch never grants: grant fields on the draft are ignored', async () => {
    const p = rich()
    const { roles } = await propose(p, { roles: [{ slug: 'qa', tools: ['Read'], mcpServers: ['mcp-1'], skills: ['s'] }] }, proxyConn)
    const qa = roles!.find((r) => r.slug === 'qa')!
    expect(qa.mcpServers).toBeUndefined()
    expect(qa.skills).toBeUndefined()
  })

  it('a new role under a manager works without restating the manager, who may then spawn it', async () => {
    const p = rich()
    const { roles, text } = await propose(p, { roles: [draft('Security', 'reviewer')] }, proxyConn)
    expect(text).toMatch(/^APPROVED/)
    const sec = roles!.find((r) => r.name === 'Security')!
    const rev = roles!.find((r) => r.slug === 'reviewer')!
    expect(sec.reportsTo).toBe('r-rev')
    expect(rev.spawnable).toEqual(expect.arrayContaining(['r-qa', sec.id]))
    expect(rev.prompt).toBe('You are reviewer.')
  })

  it('a patch giving only spawnable on a manager resolves slugs and keeps the rest', async () => {
    const p = rich()
    const { roles } = await propose(p, { roles: [{ slug: 'lead', spawnable: ['engineer', 'reviewer', 'qa'] }] }, proxyConn)
    const lead = roles!.find((r) => r.slug === 'lead')!
    expect(lead).toMatchObject({ id: 'r-lead', reportsTo: null, model: 'gw/big', prompt: 'You are lead.' })
    expect(lead.spawnable.slice().sort()).toEqual(['r-eng', 'r-qa', 'r-rev'])
    expect(roles!.filter((r) => r.reportsTo === null).map((r) => r.id)).toEqual(['r-lead'])
  })

  it('a listed root patch stays the root ahead of a new draft that also says reportsTo null', async () => {
    const p = rich()
    const { roles } = await propose(p, { roles: [draft('Helper', null), { slug: 'lead', prompt: 'You are the lead, sharper.' }] }, proxyConn)
    expect(roles!.filter((r) => r.reportsTo === null).map((r) => r.id)).toEqual(['r-lead'])
    expect(roles!.find((r) => r.name === 'Helper')!.reportsTo).toBe('r-lead')
  })

  it('propose_org_change takes the same patch', async () => {
    const p = rich()
    const ctx = fakeCtx({ project: p, connection: proxyConn as never })
    const text = await byName(workTools(ctx), 'propose_org_change').call({ title: 'T', rationale: 'r', roles: [{ slug: 'engineer', tools: ['Read'] }] })
    expect(text).toMatch(/^APPROVED/)
    const roles = (vi.mocked(ctx.requestProposal).mock.calls[0][0] as { payload: { roles: Role[] } }).payload.roles
    expect(roles.find((r) => r.slug === 'engineer')).toMatchObject({ id: 'r-eng', tools: ['Read'], prompt: 'You are the Engineer. Long prompt.', mcpServers: ['mcp-1'] })
  })
})

describe('first-time setup drafts', () => {
  const first = () => revisionProject('in_progress')

  it('a role missing a required field is a REVISE, even with an existing slug', async () => {
    const { text, ctx } = await propose(first(), { roles: [draft('Lead', null, { slug: 'lead' }), { slug: 'engineer', tools: ['Read'] }] }, proxyConn)
    expect(text).toMatch(/^REVISE\. The org chart was not shown to the user: role "engineer" is missing name, description, responsibilities, prompt, canSpawn, spawnable, reportsTo\. In first-time setup every role needs every field\./)
    expect(ctx.requestProposal).not.toHaveBeenCalled()
  })

  it('references resolve by slug as well as name, and an unknown slug is a new role', async () => {
    const { roles, text } = await propose(
      first(),
      {
        roles: [
          draft('Orchestrator', null, { slug: 'orchestrator', canSpawn: true, spawnable: ['backend-implementer'] }),
          draft('Backend Implementer', 'orchestrator', { slug: 'backend-implementer' }),
          draft('Backend Tester', 'Backend Implementer')
        ]
      },
      proxyConn
    )
    expect(text).toMatch(/^APPROVED/)
    const by = (n: string) => roles!.find((r) => r.name === n)!
    expect(by('Orchestrator').reportsTo).toBeNull()
    expect(by('Backend Implementer').reportsTo).toBe(by('Orchestrator').id)
    expect(by('Backend Tester').reportsTo).toBe(by('Backend Implementer').id)
    expect(by('Orchestrator').spawnable).toContain(by('Backend Implementer').id)
    expect(roles).toHaveLength(3)
  })

  it('a reference that matches no draft is a REVISE naming it, not a silent re-parent', async () => {
    const { text } = await propose(first(), { roles: [draft('Lead', null), draft('Dev', 'Platform Lead', { spawnable: ['Ghost'] })] }, proxyConn)
    expect(text).toMatch(/Dev reportsTo "Platform Lead"; Dev spawnable "Ghost"/)
    expect(text).toMatch(/match no role in the proposal/)
  })
})
