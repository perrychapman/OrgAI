import { describe, expect, it } from 'vitest'
import { buildRolePrompt, reportsText, reviewPolicyText, staffingText, teamSizingText } from './prompts'
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

  it('the team sizing paragraph comes with the required-reports text and never replaces it', () => {
    const strict = prompt('lead', { strictDelegation: true })
    expect(strict).toContain('You must delegate to mgr and wait for their reports before you finish')
    expect(strict).toContain(teamSizingText({ required: true, isolation: false }))
    expect(strict).toContain("start together those that do not need each other's result")
    expect(strict).toContain("start one that needs another's result as soon as that result lands, only handing it over")
    expect(strict).toContain('do not redo their work')
    expect(strict).not.toContain('start them together')
    expect(strict.indexOf('You must delegate to mgr')).toBeLessThan(strict.indexOf('Required reports still go out'))
    // A root whose own role names required reports gets the same.
    const chart = roles.map((r) => (r.slug === 'lead' ? { ...r, requiredReports: ['r-mgr'] } : r))
    const own = buildRolePrompt(chart[0], chart, project({ roles: chart }), flags)
    expect(own).toContain('You must delegate to mgr and wait')
    expect(own).toContain('Required reports still go out')
    // Without obligations the root gets the plain variant; a lead below the root with obligations gets none.
    expect(prompt('lead')).toContain(teamSizingText({ isolation: false }))
    expect(prompt('lead')).not.toContain('Required reports still go out')
    expect(prompt('mgr')).not.toContain('Required reports still go out')
    expect(prompt('mgr')).toContain('You must delegate to policy and evidence')
  })

  it('the staffing paragraph and the review policy never displace or contradict the required-delegation text', () => {
    const chart = roles.map((r) => (r.slug === 'lead' ? { ...r, requiredReports: ['r-mgr'] } : r))
    for (const goal of ['balanced', 'speed', 'cost'] as const) for (const reviewPolicy of ['risk', 'always', 'never'] as const) {
      const root = buildRolePrompt(chart[0], chart, project({ roles: chart, reviewPolicy }), { ...flags, staffingGoal: goal })
      const must = root.indexOf('You must delegate to mgr and wait for their reports before you finish')
      expect(must).toBeGreaterThanOrEqual(0)
      expect(must).toBeLessThan(root.indexOf('Required reports still go out'))
      expect(must).toBeLessThan(root.indexOf(staffingText(goal)))
      // Required reports win over the review policy: the sizing paragraph says so before its review sentence.
      const unless = root.indexOf('Unless your instructions, the brief or required reports say otherwise')
      expect(unless).toBeGreaterThanOrEqual(0)
      expect(unless).toBeLessThan(root.indexOf(reviewPolicyText(reviewPolicy)))
    }
    // Neither text tells the root to skip or replace a report.
    for (const goal of ['balanced', 'speed', 'cost'] as const) expect(staffingText(goal)).not.toMatch(/do it yourself|do the work yourself|skip|instead of/i)
    for (const policy of ['risk', 'always', 'never'] as const) expect(reviewPolicyText(policy)).not.toMatch(/required|skip/i)
    // A lead below the root with required reports gets neither the sizing nor the staffing paragraph.
    expect(prompt('mgr')).not.toContain(staffingText())
  })
})
