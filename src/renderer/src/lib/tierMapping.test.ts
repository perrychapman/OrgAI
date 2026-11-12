import { describe, expect, it } from 'vitest'
import type { ProviderModel } from '@shared/types'
import { effectiveTiers } from './tierMapping'

const m = (id: string, tier: ProviderModel['tier']): ProviderModel =>
  ({ id, label: id, connection: 'px_1', family: 'claude', adapter: 'claude', source: 'discovered', tier }) as ProviderModel

describe('effectiveTiers', () => {
  const catalog = [m('c-opus', 'deep'), m('c-sonnet', 'everyday'), m('c-haiku', 'fast')]
  it('keeps unmapped tiers Automatic with the model they follow', () => {
    const rows = effectiveTiers('px_1', { top: 'gpt-6' }, catalog)
    expect(rows.find((r) => r.tier === 'top')).toMatchObject({ model: 'gpt-6', automatic: false })
    expect(rows.find((r) => r.tier === 'deep')).toMatchObject({ model: 'c-opus', automatic: true })
    expect(rows.find((r) => r.tier === 'fast')).toMatchObject({ model: 'c-haiku', automatic: true })
  })
  it('has no model for a tier nothing resolves', () => {
    const rows = effectiveTiers('px_1', {}, [])
    expect(rows.every((r) => !r.model && !r.automatic)).toBe(true)
  })
})
