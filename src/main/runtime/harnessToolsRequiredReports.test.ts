import { describe, expect, it, vi } from 'vitest'
import type { Role } from '@shared/types'
import { PROPOSAL_TOOLS } from '@shared/setup'
import { mergeTemplateDrafts, setupTools, type HarnessTool } from './harnessTools'
import { fakeCtx, project, role } from './testHelpers'

const tool = (tools: HarnessTool[]): HarnessTool => tools.find((x) => x.name === PROPOSAL_TOOLS.orgChart)!

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

function chart(): Role[] {
  return [
    role({ id: 'r-lead', slug: 'lead', name: 'Lead', model: 'inherit', canSpawn: true, spawnable: ['r-eng', 'r-rev'], requiredReports: ['r-eng', 'r-rev'], position: { x: 0, y: 0 } }),
    role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', model: 'inherit', reportsTo: 'r-lead', position: { x: -300, y: 210 } }),
    role({ id: 'r-rev', slug: 'reviewer', name: 'Reviewer', model: 'inherit', reportsTo: 'r-lead', position: { x: 300, y: 210 } })
  ]
}

async function propose(args: Record<string, unknown>, roles: Role[] = chart()) {
  const ctx = fakeCtx({ project: project({ roles, setup: { kind: 'existing', state: 'complete' } as never }) })
  const text = await tool(setupTools(ctx)).call({ title: 'T', rationale: 'r', ...args })
  const calls = vi.mocked(ctx.requestProposal).mock.calls
  const out = calls.length ? ((calls[0][0] as { payload: { roles: Role[] } }).payload.roles) : undefined
  return { text, roles: out }
}
const lead = (roles: Role[] | undefined) => roles!.find((r) => r.slug === 'lead')!

describe('propose_org_chart requiredReports', () => {
  it('resolves names like spawnable and stores ids', async () => {
    const { text, roles } = await propose({
      roles: [
        draft('Lead', null, { slug: 'lead', canSpawn: true, spawnable: ['Engineer', 'Reviewer'], requiredReports: ['reviewer'] }),
        draft('Engineer', 'Lead', { slug: 'engineer' }),
        draft('Reviewer', 'Lead', { slug: 'reviewer' })
      ]
    })
    expect(text).toMatch(/^APPROVED/)
    expect(lead(roles).requiredReports).toEqual(['r-rev'])
  })

  it('keeps a mentioned role\'s list when the key is absent, and clears it with []', async () => {
    const kept = await propose({ roles: [draft('Lead', null, { slug: 'lead', canSpawn: true, spawnable: ['Engineer', 'Reviewer'] })] })
    expect(lead(kept.roles).requiredReports?.slice().sort()).toEqual(['r-eng', 'r-rev'])
    const cleared = await propose({ roles: [draft('Lead', null, { slug: 'lead', canSpawn: true, spawnable: ['Engineer', 'Reviewer'], requiredReports: [] })] })
    expect(lead(cleared.roles).requiredReports).toBeUndefined()
  })

  it('revision: unmentioned roles keep the list; a removed role leaves it', async () => {
    const same = await propose({ roles: [draft('Engineer', 'Lead', { slug: 'engineer', prompt: 'Sharper.' })] })
    expect(lead(same.roles).requiredReports?.slice().sort()).toEqual(['r-eng', 'r-rev'])
    const removed = await propose({ roles: [draft('Lead', null, { slug: 'lead', canSpawn: true })], remove: ['reviewer'] })
    expect(lead(removed.roles).requiredReports).toEqual(['r-eng'])
  })

  it('drops ids no longer in spawnable when spawnable is rewritten', async () => {
    const { roles } = await propose({
      roles: [draft('Lead', null, { slug: 'lead', canSpawn: true, spawnable: ['Engineer', 'Reviewer'], requiredReports: ['Engineer', 'Nobody'] })]
    })
    expect(lead(roles).requiredReports).toEqual(['r-eng'])
  })

  it('mergeTemplateDrafts maps ids to names', () => {
    const drafts = mergeTemplateDrafts(chart(), [])
    expect(drafts.find((d) => d.name === 'Lead')!.requiredReports).toEqual(['Engineer', 'Reviewer'])
    expect(drafts.find((d) => d.name === 'Engineer')!.requiredReports).toBeUndefined()
  })
})
