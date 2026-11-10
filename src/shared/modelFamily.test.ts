import { describe, expect, it } from 'vitest'
import { compareVersions, newerInFamily, parseModelId } from './modelFamily'

describe('parseModelId', () => {
  it('reads family and version from the usual shapes', () => {
    expect(parseModelId('claude-opus-4-1-20250805')).toEqual({ family: 'claude-opus', version: [4, 1] })
    expect(parseModelId('claude-opus-5-5')).toEqual({ family: 'claude-opus', version: [5, 5] })
    expect(parseModelId('claude-sonnet-5-5[1m]')).toEqual({ family: 'claude-sonnet', version: [5, 5] })
    expect(parseModelId('anthropic/claude-3-5-sonnet-20241022')).toEqual({ family: 'claude-sonnet', version: [3, 5] })
    expect(parseModelId('gpt-6.1-sol')).toEqual({ family: 'gpt-sol', version: [6, 1] })
    expect(parseModelId('gpt-5-mini')).toEqual({ family: 'gpt-mini', version: [5] })
  })
  it('gives up on aliases and opaque names', () => {
    for (const id of ['opus', 'inherit', 'my-proxy-model', '', '4-1', 'llama3-70b']) expect(parseModelId(id)).toBeUndefined()
  })
})

describe('compareVersions', () => {
  it('compares part by part, missing parts as 0', () => {
    expect(compareVersions([4, 1], [5, 5])).toBeLessThan(0)
    expect(compareVersions([5], [5, 0])).toBe(0)
    expect(compareVersions([5, 5], [5, 1])).toBeGreaterThan(0)
  })
})

describe('newerInFamily', () => {
  const catalog = ['claude-opus-5-5', 'claude-opus-4-1-20250805', 'claude-sonnet-5-5', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6.1-mini']
  it('names the newest of the same family only', () => {
    expect(newerInFamily('claude-opus-4-1-20250805', catalog)).toBe('claude-opus-5-5')
    expect(newerInFamily('claude-opus-5-5', catalog)).toBeUndefined()
    expect(newerInFamily('gpt-6-sol', catalog)).toBe('gpt-6.1-sol')
    expect(newerInFamily('claude-sonnet-5-5[1m]', catalog)).toBeUndefined()
  })
  it('does not warn when it cannot tell', () => {
    expect(newerInFamily('opus', catalog)).toBeUndefined()
    expect(newerInFamily('custom-model', catalog)).toBeUndefined()
    expect(newerInFamily('claude-haiku-4-5', catalog)).toBeUndefined()
  })
})
