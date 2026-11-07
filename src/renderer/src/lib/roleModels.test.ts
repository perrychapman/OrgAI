import { describe, expect, it } from 'vitest'
import type { ProviderModel } from '@shared/types'
import { applyExactModel, applyModelChoice, effortView, exactModelGroups, exactModelValue, roleChipLabel, roleModelChoice, roleModelSummary, tierOptionLabel } from './roleModels'

const tiers = { top: 'fable', deep: 'opus', everyday: 'sonnet', fast: 'haiku' }
const m = (id: string, family: ProviderModel['family']): ProviderModel => ({ id, family, connection: 'litellm' }) as ProviderModel

describe('role model choice', () => {
  it('labels tiers with the model they resolve to', () => {
    expect(tierOptionLabel('everyday', tiers)).toBe('Everyday (sonnet)')
    expect(tierOptionLabel('top', {})).toBe('Top')
  })
  it('reads inherit, a tier and custom', () => {
    expect(roleModelChoice({ model: 'inherit' }, tiers)).toBe('inherit')
    expect(roleModelChoice({ model: 'sonnet', tier: 'everyday' }, tiers)).toBe('everyday')
    expect(roleModelChoice({ model: 'opus' }, tiers)).toBe('deep')
    expect(roleModelChoice({ model: 'gpt-x', tier: 'everyday' }, tiers)).toBe('custom')
  })
  it('summarises without a concrete id', () => {
    expect(roleModelSummary({ model: 'inherit' }, tiers)).toBe('Inherited')
    expect(roleModelSummary({ model: 'sonnet' }, tiers)).toBe('Everyday')
    expect(roleModelSummary({ model: 'gpt-x' }, tiers)).toBe('Custom')
  })
  it('writes the tier model or inherit', () => {
    expect(applyModelChoice('deep', tiers)).toEqual({ model: 'opus', tier: 'deep' })
    expect(applyModelChoice('inherit', tiers)).toEqual({ model: 'inherit', tier: undefined })
    expect(applyModelChoice('custom', tiers)).toBeNull()
    expect(applyModelChoice('top', {})).toBeNull()
  })
  it('writes an exact model with its tier when it is one', () => {
    expect(applyExactModel('haiku', tiers)).toEqual({ model: 'haiku', tier: 'fast' })
    expect(applyExactModel('other', tiers)).toEqual({ model: 'other', tier: undefined })
    // Not set returns to the tier above, never inherit on its own (ux-review-config-2 N3).
    expect(applyExactModel('', tiers, { model: 'gpt-x', tier: 'deep' })).toEqual({ model: 'opus', tier: 'deep' })
    expect(applyExactModel('', tiers, { model: 'gpt-x' })).toEqual({ model: 'sonnet', tier: 'everyday' })
    expect(applyExactModel('', tiers, { model: 'inherit' })).toEqual({ model: 'inherit', tier: undefined })
    expect(applyExactModel('', {}, { model: 'gpt-x' })).toEqual({ model: 'inherit', tier: undefined })
  })
  it('shows a pinned id only for a custom role and chips the tier word', () => {
    expect(exactModelValue({ model: 'opus', tier: 'deep' }, tiers)).toBe('')
    expect(exactModelValue({ model: 'inherit' }, tiers)).toBe('')
    expect(exactModelValue({ model: 'gpt-x' }, tiers)).toBe('gpt-x')
    expect(roleChipLabel({ model: 'opus', tier: 'deep' })).toBe('Deep')
    expect(roleChipLabel({ model: 'inherit' })).toBe('Inherit')
    expect(roleChipLabel({ model: 'gpt-x' })).toBe('gpt-x')
  })
})

describe('exact model groups', () => {
  it('groups a proxy catalog by family and names the family in each option', () => {
    const g = exactModelGroups([m('claude-a', 'claude'), m('gpt-a', 'openai'), m('llama', 'other')], true, 'inherit')
    expect(g.filter((x) => x.label).map((x) => x.label)).toEqual(['Claude', 'GPT', 'Other'])
    expect(g.flatMap((x) => x.options).map((o) => o.label)).toEqual(['Not set (use the tier above)', 'claude-a · Claude', 'gpt-a · GPT', 'llama · Other'])
  })
  it('keeps a GPT exact model custom and readable on the chip', () => {
    expect(roleModelChoice({ model: 'gpt-a' }, { deep: 'claude-a' })).toBe('custom')
    expect(roleChipLabel({ model: 'gpt-a' })).toBe('gpt-a')
    expect(roleChipLabel({ model: 'gpt-a', tier: 'fast' })).toBe('Fast')
  })
  it('lists other connections in one group and marks a missing model', () => {
    const g = exactModelGroups([m('a', 'claude')], false, 'gone')
    expect(g.filter((x) => x.label).map((x) => x.label)).toEqual(['Models'])
    expect(g.flatMap((x) => x.options).some((o) => o.value === 'gone' && o.disabled)).toBe(true)
  })
})

describe('effort view', () => {
  it('offers Default plus the adapter levels', () => {
    expect(effortView(undefined, 'codex').options.map((o) => o.value)).toEqual(['', 'low', 'medium', 'high'])
    expect(effortView('max', 'claude').unsupported).toBeUndefined()
  })
  it('keeps an unsupported saved effort selected and explains it', () => {
    const v = effortView('xhigh', 'codex')
    expect(v.options.at(-1)).toEqual({ value: 'xhigh', label: 'xhigh (not used on OpenAI)' })
    expect(v.note).toContain('xhigh')
  })
})
