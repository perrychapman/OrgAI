import { describe, expect, it } from 'vitest'
import type { Project, Role } from '@shared/types'
import { roleModelSentence, roleModelSentenceFor } from './roleModelSentence'

const role = (p: Partial<Role> = {}): Role =>
  ({ id: 'r1', slug: 'r1', name: 'R1', description: '', responsibilities: [], prompt: '', tools: [], canSpawn: false, spawnable: [], reportsTo: 'root', color: '#fff', model: 'sonnet', tier: 'everyday', ...p }) as Role
const root = role({ id: 'root', name: 'Orchestrator', reportsTo: null, model: 'opus', tier: 'deep' })
const project = (roles: Role[], p: Partial<Project> = {}): Project => ({ id: 'p', roles, ...p }) as Project
const tiers = { top: 'opus-big', deep: 'opus', everyday: 'sonnet', fast: 'haiku' }

describe('roleModelSentence', () => {
  it('auto with an effort', () => {
    expect(roleModelSentence({ choice: 'everyday', model: 'sonnet', mode: 'auto', effort: 'high' })).toBe('Runs on Standard (sonnet). OrgAI chooses how much effort per task, up to high.')
  })
  it('auto without an effort', () => {
    expect(roleModelSentence({ choice: 'deep', model: 'opus', mode: 'auto' })).toBe('Runs on Advanced (opus). OrgAI chooses how much effort per task.')
  })
  it('fixed with and without an effort', () => {
    expect(roleModelSentence({ choice: 'top', model: 'big', mode: 'fixed', effort: 'max' })).toBe('Always runs on Most capable (big) at max effort.')
    expect(roleModelSentence({ choice: 'fast', model: 'haiku', mode: 'fixed' })).toBe('Always runs on Fast (haiku).')
  })
  it('leaves the parentheses out when the model is not known', () => {
    expect(roleModelSentence({ choice: 'fast', mode: 'fixed' })).toBe('Always runs on Fast.')
    expect(roleModelSentence({ choice: 'fast', mode: 'auto', effort: 'low' })).toBe('Runs on Fast. OrgAI chooses how much effort per task, up to low.')
  })
  it('an exact model has no tier word', () => {
    expect(roleModelSentence({ choice: 'custom', model: 'gpt-x', mode: 'fixed', effort: 'low' })).toBe('Always runs on gpt-x at low effort.')
  })
  it('inherit names the manager, or the connection default for the root', () => {
    expect(roleModelSentence({ choice: 'inherit', managerName: 'Lead', mode: 'auto' })).toBe('Uses the same model as Lead.')
    expect(roleModelSentence({ choice: 'inherit', isRoot: true, mode: 'fixed' })).toBe("Uses the connection's default model.")
  })
  it('says where a pinned role runs', () => {
    expect(roleModelSentence({ choice: 'fast', model: 'haiku', mode: 'fixed', pinnedTo: 'Gateway' })).toBe('Always runs on Fast (haiku). It runs on Gateway.')
  })
})

describe('roleModelSentenceFor', () => {
  it('a tier role is automatic and goes up to its own effort', () => {
    const r = role({ effort: 'medium' })
    expect(roleModelSentenceFor(project([root, r]), r, tiers)).toBe('Runs on Standard (sonnet). OrgAI chooses how much effort per task, up to medium.')
  })
  it('a staffing cap wins over the role effort', () => {
    const r = role({ effort: 'high', staffing: { mode: 'auto', maxEffort: 'low' } })
    expect(roleModelSentenceFor(project([root, r]), r, tiers)).toContain('up to low.')
  })
  it('a fixed role and a fixed project read as always', () => {
    const r = role({ effort: 'high', staffing: { mode: 'fixed' } })
    expect(roleModelSentenceFor(project([root, r]), r, tiers)).toBe('Always runs on Standard (sonnet) at high effort.')
    const plain = role()
    expect(roleModelSentenceFor(project([root, plain], { staffing: 'fixed' }), plain, tiers)).toBe('Always runs on Standard (sonnet).')
  })
  it('the root is always fixed', () => {
    expect(roleModelSentenceFor(project([root]), { ...root, effort: 'high' }, tiers)).toBe('Always runs on Advanced (opus) at high effort.')
  })
  it('an inheriting role names its manager', () => {
    const r = role({ model: 'inherit', tier: undefined })
    expect(roleModelSentenceFor(project([root, r]), r, tiers)).toBe('Uses the same model as Orchestrator.')
  })
  it('an exact model that is no tier is fixed and shows the id', () => {
    const r = role({ model: 'gpt-x', tier: undefined, effort: 'low' })
    expect(roleModelSentenceFor(project([root, r]), r, tiers)).toBe('Always runs on gpt-x at low effort.')
  })
  it('without tier models the tier word stands alone', () => {
    const r = role()
    expect(roleModelSentenceFor(project([root, r]), r, {})).toMatch(/^Runs on /)
  })
})
