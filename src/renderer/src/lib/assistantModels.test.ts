import { describe, expect, it } from 'vitest'
import { modelDisplayName } from './assistantModels'

describe('modelDisplayName', () => {
  it('maps aliases to their labels and keeps unknown ids', () => {
    expect(modelDisplayName('opus')).toBe('Opus')
    expect(modelDisplayName('gpt-5')).toBe('gpt-5')
  })
})
