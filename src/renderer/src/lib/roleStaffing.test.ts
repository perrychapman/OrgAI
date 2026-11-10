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
  roleStaffingControls,
  roleStaffingLine,
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
    expect(roleStaffingLine(role({ effort: 'medium' }), project(), false)).toEqual({ text: 'Automatic, up to Deep / medium' })
  })
  it('automatic without an effort says it goes up to high', () => {
    const l = roleStaffingLine(role(), project(), false)
    expect(l.text).toBe('Automatic, up to Deep / high')
    expect(l.note).toMatch(/up to high/)
  })
  it('automatic with an effort cap', () => {
    expect(roleStaffingLine(role({ effort: 'xhigh', staffing: { mode: 'auto', maxEffort: 'medium' } }), project(), false).text).toBe('Automatic, up to Deep / medium')
  })
  it('automatic with a floor', () => {
    expect(roleStaffingLine(role({ effort: 'high', staffing: { mode: 'auto', minTier: 'fast' } }), project(), false).text).toBe('Automatic, from Fast up to Deep / high')
  })
  it('fixed', () => {
    expect(roleStaffingLine(role({ effort: 'high', staffing: { mode: 'fixed' } }), project(), false)).toEqual({ text: 'Always Deep / high' })
    const none = roleStaffingLine(role({ staffing: { mode: 'fixed' } }), project(), false)
    expect(none.text).toBe('Always Deep / default effort')
    expect(none.note).toMatch(/default/)
  })
  it('a fixed project makes every role fixed', () => {
    expect(roleStaffingLine(role({ effort: 'low' }), project({ staffing: 'fixed' }), false).text).toBe('Always Deep / low')
  })
  it('an exact model with no tier is fixed', () => {
    expect(roleStaffingLine(role({ model: 'gpt-x', tier: undefined, effort: 'low' }), project(), false).text).toBe('Always gpt-x / low')
  })
  it('inherit follows the agent that started it', () => {
    expect(roleStaffingLine(role({ model: 'inherit', tier: undefined, effort: 'low' }), project(), false).text).toBe('Automatic, up to the tier of the agent that started it / low')
    expect(roleStaffingLine(role({ model: 'inherit', tier: undefined, effort: 'low', staffing: { mode: 'fixed' } }), project(), false).text).toBe('Always the model of the agent that started it / low')
  })
  it('the root always runs as configured', () => {
    expect(roleStaffingLine(role({ reportsTo: null, effort: 'high' }), project(), true).text).toBe('Always Deep / high')
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
    expect(roleStaffingControls(role(), project(), 'claude').modeOptions[0].label).toBe('Follow the project (Automatic)')
    expect(roleStaffingControls(role(), project({ staffing: 'fixed' }), 'claude').modeOptions[0].label).toBe('Follow the project (Always as configured)')
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
    expect(importedRoleSpend({ model: 'opus', tier: 'deep', effort: 'high' }, {}, false)?.text).toBe('Automatic, up to Deep / high')
    expect(importedRoleSpend(undefined, {}, false)).toBeNull()
  })
  it('kit roles show a line only when the preview carries a model', () => {
    expect(kitRoleSpend({ name: 'x', slug: 'x', prompt: '', elevatedTools: [] }, {})).toBeNull()
    expect(kitRoleSpend({ model: 'haiku', tier: 'fast', effort: 'low', staffing: { mode: 'fixed' }, reportsTo: 'a' }, {})?.text).toBe('Always Fast / low')
  })
})
