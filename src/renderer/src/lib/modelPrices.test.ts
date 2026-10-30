import { describe, expect, it } from 'vitest'
import { MODEL_PRICE_OVERRIDES_MAX } from '@shared/defaults'
import { visiblePriceRows, displayPerMTok, EMPTY_DRAFT, formatPerMTok, fromPerMTok, removeOverride, toPerMTok, upsertOverride, validateDraft } from './modelPrices'

const draft = (p: Partial<typeof EMPTY_DRAFT>): typeof EMPTY_DRAFT => ({ ...EMPTY_DRAFT, model: 'gpt-5', input: '1.25', output: '10', ...p })

describe('modelPrices conversion', () => {
  it('round-trips without float noise', () => {
    expect(toPerMTok(3e-6)).toBe(3)
    expect(toPerMTok(0.3e-6)).toBe(0.3)
    expect(fromPerMTok(0.3)).toBe(3e-7)
    expect(fromPerMTok(3.75)).toBe(3.75e-6)
    expect(formatPerMTok(1.25e-6)).toBe('1.25')
    expect(formatPerMTok(undefined)).toBe('')
  })
  it('displays', () => {
    expect(displayPerMTok(3e-6)).toBe('$3.00')
    expect(displayPerMTok(12.5e-6)).toBe('$12.50')
    expect(displayPerMTok(0.3e-6)).toBe('$0.30')
    expect(displayPerMTok(0.125e-6)).toBe('$0.125')
    expect(displayPerMTok(0.1e-6)).toBe('$0.10')
    expect(displayPerMTok(undefined)).toBe('—')
  })
})

describe('validateDraft', () => {
  it('builds an override per token', () => {
    const r = validateDraft(draft({ cacheRead: '0.125', connection: 'openai' }))
    expect(r).toEqual({ override: { model: 'gpt-5', connection: 'openai', price: { inputPerToken: 1.25e-6, outputPerToken: 1e-5, cacheReadPerToken: 1.25e-7 } } })
  })
  it('allows zero and rejects bad numbers', () => {
    expect('override' in validateDraft(draft({ input: '0' }))).toBe(true)
    for (const bad of ['', '-1', 'abc', '1e3', 'NaN', 'Infinity']) {
      const r = validateDraft(draft({ input: bad }))
      expect('errors' in r && r.errors.input).toBeTruthy()
    }
  })
  it('enforces the bounds', () => {
    const r = validateDraft(draft({ output: '10001', model: ' ' }))
    expect('errors' in r && !!r.errors.output && !!r.errors.model).toBe(true)
    expect('override' in validateDraft(draft({ output: '10000' }))).toBe(true)
    expect('errors' in validateDraft(draft({ model: 'x'.repeat(201) }))).toBe(true)
  })
})

describe('override list', () => {
  const a = { model: 'gpt-5', price: { inputPerToken: 1, outputPerToken: 1 } }
  it('replaces by normalized key', () => {
    const next = { ...a, model: 'GPT-5-20250929' }
    const r = upsertOverride([a], next)
    expect('list' in r && r.list).toEqual([next])
  })
  it('renames when replacing', () => {
    const next = { ...a, model: 'gpt-6' }
    const r = upsertOverride([a], next, { model: 'gpt-5' })
    expect('list' in r && r.list).toEqual([next])
  })
  it('caps and removes', () => {
    const many = Array.from({ length: MODEL_PRICE_OVERRIDES_MAX }, (_, i) => ({ ...a, model: `m${i}` }))
    expect('error' in upsertOverride(many, a)).toBe(true)
    expect(removeOverride([a], 'GPT-5')).toEqual([])
  })
})

describe('visiblePriceRows', () => {
  const rows = [
    { model: 'a', source: 'builtin' },
    { model: 'b', source: 'override' },
    { model: 'c', source: 'builtin' }
  ]
  it('defaults to overrides and models in use', () => {
    expect(visiblePriceRows(rows, new Set(['c']), false).map((r) => r.model)).toEqual(['b', 'c'])
    expect(visiblePriceRows(rows, new Set(), true)).toHaveLength(3)
  })
})
