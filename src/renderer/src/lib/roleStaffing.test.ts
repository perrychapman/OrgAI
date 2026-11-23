import { describe, expect, it } from 'vitest'
import type { Project, Role } from '@shared/types'
import {
  PROJECT_REVIEW_OPTIONS,
  importedRoleSpend,
  isFixedByNature,
  kitRoleSpend,
  maxEffortChoices,
  minTierChoices,
  projectStaffingPatch,
  projectStaffingView,
  CONCURRENCY_MAX,
  canRequireReview,
  concurrencyText,
  isRequiredByManager,
  roleConcurrency,
  roleKnowledgeWrite,
  roleStaffingControls,
  roleStaffingLine,
  withConcurrency,
  withKnowledgeWrite,
  withMaxEffort,
  withMinTier,
  withStaffingMode
} from './roleStaffing'

const role = (p: Partial<Role> = {}): Role =>
  ({ id: 'r1', slug: 'r1', name: 'R1', description: '', responsibilities: [], prompt: '', tools: [], canSpawn: false, spawnable: [], reportsTo: 'root', color: '#fff', model: 'sonnet', tier: 'deep', ...p }) as Role
const root = role({ id: 'root', reportsTo: null })
const project = (p: Partial<Project> = {}): Project => ({ id: 'p', roles: [root, role()], ...p }) as Project

describe('roleStaffingLine', () => {
  it('automatic with an effort', () => {
    expect(roleStaffingLine(role({ effort: 'medium' }), project(), false)).toEqual({ text: 'Automatic, up to Advanced / medium' })
  })
  it('automatic without an effort says it goes up to high', () => {
    const l = roleStaffingLine(role(), project(), false)
    expect(l.text).toBe('Automatic, up to Advanced / high')
    expect(l.note).toMatch(/up to high/)
  })
  it('automatic with an effort cap', () => {
    expect(roleStaffingLine(role({ effort: 'xhigh', staffing: { mode: 'auto', maxEffort: 'medium' } }), project(), false).text).toBe('Automatic, up to Advanced / medium')
  })
  it('automatic with a floor', () => {
    expect(roleStaffingLine(role({ effort: 'high', staffing: { mode: 'auto', minTier: 'fast' } }), project(), false).text).toBe('Automatic, from Fast up to Advanced / high')
  })
  it('fixed', () => {
    expect(roleStaffingLine(role({ effort: 'high', staffing: { mode: 'fixed' } }), project(), false)).toEqual({ text: 'Always Advanced / high' })
    const none = roleStaffingLine(role({ staffing: { mode: 'fixed' } }), project(), false)
    expect(none.text).toBe('Always Advanced / default effort')
    expect(none.note).toMatch(/default/)
  })
  it('a fixed project makes every role fixed', () => {
    expect(roleStaffingLine(role({ effort: 'low' }), project({ staffing: 'fixed' }), false).text).toBe('Always Advanced / low')
  })
  it('an exact model with no tier is fixed', () => {
    expect(roleStaffingLine(role({ model: 'gpt-x', tier: undefined, effort: 'low' }), project(), false).text).toBe('Always gpt-x / low')
  })
  it('inherit follows the agent that started it', () => {
    expect(roleStaffingLine(role({ model: 'inherit', tier: undefined, effort: 'low' }), project(), false).text).toBe('Automatic, up to the tier of the agent that started it / low')
    expect(roleStaffingLine(role({ model: 'inherit', tier: undefined, effort: 'low', staffing: { mode: 'fixed' } }), project(), false).text).toBe('Always the model of the agent that started it / low')
  })
  it('the root always runs as configured', () => {
    expect(roleStaffingLine(role({ reportsTo: null, effort: 'high' }), project(), true).text).toBe('Always Advanced / high')
  })
})

describe('controls', () => {
  it('offers only tiers at or below the role tier', () => {
    expect(minTierChoices(role({ tier: 'everyday', model: 'sonnet' }))).toEqual(['fast', 'everyday'])
    expect(minTierChoices(role({ tier: 'fast', model: 'haiku' }))).toEqual(['fast'])
    expect(minTierChoices(role({ model: 'inherit', tier: undefined }))).toHaveLength(4)
  })
  it('offers only efforts the adapter supports', () => {
    expect(maxEffortChoices('codex')).toEqual(['low', 'medium', 'high'])
    expect(maxEffortChoices('claude')).toContain('max')
  })
  it('root has no controls, exact model has no automatic', () => {
    expect(roleStaffingControls(root, project(), 'claude').kind).toBe('root')
    const exact = role({ model: 'gpt-x', tier: undefined })
    expect(isFixedByNature(exact)).toBe(true)
    const c = roleStaffingControls(exact, project(), 'claude')
    expect(c.kind).toBe('exact')
    expect(c.explanation).toMatch(/exact model/)
    expect(c.showBounds).toBe(false)
  })
  it('an exact-model role explicitly set to automatic is editable again', () => {
    const r = role({ model: 'gpt-x', tier: undefined, staffing: { mode: 'auto' } })
    expect(isFixedByNature(r)).toBe(false)
    expect(roleStaffingControls(r, project(), 'claude').kind).toBe('editable')
  })
  it('bounds show only while automatic', () => {
    expect(roleStaffingControls(role(), project(), 'claude').showBounds).toBe(true)
    expect(roleStaffingControls(role({ staffing: { mode: 'fixed' } }), project(), 'claude').showBounds).toBe(false)
    expect(roleStaffingControls(role(), project({ staffing: 'fixed' }), 'claude').showBounds).toBe(false)
  })
  it('inherit says it follows the starter', () => {
    expect(roleStaffingControls(role({ model: 'inherit', tier: undefined }), project(), 'claude').explanation).toMatch(/started it/)
  })
  it('mode default names the project mode', () => {
    expect(roleStaffingControls(role(), project(), 'claude').modeOptions[0].label).toBe('Same as the project (chosen per task)')
    expect(roleStaffingControls(role(), project({ staffing: 'fixed' }), 'claude').modeOptions[0].label).toBe('Same as the project (always this model)')
  })
  it('uses the plain labels for the floor, the cap and the notes', () => {
    const c = roleStaffingControls(role(), project(), 'claude')
    expect(c.modeOptions.map((o) => o.label)).toEqual(['Same as the project (chosen per task)', 'Chosen per task', 'Always this model'])
    expect(c.minTierOptions[0].label).toBe('Any model')
    expect(c.maxEffortOptions[0].label).toBe('Up to high (default)')
    expect(roleStaffingControls(role({ effort: 'low' }), project(), 'claude').maxEffortOptions[0].label).toBe("This role's effort (low)")
    expect(roleStaffingControls(role(), project({ staffing: 'fixed' }), 'claude').explanation).toBe('This project always uses the configured model, so this role does not change per task.')
    expect(roleStaffingLine(role(), project(), false).note).toBe('No effort is set, so OrgAI may use up to high effort.')
  })
  it('keeps an unsupported stored cap visible', () => {
    const c = roleStaffingControls(role({ staffing: { mode: 'auto', maxEffort: 'max' } }), project(), 'codex', 'OpenAI')
    expect(c.maxEffort).toBe('max')
    expect(c.maxEffortOptions.at(-1)?.label).toBe('max (not used on OpenAI)')
  })
})

describe('writes', () => {
  it('the default mode clears the field', () => {
    expect(withStaffingMode({ staffing: { mode: 'auto', minTier: 'fast' } }, 'default')).toBeUndefined()
  })
  it('fixed drops bounds, automatic keeps them', () => {
    expect(withStaffingMode({ staffing: { mode: 'auto', minTier: 'fast', maxEffort: 'low' } }, 'fixed')).toEqual({ mode: 'fixed' })
    expect(withStaffingMode({ staffing: { mode: 'auto', minTier: 'fast', maxEffort: 'low' } }, 'auto')).toEqual({ mode: 'auto', minTier: 'fast', maxEffort: 'low' })
  })
  it('floor and cap set and clear', () => {
    expect(withMinTier({}, 'fast')).toEqual({ mode: 'auto', minTier: 'fast' })
    expect(withMinTier({ staffing: { mode: 'auto', minTier: 'fast', maxEffort: 'low' } }, '')).toEqual({ mode: 'auto', maxEffort: 'low' })
    expect(withMaxEffort({ staffing: { mode: 'auto', minTier: 'fast' } }, 'medium')).toEqual({ mode: 'auto', minTier: 'fast', maxEffort: 'medium' })
    expect(withMaxEffort({ staffing: { mode: 'auto', maxEffort: 'low' } }, '')).toEqual({ mode: 'auto' })
  })
})

describe('project settings', () => {
  it('shows defaults when unset', () => {
    expect(projectStaffingView({})).toEqual({ staffing: 'auto', goal: 'balanced', review: 'risk' })
    expect(projectStaffingView({ staffing: 'fixed', staffingGoal: 'cost', reviewPolicy: 'never' })).toEqual({ staffing: 'fixed', goal: 'cost', review: 'never' })
  })
  it('choosing the default clears the field', () => {
    expect(projectStaffingPatch('staffing', 'auto')).toEqual({ staffing: undefined })
    expect(projectStaffingPatch('staffingGoal', 'balanced')).toEqual({ staffingGoal: undefined })
    expect(projectStaffingPatch('reviewPolicy', 'risk')).toEqual({ reviewPolicy: undefined })
  })
  it('other choices are written', () => {
    expect(projectStaffingPatch('staffing', 'fixed')).toEqual({ staffing: 'fixed' })
    expect(projectStaffingPatch('staffingGoal', 'speed')).toEqual({ staffingGoal: 'speed' })
    expect(projectStaffingPatch('reviewPolicy', 'always')).toEqual({ reviewPolicy: 'always' })
    expect(PROJECT_REVIEW_OPTIONS.map((o) => o.value)).toEqual(['risk', 'always', 'never'])
  })
})

describe('import and kit lines', () => {
  it('shows what an imported role may spend', () => {
    expect(importedRoleSpend({ model: 'opus', tier: 'deep', effort: 'high' }, {}, false)?.text).toBe('Automatic, up to Advanced / high')
    expect(importedRoleSpend(undefined, {}, false)).toBeNull()
  })
  it('kit roles show a line only when the preview carries a model', () => {
    expect(kitRoleSpend({ name: 'x', slug: 'x', prompt: '', elevatedTools: [] }, {})).toBeNull()
    expect(kitRoleSpend({ model: 'haiku', tier: 'fast', effort: 'low', staffing: { mode: 'fixed' }, reportsTo: 'a' }, {})?.text).toBe('Always Fast / low')
  })
})

describe('count, knowledge and required review', () => {
  it('reads and clamps the count', () => {
    expect(roleConcurrency(role())).toBeUndefined()
    expect(roleConcurrency({ maxConcurrent: 4 })).toBe(4)
    expect(roleConcurrency({ maxConcurrent: 99 })).toBe(CONCURRENCY_MAX)
    expect(roleConcurrency({ maxConcurrent: 0 })).toBe(1)
    expect(withConcurrency(20)).toEqual({ maxConcurrent: 8 })
    expect(withConcurrency(undefined)).toEqual({ maxConcurrent: undefined })
    expect(concurrencyText(undefined)).toBe('No limit of its own')
    expect(concurrencyText(1)).toBe('One at a time')
    expect(concurrencyText(3)).toBe('Up to 3')
  })
  it('reads the knowledge flag (missing means it may write)', () => {
    expect(roleKnowledgeWrite(role())).toBe(true)
    expect(roleKnowledgeWrite({ knowledgeWrite: false })).toBe(false)
    expect(withKnowledgeWrite(true)).toEqual({ knowledgeWrite: undefined })
    expect(withKnowledgeWrite(false)).toEqual({ knowledgeWrite: false })
  })
  it('offers required review only when the manager can hand it work', () => {
    const lead = role({ id: 'lead', reportsTo: 'root', canSpawn: true, spawnable: ['r1'], requiredReports: ['r1'] })
    const r1 = role({ id: 'r1', reportsTo: 'lead' })
    const roles = [root, lead, r1]
    expect(canRequireReview(roles, r1)).toBe(true)
    expect(isRequiredByManager(roles, r1)).toBe(true)
    expect(canRequireReview(roles, root)).toBe(false)
    expect(canRequireReview([root, { ...lead, canSpawn: false }, r1], r1)).toBe(false)
    expect(canRequireReview([root, { ...lead, spawnable: [] }, r1], r1)).toBe(false)
    expect(isRequiredByManager([root, { ...lead, requiredReports: undefined }, r1], r1)).toBe(false)
  })
})
