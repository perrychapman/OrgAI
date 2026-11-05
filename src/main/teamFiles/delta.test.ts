import { describe, expect, it } from 'vitest'
import { applyTeamDelta, sameTeam } from './delta'
import { normalizeDoc } from './digest'
import { sampleDoc } from './doc.fixture'

describe('applyTeamDelta', () => {
  it('keeps a pending tools change in base when the save only edited the prompt', () => {
    const before = sampleDoc()
    const base = structuredClone(before)
    base.roles.find((r) => r.slug === 'reviewer')!.tools.push('Bash')
    const after = structuredClone(before)
    after.roles.find((r) => r.slug === 'reviewer')!.prompt = 'New prompt.'
    const merged = applyTeamDelta(base, before, after)
    const r = merged.roles.find((x) => x.slug === 'reviewer')!
    expect(r.prompt).toBe('New prompt.')
    expect(r.tools).toContain('Bash')
  })

  it('keeps a pulled change on another field', () => {
    const before = sampleDoc()
    const base = structuredClone(before)
    base.roles.find((r) => r.slug === 'dev')!.description = 'Pulled description'
    base.settings.brief = 'Pulled brief'
    const after = structuredClone(before)
    after.roles.find((r) => r.slug === 'dev')!.name = 'Renamed'
    after.settings.maxBudgetUsd = 9
    const merged = applyTeamDelta(base, before, after)
    const dev = merged.roles.find((r) => r.slug === 'dev')!
    expect(dev.name).toBe('Renamed')
    expect(dev.description).toBe('Pulled description')
    expect(merged.settings.brief).toBe('Pulled brief')
    expect(merged.settings.maxBudgetUsd).toBe(9)
  })

  it('takes the save when it changes the same field', () => {
    const before = sampleDoc()
    const base = structuredClone(before)
    base.roles.find((r) => r.slug === 'dev')!.description = 'Pulled'
    const after = structuredClone(before)
    after.roles.find((r) => r.slug === 'dev')!.description = 'Saved'
    expect(applyTeamDelta(base, before, after).roles.find((r) => r.slug === 'dev')!.description).toBe('Saved')
  })

  it('adds items added in the save, removes items removed in it and keeps items only in base', () => {
    const before = sampleDoc()
    const base = structuredClone(before)
    base.skills.push({ name: 'pulled-skill', description: 'p', body: 'b', files: [], enabled: true })
    base.mcp.push({ name: 'pulled-server', transport: 'http', url: 'https://p.example', enabled: true })
    const after = structuredClone(before)
    after.roles.push({ ...after.roles[1], slug: 'tester', name: 'Tester' })
    after.roles = after.roles.filter((r) => r.slug !== 'reviewer')
    after.skills = after.skills.filter((s) => s.name !== 'old-skill')
    after.mcp = after.mcp.filter((m) => m.name !== 'wiki')
    const merged = applyTeamDelta(base, before, after)
    expect(merged.roles.map((r) => r.slug)).toEqual(['dev', 'lead', 'tester'])
    expect(merged.skills.map((s) => s.name)).toEqual(['code-style', 'pulled-skill'])
    expect(merged.mcp.map((m) => m.name)).toEqual(['docs', 'pulled-server'])
  })

  it('compares skills as a whole', () => {
    const before = sampleDoc()
    const base = structuredClone(before)
    base.skills[0].body = 'Base body'
    const after = structuredClone(before)
    after.skills[0].files = []
    const merged = applyTeamDelta(base, before, after)
    expect(merged.skills[0].body).toBe(after.skills[0].body)
    expect(merged.skills[0].files).toEqual([])
  })

  it('clears a field the save removed and does not mutate the inputs', () => {
    const before = sampleDoc()
    const base = structuredClone(before)
    const after = structuredClone(before)
    delete after.settings.maxBudgetUsd
    const snapshot = structuredClone({ base, before, after })
    const merged = applyTeamDelta(base, before, after)
    expect('maxBudgetUsd' in merged.settings).toBe(false)
    expect({ base, before, after }).toEqual(snapshot)
  })

  it('returns the base unchanged for an empty delta', () => {
    const d = sampleDoc()
    expect(applyTeamDelta(d, d, d)).toEqual(normalizeDoc(d))
  })
})

describe('sameTeam', () => {
  it('compares by digest', () => {
    const a = sampleDoc()
    const b = structuredClone(a)
    b.roles.reverse()
    expect(sameTeam(a, b)).toBe(true)
    b.roles[0].prompt += 'x'
    expect(sameTeam(a, b)).toBe(false)
  })
})
