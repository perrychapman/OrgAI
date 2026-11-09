import { describe, expect, it } from 'vitest'
import type { ProviderModel } from '@shared/types'
import { liveModelLabel, liveModelOptions } from './liveModelSwitch'

describe('live model switch', () => {
  it('shows the actual model and connection', () => {
    expect(liveModelLabel('model-id', 'anthropic')).toBe('model-id via Anthropic')
  })

  it('offers concrete ids only from the selected connection, without duplicates', () => {
    const models = [
      { id: 'a', label: 'Alpha', connection: 'anthropic' },
      { id: 'a', label: 'Alpha', connection: 'anthropic' },
      { id: 'b', label: 'b', connection: 'openai' }
    ] as ProviderModel[]
    expect(liveModelOptions(models, 'anthropic')).toEqual([{ value: 'a', label: 'Alpha (a)' }])
  })
})
