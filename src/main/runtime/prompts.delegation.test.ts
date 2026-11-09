import { describe, expect, it } from 'vitest'
import { buildRolePrompt, reportsText } from './prompts'
import { project, role } from './testHelpers'

const roles = [
  role({ id: 'r-lead', slug: 'lead', name: 'Lead', canSpawn: true, spawnable: ['r-mgr'] }),
  role({ id: 'r-mgr', slug: 'mgr', name: 'Manager', canSpawn: true, spawnable: ['r-pol', 'r-evi'], reportsTo: 'r-lead', requiredReports: ['r-pol', 'r-evi'] }),
  role({ id: 'r-pol', slug: 'policy', reportsTo: 'r-mgr' }),
  role({ id: 'r-evi', slug: 'evidence', reportsTo: 'r-mgr' })
]
const flags = { isSetup: false, isolation: false }
const prompt = (slug: string, over: Partial<typeof flags & { strictDelegation: boolean }> = {}): string =>
  buildRolePrompt(roles.find((r) => r.slug === slug)!, roles, project({ roles }), { ...flags, ...over })

describe('required delegation prompts', () => {
  it('a role with requiredReports must delegate to them', () => {
    expect(prompt('mgr')).toContain(
      "You must delegate to policy and evidence and wait for their reports before you finish; the harness checks the run's record and will not accept your report without them."
    )
  })

  it('every lead with reports learns to trust the receipt', () => {
    for (const slug of ['lead', 'mgr']) expect(prompt(slug)).toContain("trust the receipt over the report's own account")
  })

  it('a lead without obligations gets no "must delegate" line, a report gets neither', () => {
    expect(prompt('lead')).not.toContain('You must delegate')
    expect(prompt('policy')).not.toContain('You must delegate')
    expect(prompt('policy')).not.toContain('harness receipt')
  })

  it('strictDelegation requires every spawnable report of every role that can spawn', () => {
    expect(prompt('lead', { strictDelegation: true })).toContain('You must delegate to mgr and wait')
    expect(prompt('lead')).not.toContain('You must delegate')
  })

  it('reportsText names the required slugs only when given', () => {
    expect(reportsText([roles[1]])).not.toContain('You must delegate')
    expect(reportsText([roles[1]], [], 'delegate_agent', ['mgr'])).toContain('You must delegate to mgr and wait')
  })
})
